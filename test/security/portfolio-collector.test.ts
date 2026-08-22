import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GatewayPayloadError,
  MAX_GATEWAY_CHUNKS_PER_RUN,
  MAX_PORTFOLIO_INVENTORY_ITEMS_PER_RUN,
  MAX_PORTFOLIO_TRADES_PER_RUN,
  TARGET_GATEWAY_CHUNK_BYTES,
  byteLengthOfCanonicalJson,
  type PortfolioItemDto,
  type PortfolioOfferDto,
  type PortfolioSnapshot,
  type PortfolioTradeDto,
} from '../../src/shared/gateway-dto';
import { assertPortfolioSnapshot } from '../../src/shared/portfolio-dto';
import { createRetryingLazyPromise } from '../../src/shared/retrying-lazy-promise';
import {
  TRADE_HISTORY_TRUNCATED_WARNING,
  collectPortfolioSync,
} from '../../src/background/portfolio-collector';
import type { SteamReadSessionProvider } from '../../src/background/steam-read-session-provider';
import { STEAM_OFFERS_TRUNCATED_WARNING } from '../../src/background/steam-read-session-provider';

const STEAM_ID = '76561198000000000';

function item(assetId: string, contextId: '2' | '16'): PortfolioItemDto {
  return {
    appId: '730',
    contextId,
    assetId,
    classId: `10${assetId}`,
    instanceId: '0',
    amount: '1',
    marketHashName: `AK-47 | Test ${assetId} (Field-Tested)`,
    tradable: true,
    marketable: true,
    onHold: false,
  };
}

const trade: PortfolioTradeDto = {
  tradeId: '9001',
  partnerSteamId: '76561198000000001',
  occurredAt: 1_700_000_000,
  itemsGiven: [],
  itemsReceived: [],
};

function tradeAt(tradeId: string, occurredAt: number): PortfolioTradeDto {
  return { ...trade, tradeId, occurredAt };
}

const offer: PortfolioOfferDto = {
  offerId: '8001',
  direction: 'received',
  partnerAccountId: '123456',
  // 3 = Accepted. The portfolio deliberately carries only offers that moved
  // items; an in-flight offer is a P2P concern and is filtered out.
  state: 3,
  createdAt: 1_700_000_100,
  itemsToGive: [],
  itemsToReceive: [],
};

function provider(overrides: Partial<SteamReadSessionProvider> = {}): SteamReadSessionProvider {
  return {
    async readInventoryContext(contextId) {
      return {
        contextId,
        complete: true,
        items: [item(contextId === '2' ? '1001' : '1601', contextId)],
      };
    },
    async readRecentTrades() {
      return { complete: true, trades: [trade] };
    },
    async readTradeOffers() {
      return { complete: true, offers: [offer] };
    },
    async readTradeOffersForDisplay() {
      return { complete: true as const, offers: [] };
    },
    forgetSession() {},
    ...overrides,
  };
}

test('portfolio collector isolates append-only Steam source failures', async () => {
  const collected = await collectPortfolioSync({
    steamId: STEAM_ID,
    provider: provider({
      async readTradeOffers() {
        throw new Error('steam offers transient failure');
      },
    }),
    createSyncRunId: () => 'sync_run_partial_012345678901234',
    now: () => 1_700_000_200_000,
  });

  assert.equal(collected.summary.context2Items, 1);
  assert.equal(collected.summary.context16Items, 1);
  assert.equal(collected.summary.trades, 1);
  assert.equal(collected.summary.offers, 0);
  assert.deepEqual(collected.summary.failedSources, ['tradeOffers']);
  assert.deepEqual(collected.summary.warningCodes, []);
  assert.deepEqual(collected.snapshot.sources, {
    inventory: true,
    tradeHistory: true,
    tradeOffers: true,
  });
  assert.deepEqual(collected.chunks[0]?.sources, collected.snapshot.sources);
  assert.equal(collected.snapshot.completeness.inventoryContext2, true);
  assert.equal(collected.snapshot.completeness.inventoryContext16, true);
  assert.equal(collected.snapshot.completeness.trades, true);
  assert.equal(collected.snapshot.completeness.offers, false);
});

test('trade-history failure is recorded once with a safe source reason', async () => {
  const collected = await collectPortfolioSync({
    steamId: STEAM_ID,
    provider: provider({
      async readRecentTrades() {
        throw new GatewayPayloadError('INVALID_PAYLOAD', {
          reason: 'steam-read-failed',
          status: 429,
        });
      },
    }),
    createSyncRunId: () => 'sync_run_trade_failure_0123456789',
    now: () => 1_700_000_200_000,
  });

  assert.deepEqual(collected.summary.failedSources, ['tradeHistory']);
  assert.deepEqual(collected.summary.sourceFailureCodes, {
    tradeHistory: 'STEAM_RATE_LIMITED',
  });
  assert.equal(collected.snapshot.completeness.trades, false);
});

