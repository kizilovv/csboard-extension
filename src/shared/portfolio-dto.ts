import {
  GatewayPayloadError,
  MAX_GATEWAY_CHUNKS_PER_RUN,
  MAX_GATEWAY_PLAINTEXT_BYTES,
  MAX_PORTFOLIO_INVENTORY_ITEMS_PER_RUN,
  MAX_PORTFOLIO_OFFERS_PER_RUN,
  MAX_PORTFOLIO_TRADES_PER_RUN,
  TARGET_GATEWAY_CHUNK_BYTES,
  assertSafeGatewayPayload,
  assertSteamId64,
  byteLengthOfCanonicalJson,
  type PortfolioItemDto,
  type PortfolioOfferDto,
  type PortfolioSnapshot,
  type PortfolioSyncChunkPayload,
  type PortfolioTradeDto,
  type PortfolioTradeItemDto,
} from './gateway-dto';

function assertIdentifier(value: string, path: string): void {
  if (!/^[0-9]{1,32}$/.test(value)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path });
  }
}

function assertQuantity(value: string, path: string): void {
  assertIdentifier(value, path);
  const quantity = BigInt(value);
  if (quantity < 1n || quantity > 1_000n) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path });
  }
}

function assertTimestamp(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 9_999_999_999) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path });
  }
}

function assertSteamAccountId(value: string, path: string): void {
  assertIdentifier(value, path);
  if (BigInt(value) > 4_294_967_295n) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path });
  }
}

function assertTradeItem(item: PortfolioTradeItemDto, path: string): void {
  if (item.appId !== '730') {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.appId` });
  }
  assertIdentifier(item.assetId, `${path}.assetId`);
  assertIdentifier(item.classId, `${path}.classId`);
  assertIdentifier(item.instanceId, `${path}.instanceId`);
  assertQuantity(item.amount, `${path}.amount`);
  if (!/^[0-9]{1,4}$/.test(item.contextId)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.contextId` });
  }
  if (item.marketHashName !== undefined &&
      (!item.marketHashName.trim() || item.marketHashName.length > 240)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.marketHashName` });
  }
}

function assertInventoryItem(item: PortfolioItemDto, path: string): void {
  if (item.appId !== '730' || (item.contextId !== '2' && item.contextId !== '16')) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path });
  }
  assertIdentifier(item.assetId, `${path}.assetId`);
  assertIdentifier(item.classId, `${path}.classId`);
  assertIdentifier(item.instanceId, `${path}.instanceId`);
  assertQuantity(item.amount, `${path}.amount`);
  if (!item.marketHashName.trim() || item.marketHashName.length > 240) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.marketHashName` });
  }
  if (item.name !== undefined && (!item.name.trim() || item.name.length > 240)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.name` });
  }
  if (item.iconUrl) {
    let url: URL;
    try {
      url = new URL(item.iconUrl);
    } catch {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.iconUrl` });
    }
    const trustedIconOrigins = new Set([
      'https://community.cloudflare.steamstatic.com',
      'https://steamcommunity-a.akamaihd.net',
    ]);
    if (!trustedIconOrigins.has(url.origin) || !url.pathname.startsWith('/economy/image/')) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.iconUrl` });
    }
  }
  if (item.tradableAfter !== undefined) {
    assertTimestamp(item.tradableAfter, `${path}.tradableAfter`);
  }
  if (item.floatValue !== undefined &&
      (!Number.isFinite(item.floatValue) || item.floatValue < 0 || item.floatValue > 1)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.floatValue` });
  }
  if (item.paintSeed !== undefined &&
      (!Number.isSafeInteger(item.paintSeed) || item.paintSeed < 0 || item.paintSeed > 1_000)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.paintSeed` });
  }
  if (item.paintIndex !== undefined &&
      (!Number.isSafeInteger(item.paintIndex) || item.paintIndex < 0 || item.paintIndex > 1_000_000)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.paintIndex` });
  }
  if (item.defIndex !== undefined &&
      (!Number.isSafeInteger(item.defIndex) || item.defIndex < 0 || item.defIndex > 1_000_000)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.defIndex` });
  }
  if (item.stickers && item.stickers.length > 5) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.stickers` });
  }
  item.stickers?.forEach((sticker, index) => {
    const stickerPath = `${path}.stickers[${index}]`;
    if (!Number.isSafeInteger(sticker.slot) || sticker.slot < 0 || sticker.slot > 5 ||
        !sticker.name.trim() || sticker.name.length > 160 ||
        (sticker.wear !== undefined &&
          (!Number.isFinite(sticker.wear) || sticker.wear < 0 || sticker.wear > 1))) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path: stickerPath });
    }
  });
}

