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
import { injectScript } from './inject';
import type { CSBoardError, ErrorCode } from './types';
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
/** A confirmed batch capability must not survive an abandoned tab forever. */
const SELL_AUTHORIZATION_TTL_MS = 30 * 60 * 1000;
export const MAX_SELL_BATCH_SIZE = 20;

// --- Session ---

/**
 * Steam's CSRF token. The `sessionid` cookie is not httpOnly, so the content
 * script can read it directly — no page injection needed.
 */
export function getSessionId(): string | null {
  const match = /(?:^|;\s*)sessionid=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * Read the account Steam says is currently logged in. The value is read from
 * page context immediately before every write, then compared with the account
 * bound to the user's original click. A profile/navigation switch therefore
 * cannot make a reviewed batch sell from another account.
 */
export function getCurrentSteamAccountId(): string | null {
  if (typeof document === 'undefined' || !document.body) return null;
  const attribute = 'csboardCurrentSteamAccount';
  document.body.removeAttribute(attribute);
  const script = `
    try {
      var id = typeof g_steamID !== 'undefined' && g_steamID ? String(g_steamID) : '';
      document.body.setAttribute('${attribute}', id);
    } catch (e) {
      document.body.setAttribute('${attribute}', '');
    }
  `;
  const value = injectScript(script, true, 'csboardCurrentSteamAccount', attribute) ?? '';
  return /^\d{16,20}$/.test(value) ? value : null;
}

// --- Own-inventory + explicit user-gesture gate ---

export interface SellInventoryItem {
  readonly appid?: string | number;
  readonly contextid?: string | number;
  readonly assetid?: string;
  readonly amount?: string | number;
  readonly market_hash_name?: string;
  readonly marketable?: boolean | number;
  readonly tradable?: boolean | number;
  readonly tradabilityShort?: string;
  readonly owner?: string;
  readonly floatValue?: number | null;
  readonly paintSeed?: number | null;
  readonly dopplerPhase?: string | null;
  readonly patternInfo?: unknown;
  readonly stickerTotal?: number;
  readonly type?: string | { readonly key?: string };
}

/**
 * The write surface is intentionally narrower than the inventory reader.
 * Only one owned, live-context CS2 asset may cross into /market/sellitem/.
 */
export function getSellBlockReason(
  item: SellInventoryItem | null | undefined,
  loggedInSteamId: string | null,
  walletFromPage: boolean,
): string | null {
  if (!item) return 'Item data not loaded yet';
  if (!loggedInSteamId) return 'Sign in to Steam before selling';
  if (!walletFromPage) return 'Steam wallet currency unavailable — selling disabled';
  if (String(item.appid ?? '') !== '730') return 'Only CS2 inventory items can be sold here';
  if (!item.assetid || !/^\d{1,20}$/.test(item.assetid)) return 'Invalid Steam asset id';
  if (!item.market_hash_name || item.market_hash_name.length > 512) {
    return 'No valid market name for this item';
  }
  if (String(item.contextid ?? '') === '16') return 'Trade-protected — cannot be listed yet';
  if (String(item.contextid ?? '') !== '2') return 'Only the live CS2 inventory can be sold';
  if (item.owner !== loggedInSteamId) return 'Open your own Steam inventory to sell';
  if (item.marketable !== true && item.marketable !== 1) {
    return 'Steam marks this item as not marketable';
  }
  if (item.tradabilityShort) return `On trade hold (${item.tradabilityShort})`;
  if (item.tradable !== true && item.tradable !== 1) return 'Item is currently trade-protected';
  if (item.amount !== undefined && Number(item.amount) !== 1) {
    return 'Only one CS2 asset can be listed per action';
  }
  return null;
}

/**
 * Steam's name-level order book ignores individual float/pattern/sticker
 * premium. These assets receive an explicit warning before confirmation.
 */
export function hasIndividualPremiumRisk(item: SellInventoryItem): boolean {
  const name = item.market_hash_name ?? '';
  const typeKey = typeof item.type === 'string' ? item.type : item.type?.key ?? '';
  const isKnifeOrGlove =
    name.startsWith('★') ||
    /(?:gloves|hand wraps)/i.test(name) ||
    /(?:knife|glove)/i.test(typeKey);
  return Boolean(
    isKnifeOrGlove ||
    item.dopplerPhase ||
    item.patternInfo ||
    (item.stickerTotal ?? 0) > 0,
  );
}

declare const sellAuthorizationBrand: unique symbol;

/** Opaque, in-memory proof that a trusted browser click approved these assets. */
export interface MarketWriteAuthorization {
  readonly [sellAuthorizationBrand]: true;
}

interface SellAuthorizationRecord {
  readonly expectedSteamId: string;
  readonly remainingAssetIds: Set<string>;
  readonly expiresAt: number;
}

const sellAuthorizations = new WeakMap<MarketWriteAuthorization, SellAuthorizationRecord>();

declare const listingRemovalAuthorizationBrand: unique symbol;

export interface ListingRemovalAuthorization {
  readonly [listingRemovalAuthorizationBrand]: true;
}

interface ListingRemovalAuthorizationRecord {
  readonly expectedSteamId: string;
  readonly remainingListingIds: Set<string>;
  readonly expiresAt: number;
}

const listingRemovalAuthorizations = new WeakMap<
  ListingRemovalAuthorization,
  ListingRemovalAuthorizationRecord
>();

function isTrustedUserGesture(event: Event): boolean {
  return event.isTrusted &&
    (typeof navigator === 'undefined' ||
      navigator.userActivation === undefined ||
      navigator.userActivation.isActive);
}

/**
 * Mint an unforgeable, one-use-per-asset capability from a real user gesture.
 * Synthetic page clicks have isTrusted=false, and the opaque object only
 * exists in the extension's isolated world.
 */
export function authorizeSellFromUserGesture(
  event: Event,
  assetIds: readonly string[],
  expectedSteamId: string,
): Result<MarketWriteAuthorization, CSBoardError> {
  if (!isTrustedUserGesture(event)) {
    return Fail(
      'Selling requires a direct click from you',
      'VALIDATION_ERROR',
      false,
      { stopBatch: 'user_gesture' },
    );
  }
  if (!/^\d{16,20}$/.test(expectedSteamId)) {
    return Fail(
      'Cannot verify the active Steam account',
      'AUTH_REQUIRED',
      false,
      { stopBatch: 'authentication' },
    );
  }

  const uniqueAssetIds = new Set(assetIds);
  if (
    uniqueAssetIds.size === 0 ||
    uniqueAssetIds.size > MAX_SELL_BATCH_SIZE ||
    [...uniqueAssetIds].some((assetId) => !/^\d{1,20}$/.test(assetId))
  ) {
    return Fail('Invalid sell selection', 'VALIDATION_ERROR', false);
  }

  const authorization = Object.freeze({}) as MarketWriteAuthorization;
  sellAuthorizations.set(authorization, {
    expectedSteamId,
    remainingAssetIds: uniqueAssetIds,
    expiresAt: Date.now() + SELL_AUTHORIZATION_TTL_MS,
  });
  return Ok(authorization);
}

/** User-gesture capability for removing only the reviewed listing ids. */
export function authorizeListingRemovalFromUserGesture(
  event: Event,
  listingIds: readonly string[],
  expectedSteamId: string,
): Result<ListingRemovalAuthorization, CSBoardError> {
  if (!isTrustedUserGesture(event)) {
    return Fail(
      'Removing listings requires a direct click from you',
      'VALIDATION_ERROR',
      false,
      { stopBatch: 'user_gesture' },
    );
  }
  if (!/^\d{16,20}$/.test(expectedSteamId)) {
    return Fail('Cannot verify the active Steam account', 'AUTH_REQUIRED', false);
  }
  const remainingListingIds = new Set(listingIds);
  if (
    remainingListingIds.size === 0 ||
    remainingListingIds.size > 100 ||
    [...remainingListingIds].some((listingId) => !/^\d{1,20}$/.test(listingId))
  ) {
    return Fail('Invalid listing removal selection', 'VALIDATION_ERROR', false);
  }

  const authorization = Object.freeze({}) as ListingRemovalAuthorization;
  listingRemovalAuthorizations.set(authorization, {
    expectedSteamId,
    remainingListingIds,
    expiresAt: Date.now() + SELL_AUTHORIZATION_TTL_MS,
  });
  return Ok(authorization);
}

function consumeListingRemovalAuthorization(
  authorization: ListingRemovalAuthorization,
  listingId: string,
): Result<true, CSBoardError> {
  const record = listingRemovalAuthorizations.get(authorization);
  if (!record || record.expiresAt < Date.now() || !record.remainingListingIds.has(listingId)) {
    return Fail(
      'Listing removal approval expired — review again',
      'VALIDATION_ERROR',
      false,
      { stopBatch: 'user_gesture' },
    );
  }
  const currentSteamId = getCurrentSteamAccountId();
  if (!currentSteamId) {
    return Fail('Steam session is no longer signed in', 'AUTH_REQUIRED', false);
  }
  if (currentSteamId !== record.expectedSteamId) {
    return Fail(
      'Steam account changed after review — no listing was removed',
      'AUTH_EXPIRED',
      false,
      { stopBatch: 'account_mismatch' },
    );
  }
  record.remainingListingIds.delete(listingId);
  return Ok(true);
}

function consumeSellAuthorization(
  authorization: MarketWriteAuthorization,
  assetId: string,
  currentSteamId: string | null,
): Result<true, CSBoardError> {
  const record = sellAuthorizations.get(authorization);
  if (!record || record.expiresAt < Date.now() || !record.remainingAssetIds.has(assetId)) {
    return Fail(
      'Sell approval expired — review and confirm again',
      'VALIDATION_ERROR',
      false,
      { stopBatch: 'user_gesture' },
    );
  }
  if (!currentSteamId) {
    return Fail(
      'Steam session is no longer signed in',
      'AUTH_REQUIRED',
      false,
      { stopBatch: 'authentication' },
    );
  }
  if (currentSteamId !== record.expectedSteamId) {
    return Fail(
      'Steam account changed after review — nothing was listed',
      'AUTH_EXPIRED',
      false,
      { stopBatch: 'account_mismatch' },
    );
  }

  record.remainingAssetIds.delete(assetId);
  return Ok(true);
}

// --- Sell target computation ---

export type SellMode = 'sell' | 'quick' | 'instant';
export type OrderBookSellMode = Exclude<SellMode, 'sell'>;

export interface SellTarget {
  readonly mode: SellMode;
  /** What the buyer will pay, minor units. */
  readonly buyerPays: number;
  /** Fee split — `received` is what goes to sellitem. */
  readonly split: FeeSplit;
  /** Human reason the price landed where it did (shown on hover). */
  readonly basis: string;
  /** Source order-book timestamp for local, sanitized review diagnostics. */
  readonly bookFetchedAt: number | null;
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
  mode: OrderBookSellMode,
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
    if (book.lowestSellOrder === null) return null;
    buyerPays = book.lowestSellOrder - 1;
    basis = 'undercuts the cheapest listing by one wallet minor unit';
  }

  if (
    buyerPays === null ||
    !Number.isSafeInteger(buyerPays) ||
    buyerPays < MIN_BUYER_PRICE
  ) return null;

  const split = receivedForBuyerPays(buyerPays, wallet);
  if (split.received < 1) return null;

  return { mode, buyerPays: split.buyerPays, split, basis, bookFetchedAt: book.fetchedAt };
}

