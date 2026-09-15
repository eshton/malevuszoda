# CLAUDE.md

Guidance for agents working in this repository.

## What this is

A swimming pool watcher for Budapest and its agglomeration. An agent researches each
pool's current status and the result renders on a map. The question the site exists to
answer is not "is it open" but **"can I actually swim lengths there right now"** — in
Hungarian pools the water is often taken by school lessons (*úszásoktatás*), club
training, or competitions. Keep that question central when changing anything.

## Architecture

Three stages, each independently runnable, no build step anywhere:

| Stage | Command | Input → Output |
|---|---|---|
| Registry | `npm run geocode` | `data/pools.seed.json` → `data/pools.json` (+ OSM coords) |
| Research | `npm run agent` | `data/pools.json` → `docs/data/status.json` |
| Publish | `npm run build` | `data/pools.json` → `docs/data/pools.json` + validation |

`docs/` is the deployed site (vanilla ES modules + Leaflet from CDN, no bundler),
served by Cloudflare Workers Static Assets via `wrangler.jsonc`.

The agent (`scripts/agent.mjs`) makes two Claude calls per pool: **research** with the
`web_search`/`web_fetch` server tools, then **structure** via `client.messages.parse` +
`zodOutputFormat` against `PoolStatusSchema`. They are split deliberately — mixing server
tools with a constrained output format makes both jobs harder.

## The non-negotiable rule: never invent pool data

Someone may drive across Budapest on what this site says. A wrong opening time is worse
than no opening time. Concretely:

- `unknown` is a correct, expected answer. Do not add fallbacks that guess.
- Every claim carries `sources[]` with URL, date and a verbatim quote.
- `enforceEvidenceDiscipline()` in `scripts/agent.mjs` is the backstop: no sources →
  forced to `unknown`; `high` confidence without a quote → downgraded. **Do not weaken
  this to make the map look fuller.**
- The geocoder rejects OSM matches that are administrative areas rather than venues.
- If a venue cannot be confirmed to exist, delete it from the seed rather than ship it.
  Two entries were removed for exactly this reason.

## Gotchas already paid for

- **Node 22+ required.** Wrangler 4 refuses to run on Node 20; all workflows pin 22 and
  `engines` says `>=22`.
- **Nominatim hates postal addresses.** `"Lukács gyógyfürdő Budapest"` resolves;
  `"Lukács gyógyfürdő, Frankel Leó út 25-29, Budapest"` returns nothing. `geoQuery` in the
  seed must read like a map search box. `queryCandidates()` tries progressively looser forms.
- **Zod v4 is required**, not v3 — the SDK's `zodOutputFormat` goes through `zod/v4/core`
  and throws on a v3 schema.
- **Structured outputs are non-beta** in the pinned SDK: `client.messages.parse` with
  `output_config: { format: zodOutputFormat(schema) }` (single argument).
- **GITHUB_TOKEN pushes do not trigger workflows.** The watcher therefore calls
  `deploy.yml` via `workflow_call` instead of relying on its `push` trigger. Removing that
  leaves the site silently stale after every agent run.
- **Leaflet is a CDN dependency** and `initMap()` degrades to a working list if it fails.
  Keep that path alive.

## Working locally

```bash
npm install
npm run agent:dry     # full pipeline, zero API calls, statuses become "no data"
npm run build
npm run serve         # http://localhost:8080
npx wrangler dev      # serves exactly as Cloudflare does, incl. _headers and 404
```

Use `--only <id>` or `--limit N` on the agent while iterating; a full run costs real
money (see README → Cost). Never commit an API key; both secrets live in repo settings.

## Verification expectations

CI (`ci.yml`) needs no credentials and must stay that way — syntax, schema conversion,
registry validation, and `wrangler deploy --dry-run`. Before claiming the site works,
render it in a browser and check the console; the dry-run path exercises everything
except the live API.

## State as of handoff

Working and verified: registry of 24 venues with real OSM coordinates, geocoder, site
(map, filters, HU/EN, sources), Cloudflare config verified through `wrangler dev`, CI green.

Not yet exercised: **the live research path has never run against the real API.** Start
with `npm run agent -- --limit 3`. Deploy and watcher workflows are blocked on the
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `ANTHROPIC_API_KEY` secrets.

Known gaps are listed at the end of README.md; the biggest is that lane availability is
prose, not structured per-day slots.
