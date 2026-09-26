/*
  Watches the trades this browser sent, and tells csboard what Steam says.

  ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────

  Steam does not tell US what happened to an offer between two other people,
  and no public API will. The seller's own session can see it. So the phone app
  already reports offer states back (`reportTradeStatus` in the app), which is
  precisely why a sale delivered from the phone completes and a sale delivered
  from a browser used to sit there untouched — the extension sent the trade and
  then stopped looking.

  ── WHAT IT REPORTS, AND WHAT IT DOES NOT DECIDE ──────────────────────────

  Steam's raw `trade_offer_state`, passed through untranslated, plus the escrow
  end date when the offer carries one. Both go to the same endpoint the app
  uses. Nothing here decides that a sale is complete: a client saying "accepted"
  is a claim by an interested party, and the money still moves on our own
  verification of what landed in the buyer's inventory. Sending the escrow date
  matters for a different reason — without it the server falls back to a
  conservative eight-day hold and the seller waits days longer than he must for
  money that is already his.

  ── PACE ──────────────────────────────────────────────────────────────────

  A Chrome alarm, not a timer: MV3 suspends the service worker between events
  and a `setInterval` dies with it. Three minutes is chosen against what it
  costs — one Steam read and one small POST per pending sale — and against what
  it buys: a seller who confirmed on his phone sees the site catch up while he
  is still looking at it.
*/

import { getApiBase } from '../shared/config';
import { describeError } from '../shared/gateway-dto';
import { createLogger } from '../shared/logger';

const logger = createLogger('p2p-tracker');

export const P2P_TRACK_ALARM = 'csboard-p2p-track' as const;

/*
  How often to look, decided by what there is to see.

  Three minutes everywhere was the owner's objection, and he is right: a sale in
  Steam's seven-day hold does not change for days, and asking Steam about it
  every three minutes for a week is a lot of requests to learn nothing. But the
  same sale becomes urgent twice — right after the offer goes out, when the
  buyer may accept at any second, and again as the hold runs out, which is the
  moment a reversal either happened or did not.

  So the pass picks its own next interval:

    FAST   an offer is out and not yet settled, or a hold ends within the hour.
    SLOW   everything we are watching is parked in a hold with time to run.

  Chrome replaces a same-named alarm, so re-creating it at the end of each pass
  is how the period follows the work.
*/
export const TRACK_PERIOD_FAST_MINUTES = 3;
const TRACK_PERIOD_SLOW_MINUTES = 60;
/** How close to a hold's end counts as "about to matter". */
const HOLD_ENDING_SOON_MS = 60 * 60_000;

/** Kept as the catch-up's rate limit: never re-run faster than the fast pass. */
const TRACK_PERIOD_MINUTES = TRACK_PERIOD_FAST_MINUTES;

/** A sale this browser is responsible for watching. */
interface PendingSale {
  orderId: string;
  steamTradeOfferId: string;
  /** The asset the seller handed over — how a history row is matched to a sale. */
  assetId: string | null;
  /** When this sale's hold releases, if it is in one. Drives the pace. */
  holdUntil: number | null;
}

/** One sent offer as the service worker reads it for this tracker. */
export interface TrackedOffer {
  offerId: string;
  state: number;
  escrowEndAt?: number;
  /** Steam's `time_updated`, seconds: when the offer reached `state`. */
  updatedAt?: number;
  /** Assets the offer hands over; how an offer sent outside csboard is matched to a sale. */
  givenAssetIds?: readonly string[];
  /** The other party as a SteamID64. */
  partnerSteamId?: string;
}

/**
 * A purchase this browser's owner is waiting for. Watched from the BUYER's
 * side: his trade history lists the skin among the assets he received, which
 * proves the delivery when the seller's browser is closed — the ordinary way
 * a delivered sale goes silent. csfloat pings from both sides; so does this.
 */
interface PendingPurchase {
  orderId: string;
  /** The seller's asset id, which Steam keeps on the received item. */
  assetId: string;
}

/** A sale the seller accepted but has not sent through csboard (yet). */
interface UnsentSale {
  orderId: string;
  assetId: string;
  buyerSteamId: string;
}

