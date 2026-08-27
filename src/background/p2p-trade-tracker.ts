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

async function reportState(
  sale: PendingSale,
  state: number,
  escrowEndAt: number | undefined,
): Promise<void> {
  const base = await getApiBase();
  /*
    `tradableAt` as an ISO string, because that is the shape the endpoint takes
    from the app and one wire format is one fewer thing to get wrong. Steam
    gives seconds; JavaScript wants milliseconds, and confusing the two puts the
    hold in 1970 or in the year 57000.
  */
  const tradableAt = escrowEndAt ? new Date(escrowEndAt * 1000).toISOString() : undefined;
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
async function reportHistory(sale: PendingSale, trade: HistoryTrade): Promise<void> {
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
  readOffers: () => Promise<ReadonlyArray<{ offerId: string; state: number; escrowEndAt?: number }>>,
  readHistory?: () => Promise<ReadonlyArray<HistoryTrade>>,
): Promise<void> {
  const pending = await readPendingSales();
  // The pace follows the work — see `pacePeriodMinutes`. Done before the early
  // return so an empty watch list also drops the loop back to hourly.
  registerP2PTrackAlarm(pacePeriodMinutes(pending));
  if (pending.length === 0) return;

  let offers: ReadonlyArray<{ offerId: string; state: number; escrowEndAt?: number }>;
  try {
    offers = await readOffers();
  } catch (error) {
    logger.warn('Could not read Steam offers', { error: String(error) });
    return;
  }

  const byOfferId = new Map(offers.map((offer) => [offer.offerId, offer]));
  for (const sale of pending) {
    const offer = byOfferId.get(sale.steamTradeOfferId);
    // An offer we cannot see is NOT reported as anything. It may be older than
    // the window Steam returns, and inventing a state for it would be a claim
    // about someone's money that this browser cannot support.
    if (!offer) continue;
    await reportState(sale, offer.state, offer.escrowEndAt);
  }

  /*
    Then the history, which is where a reversal shows up.

    Matched on the ASSET the seller gave, not on the offer id: Steam's history
    identifies a completed trade by its own `tradeid`, which has nothing to do
    with the offer id it came from. The asset is the one value both sides carry.

    A sale whose asset we do not know is skipped rather than guessed at — a
    wrong match here would report someone else's trade against this order.
  */
  if (!readHistory) return;
  let history: ReadonlyArray<HistoryTrade>;
  try {
    history = await readHistory();
  } catch (error) {
    logger.warn('Could not read Steam trade history', { error: String(error) });
    return;
  }
  if (history.length === 0) return;

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
  for (const trade of history) {
    for (const assetId of trade.givenAssetIds) {
      const held = byGivenAsset.get(assetId);
      if (!held || trade.occurredAt > held.occurredAt) byGivenAsset.set(assetId, trade);
    }
  }
  for (const sale of pending) {
    if (!sale.assetId) continue;
    const trade = byGivenAsset.get(sale.assetId);
    if (!trade) continue;
    await reportHistory(sale, trade);
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
function pacePeriodMinutes(pending: readonly PendingSale[]): number {
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
