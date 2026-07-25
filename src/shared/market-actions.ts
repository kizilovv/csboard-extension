// ============================================================
// CSBOARD — Steam Market Write Actions
// ============================================================
// The only two state-changing calls we make on Steam's market:
//   POST /market/sellitem/            list an asset
//   POST /market/removelisting/<id>   pull a listing
// (Buy orders already have a per-row cancel in Steam's own UI — no reason to
// duplicate it and own the blast radius.)
//
// Two things are non-negotiable in here:
//
// 1. `price` on sellitem is what the SELLER RECEIVES, not what the buyer pays.
//    Sending the buyer-pays figure lists ~15% high and the item never sells;
//    that is why every call takes a target through computeSellTarget() rather
//    than a raw number.
//
// 2. Listing still needs the user's Steam Guard confirmation. Nothing here
//    bypasses it, and the UI must not claim otherwise — `requiresConfirmation`
//    is surfaced verbatim so the caller can say so.
//
// Every call is user-click-initiated. No timers, no background loops: that is
// both a Web Store policy line and the thing that keeps this off Valve's
// radar.

import { type Result, Ok, Fail } from './result';
import { createLogger } from './logger';
import type { CSBoardError } from './types';
import {
  buyerPaysForReceived,
  receivedForBuyerPays,
  type FeeSplit,
  type WalletFeeInfo,
} from './steam-fees';
import type { OrderBook } from './market-orders';

const logger = createLogger('market-actions');

/** Minimum gap between two write calls — mass sell rides this. */
const MIN_WRITE_GAP_MS = 1500;
const WRITE_TIMEOUT_MS = 15_000;
/** Steam refuses listings under 3 minor units on the buyer side. */
const MIN_BUYER_PRICE = 3;

// --- Session ---

/**
 * Steam's CSRF token. The `sessionid` cookie is not httpOnly, so the content
 * script can read it directly — no page injection needed.
 */
export function getSessionId(): string | null {
  const match = /(?:^|;\s*)sessionid=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

// --- Sell target computation ---

export type SellMode = 'quick' | 'instant';

export interface SellTarget {
  readonly mode: SellMode;
  /** What the buyer will pay, minor units. */
  readonly buyerPays: number;
  /** Fee split — `received` is what goes to sellitem. */
  readonly split: FeeSplit;
  /** Human reason the price landed where it did (shown on hover). */
  readonly basis: string;
}

/**
 * Turn an order book into an actual price.
 *
 * quick   — undercut the cheapest listing by one minor unit. Sells soon, not now.
 * instant — meet the highest standing buy order. Fills the moment Steam matches.
 *
 * Returns null when the book cannot support the mode (nothing listed / nobody
 * bidding / the price would fall under Steam's floor). Callers must render a
 * disabled button in that case rather than inventing a price.
 */
export function computeSellTarget(
  mode: SellMode,
  book: OrderBook,
  wallet: WalletFeeInfo,
): SellTarget | null {
  let buyerPays: number | null = null;
  let basis = '';

  if (mode === 'instant') {
    if (book.highestBuyOrder === null) return null;
    buyerPays = book.highestBuyOrder;
    basis = 'meets the highest buy order';
  } else {
    if (book.lowestSellOrder === null) {
      // No listings at all — undercutting nothing is meaningless. If there is a
      // bid, quick sell degrades to it rather than guessing a number.
      if (book.highestBuyOrder === null) return null;
      buyerPays = book.highestBuyOrder;
      basis = 'no listings — falls back to the highest buy order';
    } else {
      buyerPays = book.lowestSellOrder - 1;
      basis = 'undercuts the cheapest listing by 0.01';
    }
  }

  if (buyerPays === null || buyerPays < MIN_BUYER_PRICE) return null;

  const split = receivedForBuyerPays(buyerPays, wallet);
  if (split.received < 1) return null;

  return { mode, buyerPays: split.buyerPays, split, basis };
}

/** Build a target from an explicit "seller receives" figure (manual entry). */
export function sellTargetFromReceived(received: number, wallet: WalletFeeInfo): SellTarget | null {
  const split = buyerPaysForReceived(received, wallet);
  if (split.received < 1 || split.buyerPays < MIN_BUYER_PRICE) return null;
  return { mode: 'quick', buyerPays: split.buyerPays, split, basis: 'manual price' };
}

// --- Write gate ---

let lastWriteAt = 0;
let writeChain: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gatedWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(async () => {
    const wait = lastWriteAt + MIN_WRITE_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastWriteAt = Date.now();
    return fn();
  });
  writeChain = run.catch(() => undefined);
  return run;
}