/** Build a target from an explicit "seller receives" figure (manual entry). */
export function sellTargetFromReceived(received: number, wallet: WalletFeeInfo): SellTarget | null {
  if (!Number.isSafeInteger(received)) return null;
  const split = buyerPaysForReceived(received, wallet);
  if (split.received < 1 || split.buyerPays < MIN_BUYER_PRICE) return null;
  return {
    mode: 'sell',
    buyerPays: split.buyerPays,
    split,
    basis: 'editable price',
    bookFetchedAt: null,
  };
}

/** Parse a user-entered wallet amount into integer minor units. */
export function parseReceivedAmount(input: string): number | null {
  const normalized = input.trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const minorUnits = Math.round(amount * 100);
  return Number.isSafeInteger(minorUnits) && minorUnits > 0 ? minorUnits : null;
}

export interface SellReviewTotals {
  readonly itemCount: number;
  readonly received: number;
  readonly steamFee: number;
  readonly publisherFee: number;
  readonly fees: number;
  readonly buyerPays: number;
}

/** Exact, integer-only fee totals shown before any batch write. */
export function summarizeSellTargets(targets: readonly SellTarget[]): SellReviewTotals {
  return targets.reduce<SellReviewTotals>(
    (total, target) => ({
      itemCount: total.itemCount + 1,
      received: total.received + target.split.received,
      steamFee: total.steamFee + target.split.steamFee,
      publisherFee: total.publisherFee + target.split.publisherFee,
      fees: total.fees + target.split.fees,
      buyerPays: total.buyerPays + target.split.buyerPays,
    }),
    { itemCount: 0, received: 0, steamFee: 0, publisherFee: 0, fees: 0, buyerPays: 0 },
  );
}