/** What one pass did and where it failed, for the heartbeat. */
export interface TrackOutcome {
  watched: { sales: number; purchases: number; unsent: number };
  errors: { offers?: string; history?: string };
}

/** One completed trade as Steam's history reports it. */
export interface HistoryTrade {
  tradeId: string;
  status: number;
  givenAssetIds: string[];
  receivedAssetIds: string[];
  partnerSteamId: string;
  /** Steam's `time_init`, seconds. The tiebreaker — see the matching below. */
  occurredAt: number;
}

/*
  Sales that still have somewhere to go.

  `/p2p/my/sales?scope=delivery` is the seller's own delivery queue, so this
  asks for exactly the orders that are still in flight rather than pulling a
  history. An order with no offer id has not been sent yet — there is nothing to
  watch, and the send path will report it when it happens.
*/
async function readPendingSales(): Promise<PendingSale[]> {
  const base = await getApiBase();
  let response: Response;
  try {
    /*
      `watch`, not `delivery`.

      The delivery queue ends the moment the trade is sent, which is precisely
      where watching has to start: the skin then sits in Steam's seven-day hold
      and the seller can still reverse it out. Polling the delivery queue would
      have meant watching only the window where there is nothing yet to see.
    */
    response = await fetch(`${base}/p2p/my/sales?scope=watch`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return [];
  }
  // 401 is the ordinary case for a browser whose owner is not signed in to
  // csboard right now. Silent: this runs on a timer, and a logged-out browser
  // is not a fault to report.
  if (!response.ok) return [];

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  const rows = Array.isArray(body) ? body : (body as { sales?: unknown })?.sales;
  if (!Array.isArray(rows)) return [];

  const pending: PendingSale[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const orderId = row['orderId'];
    const offerId = row['steamTradeOfferId'];
    if (typeof orderId === 'string' && typeof offerId === 'string' && offerId.length > 0) {
      const asset = row['assetIdToGive'] ?? row['assetId'];
      const hold = row['holdUntil'];
      const holdMs = typeof hold === 'string' ? Date.parse(hold) : NaN;
      pending.push({
        orderId,
        steamTradeOfferId: offerId,
        assetId: typeof asset === 'string' ? asset : null,
        holdUntil: Number.isFinite(holdMs) ? holdMs : null,
      });
    }
  }
  return pending;
}

/** Seconds or milliseconds from Steam → ISO. Steam's clocks are seconds. */
function steamTimeIso(value: number | undefined): string | undefined {
  if (!value || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 1e12 ? value * 1000 : value;
  return new Date(ms).toISOString();
}

/*
  Sales the seller ACCEPTED and has not sent through csboard.
  `/p2p/my/sales?scope=delivery` is his send queue. A row here with no offer
  id is a sale csboard believes is still waiting on him — but sellers send
  from Steam itself, from another browser, from the phone, and then the offer
  exists while csboard keeps a two-hour clock running against a delivery that
  already happened. csfloat's extension annotates such offers "post-hoc" for
  exactly this reason, and so does this one: see `annotateOffersSentOutside`.
*/
async function readUnsentSales(): Promise<UnsentSale[]> {
  const base = await getApiBase();
  let response: Response;
  try {
    response = await fetch(`${base}/p2p/my/sales?scope=delivery`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  const rows = Array.isArray(body) ? body : (body as { sales?: unknown })?.sales;
  if (!Array.isArray(rows)) return [];
  const unsent: UnsentSale[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const orderId = row['orderId'];
    const offerId = row['steamTradeOfferId'];
    const asset = row['assetIdToGive'] ?? row['assetId'];
    const buyer = row['buyerSteamId64'];
    // Only a sale he accepted: the backend refuses an annotation on one he has
    // not, and an offer for a sale he never took is not his delivery.
    if (!row['sellerAcceptedAt']) continue;
    if (typeof orderId !== 'string' || (typeof offerId === 'string' && offerId.length > 0)) continue;
    if (typeof asset !== 'string' || typeof buyer !== 'string' || !/^\d{17}$/.test(buyer)) continue;
    unsent.push({ orderId, assetId: asset, buyerSteamId: buyer });
  }
  return unsent;
}

/** Purchases with a delivery in flight, from `/p2p/my/orders` (`side: buyer`). */
async function readPendingPurchases(): Promise<PendingPurchase[]> {
  const base = await getApiBase();
  let response: Response;
  try {
    response = await fetch(`${base}/p2p/my/orders`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  if (!Array.isArray(body)) return [];
  const purchases: PendingPurchase[] = [];
  for (const row of body as Array<Record<string, unknown>>) {
    if (row['side'] !== 'buyer') continue;
    const status = row['status'];
    if (status !== 'trade_pending' && status !== 'trade_sent') continue;
    const orderId = row['id'];
    const assetId = row['assetId'];
    if (typeof orderId !== 'string' || typeof assetId !== 'string' || !assetId) continue;
    purchases.push({ orderId, assetId });
  }
  return purchases;
}

/** Offer states in which the offer exists and may still deliver or already did. */
const OFFER_STATES_WORTH_ANNOTATING = new Set([2, 3, 9]); // Active, Accepted, CreatedNeedsConfirmation

/**
 * Tell csboard about offers the seller sent WITHOUT it.
 *
 * Matched on the asset the sale hands over AND the buyer: an offer that gives
 * that exact copy to that exact account is that sale's delivery, whichever
 * device made it. The backend runs the same two checks again before it
 * believes us. A match in state 9 is reported as awaiting Steam Guard, the
 * same shape the Send button reports.
 */
async function annotateOffersSentOutside(
  unsent: readonly UnsentSale[],
  offers: ReadonlyArray<TrackedOffer>,
): Promise<void> {
  if (unsent.length === 0) return;
  const base = await getApiBase();
  for (const sale of unsent) {
    const offer = offers.find((candidate) => (
      OFFER_STATES_WORTH_ANNOTATING.has(candidate.state) &&
      candidate.partnerSteamId === sale.buyerSteamId &&
      (candidate.givenAssetIds ?? []).includes(sale.assetId)
    ));
    if (!offer) continue;
    try {
      const response = await fetch(`${base}/p2p/orders/${encodeURIComponent(sale.orderId)}/sent`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          steamTradeOfferId: offer.offerId,
          givenAssetIds: offer.givenAssetIds ?? [sale.assetId],
          partnerSteamId: sale.buyerSteamId,
          needsMobileConfirmation: offer.state === 9,
        }),
      });
      logger.info('Annotated an offer sent outside csboard', {
        orderId: sale.orderId, offerId: offer.offerId, state: offer.state, ok: response.ok,
      });
    } catch (error) {
      logger.warn('Could not annotate an outside offer', { orderId: sale.orderId, error: String(error) });
    }
  }
}

async function reportState(
  sale: PendingSale,
  state: number,
  escrowEndAt: number | undefined,
  updatedAt: number | undefined,
): Promise<void> {
  const base = await getApiBase();
  /*
    `tradableAt` as an ISO string, because that is the shape the endpoint takes
    from the app and one wire format is one fewer thing to get wrong. Steam
    gives seconds; JavaScript wants milliseconds, and confusing the two puts the
    hold in 1970 or in the year 57000.
  */
  const tradableAt = escrowEndAt ? new Date(escrowEndAt * 1000).toISOString() : undefined;
  // For an accepted offer, Steam's `time_updated` is the acceptance itself.
  // Sent so a report made after the browser was reopened still dates the
  // hold — and the deadline — from when the buyer actually took the skin.
  const acceptedAt = state === 3 ? steamTimeIso(updatedAt) : undefined;
  try {
    await fetch(`${base}/p2p/ext/trade-status`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: sale.orderId,
        steamTradeOfferId: sale.steamTradeOfferId,
        state,
        ...(tradableAt ? { tradableAt } : {}),
        ...(acceptedAt ? { acceptedAt } : {}),
      }),
    });
  } catch (error) {
    // Re-posting a state that already applied is a no-op on the server — every
    // transition is guarded by the order's current status — so a lost report is
    // simply picked up on the next tick rather than needing a retry here.
    logger.warn('Could not report trade status', { orderId: sale.orderId, error: String(error) });
  }
}

