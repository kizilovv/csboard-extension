/*
  The incoming-offer scam warning (prod incidents, 2026-09).

  Five P2P sellers accepted an INCOMING offer from a farm account that asked
  for the skin they had just sold on csboard, believing it was the delivery.
  csboard never sends a seller an offer; the seller always sends it. The rule
  fires only on that exact shape, because heavy traders receive "give items,
  get nothing" offers from bot sites all day and a warning on every one of them
  would be ignored by the time it mattered.
*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { before, beforeEach } from 'node:test';

import { createSteamReadSessionProvider } from '../src/background/steam-read-session-provider.ts';
import {
  P2P_SCAM_NOTIFIED_KEY,
  P2P_SCAM_OFFERS_KEY,
  accountIdFromSteamId64,
  findScamOffers,
  mergeScamFlags,
  readStoredScamFlags,
  type ScamGuardOffer,
  type ScamGuardSale,
} from '../src/shared/p2p-scam-offers.ts';

const BUYER_STEAM_ID = '76561198100000001';
const BUYER_ACCOUNT_ID = '139734273';
const FARM_ACCOUNT_ID = '1822334455';
const SOLD_ASSET = '41000000001';
const LISTED_ASSET = '41000000009';

const sold: ScamGuardSale = {
  orderId: 'order-sold',
  status: 'trade_pending',
  assetId: SOLD_ASSET,
  buyerSteamId: BUYER_STEAM_ID,
};

function offer(overrides: Partial<ScamGuardOffer> = {}): ScamGuardOffer {
  return {
    offerId: '8100000001',
    direction: 'received',
    state: 2,
    partnerAccountId: FARM_ACCOUNT_ID,
    givenAssetIds: [SOLD_ASSET, LISTED_ASSET],
    ...overrides,
  };
}

test('the buyer SteamID64 maps onto Steam\'s 32-bit accountid_other', () => {
  assert.equal(accountIdFromSteamId64(BUYER_STEAM_ID), BUYER_ACCOUNT_ID);
  assert.equal(accountIdFromSteamId64('123'), null);
  assert.equal(accountIdFromSteamId64('76561197960265728'), null);
});

test('the farm case is flagged: a stranger asks for the sold skin', () => {
  assert.deepEqual(findScamOffers([offer()], [sold]), [{
    offerId: '8100000001',
    orderIds: ['order-sold'],
    assetIds: [SOLD_ASSET],
    partnerAccountId: FARM_ACCOUNT_ID,
  }]);
  // Needs-confirmation counts as active too.
  assert.equal(findScamOffers([offer({ state: 9 })], [sold]).length, 1);
});

test('what the seller would receive does not matter: a junk skin back does not hide it', () => {
  // The rule has no "receives nothing" condition to satisfy; givenAssetIds is
  // the only item list it reads.
  assert.equal(findScamOffers([offer({ givenAssetIds: [SOLD_ASSET] })], [sold]).length, 1);
});

test('the buyer\'s own offer for the sold skin is not flagged', () => {
  assert.deepEqual(findScamOffers([offer({ partnerAccountId: BUYER_ACCOUNT_ID })], [sold]), []);
});

test('an offer asking only for listed, unsold items is not flagged', () => {
  assert.deepEqual(findScamOffers([offer({ givenAssetIds: [LISTED_ASSET] })], [sold]), []);
  // Nor for an item whose sale is over.
  for (const status of ['completed', 'trade_expired', 'cancelled', 'refunded']) {
    assert.deepEqual(findScamOffers([offer()], [{ ...sold, status }]), [], status);
  }
});

test('an offer the seller SENT is never flagged', () => {
  assert.deepEqual(findScamOffers([offer({ direction: 'sent' })], [sold]), []);
});

test('a sale without a known buyer flags nothing', () => {
  assert.deepEqual(findScamOffers([offer()], [{ ...sold, buyerSteamId: null }]), []);
  // Even when another live sale of the same asset names a buyer: the unknown one could be the partner.
  assert.deepEqual(findScamOffers([offer()], [sold, { ...sold, orderId: 'order-2', buyerSteamId: null }]), []);
});

test('an offer that is no longer active is not flagged', () => {
  for (const state of [3, 4, 5, 6, 7, 8, 10, 11]) {
    assert.deepEqual(findScamOffers([offer({ state })], [sold]), [], `state ${state}`);
  }
});

test('an unreadable partner is not flagged', () => {
  assert.deepEqual(findScamOffers([offer({ partnerAccountId: '' })], [sold]), []);
});

test('stored flags outlive the sale while the offer is active, and not a moment longer', () => {
  const flag = findScamOffers([offer()], [sold])[0]!;
  assert.deepEqual(mergeScamFlags([flag], [], new Set(['8100000001'])), [flag]);
  assert.deepEqual(mergeScamFlags([flag], [], new Set()), []);
  assert.deepEqual(readStoredScamFlags([flag, { offerId: 'x' }, null, 'junk']), [flag]);
  assert.deepEqual(readStoredScamFlags(undefined), []);
});

/*
  The background pass: a failed read never produces a warning, a match is
  stored for the pages and announced exactly once, and flags go when the offer
  does.
*/

