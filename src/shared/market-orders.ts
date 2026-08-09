// ============================================================
// CSBOARD — Steam Market Order Book
// ============================================================
// Everything the sell buttons need comes from ONE Steam endpoint:
//   /market/itemordershistogram?...&item_nameid=<id>
//     → highest_buy_order  = instant sell target (matches immediately)
//     → lowest_sell_order  = quick sell reference (undercut by 1 unit)
//
// The catch: item_nameid is not derivable from the market_hash_name. It only
// exists inside the listing page HTML (`Market_LoadOrderSpread( 176321160 )`),
// so the first lookup for an item costs a full HTML page fetch. Those ids are
// stable forever, so they are cached permanently in chrome.storage.
//
// 429 IS THE DESIGN CONSTRAINT HERE. This account's Steam requests are the
// same bucket the trading stack lives in, and a mass-sell loop is exactly the
// shape that trips it. Hence: one request at a time, a hard minimum gap
// between them, and a global cooldown that fails every caller fast the moment
// Steam answers 429 — never a retry storm.

import { type Result, Ok, Fail } from './result';
import { createLogger } from './logger';
import type { CSBoardError, ErrorCode } from './types';
import type { WalletFeeInfo } from './steam-fees';

const logger = createLogger('market-orders');

// --- Tunables ---

/** Minimum gap between any two Steam market requests, per browser tab. */
const MIN_REQUEST_GAP_MS = 1200;
/** How long a fetched order book stays fresh. Prices move, but not per-click. */
const ORDER_BOOK_TTL_MS = 3 * 60 * 1000;
/** Cooldown after a 429 — long enough that we stop being the problem. */
const RATE_LIMIT_COOLDOWN_MS = 90 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;

const NAMEID_CACHE_KEY = 'csboard_market_nameids';

/** Stable status mapping so batch orchestration can stop on auth/429. */
export function classifyMarketReadHttpStatus(status: number): ErrorCode | null {
  if (status === 401 || status === 403) return 'AUTH_EXPIRED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'NETWORK_ERROR';
  if (status >= 400) return 'API_ERROR';
  return null;
}

function isSteamLoginRedirect(resp: Response): boolean {
  return /steamcommunity\.com\/(?:login|openid)(?:\/|\?|$)/i.test(resp.url);
}

function looksLikeSteamLoginHtml(raw: string): boolean {
  return /(?:id=["']login_form["']|g_steamID\s*=\s*(?:false|["']{2})|Sign In[^<]{0,30}Steam)/i.test(raw);
}

// --- Types ---

export interface OrderBook {
  readonly marketHashName: string;
  readonly itemNameId: string;
  /**
   * Highest standing buy order, in wallet minor units, on the BUYER-PAYS
   * basis Steam reports. Listing at this price fills instantly.
   * null = nobody is bidding.
   */
  readonly highestBuyOrder: number | null;
  /** Cheapest active listing, buyer-pays basis. null = nothing listed. */
  readonly lowestSellOrder: number | null;
  /** Number of standing buy orders at the top of book, when Steam reports it. */
  readonly buyOrderCount: number | null;
  readonly fetchedAt: number;
}

// --- Request gate (serialised + rate-limit aware) ---

let lastRequestAt = 0;
let cooldownUntil = 0;
let chain: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True while we are backing off from a Steam 429. */
export function isRateLimited(): boolean {
  return Date.now() < cooldownUntil;
}

/** Seconds left on the current cooldown (0 when clear). */
export function rateLimitSecondsLeft(): number {
  return Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
}

function enterCooldown(): void {
  cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  logger.warn('Steam rate-limited us — pausing market requests', {
    seconds: Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000),
  });
}

/**
 * Run `fn` as the only in-flight Steam market request, no sooner than
 * MIN_REQUEST_GAP_MS after the previous one. Every Steam call in this module
 * goes through here — that is the whole 429 defence.
 */
async function gated<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive even when this link rejects.
  chain = run.catch(() => undefined);
  return run;
}

async function fetchWithTimeout(url: string, accept: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: accept },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// --- item_nameid resolution ---

const nameIdMemo = new Map<string, string>();

async function readNameIdCache(): Promise<Record<string, string>> {
  try {
    const data = await chrome.storage.local.get(NAMEID_CACHE_KEY);
    return (data[NAMEID_CACHE_KEY] as Record<string, string> | undefined) ?? {};
  } catch {
    return {};
  }
}

async function writeNameId(marketHashName: string, id: string): Promise<void> {
  try {
    const cache = await readNameIdCache();
    cache[marketHashName] = id;
    await chrome.storage.local.set({ [NAMEID_CACHE_KEY]: cache });
  } catch {
    // memo still holds it for this page
  }
}

/**
 * Seed the cache with an id we already have.
 *
 * The listing page embeds its own `Market_LoadOrderSpread( <id> )`, so a script
 * running there can hand it over instead of making us re-fetch the very page
 * the user is looking at. Every avoided HTML fetch is 429 budget saved.
 */
export function primeItemNameId(marketHashName: string, id: string): void {
  if (!marketHashName || marketHashName.length > 512 || !/^\d{1,20}$/.test(id)) return;
  nameIdMemo.set(marketHashName, id);
  void writeNameId(marketHashName, id);
}

/**
 * Resolve Steam's internal item_nameid for a market_hash_name.
 * Cheap after the first hit (memo → storage); costs one listing-page HTML
 * fetch otherwise.
 */