/*
  Report a COMPLETED trade, with the status Steam gives it.

  This is the half that matters after delivery. Once the buyer accepts, the skin
  sits in Steam's seven-day trade hold, and during those days the seller can ask
  Steam to reverse the trade. Nothing outside the seller's own session can see
  that happen — not our bots, not any public API — so a browser that stops
  watching at "sent" is a browser that will report a reversed sale as a
  successful one and pay for a skin that came back.

  `status` is Steam's own ETradeStatus, passed through untranslated for the same
  reason the offer state is: the server owns what each value means, and a client
  that interpreted them would be a second opinion about somebody's money.
*/
async function reportHistory(sale: { orderId: string }, trade: HistoryTrade): Promise<void> {
  const base = await getApiBase();
  try {
    await fetch(`${base}/p2p/ext/trade-history`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: sale.orderId,
        steamTradeId: trade.tradeId,
        givenAssetIds: trade.givenAssetIds,
        receivedAssetIds: trade.receivedAssetIds,
        status: trade.status,
        otherSteamId: trade.partnerSteamId,
        // Steam's `time_init`: when the skin actually moved. The one fact that
        // can say "before you closed the order" on a late report.
        ...(steamTimeIso(trade.occurredAt) ? { occurredAt: steamTimeIso(trade.occurredAt) } : {}),
      }),
    });
  } catch (error) {
    logger.warn('Could not report trade history', { orderId: sale.orderId, error: String(error) });
  }
}

