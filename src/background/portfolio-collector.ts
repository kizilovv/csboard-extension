import {
  GatewayPayloadError,
  MAX_PORTFOLIO_INVENTORY_ITEMS_PER_RUN,
  MAX_PORTFOLIO_TRADES_PER_RUN,
  assertSafeGatewayPayload,
  assertSteamId64,
  createRandomId,
  type PortfolioItemDto,
  type PortfolioSnapshot,
  type PortfolioSyncChunkPayload,
  type PortfolioTradeDto,
} from '../shared/gateway-dto';
import {
  assertPortfolioSnapshot,
  chunkPortfolioSnapshot,
} from '../shared/portfolio-dto';
import {
  STEAM_OFFERS_TRUNCATED_WARNING,
  type SteamOffersReadResult,
  type SteamReadSessionProvider,
  type SteamTradesReadOptions,
  type SteamTradesReadResult,
} from './steam-read-session-provider';

export interface PortfolioCollectorOptions {
  readonly steamId: string;
  readonly provider: SteamReadSessionProvider;
  readonly recentTradeLimit?: number;
  readonly now?: () => number;
  readonly createSyncRunId?: () => string;
  readonly sources?: {
    readonly inventory: boolean;
    readonly tradeHistory: boolean;
    readonly tradeOffers: boolean;
  };
}

export type PortfolioCollectorSource = 'inventory' | 'tradeHistory' | 'tradeOffers';
export const PORTFOLIO_OVERSIZED_RECORDS_WARNING = 'OVERSIZED_RECORDS_DROPPED' as const;
export const TRADE_HISTORY_TRUNCATED_WARNING = 'TRADE_HISTORY_TRUNCATED' as const;
export type PortfolioCollectorWarningCode =
  | typeof STEAM_OFFERS_TRUNCATED_WARNING
  | typeof TRADE_HISTORY_TRUNCATED_WARNING
  | typeof PORTFOLIO_OVERSIZED_RECORDS_WARNING;
export type PortfolioCollectorSourceFailureCode =
  | 'STEAM_SESSION_REQUIRED'
  | 'STEAM_ACCOUNT_MISMATCH'
  | 'STEAM_RATE_LIMITED'
  | 'STEAM_UNAVAILABLE'
  | 'STEAM_RESPONSE_INVALID'
  | 'STEAM_READ_FAILED';

/**
 * The gateway DTO caps a trade or offer at 200 items per side. Steam happily
 * returns more — a 375-item offer is unusual but perfectly legal — and one such
 * record used to abort the entire sync, so a user with a single bulk trade in
 * their history could never sync a portfolio at all.
 *
 * Dropping the record and admitting the gap is the honest trade: the run stays
 * useful, and the source is no longer allowed to claim completeness, so nothing
 * downstream may read the missing rows as "this never happened".
 */
const MAX_RECORD_ITEMS_PER_SIDE = 200;
/** Steam may return fewer than requested while still setting `more`. */
const MAX_TRADE_HISTORY_PAGES = 10;

/**
 * A portfolio only cares about offers that actually moved items:
 * ETradeOfferState 3 = Accepted.
 *
 * Declined, countered, cancelled and invalid-items offers changed nothing, and
 * on a real trading account they are almost all of them — 268 of 333 on the
 * account this was measured against. Offers still in flight belong to P2P order
 * tracking, not to a record of what the account owns and traded.
 *
 * The portfolio provider applies the same accepted-only gate before inspecting
 * offer fields. Keep this collector filter as defense in depth; the trade-offers
 * page uses the separate `readTradeOffersForDisplay` path so active offers and
 * their visible price enrichment remain available there.
 */
const PORTFOLIO_OFFER_STATES = new Set([3]);