export async function resolveItemNameId(
  marketHashName: string,
): Promise<Result<string, CSBoardError>> {
  if (!marketHashName || marketHashName.length > 512 || marketHashName === '__proto__') {
    return Fail('Invalid Steam market name', 'VALIDATION_ERROR', false);
  }
  const memo = nameIdMemo.get(marketHashName);
  if (memo) return Ok(memo);

  const cache = await readNameIdCache();
  const cached = cache[marketHashName];
  if (typeof cached === 'string' && /^\d{1,20}$/.test(cached)) {
    nameIdMemo.set(marketHashName, cached);
    return Ok(cached);
  }

  if (isRateLimited()) {
    return Fail(`Steam rate limit — retry in ${rateLimitSecondsLeft()}s`, 'RATE_LIMITED', true);
  }

  const url = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(marketHashName)}`;

  try {
    const resp = await gated(() => fetchWithTimeout(url, 'text/html'));

    const httpError = classifyMarketReadHttpStatus(resp.status);
    if (httpError === 'RATE_LIMITED') {
      enterCooldown();
      return Fail('Steam rate limit (429) on listing page', 'RATE_LIMITED', true);
    }
    if (httpError === 'AUTH_EXPIRED' || isSteamLoginRedirect(resp)) {
      return Fail('Steam session expired while loading market prices', 'AUTH_EXPIRED', false);
    }
    if (!resp.ok) {
      return Fail(
        `Listing page HTTP ${resp.status}`,
        httpError ?? 'NETWORK_ERROR',
        httpError === 'NETWORK_ERROR',
      );
    }

    const html = await resp.text();
    if (looksLikeSteamLoginHtml(html)) {
      return Fail('Steam session expired while loading market prices', 'AUTH_EXPIRED', false);
    }
    const match = /Market_LoadOrderSpread\(\s*(\d+)\s*\)/.exec(html);
    const id = match?.[1];
    if (!id || !/^\d{1,20}$/.test(id)) {
      // No order spread on the page = item has never been marketable here.
      return Fail('No order book for this item', 'STEAM_DOM_ERROR', false);
    }

    nameIdMemo.set(marketHashName, id);
    await writeNameId(marketHashName, id);
    logger.debug('Resolved item_nameid', { marketHashName, id });
    return Ok(id);
  } catch (err) {
    return Fail(err instanceof Error ? err.message : String(err), 'NETWORK_ERROR', true);
  }
}

// --- Order book ---

const bookCache = new Map<string, OrderBook>();

function parseMinorUnits(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Read a cached order book without touching the network. */
export function getCachedOrderBook(marketHashName: string): OrderBook | null {
  const hit = bookCache.get(marketHashName);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > ORDER_BOOK_TTL_MS) return null;
  return hit;
}

/**
 * Fetch the live order book for an item. Serves a cached copy inside the TTL
 * so a click on an already-priced button costs nothing.
 */
export async function getOrderBook(
  marketHashName: string,
  wallet: WalletFeeInfo,
  options: { force?: boolean } = {},
): Promise<Result<OrderBook, CSBoardError>> {
  if (!options.force) {
    const cached = getCachedOrderBook(marketHashName);
    if (cached) return Ok(cached);
  }

  if (isRateLimited()) {
    return Fail(`Steam rate limit — retry in ${rateLimitSecondsLeft()}s`, 'RATE_LIMITED', true);
  }

  const idResult = await resolveItemNameId(marketHashName);
  if (!idResult.ok) return idResult;
  const itemNameId = idResult.value;

  const params = new URLSearchParams({
    country: wallet.country,
    language: 'english',
    currency: String(wallet.currencyId),
    item_nameid: itemNameId,
    two_factor: '0',
  });
  const url = `https://steamcommunity.com/market/itemordershistogram?${params.toString()}`;

  try {
    const resp = await gated(() => fetchWithTimeout(url, 'application/json'));

    const httpError = classifyMarketReadHttpStatus(resp.status);
    if (httpError === 'RATE_LIMITED') {
      enterCooldown();
      return Fail('Steam rate limit (429) on order book', 'RATE_LIMITED', true);
    }
    if (httpError === 'AUTH_EXPIRED' || isSteamLoginRedirect(resp)) {
      return Fail('Steam session expired while loading the order book', 'AUTH_EXPIRED', false);
    }
    if (!resp.ok) {
      return Fail(
        `Order book HTTP ${resp.status}`,
        httpError ?? 'NETWORK_ERROR',
        httpError === 'NETWORK_ERROR',
      );
    }

    const raw = await resp.text();
    if (looksLikeSteamLoginHtml(raw)) {
      return Fail('Steam session expired while loading the order book', 'AUTH_EXPIRED', false);
    }

    let body: {
      success?: number;
      highest_buy_order?: string | null;
      lowest_sell_order?: string | null;
      buy_order_graph?: Array<[number, number, string]>;
    };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return Fail('Steam returned an invalid order book response', 'API_ERROR', true);
    }

    if (body.success !== 1) {
      return Fail('Steam returned an empty order book', 'API_ERROR', true);
    }

    const topBuyRow = body.buy_order_graph?.[0];

    const book: OrderBook = {
      marketHashName,
      itemNameId,
      highestBuyOrder: parseMinorUnits(body.highest_buy_order),
      lowestSellOrder: parseMinorUnits(body.lowest_sell_order),
      buyOrderCount: topBuyRow ? topBuyRow[1] : null,
      fetchedAt: Date.now(),
    };

    bookCache.set(marketHashName, book);
    return Ok(book);
  } catch (err) {
    return Fail(err instanceof Error ? err.message : String(err), 'NETWORK_ERROR', true);
  }
}

/** Drop all cached order books (used when the user forces a refresh). */
export function clearOrderBookCache(): void {
  bookCache.clear();
}