test('portfolio trade history starts at latest, paginates with real cursors, and deduplicates', async () => {
  const calls: Array<{
    maxTrades: number | undefined;
    cursor?: { startAfterTime: number; startAfterTradeId: string };
    includeTotal?: boolean;
  }> = [];
  const pages = [
    {
      trades: [tradeAt('5005', 1_776_816_000), tradeAt('5004', 1_776_815_000)],
      hasMore: true,
      totalTrades: 5,
    },
    {
      trades: [tradeAt('5004', 1_776_815_000), tradeAt('5003', 1_776_814_000)],
      hasMore: true,
    },
    {
      trades: [tradeAt('5002', 1_776_813_000), tradeAt('5001', 1_776_812_000)],
      hasMore: true,
    },
  ];
  const collected = await collectPortfolioSync({
    steamId: STEAM_ID,
    provider: provider({
      async readRecentTrades(maxTrades, options) {
        calls.push({
          maxTrades,
          ...(options?.cursor ? { cursor: options.cursor } : {}),
          ...(options?.includeTotal !== undefined ? { includeTotal: options.includeTotal } : {}),
        });
        const page = pages[calls.length - 1];
        assert.ok(page, 'collector exceeded the bounded page fixture');
        return { complete: true, icons: {}, nameColors: {}, ...page };
      },
    }),
    recentTradeLimit: 5,
    createSyncRunId: () => 'sync_run_trade_pages_012345678901',
    now: () => 1_776_816_000_000,
  });

  assert.equal(calls[0]?.cursor, undefined, 'every sync run must begin at the latest page');
  assert.equal(calls[0]?.includeTotal, true);
  assert.deepEqual(calls[1]?.cursor, {
    startAfterTime: 1_776_815_000,
    startAfterTradeId: '5004',
  });
  assert.deepEqual(calls[2]?.cursor, {
    startAfterTime: 1_776_814_000,
    startAfterTradeId: '5003',
  });
  assert.deepEqual(
    collected.snapshot.trades.map((entry) => entry.tradeId),
    ['5005', '5004', '5003', '5002', '5001'],
  );
  assert.equal(collected.snapshot.trades[0]?.occurredAt, 1_776_816_000);
  assert.equal(collected.snapshot.completeness.trades, true);
  assert.deepEqual(collected.summary.failedSources, []);
  assert.deepEqual(collected.summary.warningCodes, []);
});

test('trade-history run cap keeps the newest records and reports partial completeness', async () => {
  let calls = 0;
  const newest = Array.from(
    { length: MAX_PORTFOLIO_TRADES_PER_RUN },
    (_, index) => tradeAt(String(9_000 - index), 1_776_816_000 - index),
  );
  const collected = await collectPortfolioSync({
    steamId: STEAM_ID,
    provider: provider({
      async readRecentTrades(_maxTrades, options) {
        calls += 1;
        assert.equal(options?.cursor, undefined, 'the latest page must not inherit a stale cursor');
        return {
          complete: true,
          trades: newest,
          icons: {},
          nameColors: {},
          hasMore: true,
          totalTrades: 145,
        };
      },
    }),
    createSyncRunId: () => 'sync_run_trade_cap_01234567890123',
    now: () => 1_776_816_000_000,
  });

  assert.equal(calls, 1);
  assert.equal(collected.snapshot.trades.length, MAX_PORTFOLIO_TRADES_PER_RUN);
  assert.equal(collected.snapshot.trades[0]?.tradeId, '9000');
  assert.equal(collected.snapshot.completeness.trades, false);
  assert.deepEqual(collected.summary.failedSources, []);
  assert.ok(collected.summary.warningCodes.includes(TRADE_HISTORY_TRUNCATED_WARNING));
});

test('trade-history session failure gets one bounded refresh and page retry', async () => {
  let reads = 0;
  let refreshes = 0;
  const collected = await collectPortfolioSync({
    steamId: STEAM_ID,
    provider: provider({
      async readRecentTrades() {
        reads += 1;
        if (reads === 1) {
          throw new GatewayPayloadError('INVALID_PAYLOAD', {
            reason: 'steam-session-unavailable',
          });
        }
        return {
          complete: true,
          trades: [tradeAt('7001', 1_776_816_000)],
          icons: {},
          nameColors: {},
          hasMore: false,
          totalTrades: 1,
        };
      },
      async refreshAccessToken() {
        refreshes += 1;
      },
    }),
    createSyncRunId: () => 'sync_run_trade_recovery_01234567',
    now: () => 1_776_816_000_000,
  });

  assert.equal(reads, 2);
  assert.equal(refreshes, 1);
  assert.equal(collected.summary.trades, 1);
  assert.deepEqual(collected.summary.failedSources, []);
});