function withinRecordLimit(
  record: { itemsGiven?: readonly unknown[]; itemsReceived?: readonly unknown[];
            itemsToGive?: readonly unknown[]; itemsToReceive?: readonly unknown[] },
): boolean {
  const sides = [
    record.itemsGiven, record.itemsReceived,
    record.itemsToGive, record.itemsToReceive,
  ];
  return sides.every((side) => !side || side.length <= MAX_RECORD_ITEMS_PER_SIDE);
}
type CollectedOffersResult = SteamOffersReadResult | {
  readonly complete: false;
  readonly offers: readonly [];
  readonly warningCode?: undefined;
};
type CollectedTradesResult = {
  readonly complete: boolean;
  readonly trades: readonly PortfolioTradeDto[];
  readonly warningCode?: typeof TRADE_HISTORY_TRUNCATED_WARNING;
};

export interface CollectedPortfolioSync {
  readonly snapshot: PortfolioSnapshot;
  readonly chunks: readonly PortfolioSyncChunkPayload[];
  readonly summary: {
    readonly syncRunId: string;
    readonly chunks: number;
    readonly context2Items: number;
    readonly context16Items: number;
    readonly trades: number;
    readonly offers: number;
    readonly failedSources: readonly PortfolioCollectorSource[];
    readonly sourceFailureCodes: Readonly<Partial<Record<
      PortfolioCollectorSource,
      PortfolioCollectorSourceFailureCode
    >>>;
    readonly warningCodes: readonly PortfolioCollectorWarningCode[];
  };
}

function steamFailureStatus(error: unknown): number | undefined {
  if (!(error instanceof GatewayPayloadError)) return undefined;
  const status = error.safeContext['status'];
  return typeof status === 'number' && Number.isSafeInteger(status) ? status : undefined;
}

function isSteamSessionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  if (message === 'STEAM_SESSION_REQUIRED') return true;
  if (!(error instanceof GatewayPayloadError)) return false;
  const reason = error.safeContext['reason'];
  const status = steamFailureStatus(error);
  return reason === 'steam-session-unavailable' ||
    ((status === 401 || status === 403) && reason === 'steam-read-failed');
}

function portfolioSourceFailureCode(error: unknown): PortfolioCollectorSourceFailureCode {
  const message = error instanceof Error ? error.message : '';
  if (message === 'STEAM_SESSION_REQUIRED' || isSteamSessionFailure(error)) {
    return 'STEAM_SESSION_REQUIRED';
  }
  if (message === 'STEAM_ACCOUNT_MISMATCH' ||
      (error instanceof GatewayPayloadError &&
        error.safeContext['reason'] === 'steam-account-mismatch')) {
    return 'STEAM_ACCOUNT_MISMATCH';
  }
  const status = steamFailureStatus(error);
  if (status === 429) return 'STEAM_RATE_LIMITED';
  if (status !== undefined && status >= 500) return 'STEAM_UNAVAILABLE';
  if (error instanceof GatewayPayloadError && error.code === 'INVALID_PAYLOAD' &&
      error.safeContext['reason'] !== 'steam-read-failed') {
    return 'STEAM_RESPONSE_INVALID';
  }
  return 'STEAM_READ_FAILED';
}

async function readTradeHistoryPage(
  provider: SteamReadSessionProvider,
  maxTrades: number,
  options: SteamTradesReadOptions,
): Promise<SteamTradesReadResult> {
  try {
    return await provider.readRecentTrades(maxTrades, options);
  } catch (error) {
    // Only an authentication/session verdict can benefit from a new Steam
    // credential. Data-shape, rate-limit and generic HTTP failures stay isolated
    // to this source and are not multiplied by a blind retry.
    if (!isSteamSessionFailure(error) || !provider.refreshAccessToken) throw error;
    await provider.refreshAccessToken();
    return provider.readRecentTrades(maxTrades, options);
  }
}