/** A lower live target is never accepted under an older confirmation. */
export function hasDownwardPriceDrift(reviewed: SellTarget, current: SellTarget): boolean {
  return current.buyerPays < reviewed.buyerPays || current.split.received < reviewed.split.received;
}

export type SellConfirmationStatus =
  | 'listed_live'
  | 'pending_mobile_confirmation'
  | 'pending_email_confirmation'
  | 'pending_confirmation';

export interface SteamSellConfirmationFields {
  readonly requires_confirmation?: boolean | number | string;
  readonly needs_mobile_confirmation?: boolean;
  readonly needs_email_confirmation?: boolean;
}

export function classifySellConfirmation(
  fields: SteamSellConfirmationFields,
): SellConfirmationStatus {
  if (fields.needs_mobile_confirmation === true) return 'pending_mobile_confirmation';
  if (fields.needs_email_confirmation === true) return 'pending_email_confirmation';
  const raw = fields.requires_confirmation;
  if (raw === true || raw === 1 || raw === '1') return 'pending_confirmation';
  return 'listed_live';
}

export type BatchSellStopReason =
  | 'rate_limited'
  | 'authentication'
  | 'account_mismatch'
  | 'downward_price_drift'
  | 'user_stopped'
  | 'user_gesture';

export interface BatchSellState {
  readonly phase: 'idle' | 'running' | 'stopped' | 'complete';
  readonly total: number;
  readonly processed: number;
  readonly listedLive: number;
  readonly pendingMobile: number;
  readonly pendingEmail: number;
  readonly pendingOther: number;
  readonly failed: number;
  readonly stopReason: BatchSellStopReason | null;
}

