#!/usr/bin/env node
// Resolves each seed pool to real coordinates and a postal address via OpenStreetMap's
// Nominatim service, and writes the merged registry to data/pools.json.
//
// Design rule for this whole project: we never invent a coordinate. If Nominatim
// cannot find a venue, or returns something outside the greater Budapest bounding
// box, the entry is written with geo:null and needsReview:true so it shows up as
// unverified in the UI instead of quietly placing a pin in the wrong place.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { politeFetch } from "./lib/http.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const SEED = path.join(root, "data", "pools.seed.json");
const OUT = path.join(root, "data", "pools.json");
const CACHE = path.join(root, ".cache", "geocode.json");

// Greater Budapest + agglomeration. Anything outside this is a bad match.
const BBOX = { minLat: 47.15, maxLat: 47.85, minLon: 18.7, maxLon: 19.5 };

const inBbox = (lat, lon) =>
  lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function geocode(query) {
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q: query,
      format: "jsonv2",
      addressdetails: "1",
      limit: "1",
      countrycodes: "hu",
    });

  const res = await politeFetch(url, { minIntervalMs: 1100, accept: "application/json" });
  if (!res.ok) return { error: res.error };

  let hits;
  try {
    hits = JSON.parse(res.body);
  } catch {
    return { error: "unparseable Nominatim response" };
  }
  if (!Array.isArray(hits) || hits.length === 0) return { error: "no match" };

  const hit = hits[0];

  // Guard against the classic Nominatim failure mode: a loose query like
  // "Csepel uszoda Budapest" happily matches the *district boundary* and we would
  // drop a pin in the middle of a neighbourhood. Only physical venues count.
  const category = hit.category || "";
  const addressType = hit.addresstype || "";
  const VENUE_CATEGORIES = new Set(["leisure", "amenity", "sport", "building", "tourism", "shop"]);
  const PLACE_TYPES = new Set([
    "boundary", "city", "town", "village", "suburb", "city_district",
    "borough", "quarter", "neighbourhood", "postcode", "county", "state",
  ]);
  if (PLACE_TYPES.has(addressType) || PLACE_TYPES.has(category)) {
    return { error: `match is an administrative area (${category}/${addressType}), not a venue` };
  }
  if (category && !VENUE_CATEGORIES.has(category)) {
    return { error: `match category "${category}/${hit.type || "?"}" is not a venue` };
  }

  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: "no coordinates in match" };
  if (!inBbox(lat, lon)) return { error: `match outside Budapest area (${lat}, ${lon})` };

  const a = hit.address || {};
  const address = [
    [a.road, a.house_number].filter(Boolean).join(" "),
    a.suburb || a.city_district || null,
    a.city || a.town || a.village || null,
    a.postcode || null,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    lat,
    lon,
    address: address || hit.display_name || null,
    displayName: hit.display_name || null,
    osm: hit.osm_type && hit.osm_id ? `${hit.osm_type}/${hit.osm_id}` : null,
    category: hit.category || null,
    osmType: hit.type || null,
    matchedName: hit.name || null,
  };
}

/** Progressively looser Nominatim queries for one pool. First plausible hit wins. */
function queryCandidates(pool) {
  const place = pool.city || "Budapest";
  const seen = new Set();
  return [
    pool.geoQuery,
    `${pool.name} ${place}`,
    pool.shortName ? `${pool.shortName} uszoda ${place}` : null,
    pool.shortName ? `${pool.shortName} ${place}` : null,
  ].filter((q) => q && !seen.has(q) && seen.add(q));
}

async function main() {
  const force = process.argv.includes("--force");
  const seed = await readJson(SEED, null);
  if (!seed) throw new Error(`cannot read ${SEED}`);

  const cache = force ? {} : await readJson(CACHE, {});
  const out = [];
  let resolved = 0;
  let cached = 0;
  let failed = 0;

  for (const pool of seed.pools) {
    const key = pool.geoQuery;
    let geo = cache[key];

    if (geo) {
      cached++;
    } else {
      process.stdout.write(`geocoding ${pool.id} ... `);
      // Nominatim does badly with full postal addresses in free-text queries, so we
      // try progressively looser candidates and take the first plausible hit.
      for (const candidate of queryCandidates(pool)) {
        geo = await geocode(candidate);
        if (!geo.error) {
          geo.query = candidate;
          break;
        }
      }
      cache[key] = geo;
      console.log(geo.error ? `FAILED (${geo.error})` : `${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)}`);
    }

    const ok = !geo.error;
    if (ok) resolved++;
    else failed++;

    const { geoQuery, $comment, ...rest } = pool;
    out.push({
      ...rest,
      geo: ok
        ? {
            lat: geo.lat,
            lon: geo.lon,
            source: "openstreetmap/nominatim",
            osm: geo.osm,
            matchedName: geo.matchedName,
            osmCategory: geo.category && geo.osmType ? `${geo.category}/${geo.osmType}` : null,
            query: geo.query || pool.geoQuery,
          }
        : null,
      address: ok ? geo.address : null,
      needsReview: !ok,
      reviewReason: ok ? null : `geocoding failed: ${geo.error}`,
    });
  }

  await fs.mkdir(path.dirname(CACHE), { recursive: true });
  await fs.writeFile(CACHE, JSON.stringify(cache, null, 2));

  const registry = {
    generatedAt: new Date().toISOString(),
    generatedBy: "scripts/geocode.mjs",
    attribution: "Coordinates and addresses © OpenStreetMap contributors (ODbL), via Nominatim.",
    count: out.length,
    pools: out.sort((a, b) => a.name.localeCompare(b.name, "hu")),
  };
  await fs.writeFile(OUT, JSON.stringify(registry, null, 2) + "\n");

  console.log(
    `\n${out.length} pools written to data/pools.json ` +
      `(${out.length - failed} located, ${failed} need review, ${cached} from cache)`,
  );
  if (failed) {
    console.log("Needs review:");
    for (const p of out.filter((p) => p.needsReview)) console.log(`  - ${p.id}: ${p.reviewReason}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
