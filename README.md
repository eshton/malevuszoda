# Malevuszoda

**Budapesti uszodafigyelő** — a swimming pool watcher for Budapest and its agglomeration.

Which pool is open? Which one is closed for *felújítás*? And the question no pool website
ever answers directly: **can I actually swim lengths there right now**, or is every lane
taken by school groups, club training or a competition?

An agent goes and finds out, and the answers land on a map.

<!-- Screenshot: run `npm run serve` and open http://localhost:8080 -->

## Why this exists

Hungarian pool information is scattered across the venues' own sites, the operator's news
page, and — very often — a Facebook post from three days ago. The *nyitvatartás* page tells
you the building is open from 06:00. It does not tell you that the 50 m pool has two public
lanes until 09:00 because *úszásoktatás* has the rest. That gap is what this project closes.

## How it works

```
data/pools.seed.json        curated registry, hand-maintained
        │
        │  npm run geocode    → OpenStreetMap / Nominatim
        ▼
data/pools.json             + real coordinates, postal addresses
        │
        │  npm run agent      → Claude with web_search + web_fetch
        ▼
docs/data/status.json       operational + swimmability per pool, with sources
        │
        │  npm run build
        ▼
docs/                       static site (Leaflet map, no build step)
        │
        │  npm run deploy
        ▼
Cloudflare Workers Static Assets
```

The agent makes two calls per pool:

1. **Research** — Claude with the `web_search` and `web_fetch` server tools reads the pool's
   own site, the operator's announcements and local news, searching in Hungarian, and reports
   what it found with URLs, dates and verbatim quotes.
2. **Structure** — a second call converts that report into strict JSON via structured outputs
   (`output_config.format` + a Zod schema), so the site never has to parse prose.

Split in two because mixing web tools with a constrained output format makes both jobs
harder, and because the structuring step can be re-run on a cached report for free.

## The honesty rule

A swimmer who drives across Budapest on a hallucinated opening time is worse off than one
who was told we don't know. So:

- The agent is instructed that **"I could not confirm this" is a correct answer**.
- Every claim carries its `sources[]` — URL, title, date, and a quote that supports it.
- `enforceEvidenceDiscipline()` in `scripts/agent.mjs` is the backstop: a status with no
  sources is forced to `unknown`, and `high` confidence without a supporting quote is
  downgraded. The model is asked to behave; the code makes it true.
- The geocoder refuses matches that are administrative areas rather than venues, so a loose
  query can't silently drop a pin in the middle of a district.
- Two seed entries were **deleted** during development because no source could confirm they
  exist under that name. A shorter list beats a fictional one.

The UI reflects this: pools with no evidence say *"Erről az uszodáról nincs friss, forrásolt
információnk"* rather than showing a confident-looking guess.

## Getting started

```bash
npm install

npm run geocode      # resolve coordinates from OpenStreetMap (cached; safe to re-run)
npm run agent:dry    # populate the site with "no data" placeholders, no API calls
npm run build        # publish data/ into docs/
npm run serve        # http://localhost:8080
```

