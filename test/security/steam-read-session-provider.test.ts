import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_PORTFOLIO_OFFERS_PER_RUN } from '../../src/shared/gateway-dto';
import {
  STEAM_OFFERS_TRUNCATED_WARNING,
  createSteamReadSessionProvider,
} from '../../src/background/steam-read-session-provider';

const STEAM_ID = '76561198000000000';

function tokenPage(url: string): Response {
  const response = new Response(
    '<div data-loyalty_webapi_token="abcdefghijklmnopqrstuvwxyz123456"></div>',
    { status: 200 },
  );
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function rawOffer(offerId: number, createdAt: number): Record<string, unknown> {
  return {
    tradeofferid: String(offerId),
    accountid_other: '123456',
    // 3 = Accepted: the only state the portfolio carries, so the cap and
    // ordering behaviour must be exercised with a record that survives the
    // state filter.
    trade_offer_state: 3,
    time_created: createdAt,
    items_to_give: [],
    items_to_receive: [],
  };
}

test('Steam offer read returns the deterministic newest 1,000 with a safe warning', async () => {
  const allOffers = Array.from(
    { length: MAX_PORTFOLIO_OFFERS_PER_RUN + 2 },
    (_, index) => rawOffer(index + 1, 1_700_000_000),
  );
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://steamcommunity.com/')) return tokenPage(url);
    assert.match(url, /IEconService\/GetTradeOffers\/v1/);
    return new Response(JSON.stringify({
      response: {
        descriptions: [],
        // Deliberately put the numerically oldest half first and split the
        // response: result ordering must not depend on Steam array ordering.
        trade_offers_received: allOffers.slice(0, 501),
        trade_offers_sent: allOffers.slice(501),
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const provider = createSteamReadSessionProvider({
    steamId: STEAM_ID,
    fetchImpl,
    now: () => 1_700_000_100_000,
  });

  const first = await provider.readTradeOffers();
  const second = await provider.readTradeOffers();

  assert.equal(first.complete, true);
  assert.equal(first.offers.length, MAX_PORTFOLIO_OFFERS_PER_RUN);
  assert.equal(first.warningCode, STEAM_OFFERS_TRUNCATED_WARNING);
  assert.equal(first.offers[0]?.offerId, '1002');
  assert.equal(first.offers.at(-1)?.offerId, '3');
  assert.deepEqual(
    second.offers.map((offer) => `${offer.createdAt}:${offer.offerId}:${offer.direction}`),
    first.offers.map((offer) => `${offer.createdAt}:${offer.offerId}:${offer.direction}`),
  );
});

test('Steam offer read omits the warning when the complete result is within the cap', async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://steamcommunity.com/')) return tokenPage(url);
    return new Response(JSON.stringify({
      response: {
        descriptions: [],
        trade_offers_received: [rawOffer(7, 1_700_000_001)],
        trade_offers_sent: [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const result = await createSteamReadSessionProvider({ steamId: STEAM_ID, fetchImpl })
    .readTradeOffers();

  assert.equal(result.offers.length, 1);
  assert.equal(result.warningCode, undefined);
});

test('Steam inventory read recovers the trade-hold end from the owner-only description', async () => {
  // Verified against a live account: Steam leaves `tradable_after` empty on
  // this read and ships the unlock instant as a BBCode token inside
  // `owner_descriptions`, which it serves only to the signed-in owner.
  const HOLD_ENDS_AT = 1_786_384_800;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://steamcommunity.com/')) return tokenPage(url);
    return new Response(JSON.stringify({
      response: {
        assets: [
          { appid: 730, contextid: '2', assetid: '111', classid: '9', instanceid: '0', amount: '1' },
          { appid: 730, contextid: '2', assetid: '222', classid: '8', instanceid: '0', amount: '1' },
        ],
        descriptions: [
          {
            classid: '9',
            instanceid: '0',
            market_hash_name: '★ Bayonet | Case Hardened (Battle-Scarred)',
            tradable: 1,
            marketable: 1,
            owner_descriptions: [
              { type: 'html', value: 'This item is listed on the Steam Community Market and cannot be consumed or modified while listed.' },
              { type: 'html', value: `This item is trade-protected and cannot be consumed, modified, or transferred until [date]${HOLD_ENDS_AT}[/date]` },
            ],
          },
          {
            classid: '8',
            instanceid: '0',
            market_hash_name: 'AK-47 | Redline (Field-Tested)',
            tradable: 1,
            marketable: 1,
            owner_descriptions: [
              { type: 'html', value: 'This item is listed on the Steam Community Market and cannot be consumed or modified while listed.' },
            ],
          },
        ],
        more_items: false,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const result = await createSteamReadSessionProvider({
    steamId: STEAM_ID,
    fetchImpl,
    now: () => (HOLD_ENDS_AT - 86_400) * 1_000,
  }).readInventoryContext('2');

  const held = result.items.find((item) => item.assetId === '111');
  const free = result.items.find((item) => item.assetId === '222');

  assert.equal(held?.tradableAfter, HOLD_ENDS_AT);
  // A dated hold in context 2 must report as held; before this parse the flag
  // only ever fired for context 16, so market-visible holds looked tradable.
  assert.equal(held?.onHold, true);
  // An owner-description without a date token is not a hold.
  assert.equal(free?.tradableAfter, undefined);
  assert.equal(free?.onHold, false);
});