async function collectRecentTrades(
  provider: SteamReadSessionProvider,
  maxTrades: number,
): Promise<CollectedTradesResult> {
  const tradesById = new Map<string, PortfolioTradeDto>();
  const seenCursors = new Set<string>();
  let cursor: SteamTradesReadOptions['cursor'];
  let totalTrades: number | undefined;

  for (let page = 0; page < MAX_TRADE_HISTORY_PAGES; page += 1) {
    const remaining = maxTrades - tradesById.size;
    if (remaining <= 0) {
      return {
        complete: totalTrades !== undefined && tradesById.size >= totalTrades,
        trades: [...tradesById.values()],
        ...(totalTrades === undefined || tradesById.size < totalTrades
          ? { warningCode: TRADE_HISTORY_TRUNCATED_WARNING }
          : {}),
      };
    }
    const result = await readTradeHistoryPage(provider, remaining, {
      ...(cursor ? { cursor } : {}),
      includeTotal: page === 0,
    });
    if (totalTrades === undefined && result.totalTrades !== undefined) {
      totalTrades = result.totalTrades;
    }
    for (const trade of result.trades) {
      if (!tradesById.has(trade.tradeId) && tradesById.size < maxTrades) {
        tradesById.set(trade.tradeId, trade);
      }
    }

    // Steam's total is the strongest completion signal when its `more` marker
    // lags. This also handles a final page that repeats the boundary trade.
    if (totalTrades !== undefined && tradesById.size >= totalTrades) {
      return { complete: true, trades: [...tradesById.values()] };
    }
    if (result.hasMore !== true) {
      const complete = totalTrades === undefined || tradesById.size >= totalTrades;
      return {
        complete,
        trades: [...tradesById.values()],
        ...(!complete ? { warningCode: TRADE_HISTORY_TRUNCATED_WARNING } : {}),
      };
    }
    if (tradesById.size >= maxTrades) {
      return {
        complete: false,
        trades: [...tradesById.values()],
        warningCode: TRADE_HISTORY_TRUNCATED_WARNING,
      };
    }

    const lastTrade = result.trades[result.trades.length - 1];
    if (!lastTrade) {
      return {
        complete: false,
        trades: [...tradesById.values()],
        warningCode: TRADE_HISTORY_TRUNCATED_WARNING,
      };
    }
    const nextCursorKey = `${lastTrade.occurredAt}:${lastTrade.tradeId}`;
    if (seenCursors.has(nextCursorKey)) {
      return {
        complete: false,
        trades: [...tradesById.values()],
        warningCode: TRADE_HISTORY_TRUNCATED_WARNING,
      };
    }
    seenCursors.add(nextCursorKey);
    cursor = {
      startAfterTime: lastTrade.occurredAt,
      startAfterTradeId: lastTrade.tradeId,
    };
  }

  return {
    complete: false,
    trades: [...tradesById.values()],
    warningCode: TRADE_HISTORY_TRUNCATED_WARNING,
  };
}

/**
 * Drops presentation-only duplicates before encryption/chunking. Steam `name`
 * is redundant with `marketHashName`. The trusted Steam icon is deliberately
 * retained: unlike a decorative catalog image, its exact hash distinguishes
 * Doppler/Gamma phase twins that share one marketHashName.
 */
export function minimizeInventoryItemForGateway(item: PortfolioItemDto): PortfolioItemDto {
  const {
    name: redundantDisplayName,
    ...portfolioAndP2pFacts
  } = item;
  void redundantDisplayName;
  return portfolioAndP2pFacts;
}

/**
 * Collects only the fixed read surfaces. Inventory contexts 2+16 stay atomic:
 * a partial read is rejected, while an otherwise complete snapshot that cannot
 * fit the beta contract is omitted and marked incomplete. Either way, a partial
 * inventory can never be interpreted by CSBOARD as item removal. Trade history
 * and offers are independent append-only surfaces, so an inventory size failure
 * does not block their enabled facts.
 */
