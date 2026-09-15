// Malevuszoda - Budapest pool watcher frontend.
// No build step: this file is served as-is. It reads the two JSON files the
// pipeline produces (pools.json from the geocoder, status.json from the agent)
// and renders a map + filterable list.

const STATUS_COLOR = {
  open: "var(--st-open)",
  limited: "var(--st-limited)",
  renovation: "var(--st-renovation)",
  closed_temporarily: "var(--st-renovation)",
  seasonal_closed: "var(--st-closed)",
  permanently_closed: "var(--st-closed)",
  unknown: "var(--st-unknown)",
};

const T = {
  hu: {
    tagline: "Budapesti uszodafigyelő – hol lehet ma tényleg úszni?",
    f_swimmable: "Csak ahol lehet úszni",
    f_50m: "Csak 50 m-es medence",
    f_indoor: "Csak fedett",
    kind_all: "Minden típus", kind_sport: "Sportuszoda", kind_uszoda: "Uszoda",
    kind_gyogy: "Gyógyfürdő", kind_strand: "Strand",
    area_all: "Budapest és környéke", area_bp: "Csak Budapest", area_agglo: "Csak agglomeráció",
    footer_how:
      "Az adatokat egy ügynök gyűjti az uszodák saját oldalairól és hírforrásokból. Amit nem talál meg, azt <strong>nem találja ki</strong> – az „nincs adat” marad. Indulás előtt érdemes telefonon ellenőrizni.",
    results: (n, total) => `${n} / ${total} uszoda`,
    checked: (d) => `Utolsó ellenőrzés: ${d}`,
    never_checked: "Az ügynök még nem futott le",
    operational: "Állapot",
    swimmability: "Úszható?",
    hours: "Nyitvatartás",
    lanes: "Pályák",
    closures: "Zárva tartás",
    website: "Weboldal",
    sources: "Források",
    confidence: "Megbízhatóság",
    last_checked: "Ellenőrizve",
    no_sources: "Nincs forrás – ezért az állapot „nincs adat”.",
    close: "Bezár",
    district: (d) => `${d}. kerület`,
    unknown_note:
      "Erről az uszodáról nincs friss, forrásolt információnk. Inkább üresen hagyjuk, mint hogy rosszat írjunk.",
    lane_pool: (m, indoor) => `${m} m, ${indoor ? "fedett" : "szabadtéri"}`,
    no_lane_pool: "Nincs úszómedence",
    map_unavailable: "A térkép nem tölthető be (a Leaflet nem érhető el). A lista működik.",
    dry_run_notice:
      "Az ügynök még nem gyűjtött élő adatot – a helyszínek és koordináták valósak (OpenStreetMap), az állapotok „nincs adat”-on állnak. Élesítés: <code>npm run agent</code>.",
    st: {
      open: "Nyitva", renovation: "Felújítás", closed_temporarily: "Átmenetileg zárva",
      seasonal_closed: "Szezonon kívül", permanently_closed: "Végleg bezárt", unknown: "Nincs adat",
    },
    sw: {
      good: "Szabadon úszható", limited: "Korlátozottan", poor: "Alig úszható",
      closed_to_public: "Nem látogatható", unknown: "Nincs adat",
    },
    conf: { high: "magas", medium: "közepes", low: "alacsony" },
    restr: {
      school_groups: "iskolai csoportok", club_training: "egyesületi edzés", competition: "verseny",
      tourist_crowds: "turisták", gendered_days: "nemek szerinti napok",
      partial_renovation: "részleges felújítás", reduced_hours: "csökkentett nyitvatartás",
      ticket_limit: "jegykorlát",
    },
  },
  en: {
    tagline: "Budapest pool watcher – where can you actually swim today?",
    f_swimmable: "Only where you can swim",
    f_50m: "50 m pools only",
    f_indoor: "Indoor only",
    kind_all: "All types", kind_sport: "Sports pool", kind_uszoda: "Municipal pool",
    kind_gyogy: "Thermal bath", kind_strand: "Lido",
    area_all: "Budapest & around", area_bp: "Budapest only", area_agglo: "Agglomeration only",
    footer_how:
      "An agent collects this data from the pools' own sites and news sources. What it cannot find, it <strong>does not invent</strong> – that stays “no data”. Call ahead before you travel.",
    results: (n, total) => `${n} of ${total} pools`,
    checked: (d) => `Last checked: ${d}`,
    never_checked: "The agent has not run yet",
    operational: "Status",
    swimmability: "Swimmable?",
    hours: "Opening hours",
    lanes: "Lanes",
    closures: "Closures",
    website: "Website",
    sources: "Sources",
    confidence: "Confidence",
    last_checked: "Checked",
    no_sources: "No sources – which is why the status is “no data”.",
    close: "Close",
    district: (d) => `District ${d}`,
    unknown_note:
      "We have no current, sourced information about this pool. We would rather leave it blank than tell you something wrong.",
    lane_pool: (m, indoor) => `${m} m, ${indoor ? "indoor" : "outdoor"}`,
    no_lane_pool: "No lane pool",
    map_unavailable: "The map could not load (Leaflet unavailable). The list still works.",
    dry_run_notice:
      "The agent has not collected live data yet – venues and coordinates are real (OpenStreetMap), statuses are “no data”. Run <code>npm run agent</code> to populate.",
    st: {
      open: "Open", renovation: "Renovation", closed_temporarily: "Temporarily closed",
      seasonal_closed: "Out of season", permanently_closed: "Permanently closed", unknown: "No data",
    },
    sw: {
      good: "Freely swimmable", limited: "Limited", poor: "Barely swimmable",
      closed_to_public: "Not open to public", unknown: "No data",
    },
    conf: { high: "high", medium: "medium", low: "low" },
    restr: {
      school_groups: "school groups", club_training: "club training", competition: "competition",
      tourist_crowds: "tourists", gendered_days: "gendered days",
      partial_renovation: "partial renovation", reduced_hours: "reduced hours", ticket_limit: "ticket limit",
    },
  },
};

