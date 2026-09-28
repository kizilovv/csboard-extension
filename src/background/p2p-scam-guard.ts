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
  its Accept button, and raises one notification per offer. The notification
  is for the seller who accepts from the Steam app on his phone and never opens
  the offer in this browser: it is the only place this extension can reach him.

  ── WHAT IT NEVER DOES ────────────────────────────────────────────────────

  Warn without a read. Either csboard read failing, or the Steam read failing,
  ends the check with the stored flags untouched: a stale warning on an offer
  that really was flagged is fine, a warning invented from half an answer is
  not. It also never touches the offer itself: no decline, no cancel. Deciding
  about somebody's trade is his to do.
*/

import { getApiBase } from '../shared/config';
import { initI18n, t } from '../shared/i18n';
import { createLogger } from '../shared/logger';
import {
  ACTIVE_OFFER_STATES,
  LIVE_SALE_STATUSES,
  P2P_SCAM_NOTIFIED_KEY,
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

const NOTIFICATION_PREFIX = 'csboard-scam-offer:';

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

async function readStored(): Promise<{ flags: ScamOfferFlag[]; notified: Set<string> }> {
  try {
    const stored = await chrome.storage.local.get([P2P_SCAM_OFFERS_KEY, P2P_SCAM_NOTIFIED_KEY]);
    const notified = stored?.[P2P_SCAM_NOTIFIED_KEY];
    return {
      flags: readStoredScamFlags(stored?.[P2P_SCAM_OFFERS_KEY]),
      notified: new Set(Array.isArray(notified) ? notified.filter((id): id is string => typeof id === 'string') : []),
    };
  } catch {
    /*
      Unreadable storage forgets what was announced, so a flagged offer may be
      announced again. Accepted on purpose, the opposite of the sales badge's
      choice: a repeat costs a moment of annoyance (the notification id is per
      offer, so Chrome replaces it rather than stacking), a missed warning here
      costs a skin.
    */
    return { flags: [], notified: new Set() };
  }
}

/** One notification per offer. Returns the offer ids that were actually announced. */
async function announce(flags: readonly ScamOfferFlag[]): Promise<string[]> {
  if (flags.length === 0) return [];
  try {
    await initI18n();
  } catch {
    // English is the fallback dictionary.
  }
  const announced: string[] = [];
  for (const flag of flags) {
    try {
      await chrome.notifications.create(`${NOTIFICATION_PREFIX}${flag.offerId}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: t('p2pScam.title'),
        message: t('p2pScam.body'),
        // A warning about a skin one tap from leaving for nothing stays until
        // it is read. Not gated on the sale-alerts switch either: that switch
        // is about "you sold something", this is about not losing it.
        requireInteraction: true,
      });
      announced.push(flag.offerId);
    } catch (error) {
      // Not remembered as announced, so the next pass tries again.
      logger.warn('Could not raise a scam-offer notification', { offerId: flag.offerId, error: String(error) });
    }
  }
  return announced;
}

/** Clicking the warning opens the offer, where the page puts the same warning on it. */
chrome.notifications?.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
  const offerId = notificationId.slice(NOTIFICATION_PREFIX.length);
  if (!/^[0-9]+$/.test(offerId)) return;
  void chrome.tabs.create({ url: `https://steamcommunity.com/tradeoffer/${offerId}/` });
  void chrome.notifications.clear(notificationId);
});

/**
 * One check. `readReceivedOffers` is injected for the same reason the
 * tracker's reader is: the service worker owns the Steam session.
 */
export async function runP2PScamGuard(
  readReceivedOffers: () => Promise<ReadonlyArray<ScamGuardOffer>>,
): Promise<void> {
  const sales = await readLiveSales();
  if (sales === null) return;
  const stored = await readStored();
  // Nothing sold and nothing flagged: nothing to look at in Steam.
  if (sales.length === 0 && stored.flags.length === 0) return;

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
  const flags = mergeScamFlags(stored.flags, fresh, activeOfferIds);

  const unannounced = flags.filter((flag) => !stored.notified.has(flag.offerId));
  for (const flag of unannounced) {
    logger.warn('Incoming offer asks for an item sold on csboard, from someone who is not its buyer', {
      offerId: flag.offerId,
      orderIds: flag.orderIds,
      assetIds: flag.assetIds,
      partnerAccountId: flag.partnerAccountId,
    });
  }

  // Stored before the notification, so the page already knows when the seller clicks it.
  try {
    await chrome.storage.local.set({ [P2P_SCAM_OFFERS_KEY]: flags });
  } catch (error) {
    logger.warn('Could not store scam-offer flags', { error: String(error) });
  }

  const announced = new Set(await announce(unannounced));
  // Pruned to what is still flagged: an offer that stopped being active never
  // becomes active again, so its id has nothing left to guard against.
  const notified = flags
    .map((flag) => flag.offerId)
    .filter((offerId) => stored.notified.has(offerId) || announced.has(offerId));
  try {
    await chrome.storage.local.set({ [P2P_SCAM_NOTIFIED_KEY]: notified });
  } catch {
    // Worst case one warning is shown twice; better than a failed write silencing the next.
  }
}
