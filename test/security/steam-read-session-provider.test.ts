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