export type BatchSellEvent =
  | { readonly type: 'start'; readonly total: number }
  | { readonly type: 'listed'; readonly status: SellConfirmationStatus }
  | { readonly type: 'failed' }
  | { readonly type: 'stop'; readonly reason: BatchSellStopReason }
  | { readonly type: 'finish' };

export const INITIAL_BATCH_SELL_STATE: BatchSellState = {
  phase: 'idle',
  total: 0,
  processed: 0,
  listedLive: 0,
  pendingMobile: 0,
  pendingEmail: 0,
  pendingOther: 0,
  failed: 0,
  stopReason: null,
};

/** Pure batch reducer used by the UI and exercised without network calls. */
export function reduceBatchSellState(
  state: BatchSellState,
  event: BatchSellEvent,
): BatchSellState {
  if (event.type === 'start') {
    return { ...INITIAL_BATCH_SELL_STATE, phase: 'running', total: Math.max(0, event.total) };
  }
  if (event.type === 'listed') {
    return {
      ...state,
      processed: state.processed + 1,
      listedLive: state.listedLive + (event.status === 'listed_live' ? 1 : 0),
      pendingMobile: state.pendingMobile + (event.status === 'pending_mobile_confirmation' ? 1 : 0),
      pendingEmail: state.pendingEmail + (event.status === 'pending_email_confirmation' ? 1 : 0),
      pendingOther: state.pendingOther + (event.status === 'pending_confirmation' ? 1 : 0),
    };
  }
  if (event.type === 'failed') {
    return { ...state, processed: state.processed + 1, failed: state.failed + 1 };
  }
  if (event.type === 'stop') {
    return { ...state, phase: 'stopped', stopReason: event.reason };
  }
  return { ...state, phase: 'complete' };
}

