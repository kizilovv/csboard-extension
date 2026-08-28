/*
  Kills the Steam offers csboard has given up on, and proves they died.

  ── WHY THIS EXISTS ───────────────────────────────────────────────────────

  A P2P sale can end on csboard while its Steam offer is still alive. The send
  window closes, the buyer is refunded, the order is over — and the offer sits
  in the seller's outbox where one tap still sends the skin. Accepted at that
  point, the trade has happened entirely OUTSIDE the site: the seller is out a
  skin he was already fined for not sending, the buyer holds both the item and
  his money back, and nothing on our side ever recorded a delivery.

  Nobody but the seller's own client can close that window. Steam will not
  cancel another account's offer for us, and no public API can even see it. So
  the backend keeps a queue — `/p2p/ext/pending-cancellations` — and this pass
  works it.

  ── WHAT COUNTS AS DONE ───────────────────────────────────────────────────

  Not "the cancel POST returned 200". That is this browser reporting its own
  success, which is the weakest evidence available for the most expensive
  mistake in the flow. After cancelling, the pass RE-READS the seller's offer
  list and only tells the backend the offer is dead when Steam's own state says
  so. An offer that still reads Active is left in the queue and retried, and one
  that reads Accepted is reported as the state it is — the backend decides what
  that means, and it means something very different.
*/

import { getApiBase } from '../shared/config';
import { createLogger } from '../shared/logger';
import {
  P2P_TAB_CANCEL_COMMAND,
  type P2PTabCancelCommand,
  type P2PTabCancelResult,
} from '../shared/p2p-send-protocol';
import { TRACK_PERIOD_FAST_MINUTES, registerP2PTrackAlarm } from './p2p-trade-tracker';

const logger = createLogger('p2p-cancel');

/** How long to wait for the content script in a freshly opened tab to answer. */
const TAB_READY_TIMEOUT_MS = 20_000;
const TAB_POLL_MS = 400;

/**
 * A ceiling on one pass. A seller with a long queue gets through it over
 * several passes rather than having twenty Steam tabs opened at him at once.
 */
const MAX_CANCELS_PER_PASS = 5;

/*
  A cancel that cannot succeed must not be retried forever.

  Every attempt opens a Steam tab. An offer Steam will not let this account
  cancel — too old to appear in the offers list, an account restriction, a
  session that reads as signed in and is not — would otherwise open one every
  three minutes for as long as the browser is running. The backend keeps its own
  six-hour rescue and its own reading of reported states, so giving up here
  loses no safety; it only stops the browser flailing.
*/
const CANCEL_ATTEMPTS_KEY = 'csboard_p2p_cancel_attempts';
const MAX_CANCEL_ATTEMPTS = 6;
const CANCEL_BACKOFF_BASE_MS = 3 * 60_000;
const CANCEL_BACKOFF_CAP_MS = 6 * 60 * 60_000;

interface AttemptRecord { n: number; nextAt: number }
type AttemptMap = Record<string, AttemptRecord>;

async function readAttempts(): Promise<AttemptMap> {
  try {
    const stored = await chrome.storage.local.get(CANCEL_ATTEMPTS_KEY);
    const value = stored?.[CANCEL_ATTEMPTS_KEY];
    return (value && typeof value === 'object') ? value as AttemptMap : {};
  } catch {
    return {};
  }
}

/** Written back pruned to the live queue, so a finished order stops costing a row. */
async function writeAttempts(map: AttemptMap, liveOrderIds: Set<string>): Promise<void> {
  const pruned: AttemptMap = {};
  for (const [orderId, record] of Object.entries(map)) {
    if (liveOrderIds.has(orderId)) pruned[orderId] = record;
  }
  try {
    await chrome.storage.local.set({ [CANCEL_ATTEMPTS_KEY]: pruned });
  } catch {
    // Storage full or unavailable: the worst case is that a hopeless cancel is
    // retried on the old schedule, which is where this started.
  }
}

function backoffMs(attempt: number): number {
  return Math.min(CANCEL_BACKOFF_BASE_MS * (2 ** attempt), CANCEL_BACKOFF_CAP_MS);
}

/*
  Offer states from which the buyer can no longer take the item.

  Steam's ETradeOfferState. `Active` (2) and `CreatedNeedsConfirmation` (9) are
  deliberately absent — a 9 becomes a 2 the instant its seller taps Steam Guard,
  so neither is proof of anything. `Accepted` (3) is absent for the opposite
  reason: it is not a cancelled offer, it is a delivered one, and calling it
  dead here would tell the backend the opposite of what happened.
*/
const OFFER_DEAD_STATES = new Set([1, 4, 5, 6, 7, 8, 10]);

/*
  Is this offer past the point where the buyer could still take the item?

  Absent from a successful read counts as YES, and that is the deliberate part.
  Steam's sent-offer list is the seller's own complete list; an offer we just
  cancelled and can no longer find in it has not become invisible while staying
  live. csfloat's extension makes the same judgement in the same direction —
  `state === Active` blocks their cancel ping, and anything else, including not
  found, lets it through.

  Treating absence as "unknown" instead was what left two live orders with a
  dead offer in Steam and an open queue entry on the server: they were cancelled
  correctly, and then nothing would ever say so.
*/
function offerIsSettled(state: number | undefined): boolean {
  return state === undefined || OFFER_DEAD_STATES.has(state);
}

