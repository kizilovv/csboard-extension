import assert from 'node:assert/strict';
import test, { before } from 'node:test';

/*
  2026-10-02: a seller's browser was open and signed in, the extension reported
  in every minute, and his payout still waited — the offers read was failing
  and the pass stopped there, so the trade history the payout needed was never
  read at all.
*/

const HOLD_ENDED = Date.now() - 60 * 60_000;
const posts: Array<{ path: string; body: Record<string, unknown> }> = [];

(globalThis as Record<string, unknown>)['chrome'] = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
    },
  },
  runtime: { id: 'track-test', getManifest: () => ({ version: '0.0.0-test' }) },
  alarms: { create() {} },
};

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  if (init?.method === 'POST') {
    posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return json({});
  }
  if (url.pathname.endsWith('/p2p/my/sales') && url.searchParams.get('scope') === 'watch') {
    return json([{
      orderId: 'order-1',
      steamTradeOfferId: '9001',
      assetIdToGive: '555',
      holdUntil: new Date(HOLD_ENDED).toISOString(),
    }]);
  }
  return json([]);
}) as typeof fetch;

let trackP2PTrades: typeof import('../src/background/p2p-trade-tracker.ts').trackP2PTrades;
before(async () => {
  ({ trackP2PTrades } = await import('../src/background/p2p-trade-tracker.ts'));
});

test('a failed offers read does not cost the history read a payout is waiting on', async () => {
  posts.length = 0;
  let historyAsked: { assetIds: readonly string[] } | null = null;

  const outcome = await trackP2PTrades(
    async () => { throw new Error('steam-read-failed, status=403'); },
    async (want) => {
      historyAsked = want;
      return [{
        tradeId: '7001',
        status: 3,
        givenAssetIds: ['555'],
        receivedAssetIds: [],
        partnerSteamId: '76561198000000001',
        occurredAt: HOLD_ENDED - 7 * 24 * 60 * 60_000,
      }];
    },
  );

  assert.match(outcome.errors.offers ?? '', /403/);
  assert.equal(outcome.errors.history, undefined);
  assert.deepEqual(historyAsked?.assetIds, ['555']);

  // No offer was seen, so no offer state is claimed; the completed trade is.
  assert.equal(posts.some((post) => post.path.endsWith('/p2p/ext/trade-status')), false);
  const history = posts.filter((post) => post.path.endsWith('/p2p/ext/trade-history'));
  assert.equal(history.length, 1);
  assert.equal(history[0]?.body['orderId'], 'order-1');
  assert.equal(history[0]?.body['steamTradeId'], '7001');
  assert.equal(history[0]?.body['status'], 3);
});
