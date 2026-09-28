/*
  Warns a seller when an incoming Steam offer asks for an item he sold on
  csboard. The rule and the incident behind it live in
  `shared/p2p-scam-offers.ts`; this file only feeds it and acts on the answer.

  ── WHERE IT RUNS ─────────────────────────────────────────────────────────

  In the tracker's pass, which already holds a Steam read session for this
  seller. The seller's own session is the only thing that can see his incoming
  offers, the same reason the tracker exists at all.

  ── WHAT IT DOES WITH A MATCH ─────────────────────────────────────────────

  Stores the flagged offers in chrome.storage.local, where the Steam page
  scripts read them to put a red warning on the offer and a second click on
  its Accept button. No system notification (owner, 2026-09-28).

  ── WHAT IT NEVER DOES ────────────────────────────────────────────────────

  Warn without a read. Either csboard read failing, or the Steam read failing,
  ends the check with the stored flags untouched: a stale warning on an offer
  that really was flagged is fine, a warning invented from half an answer is
  not. It also never touches the offer itself: no decline, no cancel. Deciding
  about somebody's trade is his to do.
*/

import { getApiBase } from '../shared/config';
import { createLogger } from '../shared/logger';
import {
  ACTIVE_OFFER_STATES,
  LIVE_SALE_STATUSES,
  P2P_SCAM_OFFERS_KEY,
  findScamOffers,
  mergeScamFlags,
  readStoredScamFlags,
  type ScamGuardOffer,
  type ScamGuardSale,
  type ScamOfferFlag,
} from '../shared/p2p-scam-offers';
import { TRACK_PERIOD_FAST_MINUTES, registerP2PTrackAlarm } from './p2p-trade-tracker';

const logger = createLogger('p2p-scam-guard');


/** Statuses in which the seller still holds the item, which is when the scam can work. */
const SELLER_HOLDS_ITEM = new Set(['pending', 'trade_pending']);

/*
  One scope of the seller's sales, or null when it could not be read.

  Both scopes are needed: `delivery` is the sale before it is sent (`pending`,
  `trade_pending`), which is exactly when the farm offer arrives, and `watch`
  is everything after. Neither alone is the whole live set.
*/
async function readSalesScope(scope: 'delivery' | 'watch'): Promise<ScamGuardSale[] | null> {
  const base = await getApiBase();
  let response: Response;
  try {
    response = await fetch(`${base}/p2p/my/sales?scope=${scope}`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return null;
  }
  // 401 is a browser signed out of csboard: not a fault, and not a read.
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const rows = Array.isArray(body) ? body : (body as { sales?: unknown })?.sales;
  if (!Array.isArray(rows)) return null;

  const sales: ScamGuardSale[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    if (!row || typeof row !== 'object') continue;
    const orderId = row['orderId'];
    const status = row['status'];
    if (typeof orderId !== 'string' || typeof status !== 'string') continue;
    const asset = row['assetId'] ?? row['assetIdToGive'];
    /*
      `buyerSteamId` is the field the backend is adding for this check;
      `buyerSteamId64` is the same column under the name every row already
      carries. Either is enough. Neither means the sale is not used at all —
      see `findScamOffers`.
    */
    const buyer = row['buyerSteamId'] ?? row['buyerSteamId64'];
    sales.push({
      orderId,
      status,
      assetId: typeof asset === 'string' && /^[0-9]+$/.test(asset) ? asset : null,
      buyerSteamId: typeof buyer === 'string' && /^[0-9]{17}$/.test(buyer) ? buyer : null,
    });
  }
  return sales;
}

/** Every live sale, or null unless BOTH scopes were read. */
async function readLiveSales(): Promise<ScamGuardSale[] | null> {
  const [delivery, watch] = await Promise.all([readSalesScope('delivery'), readSalesScope('watch')]);
  if (delivery === null || watch === null) return null;
  // A `trade_pending` sale with an offer is in both scopes.
  const byOrder = new Map<string, ScamGuardSale>();
  for (const sale of [...delivery, ...watch]) byOrder.set(sale.orderId, sale);
  return [...byOrder.values()].filter((sale) => LIVE_SALE_STATUSES.has(sale.status));
}

async function readStoredFlags(): Promise<ScamOfferFlag[]> {
  try {
    const stored = await chrome.storage.local.get(P2P_SCAM_OFFERS_KEY);
    return readStoredScamFlags(stored?.[P2P_SCAM_OFFERS_KEY]);
  } catch {
    return [];
  }
}

/*
  No system notification (owner, 2026-09-28): the warning lives on the offer
  itself, the page and the list, where the seller is about to act. A desktop
  notification for every flagged offer is one more thing to click away.
*/

/**
 * One check. `readReceivedOffers` is injected for the same reason the
 * tracker's reader is: the service worker owns the Steam session.
 */
export async function runP2PScamGuard(
  readReceivedOffers: () => Promise<ReadonlyArray<ScamGuardOffer>>,
): Promise<void> {
  const sales = await readLiveSales();
  if (sales === null) return;
  const storedFlags = await readStoredFlags();
  // Nothing sold and nothing flagged: nothing to look at in Steam.
  if (sales.length === 0 && storedFlags.length === 0) return;

  /*
    While the seller still holds a sold item, keep the pass on the fast clock.

    The farm offer lands in the minutes after a sale, while the order is still
    waiting for the seller (`pending`), and that is the one stretch the
    tracker's own pacing can call quiet: it has no offer to watch yet. An hour
    late, this warning would arrive after the skin.
  */
  if (sales.some((sale) => SELLER_HOLDS_ITEM.has(sale.status))) {
    registerP2PTrackAlarm(TRACK_PERIOD_FAST_MINUTES);
  }

  let offers: ReadonlyArray<ScamGuardOffer>;
  try {
    offers = await readReceivedOffers();
  } catch (error) {
    logger.warn('Could not read incoming offers for the scam check', { error: String(error) });
    return;
  }

  const fresh = findScamOffers(offers, sales);
  const activeOfferIds = new Set(
    offers
      .filter((offer) => offer.direction === 'received' && ACTIVE_OFFER_STATES.has(offer.state))
      .map((offer) => offer.offerId),
  );
  const flags = mergeScamFlags(storedFlags, fresh, activeOfferIds);

  const known = new Set(storedFlags.map((flag) => flag.offerId));
  for (const flag of flags.filter((f) => !known.has(f.offerId))) {
    logger.warn('Incoming offer asks for an item sold on csboard, from someone who is not its buyer', {
      offerId: flag.offerId,
      orderIds: flag.orderIds,
      assetIds: flag.assetIds,
      partnerAccountId: flag.partnerAccountId,
    });
  }

  try {
    await chrome.storage.local.set({ [P2P_SCAM_OFFERS_KEY]: flags });
  } catch (error) {
    logger.warn('Could not store scam-offer flags', { error: String(error) });
  }
}