/** Whether an error invalidates the whole reviewed batch. */
export function batchStopReasonForError(
  error: Pick<CSBoardError, 'code' | 'context'>,
): BatchSellStopReason | null {
  const explicit = error.context?.stopBatch;
  if (explicit === 'account_mismatch') return 'account_mismatch';
  if (explicit === 'user_gesture') return 'user_gesture';
  if (error.code === 'RATE_LIMITED') return 'rate_limited';
  if (error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_EXPIRED') return 'authentication';
  return null;
}

/** Stable classification shared by write response handling and tests. */
export function classifyMarketWriteHttpStatus(status: number): ErrorCode | null {
  if (status === 401 || status === 403) return 'AUTH_EXPIRED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'NETWORK_ERROR';
  if (status >= 400) return 'API_ERROR';
  return null;
}

export function classifyMarketRefusalMessage(message: string): ErrorCode {
  return /(?:must|need to) be logged in|not logged in|session (?:has )?expired|sign in to steam/i.test(message)
    ? 'AUTH_EXPIRED'
    : 'API_ERROR';
}

function looksLikeSteamLoginHtml(raw: string): boolean {
  return /(?:id=["']login_form["']|g_steamID\s*=\s*(?:false|["']{2})|Sign In[^<]{0,30}Steam)/i.test(raw);
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
  /** Opaque proof minted from the user's trusted click/confirmation. */
  readonly authorization: MarketWriteAuthorization;
}

export interface SellItemResult {
  readonly assetId: string;
  /** Steam accepted the listing. Confirmation may still be pending. */
  readonly listed: boolean;
  /** The listing waits on Steam Guard before it goes live. */
  readonly requiresConfirmation: boolean;
  readonly needsMobileConfirmation: boolean;
  readonly needsEmailConfirmation: boolean;
  /** Pending confirmations are not reported as live listings. */
  readonly confirmationStatus: SellConfirmationStatus;
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
  if (
    req.appId !== '730' ||
    req.contextId !== '2' ||
    !/^\d{1,20}$/.test(req.assetId) ||
    req.amount !== 1
  ) {
    return Fail('Invalid CS2 sell request', 'VALIDATION_ERROR', false);
  }
  const sessionId = getSessionId();
  if (!sessionId) {
    return Fail(
      'No Steam session — reload the page while logged in',
      'AUTH_REQUIRED',
      false,
      { stopBatch: 'authentication' },
    );
  }
  if (!Number.isSafeInteger(req.received) || req.received < 1) {
    return Fail('Price too low for Steam to accept', 'VALIDATION_ERROR', false);
  }

  const authorizationResult = consumeSellAuthorization(
    req.authorization,
    req.assetId,
    getCurrentSteamAccountId(),
  );
  if (!authorizationResult.ok) return authorizationResult;

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

    const httpError = classifyMarketWriteHttpStatus(resp.status);
    if (httpError === 'RATE_LIMITED') {
      return Fail(
        'Steam rate limit (429) — stop and wait before selling more',
        'RATE_LIMITED',
        true,
        { stopBatch: 'rate_limited' },
      );
    }
    if (httpError === 'AUTH_EXPIRED') {
      return Fail(
        'Steam session expired — reload before selling again',
        'AUTH_EXPIRED',
        false,
        { stopBatch: 'authentication' },
      );
    }