interface PendingCancellation {
  orderId: string;
  steamTradeOfferId: string;
  marketHashName: string | null;
}

async function readPendingCancellations(): Promise<PendingCancellation[]> {
  const base = await getApiBase();
  let response: Response;
  try {
    response = await fetch(`${base}/p2p/ext/pending-cancellations`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return [];
  }
  // 401 is the ordinary case for a browser whose owner is not signed in to
  // csboard. Silent: this runs on a timer.
  if (!response.ok) return [];

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  const rows = (body as { orders?: unknown })?.orders;
  if (!Array.isArray(rows)) return [];

  const pending: PendingCancellation[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const orderId = row['orderId'];
    const offerId = row['steamTradeOfferId'];
    if (typeof orderId === 'string' && typeof offerId === 'string' && offerId.length > 0) {
      const name = row['marketHashName'];
      pending.push({
        orderId,
        steamTradeOfferId: offerId,
        marketHashName: typeof name === 'string' ? name : null,
      });
    }
  }
  return pending;
}

/**
 * Open the offer's own page.
 *
 * Inactive on purpose: unlike a send, nobody asked for this. It is housekeeping
 * on a sale that is already over, and stealing focus for it — possibly five
 * times in a row — would be the extension interrupting the seller to tidy up
 * after itself.
 */
async function openOfferTab(steamTradeOfferId: string): Promise<number | null> {
  const tab = await chrome.tabs.create({
    url: `https://steamcommunity.com/tradeoffer/${encodeURIComponent(steamTradeOfferId)}/`,
    active: false,
  });
  return typeof tab.id === 'number' ? tab.id : null;
}

/**
 * Talk to the tab by retrying rather than by watching its load state — the same
 * reasoning as the send path: a content script that has not booted does not
 * answer, and asking for the "tabs" permission to learn that costs a slower
 * review for information we can get by trying.
 */
async function commandTab(tabId: number, command: P2PTabCancelCommand): Promise<P2PTabCancelResult> {
  const deadline = Date.now() + TAB_READY_TIMEOUT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, command);
      if (result && typeof result === 'object') return result as P2PTabCancelResult;
      lastError = 'empty reply';
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => { setTimeout(resolve, TAB_POLL_MS); });
  }
  return { ok: false, code: 'TAB_UNREACHABLE', detail: lastError };
}

async function cancelOne(item: PendingCancellation): Promise<P2PTabCancelResult> {
  const tabId = await openOfferTab(item.steamTradeOfferId);
  if (tabId === null) return { ok: false, code: 'TAB_UNREACHABLE' };
  try {
    return await commandTab(tabId, {
      type: P2P_TAB_CANCEL_COMMAND,
      orderId: item.orderId,
      steamTradeOfferId: item.steamTradeOfferId,
    });
  } finally {
    // Close what we opened, whatever happened — the seller did not ask for
    // these tabs and must not be left cleaning them up.
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Already gone.
    }
  }
}

/** Tell the backend Steam's own state agrees the offer is dead. */
async function confirmCancelled(item: PendingCancellation): Promise<void> {
  const base = await getApiBase();
  try {
    await fetch(`${base}/p2p/ext/confirm-cancel`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: item.orderId,
        steamTradeOfferId: item.steamTradeOfferId,
      }),
    });
  } catch (error) {
    // A lost confirmation is picked up next pass: the order stays in the queue
    // until the backend has heard, and re-confirming is a no-op there.
    logger.warn('Could not confirm cancellation', { orderId: item.orderId, error: String(error) });
  }
}

/**
 * One cancellation pass.
 *
 * `readOffers` is injected for the same reason the tracker injects it: this
 * file does not decide how a Steam session is obtained. It is used TWICE and
 * for two different questions — before, to skip offers Steam already considers
 * finished, and after, to prove the ones we just cancelled actually died.
 */