/**
 * One pass: what do we owe an answer on, and what does Steam say about it.
 *
 * `readOffers` is injected rather than imported so this file does not decide
 * how a Steam session is obtained — that is the service worker's job, and it
 * already owns the provider's lifetime and its account binding.
 */
export async function trackP2PTrades(
  readOffers: () => Promise<ReadonlyArray<TrackedOffer>>,
  /*
    The history half is told WHAT IT IS LOOKING FOR, so the read can stop as
    soon as it has found it.

    `assetIds` are the copies these pending sales handed over, and `notBefore`
    is the earliest instant any of them could have moved. A reader that knows
    both can page until the answer is in hand instead of guessing a page size —
    see the caller in `service-worker.ts`. A reader that ignores both is still
    correct, just wasteful, which is what keeps this an optional argument.
  */
  readHistory?: (
    want: { assetIds: readonly string[]; notBefore: number },
  ) => Promise<ReadonlyArray<HistoryTrade>>,
): Promise<TrackOutcome> {
  const pending = await readPendingSales();
  const unsent = await readUnsentSales();
  const purchases = await readPendingPurchases();
  const outcome: TrackOutcome = {
    watched: { sales: pending.length, purchases: purchases.length, unsent: unsent.length },
    errors: {},
  };
  // The pace follows the work — see `pacePeriodMinutes`. Done before the early
  // return so an empty watch list also drops the loop back to hourly.
  registerP2PTrackAlarm(pacePeriodMinutes(pending, unsent, purchases));
  if (pending.length === 0 && unsent.length === 0 && purchases.length === 0) return outcome;

  let offers: ReadonlyArray<TrackedOffer>;
  try {
    offers = await readOffers();
  } catch (error) {
    logger.warn('Could not read Steam offers', { error: describeError(error) });
    outcome.errors.offers = describeError(error).slice(0, 300);
    return outcome;
  }

  // First the sales csboard does not yet know were sent: the send clock is
  // running against them, and every minute matters more there than anywhere.
  await annotateOffersSentOutside(unsent, offers);
  if (pending.length === 0 && purchases.length === 0) return outcome;

  const byOfferId = new Map(offers.map((offer) => [offer.offerId, offer]));
  for (const sale of pending) {
    const offer = byOfferId.get(sale.steamTradeOfferId);
    // An offer we cannot see is NOT reported as anything. It may be older than
    // the window Steam returns, and inventing a state for it would be a claim
    // about someone's money that this browser cannot support.
    if (!offer) continue;
    await reportState(sale, offer.state, offer.escrowEndAt, offer.updatedAt);
  }

  /*
    Then the history, which is where a reversal shows up.

    Matched on the ASSET the seller gave, not on the offer id: Steam's history
    identifies a completed trade by its own `tradeid`, which has nothing to do
    with the offer id it came from. The asset is the one value both sides carry.

    A sale whose asset we do not know is skipped rather than guessed at — a
    wrong match here would report someone else's trade against this order.
  */
  if (!readHistory) return outcome;
  /*
    What the read has to cover, derived rather than assumed.

    A sale's trade happened at most a protection window plus a margin before its
    hold ends — `holdUntil` IS `tradableAt` plus an hour — so the oldest row
    worth fetching is the earliest of those minus nine days. A sale with no hold
    recorded has not been accepted yet, so its trade, if it exists at all, is
    recent; the same nine days from now covers it with room to spare.

    Nine, not seven: Steam's protection is seven days from the trade and our
    hold is computed from a date Steam gives us, and neither is worth being
    exact about when the cost of overshooting is one extra page.
  */
  const WINDOW_MS = 9 * 24 * 60 * 60_000;
  const now = Date.now();
  const wantedAssets = [
    ...pending.map((sale) => sale.assetId).filter((assetId): assetId is string => !!assetId),
    ...purchases.map((purchase) => purchase.assetId),
  ];
  const notBefore = pending.reduce(
    (oldest, sale) => Math.min(oldest, (sale.holdUntil ?? now) - WINDOW_MS),
    // A purchase in flight was accepted recently or not at all: the same window
    // from now covers it.
    purchases.length > 0 ? now - WINDOW_MS : now,
  );

  let history: ReadonlyArray<HistoryTrade>;
  try {
    history = await readHistory({ assetIds: wantedAssets, notBefore });
  } catch (error) {
    logger.warn('Could not read Steam trade history', { error: describeError(error) });
    outcome.errors.history = describeError(error).slice(0, 300);
    return outcome;
  }
  if (history.length === 0) return outcome;

  /*
    Newest row per asset, decided by TIME rather than by position.

    A reversal is a later row for the same asset than the delivery it undoes, so
    the newest row is the one that tells the truth about where the skin is now.
    Keying on iteration order would be a bet on how Steam sorts its history —
    it returns newest-first, so "last write wins" would have kept the OLDEST
    row and reported a reversed trade as a completed one. Exactly backwards, on
    the one event this whole mechanism exists to catch.
  */
  const byGivenAsset = new Map<string, HistoryTrade>();
  const byReceivedAsset = new Map<string, HistoryTrade>();
  for (const trade of history) {
    for (const assetId of trade.givenAssetIds) {
      const held = byGivenAsset.get(assetId);
      if (!held || trade.occurredAt > held.occurredAt) byGivenAsset.set(assetId, trade);
    }
    for (const assetId of trade.receivedAssetIds) {
      const held = byReceivedAsset.get(assetId);
      if (!held || trade.occurredAt > held.occurredAt) byReceivedAsset.set(assetId, trade);
    }
  }
  for (const sale of pending) {
    if (!sale.assetId) continue;
    const trade = byGivenAsset.get(sale.assetId);
    if (!trade) continue;
    await reportHistory(sale, trade);
  }
  // The buyer's side of the same fact: the skin arrived.
  for (const purchase of purchases) {
    const trade = byReceivedAsset.get(purchase.assetId);
    if (!trade) continue;
    await reportHistory(purchase, trade);
  }
  return outcome;
}

