/*
  The scam warnings stand only on a loss (owner, 2026-09-28).

  A listed offer where the user provably comes out ahead or even gets no red
  block, no red frame and no second click. A loss, or a value that cannot be
  told (an item with no price on either side), keeps the warning. The value is
  the offers list's own P/L maths, lifted into `shared/offer-valuation.ts` so
  the badge and the warning cannot disagree.
*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { offerItemPrice, valueOffer, type OfferValue } from '../src/shared/offer-valuation.ts';
import { scamWarningStands } from '../src/shared/p2p-scam-offers.ts';

function value(give: number, receive: number, unpriced: { give?: boolean; receive?: boolean } = {}): OfferValue {
  return {
    give: { total: give, unpriced: unpriced.give ?? false },
    receive: { total: receive, unpriced: unpriced.receive ?? false },
  };
}

test('a loss keeps the warning', () => {
  assert.equal(scamWarningStands(value(100, 0)), true);
  assert.equal(scamWarningStands(value(100, 99.99)), true);
});

test('a profitable or even trade drops it', () => {
  assert.equal(scamWarningStands(value(100, 120)), false);
  assert.equal(scamWarningStands(value(100, 100)), false);
});

test('a value that cannot be told keeps it', () => {
  // Even when the priced part looks like a profit: the unpriced item could be the whole story.
  assert.equal(scamWarningStands(value(100, 500, { give: true })), true);
  assert.equal(scamWarningStands(value(100, 500, { receive: true })), true);
  assert.equal(scamWarningStands(null), true);
});

test('the valuation prices items the way the offers list does', () => {
  const described = [
    { classid: '1', instanceid: '0', market_hash_name: 'AK-47 | Redline (Field-Tested)' },
    { classid: '2', instanceid: '0', market_hash_name: 'AWP | Asiimov (Field-Tested)' },
    { classid: '3', instanceid: '0', market_hash_name: 'Unpriced Sticker' },
  ];
  const prices: Record<string, number> = {
    'AK-47 | Redline (Field-Tested)': 30,
    'AWP | Asiimov (Field-Tested)': 90,
  };
  const priceOf = (name: string) => (name in prices ? { raw: prices[name]! } : null);
  const price = (item: { classid: string; instanceid: string }) => offerItemPrice(item, described, priceOf);

  // The farm shape: the user gives, gets nothing.
  const farm = valueOffer({ items_to_give: [{ classid: '2', instanceid: '0' }], items_to_receive: [] }, price);
  assert.deepEqual(farm, { give: { total: 90, unpriced: false }, receive: { total: 0, unpriced: false } });
  assert.equal(scamWarningStands(farm), true);

  // A fair swap for more than it costs him.
  const swap = valueOffer({
    items_to_give: [{ classid: '1', instanceid: '0' }],
    items_to_receive: [{ classid: '2', instanceid: '0' }],
  }, price);
  assert.equal(scamWarningStands(swap), false);

  // No price, or no description at all, is unpriced, not zero.
  const blind = valueOffer({
    items_to_give: [{ classid: '1', instanceid: '0' }],
    items_to_receive: [{ classid: '2', instanceid: '0' }, { classid: '3', instanceid: '0' }, { classid: '9', instanceid: '0' }],
  }, price);
  assert.equal(blind.receive.unpriced, true);
  assert.equal(blind.receive.total, 90);
  assert.equal(scamWarningStands(blind), true);
});

test('the offers list P/L badge uses the same valuation', async () => {
  const { readFileSync } = await import('node:fs');
  const list = readFileSync(new URL('../src/content-scripts/steam/trade-offers.ts', import.meta.url), 'utf8');
  assert.match(list, /const value = valueOffer\(/);
  assert.match(list, /offerItemPrice\(item, items, \(name, phase\) => priceEngine\.getPrice\(name, phase\)\)/);
  const page = readFileSync(new URL('../src/content-scripts/steam/p2p-scam-warning.ts', import.meta.url), 'utf8');
  assert.match(page, /offerItemPrice\(item, items, \(name, phase\) => priceEngine\.getPrice\(name, phase\)\)/);
  assert.match(page, /scamWarningStands\(/);
});
