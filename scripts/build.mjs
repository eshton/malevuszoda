#!/usr/bin/env node
// Publishes the registry into the static site and sanity-checks what the browser
// will receive. Run after `npm run geocode` or `npm run agent`.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATIONAL, SWIMMABILITY } from "./lib/schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "data", "pools.json");
const DOCS_DATA = path.join(root, "docs", "data");

const problems = [];
const warn = (m) => problems.push(m);

const registry = JSON.parse(await fs.readFile(SRC, "utf8"));
const pools = registry.pools || [];
if (!pools.length) throw new Error("registry contains no pools");

const seen = new Set();
for (const pool of pools) {
  if (seen.has(pool.id)) warn(`duplicate pool id: ${pool.id}`);
  seen.add(pool.id);
  if (!pool.name) warn(`${pool.id}: missing name`);
  if (!pool.geo) warn(`${pool.id}: no coordinates - will not appear on the map`);
  else if (Math.abs(pool.geo.lat) > 90 || Math.abs(pool.geo.lon) > 180) warn(`${pool.id}: impossible coordinates`);
}

await fs.mkdir(DOCS_DATA, { recursive: true });
await fs.writeFile(path.join(DOCS_DATA, "pools.json"), JSON.stringify(registry, null, 2) + "\n");

// status.json is optional - the site renders an honest "agent has not run" state without it.
let statusCount = 0;
try {
  const status = JSON.parse(await fs.readFile(path.join(DOCS_DATA, "status.json"), "utf8"));
  for (const [id, s] of Object.entries(status.pools || {})) {
    statusCount++;
    if (!seen.has(id)) warn(`status.json has an entry for unknown pool "${id}"`);
    if (!OPERATIONAL.includes(s.operational)) warn(`${id}: unknown operational value "${s.operational}"`);
    if (!SWIMMABILITY.includes(s.swimmability)) warn(`${id}: unknown swimmability value "${s.swimmability}"`);
  }
  for (const id of seen) if (!(id in (status.pools || {}))) warn(`no status for pool "${id}"`);
} catch {
  warn("docs/data/status.json missing - run `npm run agent` (or `npm run agent:dry`)");
}

console.log(`Published ${pools.length} pools to docs/data/pools.json (${statusCount} statuses present)`);
if (problems.length) {
  console.log(`\n${problems.length} issue(s):`);
  for (const p of problems) console.log(`  - ${p}`);
} else {
  console.log("No issues.");
}
