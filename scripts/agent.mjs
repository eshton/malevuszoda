#!/usr/bin/env node
/**
 * The pool watcher agent.
 *
 * For every pool in data/pools.json it runs two Claude calls:
 *
 *   1. RESEARCH - Claude with the web_search and web_fetch server tools goes and
 *      reads the pool's own site, the operator's news page, and whatever else it
 *      can find, then reports what it learned in prose with URLs and quotes.
 *   2. STRUCTURE - a second, cheap call turns that prose into strict JSON matching
 *      PoolStatusSchema.
 *
 * Two calls rather than one because mixing server tools with a constrained output
 * format makes both jobs harder; splitting them keeps each call simple and lets the
 * structuring step be re-run on cached research without paying for the web work again.
 *
 * The cardinal rule, enforced in the prompt and again in validation: if the agent did
 * not find evidence, the answer is "unknown". A swimmer who drives across Budapest on
 * a hallucinated opening time is worse off than one who was told we don't know.
 *
 * Usage:
 *   node scripts/agent.mjs                 # research every pool
 *   node scripts/agent.mjs --only lukacs   # one pool (repeatable)
 *   node scripts/agent.mjs --limit 3       # first N pools
 *   node scripts/agent.mjs --dry-run       # no API calls; emit "unknown" for everything
 *   node scripts/agent.mjs --concurrency 4
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { PoolStatusSchema, unknownStatus, RESTRICTIONS } from "./lib/schema.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const REGISTRY = path.join(root, "data", "pools.json");
const OUT = path.join(root, "docs", "data", "status.json");

const MODEL = process.env.POOL_WATCHER_MODEL || "claude-opus-5";

// Server-tool versions are dated. Pinned here so an API-side change is a one-line fix
// rather than a hunt through the code; override via env to try a newer pair.
const WEB_SEARCH_TOOL = process.env.POOL_WATCHER_SEARCH_TOOL || "web_search_20260209";
const WEB_FETCH_TOOL = process.env.POOL_WATCHER_FETCH_TOOL || "web_fetch_20260209";

function parseArgs(argv) {
  const args = { only: [], limit: null, dryRun: false, concurrency: 3 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--only") args.only.push(argv[++i]);
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Math.max(1, Number(argv[++i]));
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

const RESEARCH_SYSTEM = `You research the current operating status of swimming pools in and around Budapest, Hungary, for a website used by people who want to swim lengths.

Your job is to find out, for one named pool:

1. Is it open at all right now, or is it closed / under renovation (felújítás) / out of season?
2. Can an individual actually swim lengths there, or is the water taken by school swimming lessons (úszásoktatás, iskolai csoportok), club training (egyesületi edzés), competitions, or tourist crowds? This is the question that matters most to our users and the one that is hardest to find.
3. What are the current opening hours, and are there announced closures?

Method:
- Search in Hungarian first. Hungarian pool information is almost never available in English. Useful terms: "uszoda nyitvatartás", "felújítás miatt zárva", "közönségforgalom", "pályabérlés", "úszásoktatás", "technikai szünet", "aktuális nyitvatartás".
- Prefer the pool's own website and its operator (for the classic Budapest baths that is Budapest Gyógyfürdői és Hévizei Zrt., budapestgyogyfurdoi.hu). Then local news, then the venue's Facebook page, which in Hungary is often where closures are announced first.
- Read the actual pages with web_fetch rather than trusting search snippets.
- Note the date of everything you read. A 2019 timetable is not current information.

Report back in plain prose covering: operational status, whether lane swimming is realistically possible and what competes for the water, opening hours, any announced closures with dates, the official website URL, and a numbered source list with URL, page title, publication date if shown, and a short verbatim quote (Hungarian is fine) supporting each claim.

If you cannot find current information, say so explicitly and say what you did look at. Never fill a gap with a plausible guess: an honest "I could not confirm this" is a correct answer here, an invented opening time is not.`;

const STRUCTURE_SYSTEM = `Convert a research report about a Hungarian swimming pool into the required JSON structure.

Rules:
- Use only what the report supports. If the report does not establish something, use "unknown" / null / an empty array. Do not infer, do not fill gaps from general knowledge.
- confidence: "high" only when a dated, official source (the pool's or operator's own site) backs the claim; "medium" for an official but undated page, or recent news; "low" for weak, indirect, or stale evidence.
- swimmability describes whether an individual can realistically swim lengths: "good" = public lanes generally available; "limited" = public lanes exist but are squeezed by groups, clubs or events; "poor" = open but not realistically usable for training; "closed_to_public" = open but not to individual swimmers.
- headline_hu is Hungarian, headline_en is English. Both are one short sentence a swimmer can act on.
- Every source in the report that was actually used belongs in sources, with its quote where one was given.
- restrictions uses only these values: ${RESTRICTIONS.join(", ")}.`;

/**
 * Run the research call. Server tools may pause the turn (pause_turn) when the model
 * has more web work to do than fits one response; continue the conversation until it
 * finishes or we hit the continuation cap.
 */
