// Small polite HTTP helper shared by the geocoder and the watcher agent.
// Nothing here is clever; it exists so every outbound request is rate limited,
// identifies itself, and fails in a way the caller can reason about.

export const USER_AGENT =
  process.env.POOL_WATCHER_UA ||
  "malevuszoda-pool-watcher/0.1 (+https://github.com/eshton/malevuszoda)";

const lastCallByHost = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until at least `minIntervalMs` has passed since the last call to this host. */
async function throttle(host, minIntervalMs) {
  const last = lastCallByHost.get(host) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallByHost.set(host, Date.now());
}

/**
 * Fetch with per-host throttling, a real User-Agent and bounded retries.
 * Returns { ok, status, body, url, error } - it never throws for network or
 * HTTP failures, because a single dead pool website must not abort a whole run.
 */
export async function politeFetch(url, opts = {}) {
  const {
    minIntervalMs = 1100, // Nominatim's published limit is 1 req/s; be safe everywhere
    retries = 2,
    timeoutMs = 20000,
    accept = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  } = opts;

  let host;
  try {
    host = new URL(url).host;
  } catch {
    return { ok: false, status: 0, body: "", url, error: "invalid URL" };
  }

  let lastError = "unknown error";
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host, minIntervalMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: accept,
          "Accept-Language": "hu,en;q=0.8",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      const body = await res.text();
      clearTimeout(timer);
      if (res.ok) return { ok: true, status: res.status, body, url: res.url };
      // 4xx other than 429 will not get better by retrying.
      if (res.status < 500 && res.status !== 429) {
        return { ok: false, status: res.status, body, url: res.url, error: `HTTP ${res.status}` };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      clearTimeout(timer);
      lastError = err.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(err.message || err);
    }
    if (attempt < retries) await sleep(1500 * (attempt + 1));
  }
  return { ok: false, status: 0, body: "", url, error: lastError };
}