/**
 * The heartbeat: what this browser is, what it may read, what it watches and
 * where the last pass failed. csfloat's `/v1/me/extension/status`, and for the
 * same reason — `extensionLastSeenAt` says a client called, not whether the
 * call could see Steam. A seller whose token has died shows up here as
 * `tokenOk: false` with the read error, hours before a sale goes silent.
 *
 * `steamSession` because this is now sent from a pass that found no Steam
 * login as well. It used to be sent only after a pass that had one, so a
 * seller without a Steam login in this browser never reached csboard at all:
 * no device, and the site told him he had no client while the extension sat
 * installed and enabled (support, 2026-09-25). The call is what pairs the
 * device; `missing` is what keeps csboard from counting it as able to send.
 */
export async function reportExtensionStatus(report: {
  version: string;
  steamId: string | null;
  tokenOk: boolean | null;
  permissions: Record<string, boolean>;
  outcome: TrackOutcome | null;
  lastPassAt: number | null;
  nextPassAt: number | null;
  steamSession: 'ok' | 'missing';
}): Promise<void> {
  const base = await getApiBase();
  try {
    await fetch(`${base}/p2p/ext/status`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: report.version,
        steamId: report.steamId,
        tokenOk: report.tokenOk,
        permissions: report.permissions,
        errors: {
          offers: report.outcome?.errors.offers ?? null,
          history: report.outcome?.errors.history ?? null,
        },
        watched: report.outcome?.watched ?? { sales: 0, purchases: 0, unsent: 0 },
        lastPassAt: report.lastPassAt ? new Date(report.lastPassAt).toISOString() : null,
        nextPassAt: report.nextPassAt ? new Date(report.nextPassAt).toISOString() : null,
        steamSession: report.steamSession,
      }),
    });
  } catch (error) {
    logger.warn('Could not report extension status', { error: String(error) });
  }
}