async function postForm(
  url: string,
  body: URLSearchParams,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WRITE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// --- Sell ---

export interface SellItemRequest {
  readonly appId: string;
  readonly contextId: string;
  readonly assetId: string;
  readonly amount: number;
  /** What the seller receives, minor units — NOT the buyer-pays figure. */
  readonly received: number;
}

export interface SellItemResult {
  readonly assetId: string;
  /** Steam accepted the listing. Confirmation may still be pending. */
  readonly listed: boolean;
  /** The listing waits on Steam Guard before it goes live. */
  readonly requiresConfirmation: boolean;
  readonly needsMobileConfirmation: boolean;
  readonly needsEmailConfirmation: boolean;
}

/**
 * List one asset on the Steam market.
 *
 * Steam answers `success: false` with a human message for most refusals
 * (item on trade hold, market disabled, price too low, missing Guard) — those
 * come back as API_ERROR carrying Steam's own wording, because it is more
 * useful to the user than anything we could invent.
 */
export async function sellItem(
  req: SellItemRequest,
): Promise<Result<SellItemResult, CSBoardError>> {
  const sessionId = getSessionId();
  if (!sessionId) {
    return Fail('No Steam session — reload the page while logged in', 'AUTH_REQUIRED', false);
  }
  if (req.received < 1) {
    return Fail('Price too low for Steam to accept', 'VALIDATION_ERROR', false);
  }

  const body = new URLSearchParams({
    sessionid: sessionId,
    appid: req.appId,
    contextid: req.contextId,
    assetid: req.assetId,
    amount: String(Math.max(1, req.amount)),
    price: String(req.received),
  });

  try {
    const resp = await gatedWrite(() => postForm('https://steamcommunity.com/market/sellitem/', body));

    if (resp.status === 429) {
      return Fail('Steam rate limit (429) — stop and wait before selling more', 'RATE_LIMITED', true);
    }

    const raw = await resp.text();
    let parsed: {
      success?: boolean;
      message?: string;
      requires_confirmation?: number;
      needs_mobile_confirmation?: boolean;
      needs_email_confirmation?: boolean;
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      // Steam serves an HTML error page when the session is dead.
      return Fail(
        resp.ok ? 'Unexpected Steam response (not JSON)' : `Steam HTTP ${resp.status}`,
        resp.ok ? 'API_ERROR' : 'NETWORK_ERROR',
        !resp.ok,
      );
    }

    if (!parsed.success) {
      const message = parsed.message?.trim() || 'Steam refused the listing';
      logger.warn('sellitem refused', { assetId: req.assetId, message });
      return Fail(message, 'API_ERROR', false);
    }

    const result: SellItemResult = {
      assetId: req.assetId,
      listed: true,
      requiresConfirmation: parsed.requires_confirmation === 1,
      needsMobileConfirmation: parsed.needs_mobile_confirmation === true,
      needsEmailConfirmation: parsed.needs_email_confirmation === true,
    };
    logger.info('Listed on Steam market', {
      assetId: req.assetId,
      received: req.received,
      requiresConfirmation: result.requiresConfirmation,
    });
    return Ok(result);
  } catch (err) {
    return Fail(err instanceof Error ? err.message : String(err), 'NETWORK_ERROR', true);
  }
}

// --- Cancel ---

/** Pull one of the user's own listings. */
export async function removeListing(listingId: string): Promise<Result<true, CSBoardError>> {
  const sessionId = getSessionId();
  if (!sessionId) {
    return Fail('No Steam session — reload the page while logged in', 'AUTH_REQUIRED', false);
  }

  const body = new URLSearchParams({ sessionid: sessionId });

  try {
    const resp = await gatedWrite(() =>
      postForm(`https://steamcommunity.com/market/removelisting/${encodeURIComponent(listingId)}`, body),
    );

    if (resp.status === 429) {
      return Fail('Steam rate limit (429) — wait before removing more', 'RATE_LIMITED', true);
    }
    if (!resp.ok) {
      return Fail(`Steam HTTP ${resp.status}`, 'NETWORK_ERROR', resp.status >= 500);
    }
    return Ok(true);
  } catch (err) {
    return Fail(err instanceof Error ? err.message : String(err), 'NETWORK_ERROR', true);
  }
}
