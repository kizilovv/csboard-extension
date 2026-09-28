/*
  What a trade offer is worth to each side, priced the way the offers list has
  always priced it for its P/L badge.

  Lifted out of `trade-offers.ts` (`addOfferTotals`) so the scam warnings can
  ask the same question with the same answer (owner, 2026-09-28): a warning
  that called a trade a loss while the badge beside it said "+$12" would be
  the warning's credibility gone. One function, used by both.

  An item is found in the page's description list by class and instance id,
  priced by name with its Doppler phase when the icon has one, and an item
  that cannot be priced is counted as UNPRICED rather than as zero — the badge
  shows that as a trailing `*`, and the warnings read it as "cannot tell".
*/

import { getDopplerInfo } from './dopplerPhases';

interface ItemIds {
  readonly classid: string;
  readonly instanceid: string;
}

interface DescribedItem extends ItemIds {
  readonly market_hash_name?: string;
  readonly icon_url?: unknown;
}

export interface OfferSideValue {
  readonly total: number;
  /** At least one item on this side has no price. */
  readonly unpriced: boolean;
}

export interface OfferValue {
  /** The side the reading account hands over (Steam's `items_to_give`). */
  readonly give: OfferSideValue;
  /** The side it gets (Steam's `items_to_receive`). */
  readonly receive: OfferSideValue;
}

/** One item's price, or null when there is none. */
export function offerItemPrice(
  item: ItemIds,
  described: readonly DescribedItem[],
  priceOf: (marketHashName: string, dopplerPhase?: string) => { readonly raw: number } | null,
): number | null {
  const description = described.find(
    (entry) => entry.classid === item.classid && entry.instanceid === item.instanceid,
  );
  if (!description?.market_hash_name) return null;
  const dopplerPhase = typeof description.icon_url === 'string'
    ? getDopplerInfo(description.icon_url)?.name
    : undefined;
  return priceOf(description.market_hash_name, dopplerPhase)?.raw ?? null;
}

/** Both sides of one offer, summed. */
export function valueOffer<T>(
  offer: { readonly items_to_give?: readonly T[]; readonly items_to_receive?: readonly T[] },
  priceOf: (item: T) => number | null,
): OfferValue {
  const side = (items: readonly T[] | undefined): OfferSideValue => {
    let total = 0;
    let unpriced = false;
    for (const item of items ?? []) {
      const price = priceOf(item);
      if (price === null) unpriced = true;
      else total += price;
    }
    return { total, unpriced };
  };
  return { give: side(offer.items_to_give), receive: side(offer.items_to_receive) };
}