test('portfolio asset identity permits the same asset ID in contexts 2 and 16 only', () => {
  const compositeSnapshot: PortfolioSnapshot = {
    kind: 'portfolio.snapshot.v1',
    syncRunId: 'sync_run_composite_identity_01234567',
    steamId: STEAM_ID,
    capturedAt: 1_700_000_000,
    completeness: {
      inventoryContext2: true,
      inventoryContext16: true,
      trades: true,
      offers: true,
    },
    inventoryItems: [item('1001', '2'), item('1001', '16')],
    trades: [],
    offers: [],
  };

  assert.doesNotThrow(() => assertPortfolioSnapshot(compositeSnapshot));
  assert.throws(
    () => assertPortfolioSnapshot({
      ...compositeSnapshot,
      offers: [{ ...offer, state: 2 }],
    }),
    /INVALID_PAYLOAD/,
    'the wire DTO must reject non-accepted offers even if another producer skips collector filtering',
  );
  assert.throws(
    () => assertPortfolioSnapshot({
      ...compositeSnapshot,
      inventoryItems: [item('1001', '2'), item('1001', '2')],
    }),
    (error) => error instanceof GatewayPayloadError &&
      error.safeContext.reason === 'duplicate-asset-identity',
  );
});

test('portfolio collector propagates a sanitized offer-cap warning without failing sync', async () => {
  const collected = await collectPortfolioSync({
    steamId: STEAM_ID,
    provider: provider({
      async readTradeOffers() {
        return {
          complete: true,
          offers: [offer],
          warningCode: STEAM_OFFERS_TRUNCATED_WARNING,
        };
      },
    }),
    createSyncRunId: () => 'sync_run_offer_warning_0123456789',
    now: () => 1_700_000_400_000,
  });

  // Never true: the offers source is narrowed to accepted offers on purpose, so
  // it is not a complete account of what Steam holds and must not claim to be —
  // downstream reads completeness as a licence to treat absence as removal.
  assert.equal(collected.snapshot.completeness.offers, false);
  assert.equal(collected.summary.offers, 1);
  assert.deepEqual(collected.summary.failedSources, []);
  assert.deepEqual(collected.summary.warningCodes, ['TRADE_OFFERS_TRUNCATED']);
});

test('metadata-rich 5,000-item provider snapshot fits the official 64-chunk contract', async () => {
  const richItems = (contextId: '2' | '16'): PortfolioItemDto[] =>
    Array.from({ length: 2_500 }, (_, index) => ({
      appId: '730',
      contextId,
      // Reuse IDs across contexts to exercise the canonical composite identity.
      assetId: String(10_000_000 + index),
      classId: String(20_000_000 + index),
      instanceId: '0',
      amount: '1',
      marketHashName: `StatTrak™ AK-47 | Metadata Pattern ${String(index).padStart(4, '0')} (Field-Tested)`,
      name: `Localized redundant display name ${'.'.repeat(180)}`,
      iconUrl: `https://community.cloudflare.steamstatic.com/economy/image/${'a'.repeat(96)}/360fx360f`,
      tradable: contextId === '2',
      marketable: true,
      onHold: contextId === '16',
      ...(contextId === '16' ? { tradableAfter: 1_700_086_400 } : {}),
      floatValue: (index % 1_000) / 1_000,
      paintSeed: index % 1_001,
      paintIndex: 675,
      defIndex: 7,
      stickers: Array.from({ length: 5 }, (_, slot) => ({
        slot,
        name: `Sticker | Metadata ${slot} ${'.'.repeat(36)}`,
        wear: slot / 10,
      })),
    }));
  const contextItems = {
    '2': richItems('2'),
    '16': richItems('16'),
  } as const;

  const collected = await collectPortfolioSync({
    steamId: STEAM_ID,
    provider: provider({
      async readInventoryContext(contextId) {
        return { contextId, complete: true, items: contextItems[contextId] };
      },
      async readRecentTrades() {
        return { complete: true, trades: [] };
      },
      async readTradeOffers() {
        return { complete: true, offers: [] };
      },
    }),
    createSyncRunId: () => 'sync_run_max_inventory_012345678901',
    now: () => 1_700_000_500_000,
  });

  assert.equal(collected.snapshot.inventoryItems.length, 5_000);
  assert.ok(collected.chunks.length > 1);
  assert.ok(collected.chunks.length <= MAX_GATEWAY_CHUNKS_PER_RUN);
  assert.ok(collected.chunks.every((chunk) =>
    byteLengthOfCanonicalJson(chunk) <= TARGET_GATEWAY_CHUNK_BYTES));
  assert.equal(
    collected.chunks.reduce((total, chunk) => total + chunk.inventoryItems.length, 0),
    5_000,
  );
  const first = collected.snapshot.inventoryItems[0];
  assert.ok(first);
  assert.equal(first.name, undefined);
  assert.equal(
    first.iconUrl,
    `https://community.cloudflare.steamstatic.com/economy/image/${'a'.repeat(96)}/360fx360f`,
    'exact Steam icon identity must survive minimization for phase resolution',
  );
  assert.equal(first.marketHashName.startsWith('StatTrak™ AK-47'), true);
  assert.equal(first.stickers?.length, 5);
  assert.equal(first.paintIndex, 675);
});

