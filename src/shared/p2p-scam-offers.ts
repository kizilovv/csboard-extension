/*
  The "incoming trade" scam against P2P sellers, and the one rule that spots it.

  ── WHAT HAPPENED ─────────────────────────────────────────────────────────

  Prod, 2026-09: five P2P sellers gave skins away for nothing to farm accounts
  (SteamIDs 7656119982xxxxxx). Every case had the same shape. The seller had an
  item SOLD on csboard, a live order. An INCOMING offer arrived from an account
  that was not the buyer, asking for that exact item (usually with others) and
  giving nothing back, and the seller accepted it believing it was csboard's
  delivery.

  It can only be believed because sellers do not know which way a csboard trade
  goes. It goes one way only: the SELLER creates the offer (this extension or
  the app sends it), and csboard never sends the seller anything. So an incoming
  offer that asks for a sold item is never the delivery, whoever it is from.

  ── WHY THE RULE IS THIS NARROW ───────────────────────────────────────────

  "Received offer, give items, get nothing" is a normal day for a heavy trader:
  bot sites send exactly that shape to withdraw what he sold THERE, and some of
  these sellers list their whole inventory. A warning on every such offer would
  be noise within a day, and noise is how the real one gets clicked through.

  So all of these must hold:

    - the offer was RECEIVED and is still active (2, or 9 if Steam ever
      reports it on a received offer);
    - among the items the SELLER would give (`items_to_give`: Steam's fields
      are relative to the account that reads them, in both directions — see
      the display reader and the P/L maths on the offers page) is the asset of
      one of his LIVE csboard sales;
    - the partner is not that sale's buyer.

  What the seller would RECEIVE is deliberately not a condition. The farm
  offers gave nothing, but one junk skin added to the other side costs a
  scammer nothing and would slip past a "gives nothing back" test.

  A sale whose buyer we do not know is not used at all. Without the buyer
  there is no way to tell the scam from the real buyer's own offer, and a false
  alarm on a genuine sale teaches the seller to ignore the next one.

  Pure on purpose: no chrome, no fetch. The background feeds it and stores the
  result; the page scripts only read what was stored.
*/

/** chrome.storage.local key holding the flags the page scripts render. */
export const P2P_SCAM_OFFERS_KEY = 'p2p.scamOffers';

/** Offer ids already announced by a notification, so each is announced once. */
export const P2P_SCAM_NOTIFIED_KEY = 'p2p.scamOffersNotified';

/*
  Sales that are still "sold" from the seller's point of view: from the buyer
  paying until the money settles. `trade_expired` is left out even though the
  watch scope returns it: that sale is over, and its buyer is refunded.
*/
export const LIVE_SALE_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'trade_pending',
  'trade_sent',
  'trade_confirmed',
  'verification_hold',
]);

/** Steam's ETradeOfferState values in which an offer can still be accepted. */
export const ACTIVE_OFFER_STATES: ReadonlySet<number> = new Set([2, 9]);

const STEAM_ID64_BASE = 76561197960265728n;

/** One csboard sale, as the scam rule needs it. */
export interface ScamGuardSale {
  readonly orderId: string;
  readonly status: string;
  readonly assetId: string | null;
  /** SteamID64. Null when the backend did not say. */
  readonly buyerSteamId: string | null;
}

/** One Steam offer, as the scam rule needs it. */
export interface ScamGuardOffer {
  readonly offerId: string;
  readonly direction: 'sent' | 'received';
  readonly state: number;
  /** Steam's `accountid_other`: the partner's 32-bit account id. */
  readonly partnerAccountId: string;
  /** Asset ids the SELLER would hand over (Steam's `items_to_give`). */
  readonly givenAssetIds: readonly string[];
}

/** An offer the page must warn about. */
export interface ScamOfferFlag {
  readonly offerId: string;
  readonly orderIds: readonly string[];
  readonly assetIds: readonly string[];
  readonly partnerAccountId: string;
}

/** SteamID64 → the 32-bit account id Steam puts in `accountid_other`. Null if it is not one. */
export function accountIdFromSteamId64(steamId: string): string | null {
  if (!/^[0-9]{17}$/.test(steamId)) return null;
  const accountId = BigInt(steamId) - STEAM_ID64_BASE;
  if (accountId <= 0n || accountId > 0xffffffffn) return null;
  return accountId.toString();
}