const state = {
  lang: "hu",
  pools: [],
  statuses: {},
  meta: null,
  selected: null,
  markers: new Map(),
};

const $ = (sel) => document.querySelector(sel);
const t = () => T[state.lang];

/** Escape anything that reaches innerHTML. Pool names and agent output are not trusted markup. */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Only http(s) links are rendered, so an odd source URL cannot become javascript:. */
function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

const statusOf = (id) => state.statuses[id] || { operational: "unknown", swimmability: "unknown", sources: [] };

const isAgglomeration = (pool) => pool.city !== "Budapest";

// ---------------------------------------------------------------- map

let map;
let layer;

/**
 * Leaflet comes from a CDN, which can be blocked by a corporate proxy or simply be
 * down. That must degrade to a working list, not a blank page - the pool data is the
 * point, the map is the nice-to-have.
 */
function initMap() {
  if (typeof L === "undefined") {
    const el = document.getElementById("map");
    el.classList.add("map-unavailable");
    el.textContent = "";
    return false;
  }
  map = L.map("map", { scrollWheelZoom: true }).setView([47.5, 19.05], 11);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
  return true;
}

function renderMap(pools) {
  if (!map) return;
  layer.clearLayers();
  state.markers.clear();
  const points = [];

  for (const pool of pools) {
    if (!pool.geo) continue;
    const status = statusOf(pool.id);
    const color = STATUS_COLOR[status.operational] || STATUS_COLOR.unknown;
    const marker = L.marker([pool.geo.lat, pool.geo.lon], {
      title: pool.name,
      icon: L.divIcon({
        className: "",
        html: `<div class="pin" style="background:${color}"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
    });
    marker.on("click", () => select(pool.id, { pan: false }));
    marker.bindTooltip(
      `<strong>${esc(pool.shortName || pool.name)}</strong><br>${esc(t().st[status.operational] || status.operational)}`,
    );
    marker.addTo(layer);
    state.markers.set(pool.id, marker);
    points.push([pool.geo.lat, pool.geo.lon]);
  }

  if (points.length) map.fitBounds(points, { padding: [40, 40], maxZoom: 13 });
}

// ---------------------------------------------------------------- list

function poolMeta(pool) {
  const bits = [];
  bits.push(pool.city === "Budapest" ? (pool.district ? t().district(pool.district) : "Budapest") : pool.city);
  bits.push(t()[`kind_${{ sportuszoda: "sport", uszoda: "uszoda", gyogyfurdo: "gyogy", strand: "strand" }[pool.kind]}`] || pool.kind);
  if (pool.lanePool) bits.push(t().lane_pool(pool.lanePool.lengthM, pool.lanePool.indoor));
  return bits.join(" · ");
}

function renderList(pools) {
  const list = $("#pool-list");
  list.innerHTML = "";

  for (const pool of pools) {
    const status = statusOf(pool.id);
    const color = STATUS_COLOR[status.operational] || STATUS_COLOR.unknown;
    const headline = state.lang === "hu" ? status.headline_hu : status.headline_en;

    const li = document.createElement("li");
    li.innerHTML = `
      <button type="button" class="pool-btn" data-id="${esc(pool.id)}"
              aria-current="${state.selected === pool.id}">
        <span class="dot" style="background:${color}"></span>
        <span>
          <span class="pool-name">${esc(pool.name)}</span>
          <span class="pool-meta">${esc(poolMeta(pool))}</span>
          ${headline ? `<span class="pool-head">${esc(headline)}</span>` : ""}
        </span>
      </button>`;
    list.appendChild(li);
  }

  $("#result-count").textContent = t().results(pools.length, state.pools.length);
}

// ---------------------------------------------------------------- detail

function renderDetail(pool) {
  const panel = $("#detail");
  if (!pool) {
    panel.hidden = true;
    return;
  }
  const s = statusOf(pool.id);
  const tr = t();
  const rows = [];

  const push = (label, value) => value && rows.push(`<dt>${esc(label)}</dt><dd>${value}</dd>`);

  push(tr.operational, esc(tr.st[s.operational] || s.operational));
  push(tr.swimmability, esc(tr.sw[s.swimmability] || s.swimmability));
  push(tr.hours, esc(s.opening_hours_summary));
  push(tr.lanes, esc(s.lane_note));

  if (s.closures?.length) {
    push(
      tr.closures,
      s.closures
        .map((c) => esc([[c.from, c.to].filter(Boolean).join(" – "), c.reason].filter(Boolean).join(": ")))
        .join("<br>"),
    );
  }

  const site = safeUrl(s.official_website || pool.website || "");
  if (site) push(tr.website, `<a href="${esc(site)}" target="_blank" rel="noopener noreferrer">${esc(site)}</a>`);
  if (s.confidence) push(tr.confidence, esc(tr.conf[s.confidence] || s.confidence));
  if (s.checkedAt) push(tr.last_checked, esc(new Date(s.checkedAt).toLocaleString(state.lang === "hu" ? "hu-HU" : "en-GB")));

  const restrictions = (s.restrictions || [])
    .map((r) => `<span class="badge soft">${esc(tr.restr[r] || r)}</span>`)
    .join("");

  const sources = (s.sources || [])
    .map((src) => {
      const url = safeUrl(src.url);
      const label = esc(src.title || url || src.url);
      const link = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
      const date = src.date ? ` <span class="pool-meta">(${esc(src.date)})</span>` : "";
      const quote = src.quote ? `<blockquote>${esc(src.quote)}</blockquote>` : "";
      return `<li>${link}${date}${quote}</li>`;
    })
    .join("");

  const detailsText = state.lang === "hu" ? s.headline_hu : s.details_en || s.headline_en;
  const noEvidence = !s.sources?.length;

  panel.innerHTML = `
    <button type="button" class="close-detail" id="close-detail">${esc(tr.close)}</button>
    <h2>${esc(pool.name)}</h2>
    <p class="sub">${esc(poolMeta(pool))}${pool.address ? ` · ${esc(pool.address)}` : ""}</p>
    <div class="badges">
      <span class="badge" style="background:${STATUS_COLOR[s.operational] || STATUS_COLOR.unknown}">
        ${esc(tr.st[s.operational] || s.operational)}
      </span>
      <span class="badge soft">${esc(tr.sw[s.swimmability] || s.swimmability)}</span>
      ${restrictions}
    </div>
    ${detailsText ? `<p>${esc(detailsText)}</p>` : ""}
    ${pool.swimmerNote ? `<p class="pool-meta">${esc(pool.swimmerNote)}</p>` : ""}
    ${rows.length ? `<dl>${rows.join("")}</dl>` : ""}
    ${
      noEvidence
        ? `<p class="unknown-note">${esc(tr.unknown_note)}</p>`
        : `<h3 style="font-size:14px;margin:0 0 8px">${esc(tr.sources)}</h3><ol class="sources">${sources}</ol>`
    }`;
  panel.hidden = false;
  $("#close-detail").addEventListener("click", () => select(null));
}

function select(id, { pan = true } = {}) {
  state.selected = id;
  const pool = state.pools.find((p) => p.id === id) || null;
  renderDetail(pool);
  document.querySelectorAll(".pool-btn").forEach((b) => b.setAttribute("aria-current", String(b.dataset.id === id)));
  if (map && pool?.geo && pan) map.setView([pool.geo.lat, pool.geo.lon], Math.max(map.getZoom(), 14));
  if (pool) state.markers.get(id)?.openTooltip?.();
  if (pool) $("#detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------------------------------------------------------------- filtering

function visiblePools() {
  const swimmableOnly = $("#f-swimmable").checked;
  const only50 = $("#f-50m").checked;
  const indoorOnly = $("#f-indoor").checked;
  const kind = $("#f-kind").value;
  const area = $("#f-area").value;

  return state.pools.filter((pool) => {
    const s = statusOf(pool.id);
    if (swimmableOnly && !["good", "limited"].includes(s.swimmability)) return false;
    if (only50 && pool.lanePool?.lengthM !== 50) return false;
    if (indoorOnly && !pool.lanePool?.indoor) return false;
    if (kind && pool.kind !== kind) return false;
    if (area === "budapest" && isAgglomeration(pool)) return false;
    if (area === "agglo" && !isAgglomeration(pool)) return false;
    return true;
  });
}

function render() {
  const pools = visiblePools();
  renderList(pools);
  renderMap(pools);
  if (state.selected && !pools.some((p) => p.id === state.selected)) select(null);
}

// ---------------------------------------------------------------- i18n & chrome

function applyLanguage() {
  const tr = t();
  document.documentElement.lang = state.lang;
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const value = tr[el.dataset.i18n];
    if (typeof value === "string") el.innerHTML = value;
  }
  document.querySelectorAll(".lang button").forEach((b) => b.classList.toggle("active", b.dataset.lang === state.lang));

  const meta = state.meta;
  const checkedAt = meta?.completedAt && meta.mode === "live" ? new Date(meta.completedAt) : null;
  $("#freshness").textContent = checkedAt
    ? tr.checked(checkedAt.toLocaleString(state.lang === "hu" ? "hu-HU" : "en-GB"))
    : tr.never_checked;

  const notice = $("#notice");
  if (meta && meta.mode !== "live") {
    notice.innerHTML = tr.dry_run_notice;
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }

  render();
  if (state.selected) renderDetail(state.pools.find((p) => p.id === state.selected));
}

// ---------------------------------------------------------------- boot

async function load(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function boot() {
  const mapReady = initMap();

  try {
    const [registry, status] = await Promise.all([load("data/pools.json"), load("data/status.json").catch(() => null)]);
    state.pools = registry.pools || [];
    state.statuses = status?.pools || {};
    state.meta = status;
  } catch (err) {
    $("#notice").hidden = false;
    $("#notice").textContent = `Nem sikerült betölteni az adatokat / could not load data: ${err.message}`;
    return;
  }

  $("#pool-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".pool-btn");
    if (btn) select(btn.dataset.id);
  });
  for (const id of ["#f-swimmable", "#f-50m", "#f-indoor", "#f-kind", "#f-area"]) {
    $(id).addEventListener("change", render);
  }
  document.querySelectorAll(".lang button").forEach((b) =>
    b.addEventListener("click", () => {
      state.lang = b.dataset.lang;
      applyLanguage();
    }),
  );

  applyLanguage();

  if (!mapReady) {
    const el = document.getElementById("map");
    el.textContent = t().map_unavailable;
  }
}

boot();