test('inventory above the beta contract fails only that source and preserves trade facts', async () => {
  const collected = await collectPortfolioSync({
    steamId: STEAM_ID,
    provider: provider({
      async readInventoryContext(contextId) {
        const count = contextId === '2'
          ? MAX_PORTFOLIO_INVENTORY_ITEMS_PER_RUN
          : 1;
        return {
          contextId,
          complete: true,
          items: Array.from({ length: count }, (_, index) =>
            item(String(20_000_000 + index), contextId)),
        };
      },
      async readTradeOffers() {
        throw new Error('disabled trade offers must not be read');
      },
    }),
    sources: {
      inventory: true,
      tradeHistory: true,
      tradeOffers: false,
    },
    createSyncRunId: () => 'sync_run_inventory_limit_0123456789',
    now: () => 1_700_000_600_000,
  });

  assert.deepEqual(collected.summary.failedSources, ['inventory']);
  assert.equal(collected.snapshot.inventoryItems.length, 0);
  assert.equal(collected.snapshot.completeness.inventoryContext2, false);
  assert.equal(collected.snapshot.completeness.inventoryContext16, false);
  assert.equal(collected.snapshot.completeness.trades, true);
  assert.deepEqual(collected.snapshot.trades, [trade]);
  assert.deepEqual(
    collected.chunks.flatMap((chunk) => chunk.inventoryItems),
    [],
    'an over-limit inventory is omitted atomically, never truncated',
  );
  assert.deepEqual(collected.chunks.flatMap((chunk) => chunk.trades), [trade]);
  assert.ok(collected.chunks.every((chunk) =>
    chunk.completeness.inventoryContext2 === false &&
    chunk.completeness.inventoryContext16 === false &&
    chunk.completeness.trades === true));
});

test('portfolio collector preserves disabled inventory source in every chunk', async () => {
  const collected = await collectPortfolioSync({
    steamId: STEAM_ID,
    provider: provider({
      async readInventoryContext() {
        throw new Error('inventory must not be read');
      },
    }),
    sources: {
      inventory: false,
      tradeHistory: true,
      tradeOffers: true,
    },
    createSyncRunId: () => 'sync_run_no_inventory_012345678901',
    now: () => 1_700_000_300_000,
  });

  assert.deepEqual(collected.snapshot.sources, {
    inventory: false,
    tradeHistory: true,
    tradeOffers: true,
  });
  assert.equal(collected.summary.context2Items, 0);
  assert.equal(collected.summary.context16Items, 0);
  assert.equal(collected.snapshot.completeness.inventoryContext2, false);
  assert.equal(collected.snapshot.completeness.inventoryContext16, false);
  assert.equal(collected.snapshot.inventoryItems.length, 0);
  assert.equal(collected.snapshot.trades.length, 1);
  assert.equal(collected.snapshot.offers.length, 1);
  assert.deepEqual(collected.chunks.map((chunk) => chunk.sources), [
    collected.snapshot.sources,
  ]);
});

test('portfolio collector fails closed for incomplete inventory contexts', async () => {
  await assert.rejects(
    () => collectPortfolioSync({
      steamId: STEAM_ID,
      provider: provider({
        async readInventoryContext(contextId) {
          return { contextId, complete: contextId === '2', items: [] } as never;
        },
      }),
      createSyncRunId: () => 'sync_run_inventory_01234567890123',
    }),
    (error) => error instanceof GatewayPayloadError &&
      error.safeContext.reason === 'steam-inventory-read-incomplete',
  );
});

test('retrying lazy promise clears rejected init and retries next call', async () => {
  let attempts = 0;
  const getValue = createRetryingLazyPromise(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('first init failed');
    return 'ready';
  });

  await assert.rejects(() => getValue(), /first init failed/);
  assert.equal(await getValue(), 'ready');
  assert.equal(await getValue(), 'ready');
  assert.equal(attempts, 2);
});
