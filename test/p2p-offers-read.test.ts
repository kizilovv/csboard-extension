/*
  The P2P tracker's offers read (2026-09-26).

  The site put up "the extension cannot see Steam" on the owner's /p2p after a
  single failed GetTradeOffers, and the report said only
  "GatewayPayloadError: INVALID_PAYLOAD", the same words for a 429, a 502 and a
  lost session. Two things are pinned down here: the tracker's read no longer
  asks for the description table it never used (CSFloat's tracker does not
  either), and the error that leaves the browser keeps its reason and status.
  That both reads in the pass use it is pinned in live-settings.test.ts.
*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { createSteamReadSessionProvider } from '../src/background/steam-read-session-provider.ts';
import { describeError, GatewayPayloadError } from '../src/shared/gateway-dto.ts';

const STEAM_ID = '76561198000000001';

function offersProvider(status = 200) {
  const urls: string[] = [];
  const provider = createSteamReadSessionProvider({
    steamId: STEAM_ID,
    now: () => Date.UTC(2026, 8, 26),
    fetchImpl: (async (input: unknown) => {
      urls.push(String(input));
      if (status !== 200) return new Response('', { status });
      return new Response(JSON.stringify({
        response: {
          trade_offers_sent: [{
            tradeofferid: '9200000001',
            accountid_other: '123456789',
            trade_offer_state: 2,
            time_created: 1790000000,
            items_to_give: [{
              appid: '730', contextid: '2', assetid: '50000000001',
              classid: '3745384988', instanceid: '188530170', amount: '1',
            }],
            items_to_receive: [],
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  provider.offerAccessToken('a'.repeat(40), STEAM_ID);
  return { provider, urls };
}

test('the tracker read asks Steam for no descriptions and still gets the items', async () => {
  const { provider, urls } = offersProvider();
  const result = await provider.readTradeOffersForDisplay({ received: false, descriptions: false });
  const query = new URL(urls[0]!).searchParams;
  assert.equal(query.get('get_descriptions'), null);
  assert.equal(query.get('get_received_offers'), '0');
  assert.deepEqual(result.offers.map((offer) => offer.items_to_give.map((item) => item.assetid)), [['50000000001']]);
  assert.equal(result.offers[0]?.trade_offer_state, 2);
});

test('the page read still asks for descriptions', async () => {
  const { provider, urls } = offersProvider();
  await provider.readTradeOffersForDisplay({ received: false });
  assert.equal(new URL(urls[0]!).searchParams.get('get_descriptions'), '1');
});

test('a failed Steam read reports its status, not only its class', async () => {
  const { provider } = offersProvider(429);
  const error = await provider.readTradeOffersForDisplay({ received: false, descriptions: false })
    .then(() => null, (caught: unknown) => caught);
  assert.equal(
    describeError(error),
    'GatewayPayloadError: INVALID_PAYLOAD (reason=steam-read-failed, status=429)',
  );
});

test('describeError leaves other errors as String() had them', () => {
  assert.equal(describeError(new TypeError('Failed to fetch')), 'TypeError: Failed to fetch');
  assert.equal(describeError(new GatewayPayloadError('INVALID_PAYLOAD')), 'GatewayPayloadError: INVALID_PAYLOAD');
});