const local: Record<string, unknown> = {};
const notifications: Array<{ id: string; title: string; message: string }> = [];
let salesStatus = 200;
let deliveryRows: unknown[] = [];
let watchRows: unknown[] = [];

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
  runtime: {
    id: 'scam-test',
    getURL: (path: string) => `chrome-extension://scam-test/${path}`,
    getManifest: () => ({ version: '0.0.0-test' }),
  },
  i18n: { getUILanguage: () => 'en-US' },
  notifications: {
    create: async (id: string, options: { title: string; message: string }) => {
      notifications.push({ id, title: options.title, message: options.message });
      return id;
    },
    clear: async () => true,
    onClicked: { addListener() {} },
  },
  alarms: { create() {} },
  tabs: { create: async () => ({}) },
};

globalThis.fetch = (async (input: string | URL) => {
  const url = String(input);
  if (url.includes('/p2p/my/sales')) {
    const rows = url.includes('scope=watch') ? watchRows : deliveryRows;
    return new Response(JSON.stringify({ sales: rows }), {
      status: url.includes('scope=watch') ? salesStatus : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('', { status: 200 });
}) as typeof fetch;

let runP2PScamGuard: typeof import('../src/background/p2p-scam-guard.ts').runP2PScamGuard;
before(async () => {
  ({ runP2PScamGuard } = await import('../src/background/p2p-scam-guard.ts'));
});

beforeEach(() => {
  for (const key of Object.keys(local)) delete local[key];
  notifications.length = 0;
  salesStatus = 200;
  // The shape `/p2p/my/sales` returns today: `buyerSteamId64` on every row.
  deliveryRows = [{
    orderId: 'order-sold',
    status: 'pending',
    assetId: SOLD_ASSET,
    steamTradeOfferId: null,
    buyerSteamId64: BUYER_STEAM_ID,
  }];
  watchRows = [];
});

test('a failed Steam read produces no flag and no notification', async () => {
  await runP2PScamGuard(async () => { throw new Error('steam-read-failed'); });
  assert.equal(local[P2P_SCAM_OFFERS_KEY], undefined);
  assert.deepEqual(notifications, []);
});

test('a failed csboard read produces no flag and does not even ask Steam', async () => {
  salesStatus = 500;
  let steamReads = 0;
  await runP2PScamGuard(async () => { steamReads += 1; return [offer()]; });
  assert.equal(steamReads, 0);
  assert.equal(local[P2P_SCAM_OFFERS_KEY], undefined);
  assert.deepEqual(notifications, []);
});

test('the farm offer is stored for the pages and announced once', async () => {
  await runP2PScamGuard(async () => [offer(), offer({ offerId: '8100000002', partnerAccountId: BUYER_ACCOUNT_ID })]);
  assert.deepEqual(
    readStoredScamFlags(local[P2P_SCAM_OFFERS_KEY]).map((flag) => flag.offerId),
    ['8100000001'],
  );
  assert.deepEqual(notifications.map((note) => note.id), ['csboard-scam-offer:8100000001']);
  assert.equal(notifications[0]?.title, 'Careful: this is not your CSBoard buyer');
  assert.doesNotMatch(`${notifications[0]?.title} ${notifications[0]?.message}`, /—/);

  // The next pass sees the same offer: still flagged, not announced again.
  await runP2PScamGuard(async () => [offer()]);
  assert.equal(notifications.length, 1);
  assert.deepEqual(local[P2P_SCAM_NOTIFIED_KEY], ['8100000001']);

  // The offer is gone from the inbox (declined, accepted, expired): so is the flag.
  await runP2PScamGuard(async () => []);
  assert.deepEqual(local[P2P_SCAM_OFFERS_KEY], []);
  assert.deepEqual(local[P2P_SCAM_NOTIFIED_KEY], []);
});

test('the new buyerSteamId field is read too, and a row without either is left out', async () => {
  deliveryRows = [{ orderId: 'order-sold', status: 'pending', assetId: SOLD_ASSET, buyerSteamId: BUYER_STEAM_ID }];
  await runP2PScamGuard(async () => [offer()]);
  assert.equal(notifications.length, 1);

  for (const key of Object.keys(local)) delete local[key];
  notifications.length = 0;
  deliveryRows = [{ orderId: 'order-sold', status: 'pending', assetId: SOLD_ASSET, buyerSteamId: null }];
  await runP2PScamGuard(async () => [offer()]);
  assert.deepEqual(notifications, []);
  assert.deepEqual(local[P2P_SCAM_OFFERS_KEY] ?? [], []);
});

test('the inbox read asks Steam for received, active offers only, without descriptions', async () => {
  const steamId = '76561198000000001';
  const now = Date.UTC(2026, 8, 28);
  const urls: string[] = [];
  const provider = createSteamReadSessionProvider({
    steamId,
    now: () => now,
    fetchImpl: (async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        response: {
          trade_offers_received: [{
            tradeofferid: '8100000001',
            accountid_other: FARM_ACCOUNT_ID,
            trade_offer_state: 2,
            time_created: 1790000000,
            items_to_give: [{ appid: '730', contextid: '2', assetid: SOLD_ASSET, classid: '1', instanceid: '0', amount: '1' }],
            items_to_receive: [],
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  provider.offerAccessToken('a'.repeat(40), steamId);

  const result = await provider.readTradeOffersForDisplay({ sent: false, activeOnly: true, descriptions: false });
  const query = new URL(urls[0]!).searchParams;
  assert.equal(query.get('get_sent_offers'), '0');
  assert.equal(query.get('get_received_offers'), '1');
  assert.equal(query.get('active_only'), '1');
  assert.equal(query.get('get_descriptions'), null);
  // A cutoff in the future: active offers, and none of the history.
  assert.ok(Number(query.get('time_historical_cutoff')) > now / 1000);
  // On a received offer, items_to_give is the seller's own side.
  assert.equal(result.offers[0]?.direction, 'received');
  assert.deepEqual(result.offers[0]?.items_to_give.map((item) => item.assetid), [SOLD_ASSET]);
});

/*
  The page halves run with the Steam site switch OFF too: turning off price
  overlays is not a choice to lose a sold skin. Pinned on the source because
  the gate is one line away and easy to wrap around everything.
*/
test('the offer pages start the warning outside the site switch', () => {
  for (const [file, starter] of [
    ['trade-offer', 'guardScamOfferPage'],
    ['trade-offers', 'markScamOffersOnList'],
  ] as const) {
    const source = readFileSync(new URL(`../src/content-scripts/steam/${file}.ts`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`const startScamGuard = \\(\\) => \\{ ${starter}\\(\\); \\};`), file);
    assert.match(source, /\n  startScamGuard\(\);\n  whenSiteEnabled\('steam', bootstrap\);\n\}/, file);
  }
  const page = readFileSync(new URL('../src/content-scripts/steam/p2p-scam-warning.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /\b(whenSiteEnabled|isSiteEnabled)\(/);
  // No native dialogs: they are what gets clicked through without reading.
  assert.doesNotMatch(page, /window\.(alert|confirm)\(/);
});