function assertTrade(trade: PortfolioTradeDto, path: string): void {
  assertIdentifier(trade.tradeId, `${path}.tradeId`);
  assertSteamId64(trade.partnerSteamId);
  assertTimestamp(trade.occurredAt, `${path}.occurredAt`);
  if (trade.occurredAt === 0 || trade.itemsGiven.length > 200 || trade.itemsReceived.length > 200) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path });
  }
  trade.itemsGiven.forEach((item, index) => assertTradeItem(item, `${path}.itemsGiven[${index}]`));
  trade.itemsReceived.forEach((item, index) =>
    assertTradeItem(item, `${path}.itemsReceived[${index}]`));
}

function assertOffer(offer: PortfolioOfferDto, path: string): void {
  assertIdentifier(offer.offerId, `${path}.offerId`);
  assertSteamAccountId(offer.partnerAccountId, `${path}.partnerAccountId`);
  if (offer.direction !== 'sent' && offer.direction !== 'received') {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.direction` });
  }
  if (!Number.isSafeInteger(offer.state) || offer.state < 1 || offer.state > 32) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}.state` });
  }
  assertTimestamp(offer.createdAt, `${path}.createdAt`);
  if (offer.createdAt === 0 || offer.itemsToGive.length > 200 ||
      offer.itemsToReceive.length > 200) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path });
  }
  if (offer.expiresAt !== undefined) assertTimestamp(offer.expiresAt, `${path}.expiresAt`);
  if (offer.escrowEndAt !== undefined) assertTimestamp(offer.escrowEndAt, `${path}.escrowEndAt`);
  offer.itemsToGive.forEach((item, index) =>
    assertTradeItem(item, `${path}.itemsToGive[${index}]`));
  offer.itemsToReceive.forEach((item, index) =>
    assertTradeItem(item, `${path}.itemsToReceive[${index}]`));
}

/** Steam Economy asset identity is scoped by app and inventory context. */
export function portfolioAssetIdentity(
  item: Pick<PortfolioItemDto, 'appId' | 'contextId' | 'assetId'>,
): string {
  return `${item.appId}:${item.contextId}:${item.assetId}`;
}

export function assertPortfolioSnapshot(snapshot: PortfolioSnapshot): void {
  assertSafeGatewayPayload(snapshot);
  if (snapshot.kind !== 'portfolio.snapshot.v1') {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.kind' });
  }
  assertSteamId64(snapshot.steamId);
  assertTimestamp(snapshot.capturedAt, '$.capturedAt');
  if (!/^[A-Za-z0-9_-]{22,86}$/.test(snapshot.syncRunId)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.syncRunId' });
  }
  if (snapshot.sources) {
    const sourceValues = [
      snapshot.sources.inventory,
      snapshot.sources.tradeHistory,
      snapshot.sources.tradeOffers,
    ];
    if (sourceValues.some((value) => typeof value !== 'boolean') ||
        sourceValues.every((value) => !value)) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.sources' });
    }
  }
  if (
    snapshot.inventoryItems.length > MAX_PORTFOLIO_INVENTORY_ITEMS_PER_RUN ||
    snapshot.trades.length > MAX_PORTFOLIO_TRADES_PER_RUN ||
    snapshot.offers.length > MAX_PORTFOLIO_OFFERS_PER_RUN
  ) {
    throw new GatewayPayloadError('PAYLOAD_TOO_LARGE', {
      reason: 'sync-run-record-limit',
      inventoryItems: snapshot.inventoryItems.length,
      trades: snapshot.trades.length,
      offers: snapshot.offers.length,
    });
  }

  const inventoryKeys = new Set<string>();
  snapshot.inventoryItems.forEach((item, index) => {
    assertInventoryItem(item, `$.inventoryItems[${index}]`);
    const key = portfolioAssetIdentity(item);
    if (inventoryKeys.has(key)) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', {
        path: `$.inventoryItems[${index}]`,
        reason: 'duplicate-asset-identity',
      });
    }
    inventoryKeys.add(key);
  });

  const tradeIds = new Set<string>();
  snapshot.trades.forEach((trade, index) => {
    assertTrade(trade, `$.trades[${index}]`);
    if (tradeIds.has(trade.tradeId)) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', {
        path: `$.trades[${index}]`,
        reason: 'duplicate-trade',
      });
    }
    tradeIds.add(trade.tradeId);
  });

  const offerIds = new Set<string>();
  snapshot.offers.forEach((offer, index) => {
    assertOffer(offer, `$.offers[${index}]`);
    const key = `${offer.direction}:${offer.offerId}`;
    if (offerIds.has(key)) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', {
        path: `$.offers[${index}]`,
        reason: 'duplicate-offer',
      });
    }
    offerIds.add(key);
  });
}

