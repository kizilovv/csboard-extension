// ============================================================
// CSBOARD-PROD — Geo-Aware Endpoint Resolver
// ============================================================
// Production domains are geo-routed at nginx:
//   - csboard.com   — non-RU traffic (canonical).
//   - csboard.trade — RU traffic (no VPN required).
// nginx 302's any visitor whose geo doesn't match the domain to the other
// host. fetch(credentials:'include') strips cookies on cross-origin redirect
// and POST bodies don't survive a 302 reliably — the extension must hit the
// user's "local" domain directly.
//
// Strategy: probe both domains once at boot with redirect:'error'. The one
// that does NOT 302 is this user's local host. Cache for 24h.
//
// Browser navigation (chrome.tabs.create, anchor href) follows 302 fine, so
// SITE_BASE can stay static — only API_BASE needs runtime resolution.

const DOMAINS = {
  com: 'https://csboard.com',
  trade: 'https://csboard.trade',
} as const;

const PROBE_PATH = '/api/extension/exchange-rates';
const CACHE_KEY = 'csboard_resolved_origin';
const CACHE_TS_KEY = 'csboard_resolved_origin_at';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 6000;

export const SITE_BASE = DOMAINS.com;
export const SITE_NAME = 'CSBOARD';

let resolvedOrigin: string | null = null;
let inflightResolve: Promise<string> | null = null;

async function probeNoRedirect(origin: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(`${origin}${PROBE_PATH}`, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function readCachedOrigin(): Promise<string | null> {
  try {
    const data = await chrome.storage.local.get([CACHE_KEY, CACHE_TS_KEY]);
    const origin = data[CACHE_KEY] as string | undefined;
    const ts = data[CACHE_TS_KEY] as number | undefined;
    if (!origin || !ts) return null;
    if (Date.now() - ts > CACHE_TTL_MS) return null;
    if (origin !== DOMAINS.com && origin !== DOMAINS.trade) return null;
    return origin;
  } catch {
    return null;
  }
}

async function writeCachedOrigin(origin: string): Promise<void> {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: origin,
      [CACHE_TS_KEY]: Date.now(),
    });
  } catch {
    // ignore — we'll re-probe next call
  }
}

async function resolveOrigin(): Promise<string> {
  if (resolvedOrigin) return resolvedOrigin;
  if (inflightResolve) return inflightResolve;

  inflightResolve = (async () => {
    const cached = await readCachedOrigin();
    if (cached) {
      resolvedOrigin = cached;
      return cached;
    }

    const [comOk, tradeOk] = await Promise.all([
      probeNoRedirect(DOMAINS.com),
      probeNoRedirect(DOMAINS.trade),
    ]);

    let chosen: string;
    if (comOk) chosen = DOMAINS.com;
    else if (tradeOk) chosen = DOMAINS.trade;
    else chosen = DOMAINS.com;

    resolvedOrigin = chosen;
    await writeCachedOrigin(chosen);
    return chosen;
  })();

  try {
    return await inflightResolve;
  } finally {
    inflightResolve = null;
  }
}

/** Returns the API base for the current user (e.g. "https://csboard.com/api"). */
export async function getApiBase(): Promise<string> {
  return `${await resolveOrigin()}/api`;
}

/** Force a re-probe (e.g. after suspected network change). */
export async function invalidateOriginCache(): Promise<void> {
  resolvedOrigin = null;
  try {
    await chrome.storage.local.remove([CACHE_KEY, CACHE_TS_KEY]);
  } catch {
    // ignore
  }
}