    const raw = await resp.text();
    let parsed: {
      success?: boolean;
      message?: string;
      requires_confirmation?: boolean | number | string;
      needs_mobile_confirmation?: boolean;
      needs_email_confirmation?: boolean;
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      // Steam serves an HTML error page when the session is dead.
      if (looksLikeSteamLoginHtml(raw)) {
        return Fail(
          'Steam session expired — reload before selling again',
          'AUTH_EXPIRED',
          false,
          { stopBatch: 'authentication' },
        );
      }
      return Fail(
        resp.ok ? 'Unexpected Steam response (not JSON)' : `Steam HTTP ${resp.status}`,
        resp.ok ? 'API_ERROR' : (httpError ?? 'NETWORK_ERROR'),
        httpError === 'NETWORK_ERROR',
      );
    }

    if (!parsed.success) {
      const message = parsed.message?.trim() || 'Steam refused the listing';
      logger.warn('sellitem refused', { assetId: req.assetId, message });
      const refusalCode = classifyMarketRefusalMessage(message);
      return Fail(
        message,
        refusalCode,
        false,
        refusalCode === 'AUTH_EXPIRED' ? { stopBatch: 'authentication' } : undefined,
      );
    }

    const confirmationStatus = classifySellConfirmation(parsed);
    const requiresConfirmation = confirmationStatus !== 'listed_live';

    const result: SellItemResult = {
      assetId: req.assetId,
      listed: true,
      requiresConfirmation,
      needsMobileConfirmation: parsed.needs_mobile_confirmation === true,
      needsEmailConfirmation: parsed.needs_email_confirmation === true,
      confirmationStatus,
    };
    logger.info('Listed on Steam market', {
      assetId: req.assetId,
      received: req.received,
      confirmationStatus: result.confirmationStatus,
    });
    return Ok(result);
  } catch (err) {
    return Fail(err instanceof Error ? err.message : String(err), 'NETWORK_ERROR', true);
  }
}

// --- Cancel ---

/** Pull one of the user's own listings. */
export async function removeListing(
  listingId: string,
  authorization: ListingRemovalAuthorization,
): Promise<Result<true, CSBoardError>> {
  if (!/^\d{1,20}$/.test(listingId)) {
    return Fail('Invalid Steam listing id', 'VALIDATION_ERROR', false);
  }
  const sessionId = getSessionId();
  if (!sessionId) {
    return Fail('No Steam session — reload the page while logged in', 'AUTH_REQUIRED', false);
  }

  const authorizationResult = consumeListingRemovalAuthorization(authorization, listingId);
  if (!authorizationResult.ok) return authorizationResult;

  const body = new URLSearchParams({ sessionid: sessionId });

  try {
    const resp = await gatedWrite(() =>
      postForm(`https://steamcommunity.com/market/removelisting/${encodeURIComponent(listingId)}`, body),
    );

    const httpError = classifyMarketWriteHttpStatus(resp.status);
    if (httpError === 'RATE_LIMITED') {
      return Fail('Steam rate limit (429) — wait before removing more', 'RATE_LIMITED', true);
    }
    if (httpError === 'AUTH_EXPIRED') {
      return Fail('Steam session expired — reload before changing listings', 'AUTH_EXPIRED', false);
    }
    if (!resp.ok) {
      return Fail(`Steam HTTP ${resp.status}`, httpError ?? 'NETWORK_ERROR', httpError === 'NETWORK_ERROR');
    }

    const raw = await resp.text();
    if (looksLikeSteamLoginHtml(raw)) {
      return Fail('Steam session expired — reload before changing listings', 'AUTH_EXPIRED', false);
    }
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as { success?: boolean | number; message?: string };
        if (parsed.success === false || parsed.success === 0) {
          const message = parsed.message?.trim() || 'Steam refused to remove the listing';
          const code = classifyMarketRefusalMessage(message);
          return Fail(message, code, false);
        }
      } catch {
        return Fail('Steam returned an invalid remove-listing response', 'API_ERROR', true);
      }
    }
    return Ok(true);
  } catch (err) {
    return Fail(err instanceof Error ? err.message : String(err), 'NETWORK_ERROR', true);
  }
}
