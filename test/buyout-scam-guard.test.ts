/*
  The buyout API-key scam (owner, 2026-09-28).

  An instant sell to csboard ends in an INCOMING offer from a vendor bot that
  asks for the skins and gives nothing in Steam. A scammer with the user's
  stolen API key cancels that offer and sends a lookalike from his own bot.
  Flagged: an incoming active offer asking for a live leg's skin that is
  neither the leg's own offer nor from the leg's bot. Not flagged: anything we
  cannot tell apart from the real offer yet.
*/

import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';

import {
  BUYOUT_SCAM_OFFERS_KEY,
  buyoutFlagCleared,
  findBuyoutScamOffers,
  type BuyoutLeg,
} from '../src/shared/buyout-scam-offers.ts';
import { readStoredScamFlags, type ScamGuardOffer } from '../src/shared/p2p-scam-offers.ts';

const VENDOR_BOT = '76561198300000001';
const VENDOR_ACCOUNT = '339734273';
const SCAM_ACCOUNT = '1822334455';
const SOLD_ASSET = '42000000001';

const leg: BuyoutLeg = {
  id: 'leg-1',
  status: 'offer_sent',
  tradeOfferId: '8200000001',
  botSteamId: VENDOR_BOT,
  assetIds: [SOLD_ASSET, '42000000002'],
};

function offer(overrides: Partial<ScamGuardOffer> = {}): ScamGuardOffer {
  return {
    offerId: '8200000099',
    direction: 'received',
    state: 2,
    partnerAccountId: SCAM_ACCOUNT,
    givenAssetIds: [SOLD_ASSET],
    ...overrides,
  };
}

test('the vendor\'s own offer is not flagged', () => {
  assert.deepEqual(findBuyoutScamOffers([offer({ offerId: '8200000001', partnerAccountId: VENDOR_ACCOUNT })], [leg]), []);
  // Its id alone is enough, whoever Steam says sent it.
  assert.deepEqual(findBuyoutScamOffers([offer({ offerId: '8200000001' })], [leg]), []);
});

test('an offer from the leg\'s bot under a different id is not flagged', () => {
  assert.deepEqual(findBuyoutScamOffers([offer({ partnerAccountId: VENDOR_ACCOUNT })], [leg]), []);
});

test('a lookalike from another bot is flagged', () => {
  assert.deepEqual(findBuyoutScamOffers([offer()], [leg]), [{
    offerId: '8200000099',
    orderIds: ['leg-1'],
    assetIds: [SOLD_ASSET],
    partnerAccountId: SCAM_ACCOUNT,
  }]);
  // Also when only one of the two is known.
  assert.equal(findBuyoutScamOffers([offer()], [{ ...leg, botSteamId: null }]).length, 1);
  assert.equal(findBuyoutScamOffers([offer()], [{ ...leg, tradeOfferId: null }]).length, 1);
  assert.equal(findBuyoutScamOffers([offer({ state: 9 })], [leg]).length, 1);
});

test('a leg that knows neither its offer nor its bot flags nothing', () => {
  assert.deepEqual(findBuyoutScamOffers([offer()], [{ ...leg, tradeOfferId: null, botSteamId: null }]), []);
});

test('an asset in no live leg is not flagged', () => {
  assert.deepEqual(findBuyoutScamOffers([offer({ givenAssetIds: ['42000000777'] })], [leg]), []);
  assert.deepEqual(findBuyoutScamOffers([offer()], [{ ...leg, status: 'completed' }]), []);
});

test('sent offers and settled offers are not flagged', () => {
  assert.deepEqual(findBuyoutScamOffers([offer({ direction: 'sent' })], [leg]), []);
  for (const state of [3, 6, 7]) assert.deepEqual(findBuyoutScamOffers([offer({ state })], [leg]), [], `state ${state}`);
});

test('a flag is cleared once csboard names the offer or its bot as the vendor\'s', () => {
  const [flag] = findBuyoutScamOffers([offer()], [{ ...leg, tradeOfferId: null }]);
  assert.ok(flag);
  assert.equal(buyoutFlagCleared(flag, [{ ...leg, tradeOfferId: null }]), false);
  assert.equal(buyoutFlagCleared(flag, [{ ...leg, tradeOfferId: '8200000099' }]), true);
});

/* The background pass against `/market/sell/status`. */

const local: Record<string, unknown> = {};
let statusCode = 200;
let statusBody: unknown = {};

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
  runtime: { id: 'buyout-test', getManifest: () => ({ version: '0.0.0-test' }) },
  alarms: { create() {} },
};

const requested: string[] = [];
globalThis.fetch = (async (input: string | URL) => {
  const url = String(input);
  if (url.includes('/market/sell/status')) {
    requested.push(url);
    return new Response(JSON.stringify(statusBody), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('', { status: 200 });
}) as typeof fetch;

let runBuyoutScamGuard: typeof import('../src/background/buyout-scam-guard.ts').runBuyoutScamGuard;
before(async () => {
  ({ runBuyoutScamGuard } = await import('../src/background/buyout-scam-guard.ts'));
});

beforeEach(() => {
  for (const key of Object.keys(local)) delete local[key];
  statusCode = 200;
  statusBody = { activeSubOrders: [{ ...leg, botProfile: 'vendor', routedAdapter: 'x' }] };
});

const storedIds = () => readStoredScamFlags(local[BUYOUT_SCAM_OFFERS_KEY]).map((flag) => flag.offerId);

test('the lookalike is stored for the pages, from the csboard API the /sell page uses', async () => {
  await runBuyoutScamGuard(async () => [offer(), offer({ offerId: '8200000001', partnerAccountId: VENDOR_ACCOUNT })]);
  assert.match(requested.at(-1)!, /\/api\/market\/sell\/status$/);
  assert.deepEqual(storedIds(), ['8200000099']);
  // Gone from the inbox, gone from the list.
  await runBuyoutScamGuard(async () => []);
  assert.deepEqual(storedIds(), []);
});

test('failed reads, and a backend without assetIds, flag nothing', async () => {
  await runBuyoutScamGuard(async () => { throw new Error('steam-read-failed'); });
  assert.equal(local[BUYOUT_SCAM_OFFERS_KEY], undefined);

  statusCode = 500;
  let steamReads = 0;
  await runBuyoutScamGuard(async () => { steamReads += 1; return [offer()]; });
  assert.equal(steamReads, 0);
  assert.equal(local[BUYOUT_SCAM_OFFERS_KEY], undefined);

  statusCode = 200;
  const { assetIds: _dropped, ...oldLeg } = leg;
  statusBody = { activeSubOrders: [oldLeg] };
  await runBuyoutScamGuard(async () => [offer()]);
  assert.deepEqual(storedIds(), []);
});

test('a flag outlives its leg while the offer is active: the scam cancels the vendor\'s offer', async () => {
  await runBuyoutScamGuard(async () => [offer()]);
  assert.deepEqual(storedIds(), ['8200000099']);
  statusBody = { activeSubOrders: [] };
  await runBuyoutScamGuard(async () => [offer()]);
  assert.deepEqual(storedIds(), ['8200000099']);
});