export async function collectPortfolioSync(
  options: PortfolioCollectorOptions,
): Promise<CollectedPortfolioSync> {
  assertSteamId64(options.steamId);
  const recentTradeLimit = options.recentTradeLimit ?? MAX_PORTFOLIO_TRADES_PER_RUN;
  if (!Number.isSafeInteger(recentTradeLimit) || recentTradeLimit < 1 ||
      recentTradeLimit > MAX_PORTFOLIO_TRADES_PER_RUN) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.recentTradeLimit' });
  }

  const sources = options.sources ?? {
    inventory: true,
    tradeHistory: true,
    tradeOffers: true,
  };
  if (!sources.inventory && !sources.tradeHistory && !sources.tradeOffers) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'no-sync-source-enabled' });
  }

  const failedSources: PortfolioCollectorSource[] = [];
  const sourceFailureCodes: Partial<Record<
    PortfolioCollectorSource,
    PortfolioCollectorSourceFailureCode
  >> = {};
  let usableSources = 0;

  const [context2, context16] = sources.inventory
    ? await Promise.all([
      options.provider.readInventoryContext('2'),
      options.provider.readInventoryContext('16'),
    ]).catch(() => {
      throw new GatewayPayloadError('INVALID_PAYLOAD', {
        reason: 'steam-inventory-read-failed',
      });
    })
    : [
      { contextId: '2' as const, complete: false as const, items: [] },
      { contextId: '16' as const, complete: false as const, items: [] },
    ];
  if (sources.inventory && (!context2.complete || !context16.complete)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', {
      reason: 'steam-inventory-read-incomplete',
    });
  }
  const inventoryExceedsRunContract = sources.inventory &&
    context2.items.length + context16.items.length > MAX_PORTFOLIO_INVENTORY_ITEMS_PER_RUN;
  if (inventoryExceedsRunContract) {
    // Inventory is an atomic replacement snapshot. Sending the first 5,000
    // rows would make an omitted owned asset indistinguishable from removal,
    // so this run carries none of the inventory and explicitly marks both
    // contexts incomplete. Append-only sources can still be uploaded safely.
    failedSources.push('inventory');
  } else if (sources.inventory) {
    usableSources += 1;
  }

  let trades: CollectedTradesResult = { complete: false, trades: [] };
  if (sources.tradeHistory) {
    try {
      trades = await collectRecentTrades(options.provider, recentTradeLimit);
      // Append-only facts remain safe and useful even when the bounded run cap
      // prevents a completeness claim.
      usableSources += 1;
    } catch (error) {
      failedSources.push('tradeHistory');
      sourceFailureCodes.tradeHistory = portfolioSourceFailureCode(error);
    }
  }

  const emptyOffers: CollectedOffersResult = { complete: false, offers: [] };
  let offers: CollectedOffersResult = emptyOffers;
  if (sources.tradeOffers) {
    try {
      offers = await options.provider.readTradeOffers();
      usableSources += 1;
    } catch (error) {
      failedSources.push('tradeOffers');
      sourceFailureCodes.tradeOffers = portfolioSourceFailureCode(error);
    }
  }

  const warningCodes: PortfolioCollectorWarningCode[] = [];
  if (trades.warningCode === TRADE_HISTORY_TRUNCATED_WARNING) {
    warningCodes.push(TRADE_HISTORY_TRUNCATED_WARNING);
  }
  if (offers.warningCode === STEAM_OFFERS_TRUNCATED_WARNING) {
    warningCodes.push(STEAM_OFFERS_TRUNCATED_WARNING);
  }

  if (usableSources === 0) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'steam-read-failed' });
  }

  const keptTrades = trades.trades.filter(withinRecordLimit);
  const keptOffers = offers.offers
    .filter((offer) => PORTFOLIO_OFFER_STATES.has(offer.state))
    .filter(withinRecordLimit);
  const droppedRecords =
    (trades.trades.length - keptTrades.length) + (offers.offers.length - keptOffers.length);
  if (droppedRecords > 0) warningCodes.push(PORTFOLIO_OVERSIZED_RECORDS_WARNING);

  const snapshot: PortfolioSnapshot = {
    kind: 'portfolio.snapshot.v1',
    syncRunId: options.createSyncRunId?.() ?? createRandomId(24),
    steamId: options.steamId,
    capturedAt: Math.floor((options.now?.() ?? Date.now()) / 1_000),
    sources,
    completeness: {
      inventoryContext2: context2.complete && !inventoryExceedsRunContract,
      inventoryContext16: context16.complete && !inventoryExceedsRunContract,
      // A dropped record means this source is no longer a complete account of
      // itself, and saying otherwise would license downstream removals.
      trades: trades.complete && keptTrades.length === trades.trades.length,
      // Deliberately narrowed to accepted offers, so this source is never a
      // complete account of every offer Steam holds.
      offers: false,
    },
    inventoryItems: inventoryExceedsRunContract
      ? []
      : [...context2.items, ...context16.items].map(minimizeInventoryItemForGateway),
    trades: keptTrades,
    offers: keptOffers,
  };
  assertSafeGatewayPayload(snapshot);
  assertPortfolioSnapshot(snapshot);
  const chunks = chunkPortfolioSnapshot(snapshot);
  return {
    snapshot,
    chunks,
    summary: {
      syncRunId: snapshot.syncRunId,
      chunks: chunks.length,
      context2Items: context2.items.length,
      context16Items: context16.items.length,
      trades: trades.trades.length,
      offers: offers.offers.length,
      failedSources,
      sourceFailureCodes,
      warningCodes,
    },
  };
}