/** `accountid_other` as a canonical decimal string, or null if it is not one. */
function canonicalAccountId(value: string): string | null {
  if (!/^[0-9]{1,10}$/.test(value)) return null;
  const accountId = BigInt(value);
  if (accountId <= 0n || accountId > 0xffffffffn) return null;
  return accountId.toString();
}

/**
 * The offers that match the scam, from what Steam and csboard said.
 *
 * Every input that cannot be read decides "not flagged": no buyer, no asset, an
 * unreadable partner. A missing read must never become a warning.
 */
export function findScamOffers(
  offers: readonly ScamGuardOffer[],
  sales: readonly ScamGuardSale[],
): ScamOfferFlag[] {
  /*
    Per asset: which live sales hold it, and who bought it. An asset with any
    live sale of unknown buyer is not judged at all — that sale's buyer could
    be exactly the partner we are looking at.
  */
  const byAsset = new Map<string, { orderIds: string[]; buyers: Set<string>; unknownBuyer: boolean }>();
  for (const sale of sales) {
    if (!LIVE_SALE_STATUSES.has(sale.status)) continue;
    if (!sale.assetId) continue;
    const entry = byAsset.get(sale.assetId) ?? { orderIds: [], buyers: new Set<string>(), unknownBuyer: false };
    const buyer = sale.buyerSteamId ? accountIdFromSteamId64(sale.buyerSteamId) : null;
    if (buyer) entry.buyers.add(buyer);
    else entry.unknownBuyer = true;
    entry.orderIds.push(sale.orderId);
    byAsset.set(sale.assetId, entry);
  }
  if (byAsset.size === 0) return [];

  const flags: ScamOfferFlag[] = [];
  for (const offer of offers) {
    if (offer.direction !== 'received') continue;
    if (!ACTIVE_OFFER_STATES.has(offer.state)) continue;
    const partner = canonicalAccountId(offer.partnerAccountId);
    if (!partner) continue;

    const orderIds: string[] = [];
    const assetIds: string[] = [];
    for (const assetId of new Set(offer.givenAssetIds)) {
      const entry = byAsset.get(assetId);
      if (!entry || entry.unknownBuyer) continue;
      if (entry.buyers.has(partner)) continue;
      assetIds.push(assetId);
      for (const orderId of entry.orderIds) if (!orderIds.includes(orderId)) orderIds.push(orderId);
    }
    if (assetIds.length === 0) continue;
    flags.push({ offerId: offer.offerId, orderIds, assetIds, partnerAccountId: partner });
  }
  return flags;
}

/*
  What to store after a pass: this pass's flags, plus earlier flags whose offer
  is still active.

  Kept, not recomputed, because the scam does not stop being one when the sale
  it copied ends. An order that expires or completes leaves the farm offer in
  the seller's inbox asking for the same skin, and it is still not csboard.
  Dropped the moment the offer is no longer active: there is nothing left to
  accept, and the list stays as short as the inbox.
*/
export function mergeScamFlags(
  previous: readonly ScamOfferFlag[],
  fresh: readonly ScamOfferFlag[],
  activeOfferIds: ReadonlySet<string>,
): ScamOfferFlag[] {
  const merged = new Map<string, ScamOfferFlag>();
  for (const flag of previous) if (activeOfferIds.has(flag.offerId)) merged.set(flag.offerId, flag);
  for (const flag of fresh) merged.set(flag.offerId, flag);
  return [...merged.values()];
}

/** Tolerant read of the stored flags: anything malformed is dropped, never thrown. */
export function readStoredScamFlags(value: unknown): ScamOfferFlag[] {
  if (!Array.isArray(value)) return [];
  const flags: ScamOfferFlag[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const offerId = record['offerId'];
    if (typeof offerId !== 'string' || !/^[0-9]{1,32}$/.test(offerId)) continue;
    const strings = (list: unknown): string[] => (
      Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
    );
    flags.push({
      offerId,
      orderIds: strings(record['orderIds']),
      assetIds: strings(record['assetIds']),
      partnerAccountId: typeof record['partnerAccountId'] === 'string' ? record['partnerAccountId'] : '',
    });
  }
  return flags;
}