/** Storage key for the last attempt, used by the wake-up catch-up below. */
const LAST_PASS_KEY = 'csboard:p2p:lastTrackPass';

/*
  A pass on service-worker wake-up, not only on the alarm.

  Chrome's alarm scheduling assumes the browser stays open. Real sellers do not:
  someone opens the laptop, sends a trade, and shuts it again inside a minute —
  and the three-minute alarm never fires at all, so the offer we just sent is
  never reported and the sale sits there. csfloat's own extension carries the
  same catch-up for the same stated reason.

  Rate-limited against the stored timestamp so a service worker that wakes
  repeatedly (each message, each alarm, each tab event) does not turn this into
  a request per wake.
*/
export async function catchUpP2PTracking(run: () => Promise<void>): Promise<void> {
  let last: number | undefined;
  try {
    const stored = await chrome.storage.local.get(LAST_PASS_KEY);
    const value = stored?.[LAST_PASS_KEY];
    last = typeof value === 'number' ? value : undefined;
  } catch {
    // No storage, no memory of the last pass — run, and let the write below
    // fail too. A duplicate report is a no-op on the server; a missed one is
    // a sale that hangs.
  }
  if (last && last > Date.now() - TRACK_PERIOD_MINUTES * 60_000) return;
  try {
    await chrome.storage.local.set({ [LAST_PASS_KEY]: Date.now() });
  } catch { /* see above */ }
  await run();
}

/*
  What pace the work deserves right now.

  Fast while anything is genuinely in motion: an offer is out and unsettled, or
  a hold is about to release — the moment a reversal has either happened or not.
  Slow when every watched sale is parked in a hold with time left to run, which
  is most of a seven-day wait and where a three-minute poll learns nothing new
  several hundred times.

  Nothing to watch at all is also slow: the next sale will arrive through the
  send path, which reports immediately, not through this loop.
*/
function pacePeriodMinutes(
  pending: readonly PendingSale[],
  unsent: readonly UnsentSale[] = [],
  purchases: readonly PendingPurchase[] = [],
): number {
  // A sale waiting to be sent has a two-hour clock on it; if the seller sends
  // it from Steam itself, this loop is how csboard finds out. Fast. A purchase
  // in flight is the other party's clock, and this browser may be the only
  // one that can report it.
  if (unsent.length > 0 || purchases.length > 0) return TRACK_PERIOD_FAST_MINUTES;
  if (pending.length === 0) return TRACK_PERIOD_SLOW_MINUTES;
  const now = Date.now();
  const urgent = pending.some((sale) => (
    // Not in a hold yet: the buyer can accept or decline at any second.
    sale.holdUntil === null ||
    // Or the hold is close enough that the answer is about to change.
    sale.holdUntil - now <= HOLD_ENDING_SOON_MS
  ));
  return urgent ? TRACK_PERIOD_FAST_MINUTES : TRACK_PERIOD_SLOW_MINUTES;
}

/**
 * Register the recurring pass at a given pace.
 *
 * Idempotent: Chrome replaces a same-named alarm, which is what lets the pass
 * re-register itself at the end and so follow the work rather than a constant.
 */
export function registerP2PTrackAlarm(periodInMinutes = TRACK_PERIOD_FAST_MINUTES): void {
  try {
    chrome.alarms.create(P2P_TRACK_ALARM, {
      periodInMinutes,
      // A first pass shortly after startup, so a browser reopened on a pending
      // sale does not wait a full period to catch up.
      delayInMinutes: 1,
    });
  } catch (error) {
    logger.warn('Could not register the trade tracking alarm', { error: String(error) });
  }
}