For a real run you need an Anthropic API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run agent                      # all pools
npm run agent -- --only lukacs     # one pool, repeatable
npm run agent -- --limit 3         # first three, for a cheap smoke test
npm run build
```

Useful environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `POOL_WATCHER_MODEL` | `claude-opus-5` | Model for both calls |
| `POOL_WATCHER_SEARCH_TOOL` | `web_search_20260209` | Pin a server-tool version |
| `POOL_WATCHER_FETCH_TOOL` | `web_fetch_20260209` | Pin a server-tool version |
| `POOL_WATCHER_UA` | project UA string | User-Agent for Nominatim etc. |

## Cost

This is the number worth knowing before you enable the schedule. Each pool costs roughly
**$0.20–0.50** per refresh on `claude-opus-5` — dominated by fetched page content, not by the
prompts. A full 24-pool run is therefore on the order of **$5–12**, and a daily schedule is
**$150–360/month**.

Levers, in the order worth pulling:

- Keep the schedule **daily** (the shipped default). Renovations are announced days ahead.
- Research only what changes: `--only <id>` for the handful of pools you personally use.
- `POOL_WATCHER_MODEL=claude-sonnet-5` for the research call — this is mostly reading and
  summarising, which does not need the top tier.
- `max_content_tokens` on the `web_fetch` tool is already capped at 20 000.

## Deploying (Cloudflare)

The site is plain files with no build step, deployed to **Cloudflare Workers Static
Assets** — `docs/` is uploaded and served from the edge, with no Worker script.

One-time setup:

```bash
npx wrangler login          # or set CLOUDFLARE_API_TOKEN
npm run deploy              # publishes to <name>.<subdomain>.workers.dev
```

Check the config without publishing anything:

```bash
npm run deploy:dry
npx wrangler dev            # serve exactly as Cloudflare will, including _headers
```

For CI deploys, add two repository secrets — **`CLOUDFLARE_API_TOKEN`** (with the
*Edit Cloudflare Workers* template) and **`CLOUDFLARE_ACCOUNT_ID`**.

Three workflows:

| Workflow | Trigger | Needs secrets |
|---|---|---|
| `ci.yml` | every push / PR | none |
| `deploy.yml` | push to `main` touching `docs/`, manual, or called by the watcher | Cloudflare |
| `watch.yml` | daily cron, or manual | `ANTHROPIC_API_KEY` + Cloudflare |

`deploy.yml` refuses to publish if the registry is empty, so a broken agent run cannot
replace a working site with a blank one.

One wrinkle worth knowing, since it is the kind of thing that fails silently: GitHub does
**not** trigger workflows for pushes made with the default `GITHUB_TOKEN`. The watcher's
data commit would therefore never fire `deploy.yml`'s `push` trigger. That is why
`deploy.yml` also exposes `workflow_call` and the watcher invokes it directly after a
commit that changed something.

`docs/_headers` sets cache and security headers: data JSON is cached for 5 minutes with
`stale-while-revalidate`, the shell a little longer.

### GitHub Pages (alternative)

The layout also works unchanged on Pages — **Settings → Pages → Deploy from a branch →
`main` / `/docs`** — which is why the directory is `docs/` rather than `public/`.

## Adding a pool

Add an entry to `data/pools.seed.json` with `id`, `name`, `kind`, `city`, `district` and a
`geoQuery` that reads like something you'd type into a map search (`"Lukács gyógyfürdő
Budapest"` works; a full postal address does not). Then:

```bash
npm run geocode && npm run build
```

If the geocoder reports `needs review`, the venue isn't in OpenStreetMap under that name —
fix the query or leave the entry out rather than inventing coordinates.

## Current state and known gaps

Working: the registry (24 venues, all with verified OSM coordinates), the geocoder, the
agent, the static site with map, filters, HU/EN toggle and per-pool sources, and all
three workflows. Cloudflare serving was verified locally through `wrangler dev` —
headers, caching, the 404 page and the full app. The pipeline has been exercised end to end in dry-run mode; the live research
path has not yet been run against the real API.

Known gaps, roughly in the order I'd tackle them:

- **`swimmerNote` in the seed registry is English only** — it shows untranslated in the
  Hungarian UI. Should become `{ hu, en }`.
- **No lane-level timetable.** The agent summarises lane availability as prose. Turning
  Hungarian pool timetables into structured per-day slots is the obvious next milestone
  and the hard part of the problem.
- **No crowd-sourcing.** A "swam here today, two lanes free" button would beat any scraper,
  but it needs a backend; the site is deliberately static for now.
- **Agglomeration coverage is thin** (four venues). Easy to extend via the seed file.
- **No history.** Each run overwrites the status; keeping a time series would let the site
  show "usually quiet on Tuesday mornings".

## Data & licences

Coordinates and addresses come from OpenStreetMap via Nominatim, © OpenStreetMap
contributors, ODbL. Map tiles from openstreetmap.org. Status information is collected from
each venue's public pages — always with a link back to the source.
