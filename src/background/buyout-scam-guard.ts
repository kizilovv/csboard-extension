/*
  Flags the lookalike offer in the stolen-API-key scam against a buyout sale.
  The rule is in `shared/buyout-scam-offers.ts`; this file feeds it the user's
  live buyout legs and his incoming offers, and stores what it finds for the
  Steam pages. Same shape and same promises as `p2p-scam-guard.ts`: no read,
  no flag; nothing is ever done to the offer itself; no system notification.
*/

import { getApiBase } from '../shared/config';
import { createLogger } from '../shared/logger';
import {
  BUYOUT_SCAM_OFFERS_KEY,
  LIVE_BUYOUT_STATUSES,
  buyoutFlagCleared,
  findBuyoutScamOffers,
  type BuyoutLeg,
} from '../shared/buyout-scam-offers';
import {
  ACTIVE_OFFER_STATES,
  mergeScamFlags,
  readStoredScamFlags,
  type ScamGuardOffer,
  type ScamOfferFlag,
} from '../shared/p2p-scam-offers';
import { TRACK_PERIOD_FAST_MINUTES, registerP2PTrackAlarm } from './p2p-trade-tracker';

const logger = createLogger('buyout-scam-guard');

/*
  The user's live buyout legs, or null when they could not be read.

  `GET /market/sell/status` is what csboard's own /sell page polls, and its
  `activeSubOrders` are exactly the legs whose vendor offer is still waiting on
  the user. A leg without `assetIds` comes from a backend that predates this
  check and is dropped: without the skins there is nothing to match.
*/
async function readLiveLegs(): Promise<BuyoutLeg[] | null> {
  const base = await getApiBase();
  let response: Response;
  try {
    response = await fetch(`${base}/market/sell/status`, {
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
  const rows = (body as { activeSubOrders?: unknown } | null)?.activeSubOrders;
  if (!Array.isArray(rows)) return null;

  const legs: BuyoutLeg[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    if (!row || typeof row !== 'object') continue;
    const id = row['id'];
    const status = row['status'];
    const assetIds = row['assetIds'];
    if (typeof id !== 'string' || typeof status !== 'string' || !Array.isArray(assetIds)) continue;
    if (!LIVE_BUYOUT_STATUSES.has(status)) continue;
    const offerId = row['tradeOfferId'];
    const bot = row['botSteamId'];
    legs.push({
      id,
      status,
      tradeOfferId: typeof offerId === 'string' && /^[0-9]+$/.test(offerId) ? offerId : null,
      botSteamId: typeof bot === 'string' && /^[0-9]{17}$/.test(bot) ? bot : null,
      assetIds: assetIds.filter((asset): asset is string => typeof asset === 'string' && /^[0-9]+$/.test(asset)),
    });
  }
  return legs;
}

async function readStoredFlags(): Promise<ScamOfferFlag[]> {
  try {
    const stored = await chrome.storage.local.get(BUYOUT_SCAM_OFFERS_KEY);
    return readStoredScamFlags(stored?.[BUYOUT_SCAM_OFFERS_KEY]);
  } catch {
    return [];
  }
}

/** One check. The reader is shared with the P2P guard, so one pass reads the inbox once. */
export async function runBuyoutScamGuard(
  readReceivedOffers: () => Promise<ReadonlyArray<ScamGuardOffer>>,
): Promise<void> {
  const legs = await readLiveLegs();
  if (legs === null) return;
  const storedFlags = await readStoredFlags();
  if (legs.length === 0 && storedFlags.length === 0) return;

  /*
    A buyout leg lives about fifteen minutes, and the scam lands inside them.
    A pass on the slow clock would look after the leg was already gone.
  */
  if (legs.length > 0) registerP2PTrackAlarm(TRACK_PERIOD_FAST_MINUTES);

  let offers: ReadonlyArray<ScamGuardOffer>;
  try {
    offers = await readReceivedOffers();
  } catch (error) {
    logger.warn('Could not read incoming offers for the buyout scam check', { error: String(error) });
    return;
  }

  const fresh = findBuyoutScamOffers(offers, legs);
  const activeOfferIds = new Set(
    offers
      .filter((offer) => offer.direction === 'received' && ACTIVE_OFFER_STATES.has(offer.state))
      .map((offer) => offer.offerId),
  );
  /*
    Kept while the offer is active, as the P2P flags are: in this scam the
    scammer CANCELS the vendor's offer, and the leg may drop out of the live
    set right after. The lookalike is no more legitimate for that. Dropped
    early only when csboard now names the offer, or its bot, as the vendor's.
  */
  const flags = mergeScamFlags(storedFlags, fresh, activeOfferIds, (flag) => buyoutFlagCleared(flag, legs));

  const known = new Set(storedFlags.map((flag) => flag.offerId));
  for (const flag of flags.filter((f) => !known.has(f.offerId))) {
    logger.warn('Incoming offer asks for skins in a live buyout, and is not the vendor\'s', {
      offerId: flag.offerId,
      legIds: flag.orderIds,
      assetIds: flag.assetIds,
      partnerAccountId: flag.partnerAccountId,
    });
  }

  try {
    await chrome.storage.local.set({ [BUYOUT_SCAM_OFFERS_KEY]: flags });
  } catch (error) {
    logger.warn('Could not store buyout scam flags', { error: String(error) });
  }
}
