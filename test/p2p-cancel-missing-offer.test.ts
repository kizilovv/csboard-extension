/*
  A queued offer that is missing from the sent-offer list is not dead
  (2026-09-28).

  The cancellation pass used to confirm "cancelled, verified" to the backend for
  any queued offer it could not find in `readOffers()`, and that confirmation
  can finalise money. The list stops at the historical cutoff, a read can come
  back partial, and an ACCEPTED offer can be missing from it as easily as a
  cancelled one. Pinned here: the classification, the one-offer Steam read that
  now settles a missing offer, and a whole pass in which only Steam's own
  "dead" ever reaches `/p2p/ext/confirm-cancel`.
*/

import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';

import { createSteamReadSessionProvider } from '../src/background/steam-read-session-provider.ts';

const local: Record<string, unknown> = {};
const confirmed: string[] = [];
const tabsOpened: string[] = [];
let queue: Array<{ orderId: string; steamTradeOfferId: string }> = [];

(globalThis as Record<string, unknown>)['chrome'] = {
  storage: {
    local: {
      get: async (keys: string | string[]) => {
        const out: Record<string, unknown> = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) if (key in local) out[key] = local[key];
        return out;
      },
      set: async (values: Record<string, unknown>) => { Object.assign(local, values); },
      remove: async () => {},
    },
  },
  runtime: { id: 'cancel-test', getManifest: () => ({ version: '0.0.0-test' }) },
  alarms: { create() {} },
  tabs: {
    create: async ({ url }: { url: string }) => { tabsOpened.push(url); return { id: tabsOpened.length }; },
    sendMessage: async () => ({ ok: true }),
    remove: async () => {},
  },
};

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/p2p/ext/pending-cancellations')) {
    return new Response(JSON.stringify({ orders: queue }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.includes('/p2p/ext/confirm-cancel')) {
    confirmed.push(JSON.parse(String(init?.body)).orderId);
    return new Response('{}', { status: 200 });
  }
  // The csboard origin probe in shared/config.
  return new Response('', { status: 200 });
}) as typeof fetch;

let classifyQueuedOffer: typeof import('../src/background/p2p-trade-cancel.ts').classifyQueuedOffer;
let runP2PCancellations: typeof import('../src/background/p2p-trade-cancel.ts').runP2PCancellations;
before(async () => {
  ({ classifyQueuedOffer, runP2PCancellations } = await import('../src/background/p2p-trade-cancel.ts'));
});

beforeEach(() => {
  for (const key of Object.keys(local)) delete local[key];
  confirmed.length = 0;
  tabsOpened.length = 0;
});

test('missing is not dead, and accepted is not cancelled', () => {
  assert.equal(classifyQueuedOffer(undefined), 'missing');
  assert.equal(classifyQueuedOffer(null), 'missing');
  for (const state of [1, 4, 5, 6, 7, 8, 10]) assert.equal(classifyQueuedOffer(state), 'dead', `state ${state}`);
  assert.equal(classifyQueuedOffer(3), 'accepted');
  // Active and needs-confirmation can still deliver; in escrow is not over.
  for (const state of [2, 9, 11]) assert.equal(classifyQueuedOffer(state), 'live', `state ${state}`);
});

test('a missing offer is settled by its own Steam read, and only a dead one is confirmed', async () => {
  queue = [
    { orderId: 'o-accepted', steamTradeOfferId: '900001' },
    { orderId: 'o-dead', steamTradeOfferId: '900002' },
    { orderId: 'o-read-throws', steamTradeOfferId: '900003' },
    { orderId: 'o-read-empty', steamTradeOfferId: '900004' },
    { orderId: 'o-list-dead', steamTradeOfferId: '900005' },
  ];
  const singleStates: Record<string, number | null | Error> = {
    '900001': 3,
    '900002': 6,
    '900003': new Error('steam-read-failed'),
    '900004': null,
  };
  const singleReads: string[] = [];

  await runP2PCancellations(
    async () => [{ offerId: '900005', state: 7 }],
    async (offerId) => {
      singleReads.push(offerId);
      const answer = singleStates[offerId];
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
  );

  // Only Steam's own "dead" reaches the backend: from the list, or from the one-offer read.
  assert.deepEqual(confirmed.sort(), ['o-dead', 'o-list-dead']);
  // The list's answer needs no second read; every missing one got exactly one.
  assert.deepEqual(singleReads.sort(), ['900001', '900002', '900003', '900004']);
  // Accepted is left alone, and a failed read decides nothing: no cancel tab for either.
  assert.deepEqual(tabsOpened, []);
});

test('a live offer read on its own is cancelled, and the proof re-reads it on its own too', async () => {
  queue = [{ orderId: 'o-live', steamTradeOfferId: '900010' }];
  const answers = [2, 6];
  const singleReads: string[] = [];

  await runP2PCancellations(
    async () => [],
    async (offerId) => {
      singleReads.push(offerId);
      return answers.shift() ?? null;
    },
  );

  assert.deepEqual(tabsOpened, ['https://steamcommunity.com/tradeoffer/900010/']);
  assert.deepEqual(singleReads, ['900010', '900010']);
  assert.deepEqual(confirmed, ['o-live']);
});

test('a missing offer that is still live after the cancel is not confirmed', async () => {
  queue = [{ orderId: 'o-stuck', steamTradeOfferId: '900020' }];

  await runP2PCancellations(async () => [], async () => 2);

  assert.equal(tabsOpened.length, 1);
  assert.deepEqual(confirmed, []);
});

test('an accepted offer in the list gets no cancel tab and no confirmation', async () => {
  queue = [{ orderId: 'o-taken', steamTradeOfferId: '900030' }];
  let singleReads = 0;

  await runP2PCancellations(
    async () => [{ offerId: '900030', state: 3 }],
    async () => { singleReads += 1; return null; },
  );

  assert.deepEqual(tabsOpened, []);
  assert.deepEqual(confirmed, []);
  assert.equal(singleReads, 0);
});

test('the one-offer read asks GetTradeOffer for that id and returns its state', async () => {
  const steamId = '76561198000000001';
  const urls: string[] = [];
  let body: unknown = { response: { offer: { tradeofferid: '900040', trade_offer_state: 3 } } };
  const provider = createSteamReadSessionProvider({
    steamId,
    fetchImpl: (async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  provider.offerAccessToken('a'.repeat(40), steamId);

  assert.equal(await provider.readTradeOfferState('900040'), 3);
  const url = new URL(urls[0]!);
  assert.match(url.pathname, /\/IEconService\/GetTradeOffer\/v1\/$/);
  assert.equal(url.searchParams.get('tradeofferid'), '900040');

  // Steam answers an offer it will not show with an empty response: no answer, not "dead".
  body = { response: {} };
  assert.equal(await provider.readTradeOfferState('900040'), null);
  // A state for some other offer is not a state for this one.
  body = { response: { offer: { tradeofferid: '900041', trade_offer_state: 6 } } };
  assert.equal(await provider.readTradeOfferState('900040'), null);
  await assert.rejects(provider.readTradeOfferState('not-an-id'));
});