export function sortPortfolioSnapshot(snapshot: PortfolioSnapshot): PortfolioSnapshot {
  assertPortfolioSnapshot(snapshot);
  return {
    ...snapshot,
    inventoryItems: [...snapshot.inventoryItems].sort((left, right) =>
      left.contextId.localeCompare(right.contextId) || left.assetId.localeCompare(right.assetId)),
    trades: [...snapshot.trades].sort((left, right) =>
      left.occurredAt - right.occurredAt || left.tradeId.localeCompare(right.tradeId)),
    offers: [...snapshot.offers].sort((left, right) =>
      left.createdAt - right.createdAt ||
      left.direction.localeCompare(right.direction) ||
      left.offerId.localeCompare(right.offerId)),
  };
}

type ChunkRecord =
  | { readonly type: 'inventory'; readonly value: PortfolioItemDto }
  | { readonly type: 'trade'; readonly value: PortfolioTradeDto }
  | { readonly type: 'offer'; readonly value: PortfolioOfferDto };

function toChunk(
  snapshot: PortfolioSnapshot,
  chunkIndex: number,
  chunkCount: number,
  records: readonly ChunkRecord[],
): PortfolioSyncChunkPayload {
  return {
    kind: 'portfolio.sync.chunk.v1',
    syncRunId: snapshot.syncRunId,
    steamId: snapshot.steamId,
    capturedAt: snapshot.capturedAt,
    chunkIndex,
    chunkCount,
    ...(snapshot.sources ? { sources: snapshot.sources } : {}),
    completeness: snapshot.completeness,
    inventoryItems: records
      .filter((record): record is Extract<ChunkRecord, { type: 'inventory' }> =>
        record.type === 'inventory')
      .map((record) => record.value),
    trades: records
      .filter((record): record is Extract<ChunkRecord, { type: 'trade' }> =>
        record.type === 'trade')
      .map((record) => record.value),
    offers: records
      .filter((record): record is Extract<ChunkRecord, { type: 'offer' }> =>
        record.type === 'offer')
      .map((record) => record.value),
  };
}

/**
 * Greedily packs normalized records into independent gateway payloads. Backend
 * reconciliation must wait until every chunk in `syncRunId` is present.
 */
export function chunkPortfolioSnapshot(
  input: PortfolioSnapshot,
  targetBytes = TARGET_GATEWAY_CHUNK_BYTES,
): readonly PortfolioSyncChunkPayload[] {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 16 * 1024 ||
      targetBytes > MAX_GATEWAY_PLAINTEXT_BYTES) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-chunk-size' });
  }

  const snapshot = sortPortfolioSnapshot(input);
  const records: ChunkRecord[] = [
    ...snapshot.inventoryItems.map((value) => ({ type: 'inventory' as const, value })),
    ...snapshot.trades.map((value) => ({ type: 'trade' as const, value })),
    ...snapshot.offers.map((value) => ({ type: 'offer' as const, value })),
  ];

  const groups: ChunkRecord[][] = [[]];
  for (const record of records) {
    const current = groups[groups.length - 1];
    if (!current) throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'chunk-state' });
    const candidate = [...current, record];
    const provisional = toChunk(snapshot, groups.length - 1, 999_999, candidate);
    if (byteLengthOfCanonicalJson(provisional) <= targetBytes) {
      current.push(record);
      continue;
    }

    if (current.length === 0) {
      throw new GatewayPayloadError('PAYLOAD_TOO_LARGE', { reason: 'single-record-too-large' });
    }
    groups.push([record]);
    if (groups.length > MAX_GATEWAY_CHUNKS_PER_RUN) {
      throw new GatewayPayloadError('PAYLOAD_TOO_LARGE', { reason: 'too-many-chunks' });
    }
    const single = toChunk(snapshot, groups.length - 1, 999_999, [record]);
    if (byteLengthOfCanonicalJson(single) > targetBytes) {
      throw new GatewayPayloadError('PAYLOAD_TOO_LARGE', { reason: 'single-record-too-large' });
    }
  }

  const chunks = groups.map((group, index) => toChunk(snapshot, index, groups.length, group));
  for (const chunk of chunks) {
    const bytes = byteLengthOfCanonicalJson(chunk);
    if (bytes > MAX_GATEWAY_PLAINTEXT_BYTES) {
      throw new GatewayPayloadError('PAYLOAD_TOO_LARGE', { bytes });
    }
  }
  return chunks;
}
