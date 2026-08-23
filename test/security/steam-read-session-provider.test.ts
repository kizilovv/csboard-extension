import assert from 'node:assert/strict';
import test from 'node:test';

import { generateHex } from '@csfloat/cs2-inspect-serializer';

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
    tradeid: String(10_000 + offerId),
    message: offerId % 2 === 0
      ? 'Order completed via CSFloat.com'
      : 'BUFF163 purchase delivery',
    time_created: createdAt,
    items_to_give: [],
    items_to_receive: [],
  };
}

function rawTradeItem(assetId: string, contextId: string): Record<string, unknown> {
  return {
    appid: '730',
    contextid: contextId,
    assetid: assetId,
    classid: '100',
    instanceid: '0',
    amount: '1',
  };
}

test('Steam trade history uses post-trade ids only for received items', async () => {
  const given = {
    ...rawTradeItem('101', '2'),
    new_assetid: '901',
    new_contextid: '16',
  };
  const received = {
    ...rawTradeItem('202', '2'),
    new_assetid: '902',
    new_contextid: '16',
  };
  const receivedWithInvalidNewPair = {
    ...rawTradeItem('203', '2'),
    new_assetid: 'not-an-asset-id',
    new_contextid: '16',
  };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://steamcommunity.com/')) return tokenPage(url);
    assert.match(url, /IEconService\/GetTradeHistory\/v1/);
    return new Response(JSON.stringify({
      response: {
        descriptions: [],
        trades: [{
          tradeid: '3001',
          steamid_other: '76561198000000001',
          time_init: 1_700_000_001,
          assets_given: [given],
          assets_received: [received, receivedWithInvalidNewPair],
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const result = await createSteamReadSessionProvider({ steamId: STEAM_ID, fetchImpl })
    .readRecentTrades();

  assert.deepEqual(result.trades[0]?.itemsGiven[0], {
    appId: '730',
    contextId: '2',
    assetId: '101',
    classId: '100',
    instanceId: '0',
    amount: '1',
  });
  assert.deepEqual(result.trades[0]?.itemsReceived[0], {
    appId: '730',
    contextId: '16',
    assetId: '902',
    classId: '100',
    instanceId: '0',
    amount: '1',
  });
  assert.deepEqual(result.trades[0]?.itemsReceived[1], {
    appId: '730',
    contextId: '2',
    assetId: '203',
    classId: '100',
    instanceId: '0',
    amount: '1',
  });
});

test('Steam trade facts retain the trusted icon needed for exact phase identity', async () => {
  const iconPath = `phaseEvidence_${'a'.repeat(80)}/96fx96f`;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://steamcommunity.com/')) return tokenPage(url);
    return new Response(JSON.stringify({
      response: {
        descriptions: [{
          classid: '100',
          instanceid: '0',
          market_hash_name: '★ Karambit | Doppler (Factory New)',
          icon_url: iconPath,
        }],
        trades: [{
          tradeid: '3002',
          steamid_other: '76561198000000001',
          time_init: 1_700_000_002,
          assets_given: [rawTradeItem('102', '2')],
          assets_received: [],
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const result = await createSteamReadSessionProvider({ steamId: STEAM_ID, fetchImpl })
    .readRecentTrades();

  assert.deepEqual(result.trades[0]?.itemsGiven[0], {
    appId: '730',
    contextId: '2',
    assetId: '102',
    classId: '100',
    instanceId: '0',
    amount: '1',
    marketHashName: '★ Karambit | Doppler (Factory New)',
    iconUrl: `https://community.cloudflare.steamstatic.com/economy/image/${iconPath}`,
  });
});

test('Steam trade history sends the real cursor and exposes pagination metadata', async () => {
  let apiUrl = '';
  const fetchImpl = (async (input: RequestInfo | URL) => {
    apiUrl = String(input);
    return new Response(JSON.stringify({
      response: {
        more: 1,
        total_trades: 114,
        descriptions: [],
        trades: [{
          tradeid: '3003',
          steamid_other: '76561198000000001',
          time_init: 1_699_999_999,
          assets_given: [],
          assets_received: [],
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const provider = createSteamReadSessionProvider({ steamId: STEAM_ID, fetchImpl });
  provider.offerAccessToken('a'.repeat(40), STEAM_ID);

  const result = await provider.readRecentTrades(50, {
    cursor: {
      startAfterTime: 1_700_000_000,
      startAfterTradeId: '3004',
    },
    includeTotal: true,
  });

  const query = new URL(apiUrl).searchParams;
  assert.equal(query.get('max_trades'), '50');
  assert.equal(query.get('start_after_time'), '1700000000');
  assert.equal(query.get('start_after_tradeid'), '3004');
  assert.equal(query.get('navigating_back'), 'false');
  assert.equal(query.get('include_failed'), 'false');
  assert.equal(query.get('include_total'), 'true');
  assert.equal(result.hasMore, true);
  assert.equal(result.totalTrades, 114);
  assert.equal(result.trades[0]?.tradeId, '3003');
});

test('a first-party token remains memory-usable across the hourly sync boundary', () => {
  let now = 2_000_000_000_000;
  const provider = createSteamReadSessionProvider({
    steamId: STEAM_ID,
    fetchImpl: (async () => {
      throw new Error('network must not be touched by the memory-only status check');
    }) as typeof fetch,
    now: () => now,
  });
  provider.offerAccessToken('a'.repeat(40), STEAM_ID);

  now += 61 * 60 * 1_000;
  assert.equal(provider.hasUsableAccessToken?.(), true);
});

test('explicit token refresh replaces the private credential without exposing it', async () => {
  const oldToken = 'a'.repeat(40);
  const freshToken = 'b'.repeat(40);
  const requestedApiTokens: string[] = [];
  let tokenPageReads = 0;
  const provider = createSteamReadSessionProvider({
    steamId: STEAM_ID,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://steamcommunity.com/')) {
        tokenPageReads += 1;
        const response = new Response(
          `<script>var g_steamID = "${STEAM_ID}";</script>` +
          `<div data-loyalty_webapi_token="${freshToken}"></div>`,
          { status: 200 },
        );
        Object.defineProperty(response, 'url', { value: url });
        return response;
      }
      requestedApiTokens.push(new URL(url).searchParams.get('access_token') ?? '');
      return new Response(JSON.stringify({
        response: { trades: [], descriptions: [], more: false, total_trades: 0 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  });
  provider.offerAccessToken(oldToken, STEAM_ID);

  await provider.refreshAccessToken?.();
  await provider.readRecentTrades(1, { includeTotal: true });

  assert.equal(tokenPageReads, 1);
  assert.deepEqual(requestedApiTokens, [freshToken]);
  assert.equal('accessToken' in provider, false);
});

test('accepted Steam offers use post-trade ids only for received items', async () => {
  const offer = {
    ...rawOffer(30, 1_700_000_030),
    items_to_give: [{
      ...rawTradeItem('303', '2'),
      new_assetid: '903',
      new_contextid: '16',
    }],
    items_to_receive: [{
      ...rawTradeItem('404', '2'),
      new_assetid: '904',
      new_contextid: '16',
    }],
  };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://steamcommunity.com/')) return tokenPage(url);
    assert.match(url, /IEconService\/GetTradeOffers\/v1/);
    return new Response(JSON.stringify({
      response: {
        descriptions: [],
        trade_offers_received: [offer],
        trade_offers_sent: [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const result = await createSteamReadSessionProvider({ steamId: STEAM_ID, fetchImpl })
    .readTradeOffers();

  assert.deepEqual(result.offers[0]?.itemsToGive[0], {
    appId: '730',
    contextId: '2',
    assetId: '303',
    classId: '100',
    instanceId: '0',
    amount: '1',
  });
  assert.deepEqual(result.offers[0]?.itemsToReceive[0], {
    appId: '730',
    contextId: '16',
    assetId: '904',
    classId: '100',
    instanceId: '0',
    amount: '1',
  });
});

test('accepted Steam offers omit zero timestamp sentinels and preserve positive epoch seconds', async () => {
  const offers = [
    { ...rawOffer(31, 1_700_000_031), expiration_time: 0, escrow_end_date: 0 },
    { ...rawOffer(32, 1_700_000_032), expiration_time: '0', escrow_end_date: '0' },
    {
      ...rawOffer(33, 1_700_000_033),
      expiration_time: 1_800_000_032,
      escrow_end_date: 1_800_000_033,
    },
  ];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://steamcommunity.com/')) return tokenPage(url);
    assert.match(url, /IEconService\/GetTradeOffers\/v1/);
    return new Response(JSON.stringify({
      response: {
        descriptions: [],
        trade_offers_received: offers,
        trade_offers_sent: [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const result = await createSteamReadSessionProvider({ steamId: STEAM_ID, fetchImpl })
    .readTradeOffers();
  const byOfferId = new Map(result.offers.map((offer) => [offer.offerId, offer]));

  assert.equal(Object.hasOwn(byOfferId.get('31') ?? {}, 'escrowEndAt'), false);
  assert.equal(Object.hasOwn(byOfferId.get('32') ?? {}, 'escrowEndAt'), false);
  assert.equal(byOfferId.get('33')?.escrowEndAt, 1_800_000_033);
  assert.equal(Object.hasOwn(byOfferId.get('31') ?? {}, 'expiresAt'), false);
  assert.equal(Object.hasOwn(byOfferId.get('32') ?? {}, 'expiresAt'), false);
  assert.equal(byOfferId.get('33')?.expiresAt, 1_800_000_032);
});

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
  assert.equal(result.offers[0]?.completedTradeId, '10007');
  assert.equal(result.offers[0]?.marketplaceHint, 'buff163');
});

test('Steam offer cap and warning count accepted rows only', async () => {
  const ignoredOffers = Array.from(
    { length: MAX_PORTFOLIO_OFFERS_PER_RUN + 2 },
    (_, index) => ({
      ...rawOffer(index + 1, 1_700_000_000 + index),
      trade_offer_state: index % 2 === 0 ? 6 : 7,
    }),
  );
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://steamcommunity.com/')) return tokenPage(url);
    return new Response(JSON.stringify({
      response: {
        descriptions: [],
        trade_offers_received: ignoredOffers,
        trade_offers_sent: [rawOffer(2_000, 1_800_000_000)],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const result = await createSteamReadSessionProvider({ steamId: STEAM_ID, fetchImpl })
    .readTradeOffers();

  assert.deepEqual(result.offers.map((offer) => offer.offerId), ['2000']);
  assert.equal(result.warningCode, undefined);
});

test('Steam offer read derives only an allowlisted marketplace hint and never uploads the note', async () => {
  const offers = [
    { ...rawOffer(8, 1_700_000_008), message: 'https://csfloat.com/item/123 secret note' },
    { ...rawOffer(9, 1_700_000_009), message: 'ordinary private trade note' },
    { ...rawOffer(7, 1_700_000_007), message: 'buff or csfloat — not sure' },
    { ...rawOffer(10, 1_700_000_010), message: 'this skin needs a buff' },
    { ...rawOffer(11, 1_700_000_011), message: 'BUFF' },
    { ...rawOffer(12, 1_700_000_012), message: 'BUFF163 purchase delivery' },
    { ...rawOffer(13, 1_700_000_013), message: 'buff.163.com order' },
    { ...rawOffer(14, 1_700_000_014), message: 'buff.market order' },
    { ...rawOffer(15, 1_700_000_015), message: 'buffalo delivery' },
    { ...rawOffer(16, 1_700_000_016), message: 'buffering purchase' },
    { ...rawOffer(17, 1_700_000_017), message: 'CSGOFloat.com order' },
    { ...rawOffer(18, 1_700_000_018), message: 'BUFF163 plus CSGOFloat' },
    { ...rawOffer(19, 1_700_000_019), message: 'via buff' },
    { ...rawOffer(20, 1_700_000_020), message: 'buff order' },
  ];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://steamcommunity.com/')) return tokenPage(url);
    return new Response(JSON.stringify({
      response: {
        descriptions: [],
        trade_offers_received: offers,
        trade_offers_sent: [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const result = await createSteamReadSessionProvider({ steamId: STEAM_ID, fetchImpl })
    .readTradeOffers();

  const marketplaceHints = Object.fromEntries(
    result.offers.map((offer) => [offer.offerId, offer.marketplaceHint]),
  );
  assert.deepEqual(marketplaceHints, {
    '7': undefined,
    '8': 'csfloat',
    '9': undefined,
    '10': undefined,
    '11': 'buff163',
    '12': 'buff163',
    '13': 'buff163',
    '14': 'buff163',
    '15': undefined,
    '16': undefined,
    '17': 'csfloat',
    '18': undefined,
    '19': 'buff163',
    '20': 'buff163',
  });
  for (const offer of result.offers) {
    assert.equal('message' in (offer as unknown as Record<string, unknown>), false);
  }
});

test('Steam portfolio offer read ignores non-accepted rows before touching private fields', async () => {
  const privateReads: string[] = [];
  const guardedOffer = (offerId: number, state: number): Record<string, unknown> => {
    const offer: Record<string, unknown> = {
      trade_offer_state: state,
      time_created: 1_700_000_000 + offerId,
    };
    const privateFields: Record<string, unknown> = {
      tradeofferid: String(offerId),
      accountid_other: '123456',
      tradeid: String(20_000 + offerId),
      message: 'private CSFloat order note',
      expiration_time: 1_800_000_000,
      escrow_end_date: 1_800_000_001,
      items_to_give: [],
      items_to_receive: [],
    };
    for (const [field, value] of Object.entries(privateFields)) {
      Object.defineProperty(offer, field, {
        enumerable: true,
        get() {
          privateReads.push(`${state}:${field}`);
          return value;
        },
      });
    }
    return offer;
  };
  const apiResponse = {
    ok: true,
    status: 200,
    async json() {
      return {
        response: {
          descriptions: [],
          trade_offers_received: [
            guardedOffer(20, 2), // active
            guardedOffer(21, 7), // declined
          ],
          trade_offers_sent: [
            guardedOffer(22, 6), // cancelled
            rawOffer(23, 1_700_000_023),
          ],
        },
      };
    },
  } as unknown as Response;
  const provider = createSteamReadSessionProvider({
    steamId: STEAM_ID,
    fetchImpl: (async () => apiResponse) as typeof fetch,
  });
  provider.offerAccessToken('a'.repeat(40), STEAM_ID);

  const result = await provider.readTradeOffers();

  assert.deepEqual(privateReads, []);
  assert.deepEqual(result.offers.map((offer) => offer.offerId), ['23']);
  assert.equal(result.offers[0]?.marketplaceHint, 'buff163');
});

test('Steam portfolio offer read skips malformed non-accepted rows before accepted-only validation', async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://steamcommunity.com/')) return tokenPage(url);
    return new Response(JSON.stringify({
      response: {
        descriptions: [],
        trade_offers_received: [
          { trade_offer_state: 2 },
          rawOffer(24, 1_700_000_024),
        ],
        trade_offers_sent: [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const result = await createSteamReadSessionProvider({ steamId: STEAM_ID, fetchImpl })
    .readTradeOffers();

  assert.deepEqual(result.offers.map((offer) => offer.offerId), ['24']);
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

test('Steam inventory read decodes exact float metadata from the inspect certificate', async () => {
  const certificate = generateHex({
    itemid: 333n,
    defindex: 7,
    paintindex: 474,
    paintseed: 306,
    paintwear: 0.6336590647697449,
    stickers: [],
    keychains: [],
    variations: [],
  });
  const fetchImpl = (async () => new Response(JSON.stringify({
    response: {
      assets: [
        { appid: 730, contextid: '2', assetid: '333', classid: '9', instanceid: '0', amount: '1' },
      ],
      descriptions: [
        {
          classid: '9',
          instanceid: '0',
          market_hash_name: 'AK-47 | Legacy (Battle-Scarred)',
          tradable: 1,
          marketable: 1,
        },
      ],
      asset_properties: [
        {
          assetid: '333',
          asset_properties: [{ propertyid: 6, string_value: certificate }],
        },
      ],
      more_items: false,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const provider = createSteamReadSessionProvider({ steamId: STEAM_ID, fetchImpl });
  provider.offerAccessToken('a'.repeat(40), STEAM_ID);

  const result = await provider.readInventoryContext('2');
  const item = result.items[0];

  assert.ok(item?.floatValue !== undefined);
  assert.ok(Math.abs(item.floatValue - 0.6336590647697449) < 1e-7);
  assert.equal(item.paintSeed, 306);
  assert.equal(item.defIndex, 7);
  assert.equal(item.paintIndex, 474);
});

test('Steam inventory read accepts asset_properties object maps keyed by asset id', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    response: {
      assets: [
        { appid: 730, contextid: '2', assetid: '444', classid: '10', instanceid: '0', amount: '1' },
      ],
      descriptions: [
        {
          classid: '10',
          instanceid: '0',
          market_hash_name: 'M4A1-S | Printstream (Field-Tested)',
          tradable: 1,
          marketable: 1,
        },
      ],
      asset_properties: {
        '444': {
          seed: { propertyid: '1', int_value: '581' },
          float: { propertyid: '2', float_value: '0.31492' },
        },
      },
      more_items: false,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const provider = createSteamReadSessionProvider({ steamId: STEAM_ID, fetchImpl });
  provider.offerAccessToken('a'.repeat(40), STEAM_ID);

  const result = await provider.readInventoryContext('2');
  const item = result.items[0];

  assert.equal(item?.floatValue, 0.31492);
  assert.equal(item?.paintSeed, 581);
});