async function research(client, pool) {
  const known = [
    `Name: ${pool.name}`,
    pool.district ? `Location: Budapest district ${pool.district}` : `Location: ${pool.city}`,
    pool.address ? `Address: ${pool.address}` : null,
    pool.website ? `Known website: ${pool.website}` : "Known website: none - find it.",
    pool.operator ? `Operator: ${pool.operator}` : null,
    pool.lanePool
      ? `Lane pool on record: ${pool.lanePool.lengthM} m, ${pool.lanePool.indoor ? "indoor" : "outdoor"}`
      : "Lane pool on record: none",
  ]
    .filter(Boolean)
    .join("\n");

  const messages = [
    {
      role: "user",
      content: `Research the current status of this pool. Today is ${new Date().toISOString().slice(0, 10)}.\n\n${known}`,
    },
  ];

  let response;
  for (let turn = 0; turn < 4; turn++) {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: RESEARCH_SYSTEM,
      thinking: { type: "adaptive" },
      tools: [
        { type: WEB_SEARCH_TOOL, name: "web_search", max_uses: 6 },
        // max_content_tokens caps how much of a fetched page enters context. Hungarian
        // pool sites are small, but a stray PDF timetable can otherwise dominate the bill.
        { type: WEB_FETCH_TOOL, name: "web_fetch", max_uses: 6, max_content_tokens: 20000 },
      ],
      messages,
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`refused: ${response.stop_details?.explanation || "no explanation"}`);
    }
    if (response.stop_reason !== "pause_turn") break;

    // Hand the paused turn straight back to continue the web work.
    messages.push({ role: "assistant", content: response.content });
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!text) throw new Error("research produced no text");
  return text;
}

async function structure(client, pool, report) {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: STRUCTURE_SYSTEM,
    output_config: { format: zodOutputFormat(PoolStatusSchema) },
    messages: [
      {
        role: "user",
        content: `Pool: ${pool.name} (${pool.city}${pool.district ? `, district ${pool.district}` : ""})\n\nResearch report:\n\n${report}`,
      },
    ],
  });

  if (response.stop_reason === "max_tokens") throw new Error("structuring hit max_tokens");
  if (!response.parsed_output) throw new Error("structuring returned no parsed output");
  return response.parsed_output;
}

/**
 * Last line of defence against a confident-sounding but unsourced answer. The model is
 * told to say "unknown" without evidence; this makes it true regardless.
 */
function enforceEvidenceDiscipline(status, poolId) {
  const warnings = [];
  const hasSources = Array.isArray(status.sources) && status.sources.length > 0;

  if (!hasSources) {
    if (status.operational !== "unknown" || status.swimmability !== "unknown") {
      warnings.push(`${poolId}: claims status with no sources - downgraded to unknown`);
      status.operational = "unknown";
      status.swimmability = "unknown";
    }
    status.confidence = "low";
  }
  if (status.confidence === "high" && !status.sources.some((s) => s.quote)) {
    warnings.push(`${poolId}: high confidence without a supporting quote - downgraded to medium`);
    status.confidence = "medium";
  }
  return warnings;
}

/** Run `worker` over `items` with bounded concurrency, preserving input order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(await fs.readFile(fileURLToPath(import.meta.url), "utf8").then((s) => s.split("*/")[0]));
    return;
  }

  const registry = JSON.parse(await fs.readFile(REGISTRY, "utf8"));
  let pools = registry.pools;
  if (args.only.length) pools = pools.filter((p) => args.only.includes(p.id));
  if (args.limit) pools = pools.slice(0, args.limit);
  if (!pools.length) throw new Error("no pools selected");

  const useApi = !args.dryRun;
  if (useApi && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error(
      "No ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN found.\n" +
        "Set one, or run with --dry-run to regenerate the site data without calling the API.",
    );
    process.exit(2);
  }

  const client = useApi ? new Anthropic() : null;
  const warnings = [];
  const startedAt = new Date();

  console.log(`${useApi ? "Researching" : "Dry run over"} ${pools.length} pools with ${MODEL}\n`);

  const entries = await mapWithConcurrency(pools, args.concurrency, async (pool) => {
    if (!useApi) {
      return [pool.id, { ...unknownStatus("Dry run - no research performed."), checkedAt: null }];
    }
    const t0 = Date.now();
    try {
      const report = await research(client, pool);
      const status = await structure(client, pool, report);
      warnings.push(...enforceEvidenceDiscipline(status, pool.id));
      console.log(
        `  ok   ${pool.id.padEnd(18)} ${status.operational}/${status.swimmability} ` +
          `(${status.confidence}, ${status.sources.length} sources, ${((Date.now() - t0) / 1000).toFixed(0)}s)`,
      );
      return [pool.id, { ...status, checkedAt: new Date().toISOString() }];
    } catch (err) {
      const reason = `Research failed: ${err.message}`;
      console.log(`  FAIL ${pool.id.padEnd(18)} ${err.message}`);
      warnings.push(`${pool.id}: ${reason}`);
      return [pool.id, { ...unknownStatus(reason), checkedAt: new Date().toISOString() }];
    }
  });

  const statuses = Object.fromEntries(entries);

  // Merge with the previous run so a partial run (--only, --limit) does not wipe
  // everything else off the site.
  let previous = {};
  try {
    previous = JSON.parse(await fs.readFile(OUT, "utf8")).pools || {};
  } catch {
    /* first run */
  }

  const payload = {
    generatedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    model: useApi ? MODEL : null,
    mode: useApi ? "live" : "dry-run",
    poolsChecked: pools.map((p) => p.id),
    warnings,
    pools: { ...previous, ...statuses },
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");

  const counts = {};
  for (const s of Object.values(payload.pools)) counts[s.operational] = (counts[s.operational] || 0) + 1;
  console.log(`\nWrote ${OUT}`);
  console.log("Status spread:", counts);
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