export type SafePortfolioFailureCode =
  | 'steam-session-required'
  | 'steam-read-failed'
  | 'unsafe-payload-rejected'
  | 'payload-too-large'
  | 'gateway-unconfigured'
  | 'gateway-unavailable'
  | 'device-revoked'
  | 'internal-error';

/** Converts thrown failures to a code safe for popup/status UI and logs. */
export function redactPortfolioFailure(error: unknown): SafePortfolioFailureCode {
  if (error instanceof GatewayPayloadError) {
    // Append our own reason constant when there is one. Without it every size
    // rejection reads the same in the popup and the actual throw site — record
    // limit, chunk count, single oversized record, envelope size — can only be
    // found by reading source, which is how one of these cost hours.
    const detail = typeof error.safeContext['reason'] === 'string'
      ? `:${error.safeContext['reason']}`
      : '';
    if (error.code === 'FORBIDDEN_SECRET') return 'unsafe-payload-rejected';
    if (error.code === 'PAYLOAD_TOO_LARGE') {
      return `payload-too-large${detail}` as SafePortfolioFailureCode;
    }
    if (error.code === 'GATEWAY_UNCONFIGURED') return 'gateway-unconfigured';
    const reason = error.safeContext['reason'];
    if (reason === 'steam-session-unavailable') return 'steam-session-required';
    if (typeof reason === 'string' && reason.startsWith('steam-')) return 'steam-read-failed';
    // A rejected field is the most common failure here and "internal error"
    // says nothing about it. The path is built from field names and array
    // indexes only — no values — so it is safe to show and it names the exact
    // record that Steam sent in a shape we refuse.
    if (error.code === 'INVALID_PAYLOAD') {
      const path = error.safeContext['path'];
      const detail = typeof reason === 'string'
        ? reason
        : typeof path === 'string' ? path : '';
      return (detail ? `invalid-payload:${detail}` : 'invalid-payload') as SafePortfolioFailureCode;
    }
  }
  if (typeof error === 'object' && error !== null && 'name' in error &&
      (error as { name?: unknown }).name === 'GatewayClientError' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'NETWORK_ERROR') return 'gateway-unavailable';
    if (code === 'DEVICE_REVOKED') return 'device-revoked';
    if (code === 'UNCONFIGURED' || code === 'DISCOVERY_REJECTED') {
      return 'gateway-unconfigured';
    }
  }
  // Last resort: name the error class so the next report is not another
  // round of guessing.
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name).slice(0, 40)
    : '';
  const message = error instanceof Error && error.message
    ? error.message.slice(0, 60)
    : '';
  return (message ? `internal-error:${message}` : name ? `internal-error:${name}` : 'internal-error') as SafePortfolioFailureCode;
}