export async function runP2PCancellations(
  readOffers: () => Promise<ReadonlyArray<{ offerId: string; state: number }>>,
): Promise<void> {
  const queue = await readPendingCancellations();
  if (queue.length === 0) return;
  const liveOrderIds = new Set(queue.map((item) => item.orderId));
  const attempts = await readAttempts();
  /*
    A pass that has work says what it did, every time.

    The first version logged only on a refusal or a verified cancel, so the most
    interesting outcome — cancelled, but Steam still reports it alive, so no
    confirmation was sent — produced complete silence. Two orders sat half-closed
    with a dead offer in Steam and a queue entry on the server, and the console
    had nothing to say about either. Silence is not evidence of nothing
    happening.
  */
  const tally = { queued: queue.length, alreadyDead: 0, cancelled: 0, refused: 0, confirmed: 0, stillLive: 0 };

  /*
    A queued cancellation overrides the slow pace.

    The tracker drops to hourly when everything it watches is parked in a
    seven-day hold, which is right for watching and wrong for this: the offer in
    this queue is one tap away from sending a skin for a sale that no longer
    exists, and an hour is a long time to leave that open. Chrome replaces a
    same-named alarm, so this simply pulls the next pass forward.
  */
  registerP2PTrackAlarm(TRACK_PERIOD_FAST_MINUTES);

  let before: Map<string, number>;
  try {
    before = new Map((await readOffers()).map((offer) => [offer.offerId, offer.state]));
  } catch (error) {
    logger.warn('Could not read Steam offers before cancelling', { error: String(error) });
    return;
  }

  /*
    Anything Steam already calls dead needs no cancel call at all — just the
    confirmation the backend has been waiting for. This is the ordinary case
    for a seller who cancelled the offer himself in Steam.
  */
  const alreadyDead: PendingCancellation[] = [];
  const work: PendingCancellation[] = [];
  for (const item of queue) {
    const state = before.get(item.steamTradeOfferId);
    if (offerIsSettled(state)) {
      alreadyDead.push(item);
      continue;
    }
    // Given up on, or not due for another try yet.
    const record = attempts[item.orderId];
    if (record && (record.n >= MAX_CANCEL_ATTEMPTS || Date.now() < record.nextAt)) continue;
    work.push(item);
  }

  /*
    Confirmations are capped per pass too, and for the same reason the cancels
    are: each one can finalise money on the server — a buyer-accept expiry pays
    out through exactly this call — and a backlog discovered all at once should
    drain over several passes rather than fire in one burst.
  */
  for (const item of alreadyDead.slice(0, MAX_CANCELS_PER_PASS)) {
    await confirmCancelled(item);
    delete attempts[item.orderId];
    tally.alreadyDead += 1;
    tally.confirmed += 1;
  }
  if (alreadyDead.length > MAX_CANCELS_PER_PASS) {
    logger.info('More already-dead offers than one pass confirms', { queued: alreadyDead.length });
  }

  if (work.length === 0) {
    await writeAttempts(attempts, liveOrderIds);
    logger.info('Cancellation pass', tally);
    return;
  }

  const batch = work.slice(0, MAX_CANCELS_PER_PASS);
  if (work.length > batch.length) {
    logger.info('Cancellation queue longer than one pass', {
      queued: work.length,
      thisPass: batch.length,
    });
  }

  for (const item of batch) {
    const result = await cancelOne(item);
    if (!result.ok) {
      const n = (attempts[item.orderId]?.n ?? 0) + 1;
      attempts[item.orderId] = { n, nextAt: Date.now() + backoffMs(n) };
      logger.warn('Cancel refused', {
        orderId: item.orderId,
        code: result.code,
        detail: result.detail,
        attempt: n,
        givingUp: n >= MAX_CANCEL_ATTEMPTS,
      });
      tally.refused += 1;
    } else {
      tally.cancelled += 1;
    }
  }

  /*
    The proof, and the reason this pass does not simply trust its own POSTs.

    One read after the batch: whichever offers Steam now reports in a dead state
    are the ones the backend is told about. An offer that still reads Active is
    left in the queue for the next pass rather than being reported as handled,
    and one that reads Accepted is left alone entirely — it is not a cancelled
    offer, and saying it was would bury the single worst outcome this whole path
    exists to catch. The tracker reports that state through its own endpoint,
    where the backend knows what to do with it.
  */
  let after: Map<string, number>;
  try {
    after = new Map((await readOffers()).map((offer) => [offer.offerId, offer.state]));
  } catch (error) {
    logger.warn('Could not verify cancellations', { error: String(error) });
    await writeAttempts(attempts, liveOrderIds);
    logger.info('Cancellation pass', { ...tally, verifyFailed: true });
    return;
  }

  for (const item of batch) {
    const state = after.get(item.steamTradeOfferId);
    if (offerIsSettled(state)) {
      await confirmCancelled(item);
      delete attempts[item.orderId];
      tally.confirmed += 1;
      logger.info('Offer cancelled and verified', {
        orderId: item.orderId,
        steamTradeOfferId: item.steamTradeOfferId,
        state,
      });
      continue;
    }
    /*
      Cancelled, and Steam still does not call it dead. Almost always its list
      lagging by a few seconds, which the next pass clears through the
      already-dead branch — but it is exactly the case that used to vanish
      without a trace, so it is counted and named.
    */
    tally.stillLive += 1;
    logger.warn('Cancelled but not yet confirmed dead by Steam', {
      orderId: item.orderId,
      steamTradeOfferId: item.steamTradeOfferId,
      steamState: state ?? 'not-in-offer-list',
    });
    if (!attempts[item.orderId]) {
      /*
        The POST was accepted and the offer is still not dead. That is a
        failure of the outcome, not of the call, and it counts against the
        budget — otherwise an offer that swallows every cancel silently keeps
        its tab-per-pass forever.
      */
      attempts[item.orderId] = { n: 1, nextAt: Date.now() + backoffMs(1) };
    }
  }

  await writeAttempts(attempts, liveOrderIds);
  logger.info('Cancellation pass', tally);
}
