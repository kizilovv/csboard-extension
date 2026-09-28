/*
  The stolen-API-key scam against a user selling to csboard's buyout, and the
  rule that spots it.

  ── THE SCAM ──────────────────────────────────────────────────────────────

  An instant sell ends in an INCOMING offer: a vendor bot asks for the skins
  and gives nothing in Steam, because the user is paid on csboard. That shape
  is exactly what the classic Steam API-key scam copies. A scammer holding the
  user's API key watches his offers, cancels the vendor's real one the moment
  it lands, and sends a lookalike from his own bot asking for the same skins.
  The user, expecting "a bot asks for my items", accepts it.

  ── THE RULE ──────────────────────────────────────────────────────────────

  A received, active offer (2 or 9) is flagged when one of the skins it asks
  for (`items_to_give`, the user's side) belongs to a live buyout leg, unless it
  IS that leg's offer (`tradeOfferId`) or comes from that leg's bot
  (`botSteamId`). Offer id or bot is enough: a vendor that re-sends from the
  same bot gets a new offer id before csboard hears of it.

  A leg that knows neither yet (an async vendor that has not sent) flags
  nothing: there is no way to tell its real offer from a fake one, and a false
  alarm on the real one is how the user learns to click through the next.
  A leg without `assetIds` (a backend older than this check) is not a leg for
  this rule at all.

  Pure: no chrome, no fetch. Same shape of flag and the same storage handling
  as the P2P guard (`p2p-scam-offers.ts`), under its own key so each page knows
  which warning to show.
*/

import {
  ACTIVE_OFFER_STATES,
  accountIdFromSteamId64,
  canonicalAccountId,
  type ScamGuardOffer,
  type ScamOfferFlag,
} from './p2p-scam-offers';

/** chrome.storage.local key for buyout flags; the P2P ones live under `p2p.scamOffers`. */
export const BUYOUT_SCAM_OFFERS_KEY = 'buyout.scamOffers';

/** Leg statuses `/market/sell/status` reports while the vendor's offer is still to be accepted. */
export const LIVE_BUYOUT_STATUSES: ReadonlySet<string> = new Set(['pending', 'offer_sent']);

/** One live buyout leg (a sub-order), as the rule needs it. */
export interface BuyoutLeg {
  readonly id: string;
  readonly status: string;
  readonly tradeOfferId: string | null;
  /** The vendor bot, SteamID64. */
  readonly botSteamId: string | null;
  readonly assetIds: readonly string[];
}

/** True when the offer is the leg's own, or from the leg's bot. */
function isLegsOffer(leg: BuyoutLeg, offerId: string, partnerAccountId: string): boolean {
  if (leg.tradeOfferId && leg.tradeOfferId === offerId) return true;
  const bot = leg.botSteamId ? accountIdFromSteamId64(leg.botSteamId) : null;
  return bot !== null && bot === partnerAccountId;
}

export function findBuyoutScamOffers(
  offers: readonly ScamGuardOffer[],
  legs: readonly BuyoutLeg[],
): ScamOfferFlag[] {
  const legsByAsset = new Map<string, BuyoutLeg[]>();
  for (const leg of legs) {
    if (!LIVE_BUYOUT_STATUSES.has(leg.status)) continue;
    for (const assetId of leg.assetIds) {
      const list = legsByAsset.get(assetId) ?? [];
      list.push(leg);
      legsByAsset.set(assetId, list);
    }
  }
  if (legsByAsset.size === 0) return [];

  const flags: ScamOfferFlag[] = [];
  for (const offer of offers) {
    if (offer.direction !== 'received') continue;
    if (!ACTIVE_OFFER_STATES.has(offer.state)) continue;
    const partner = canonicalAccountId(offer.partnerAccountId);
    if (!partner) continue;

    const legIds: string[] = [];
    const assetIds: string[] = [];
    for (const assetId of new Set(offer.givenAssetIds)) {
      const assetLegs = legsByAsset.get(assetId);
      if (!assetLegs) continue;
      // Any leg of this skin we cannot tell the real offer of: say nothing about it.
      if (assetLegs.some((leg) => !leg.tradeOfferId && !leg.botSteamId)) continue;
      // The leg's own offer, or its bot: this is the sale going through.
      if (assetLegs.some((leg) => isLegsOffer(leg, offer.offerId, partner))) continue;
      assetIds.push(assetId);
      for (const leg of assetLegs) if (!legIds.includes(leg.id)) legIds.push(leg.id);
    }
    if (assetIds.length === 0) continue;
    flags.push({ offerId: offer.offerId, orderIds: legIds, assetIds, partnerAccountId: partner });
  }
  return flags;
}

/**
 * A stored flag the current legs now recognise as the vendor's: csboard
 * learned the real offer id or bot after the flag was raised. Dropped rather
 * than kept for the life of the offer, which is what the P2P flags do.
 */
export function buyoutFlagCleared(flag: ScamOfferFlag, legs: readonly BuyoutLeg[]): boolean {
  return legs.some((leg) => (
    LIVE_BUYOUT_STATUSES.has(leg.status) && isLegsOffer(leg, flag.offerId, flag.partnerAccountId)
  ));
}
