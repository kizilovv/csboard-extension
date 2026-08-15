// ============================================================
// CSBOARD Background Service Worker — Senior Architecture
// ============================================================
// Single responsibility: message routing + periodic tasks.
// All business logic lives in api.ts / storage.ts.
// Uses typed message router — zero `any`, zero `switch`.

import { getApiBase, SITE_BASE } from '../shared/config';
import {
  priceEngine,
  type CompactPrice,
  type PriceEngineSettings,
} from '../shared/price-engine';
import { getAuthStatus, logout, unwrapAuthMeUserPayload } from '../shared/api';
import { getTradeHoldItems } from '../shared/steam-api';
import { fetchSteamSession } from './steam-session';
import { createMessageRouter } from '../shared/message-bus';
import { createRetryingLazyPromise } from '../shared/retrying-lazy-promise';
import {
  getSettings,
  runMigrations,
  updateSettings,
} from '../shared/storage';
import { createLogger } from '../shared/logger';
import type { MarketHashName, PriceData } from '../shared/types';
import { GatewayPayloadError } from '../shared/gateway-dto';
import {
  isTrustedSteamPageSender,
  normalizeSteamPageCredential,
} from '../shared/steam-page-credential';
import {
  DEFAULT_POPUP_SETTINGS,
  DEFAULT_PORTFOLIO_STATUS,
  POPUP_SETTINGS_SCHEMA_VERSION,
  isSupportedCurrency,
  isSupportedPriceSource,
  type PopupSettingsV2,
  type PortfolioSource,
  type PortfolioSourceStatus,
  type PortfolioSyncStatus,
  type PricePreferenceSyncStatus,
} from '../popup/contracts';
import {
  createSteamReadSessionProvider,
  type SteamOfferDisplayItem,
  type SteamReadSessionProvider,
} from './steam-read-session-provider';
import { registerExternalStatusRouter } from './external-router';
import { IndexedDbDeviceKeyStore } from './device-key-store';
import { ProtectedGatewayClient } from './gateway-client';
import {
  GatewayController,
  PortfolioSyncCancelledError,
} from './gateway-controller';
import { clearGatewayOutbox } from './sync-outbox';
import { readGatewayBuildConfig } from './gateway-config';
import { P2PListingController } from './p2p-listing-client';

const logger = createLogger('background');

function requirePopupSender(sender: chrome.runtime.MessageSender): void {
  const popupUrl = chrome.runtime.getURL('popup/popup.html');
  if (sender.id !== chrome.runtime.id || sender.url !== popupUrl) {
    throw new Error('POPUP_ONLY_OPERATION');
  }
}

// ============================================================
// Message Router (replaces monolithic switch statement)
// ============================================================

const router = createMessageRouter();

// --- Auth (cookie-based — no tokens, just check /auth/me with cookies) ---
router.on('GET_AUTH_STATUS', async () => {
  return getAuthStatus();
});

router.on('LOGOUT', async () => {
  await logout();
  return { success: true as const };
});

// --- Pricing — read from local price-engine cache (full dump from /api/extension/prices) ---
router.on('GET_PRICES', async (msg) => {
  await priceEngine.init();
  const items = msg.data.items as MarketHashName[];
  const out: Record<string, PriceData> = {};
  for (const name of items) {
    const compact = (priceEngine as unknown as { prices: Record<string, CompactPrice> }).prices[name];
    if (!compact) continue;
    out[name] = {
      marketHashName: name,
      ...(compact.s != null ? { steam: compact.s } : {}),
      ...(compact.b != null ? { buff163: compact.b } : {}),
      ...(compact.bo != null ? { buff163_buy: compact.bo } : {}),
      ...(compact.cf != null ? { csfloat: compact.cf } : {}),
      ...(compact.sp != null ? { skinport: compact.sp } : {}),
      ...(compact.dm != null ? { dmarket: compact.dm } : {}),
      ...(compact.yp != null ? { youpin: compact.yp } : {}),
      ...(compact.ls != null ? { lisskins: compact.ls } : {}),
    } as PriceData;
  }
  return out;
});

router.on('REFRESH_PRICES', async () => {
  return refreshAllPrices();
});

// --- Fixed Steam read provider ---
// The provider owns its memory-only credential. Messages never carry or return it.
let steamReadProvider: SteamReadSessionProvider | null = null;
let steamReadProviderAccount: string | null = null;

/**
 * `pageCredential` is a webapi token a content script read straight out of the
 * page DOM. It is the reliable source: the service worker's own fetch to
 * steamcommunity.com is cross-site from the extension origin, so with
 * third-party cookies blocked it sees a logged-out page and every read fails
 * with STEAM_SESSION_REQUIRED while the user is plainly signed in.
 */
async function getSteamReadProvider(
  expectedSteamId?: string,
  pageCredential?: { token?: string; steamId?: string },
): Promise<SteamReadSessionProvider> {
  const pageSteamId = pageCredential?.steamId;
  const pageToken = pageCredential?.token;
  // A credential bridge has already bound a fresh token to this exact paired
  // account. Re-probing steamcommunity.com from the extension origin here
  // would discard that first-party proof under third-party-cookie blocking.
  if (!pageSteamId && !pageToken && expectedSteamId && steamReadProvider &&
      steamReadProviderAccount === expectedSteamId &&
      steamReadProvider.hasUsableAccessToken?.()) {
    return steamReadProvider;
  }
  // A page-supplied identity is first-party proof of who is signed in, so it
  // stands in for the session probe the worker cannot always make.
  const session = pageSteamId && pageToken
    ? { ok: true as const, value: { isLoggedIn: true, steamId: pageSteamId } }
    : await fetchSteamSession();
  if (!session.ok || !session.value.isLoggedIn || !session.value.steamId) {
    clearSteamReadProvider();
    throw new Error('STEAM_SESSION_REQUIRED');
  }
  const actualSteamId = session.value.steamId;
  if (expectedSteamId && actualSteamId !== expectedSteamId) {
    clearSteamReadProvider();
    throw new Error('STEAM_ACCOUNT_MISMATCH');
  }
  if (!steamReadProvider || steamReadProviderAccount !== actualSteamId) {
    clearSteamReadProvider();
    steamReadProvider = createSteamReadSessionProvider({ steamId: actualSteamId });
    steamReadProviderAccount = actualSteamId;
  }
  if (pageToken && pageSteamId) {
    steamReadProvider.offerAccessToken(pageToken, pageSteamId);
  }
  return steamReadProvider;
}

function clearSteamReadProvider(): void {
  steamReadProvider?.forgetSession();
  steamReadProvider = null;
  steamReadProviderAccount = null;
}

// --- Opt-in encrypted portfolio gateway ---
const PORTFOLIO_UI_STATUS_KEY = 'csboard_portfolio_ui_status_v1';

interface StoredPortfolioUiStatus {
  readonly lastAttemptedAt: number | null;
  readonly lastSuccessfulAt: number | null;
  readonly sourceRecords: Partial<Record<PortfolioSource, number>>;
  readonly sourceErrors: Partial<Record<PortfolioSource, string>>;
  readonly sourceWarnings: Partial<Record<PortfolioSource, string>>;
  readonly errorCode?: string;
  readonly connectionOverride?: 'revoked' | 'mismatch' | 'error';
}

const EMPTY_PORTFOLIO_UI_STATUS: StoredPortfolioUiStatus = {
  lastAttemptedAt: null,
  lastSuccessfulAt: null,
  sourceRecords: {},
  sourceErrors: {},
  sourceWarnings: {},
};

let gatewayDeviceKeys: IndexedDbDeviceKeyStore | null = null;
const getGatewayController = createRetryingLazyPromise(async () => {
  const buildConfig = readGatewayBuildConfig();
  const apiBase = await getApiBase();
  const origin = new URL(apiBase).origin;
  if (!buildConfig.allowedOrigins.includes(origin)) {
    throw new Error('GATEWAY_ORIGIN_NOT_PINNED');
  }
  const deviceKeys = getGatewayDeviceKeys();
  const client = new ProtectedGatewayClient({
    gatewayOrigin: origin,
    allowedGatewayOrigins: buildConfig.allowedOrigins,
    pinnedDiscoveryRoot: buildConfig.pinnedRoot,
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
  }, deviceKeys);
  return new GatewayController({
    client,
    deviceKeys,
    extensionVersion: chrome.runtime.getManifest().version,
    createSteamProvider: (steamId) => getSteamReadProvider(steamId),
    getEnabledSources: async () => {
      const settings = await getSettings();
      if (!settings.portfolioSyncEnabled || !hasEnabledPortfolioSource(settings)) {
        throw new Error('PORTFOLIO_SYNC_NOT_ENABLED');
      }
      return portfolioCollectorSources(settings);
    },
  });
});

function getGatewayDeviceKeys(): IndexedDbDeviceKeyStore {
  gatewayDeviceKeys ??= new IndexedDbDeviceKeyStore();
  return gatewayDeviceKeys;
}

type ExtensionSettings = Awaited<ReturnType<typeof getSettings>>;

/**
 * Only user-visible sources count as consent entry points. Accepted-offer
 * correlation is a bounded enrichment of Trade History, not a third setting;
 * Steam Market history is not shipped yet.
 */
function hasEnabledPortfolioSource(settings: ExtensionSettings): boolean {
  return settings.portfolioSources.inventory || settings.portfolioSources.tradeHistory;
}

/**
 * Translate the two simple popup choices into collector reads. Trade History
 * automatically carries accepted-offer correlation metadata so CSFolder can
 * match a completed trade to its venue hint. The provider/collector boundary
 * limits this read to accepted offers from the last 30 days and strips raw
 * Steam notes before the payload exists.
 */
function portfolioCollectorSources(settings: ExtensionSettings): {
  readonly inventory: boolean;
  readonly tradeHistory: boolean;
  readonly tradeOffers: boolean;
} {
  return {
    inventory: settings.portfolioSyncEnabled && settings.portfolioSources.inventory,
    tradeHistory: settings.portfolioSyncEnabled && settings.portfolioSources.tradeHistory,
    tradeOffers: settings.portfolioSyncEnabled && settings.portfolioSources.tradeHistory,
  };
}

async function readStoredPortfolioUiStatus(): Promise<StoredPortfolioUiStatus> {
  const result = await chrome.storage.local.get(PORTFOLIO_UI_STATUS_KEY);
  const raw = result[PORTFOLIO_UI_STATUS_KEY] as Partial<StoredPortfolioUiStatus> | undefined;
  if (!raw || typeof raw !== 'object') return EMPTY_PORTFOLIO_UI_STATUS;
  const safeTimestamp = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
  const sourceRecords: Partial<Record<PortfolioSource, number>> = {};
  if (raw.sourceRecords && typeof raw.sourceRecords === 'object') {
    for (const source of ['inventory', 'tradeHistory'] as const) {
      const count = raw.sourceRecords[source];
      if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) {
        sourceRecords[source] = count;
      }
    }
  }
  const sourceErrors: Partial<Record<PortfolioSource, string>> = {};
  if (raw.sourceErrors && typeof raw.sourceErrors === 'object') {
    for (const source of ['inventory', 'tradeHistory'] as const) {
      const code = raw.sourceErrors[source];
      if (typeof code === 'string' && /^[A-Z0-9_-]{1,96}$/.test(code)) {
        sourceErrors[source] = code;
      }
    }
  }
  const sourceWarnings: Partial<Record<PortfolioSource, string>> = {};
  if (raw.sourceWarnings && typeof raw.sourceWarnings === 'object') {
    for (const source of ['inventory', 'tradeHistory'] as const) {
      const code = raw.sourceWarnings[source];
      if (typeof code === 'string' && /^[A-Z0-9_-]{1,96}$/.test(code)) {
        sourceWarnings[source] = code;
      }
    }
  }
  const allowedOverrides = new Set(['revoked', 'mismatch', 'error']);
  return {
    lastAttemptedAt: safeTimestamp(raw.lastAttemptedAt),
    lastSuccessfulAt: safeTimestamp(raw.lastSuccessfulAt),
    sourceRecords,
    sourceErrors,
    sourceWarnings,
    ...(typeof raw.errorCode === 'string' && /^[A-Z0-9_-]{1,96}$/.test(raw.errorCode)
      ? { errorCode: raw.errorCode }
      : {}),
    ...(raw.connectionOverride && allowedOverrides.has(raw.connectionOverride)
      ? { connectionOverride: raw.connectionOverride }
      : {}),
  };
}

async function writeStoredPortfolioUiStatus(status: StoredPortfolioUiStatus): Promise<void> {
  await chrome.storage.local.set({ [PORTFOLIO_UI_STATUS_KEY]: status });
}

function safePortfolioErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'STEAM_SESSION_REQUIRED') return 'STEAM_SESSION_REQUIRED';
  if (message === 'STEAM_ACCOUNT_MISMATCH') return 'STEAM_ACCOUNT_MISMATCH';
  if (message === 'PORTFOLIO_SYNC_NOT_ENABLED') return 'SYNC_NOT_ENABLED';
  if (message === 'DEVICE_REVOKED') return 'DEVICE_REVOKED';
  if (message === 'GATEWAY_BUILD_CONFIG_UNAVAILABLE' ||
      message === 'GATEWAY_BUILD_CONFIG_INVALID' || message === 'GATEWAY_ORIGIN_NOT_PINNED') {
    return 'GATEWAY_UNCONFIGURED';
  }
  if (error instanceof GatewayPayloadError &&
      error.safeContext['reason'] === 'steam-session-unavailable') {
    return 'STEAM_SESSION_REQUIRED';
  }
  return 'SYNC_FAILED';
}

function sourceStatus(
  source: PortfolioSource,
  enabled: boolean,
  runtimeState: 'idle' | 'syncing' | 'error',
  stored: StoredPortfolioUiStatus,
): PortfolioSourceStatus {
  // Accepted offers are hidden enrichment of Trade History: no independent
  // toggle, progress row, error badge or record counter is exposed.
  if (source === 'tradeOffers') {
    return { enabled: false, state: 'disabled' };
  }
  if (source === 'marketHistory') {
    return { enabled: false, state: 'disabled', errorCode: 'NOT_AVAILABLE_IN_1_1' };
  }
  if (!enabled) return { enabled: false, state: 'disabled' };
  const sourceError = stored.sourceErrors[source];
  const sourceWarning = stored.sourceWarnings[source];
  const state = runtimeState === 'syncing'
    ? 'running'
    : runtimeState === 'error'
      ? 'error'
      : sourceError
        ? 'error'
      : stored.lastSuccessfulAt ? 'success' : 'idle';
  return {
    enabled: true,
    state,
    ...(stored.sourceRecords[source] !== undefined
      ? { records: stored.sourceRecords[source] }
      : {}),
    ...(state === 'error' && (sourceError ?? stored.errorCode)
      ? { errorCode: sourceError ?? stored.errorCode }
      : {}),
    ...(state !== 'error' && sourceWarning ? { warningCode: sourceWarning } : {}),
  };
}

async function buildPortfolioPopupStatus(): Promise<PortfolioSyncStatus> {
  const [settings, stored, autoSync] = await Promise.all([
    getSettings(),
    readStoredPortfolioUiStatus(),
    readPortfolioAutoSyncState().catch(() => EMPTY_PORTFOLIO_AUTO_SYNC_STATE),
  ]);
  let registration = null;
  try {
    registration = await getGatewayDeviceKeys().getRegistration();
  } catch {
    // IndexedDB failures remain a local, non-secret status error.
  }
  let runtimeState: 'idle' | 'syncing' | 'error' = 'idle';
  let pending = 0;
  let controllerFailure: string | undefined;
  try {
    const status = await (await getGatewayController()).status();
    runtimeState = status.syncState;
    pending = status.pendingEncryptedRequests;
    controllerFailure = status.lastFailureCode;
  } catch (error) {
    if (registration) {
      runtimeState = 'error';
      controllerFailure = safePortfolioErrorCode(error);
    }
  }

  const errorCode = controllerFailure ?? stored.errorCode;
  const connectionState: PortfolioSyncStatus['connectionState'] = !registration
    ? 'unpaired'
    : controllerFailure === 'device-revoked' || stored.connectionOverride === 'revoked'
      ? 'revoked'
      : stored.connectionOverride === 'mismatch'
        ? 'mismatch'
        : runtimeState === 'error' || stored.connectionOverride === 'error'
          ? 'error'
          : 'paired';
  const effectiveState = connectionState === 'paired' ? runtimeState : 'error';
  return {
    ...DEFAULT_PORTFOLIO_STATUS,
    connectionState,
    steamId: registration?.steamId ?? null,
    paused: !settings.portfolioSyncEnabled,
    sources: {
      inventory: sourceStatus('inventory', settings.portfolioSources.inventory, effectiveState, stored),
      tradeOffers: sourceStatus('tradeOffers', false, effectiveState, stored),
      tradeHistory: sourceStatus('tradeHistory', settings.portfolioSources.tradeHistory, effectiveState, stored),
      marketHistory: sourceStatus('marketHistory', false, effectiveState, stored),
    },
    lastAttemptedAt: stored.lastAttemptedAt,
    lastSuccessfulAt: stored.lastSuccessfulAt,
    queuedRecords: pending,
    retryAt: registration && settings.portfolioSyncEnabled &&
        hasEnabledPortfolioSource(settings) && !autoSync.suspended
      ? autoSync.nextAttemptAt
      : null,
    ...(errorCode ? { errorCode } : {}),
  };
}

router.on('FETCH_TRADE_HISTORY', async (msg) => {
  const provider = await getSteamReadProvider();
  const startAfterTime = msg.data.startAfterTime;
  const startAfterTradeId = msg.data.startAfterTradeId;
  const hasTimeCursor = startAfterTime !== undefined && startAfterTime !== 0;
  const hasTradeCursor = startAfterTradeId !== undefined && startAfterTradeId !== '0';
  if (hasTimeCursor !== hasTradeCursor) throw new Error('INVALID_TRADE_HISTORY_CURSOR');
  const result = await provider.readRecentTrades(msg.data.maxTrades, {
    includeTotal: true,
    ...(hasTimeCursor && hasTradeCursor ? {
      cursor: {
        startAfterTime: startAfterTime as number,
        startAfterTradeId: startAfterTradeId as string,
      },
    } : {}),
  });
  const trades = result.trades;

  // The provider deliberately returns identities only — that DTO is also what
  // the gateway uploads, and it must stay free of derived money fields. Pricing
  // therefore happens here, for the local view alone. Values are today's market
  // prices at the user's chosen source; they are not a historical cost basis.
  await priceEngine.init();
  const settings = priceEngine.getSettings();
  const priceItems = (
    items: readonly { marketHashName?: string; classId?: string; instanceId?: string }[],
  ) => items.map((item) => {
    const price = item.marketHashName ? priceEngine.getPrice(item.marketHashName) : null;
    const key = `${item.classId}:${item.instanceId}`;
    const iconUrl = result.icons[key];
    const nameColor = result.nameColors[key];
    return {
      ...item,
      ...(price ? { priceUsd: price.raw, priceDisplay: price.display } : {}),
      ...(iconUrl ? { iconUrl } : {}),
      ...(nameColor ? { nameColor } : {}),
    };
  });
  const sum = (items: readonly { priceUsd?: number }[]) =>
    Math.round(items.reduce((total, item) => total + (item.priceUsd ?? 0), 0) * 100) / 100;

  const enriched = trades.map((trade) => {
    const itemsGiven = priceItems(trade.itemsGiven);
    const itemsReceived = priceItems(trade.itemsReceived);
    const totalGivenUsd = sum(itemsGiven);
    const totalReceivedUsd = sum(itemsReceived);
    return {
      ...trade,
      itemsGiven,
      itemsReceived,
      totalGivenUsd,
      totalReceivedUsd,
      profitLossUsd: Math.round((totalReceivedUsd - totalGivenUsd) * 100) / 100,
      priceSource: settings.priceSource,
    };
  });

  const last = trades.length > 0 ? trades[trades.length - 1] : undefined;
  return {
    trades: enriched,
    totalTrades: result.totalTrades ?? enriched.length,
    hasMore: result.hasMore === true,
    ...(last ? { lastTradeId: last.tradeId, lastTradeTime: last.occurredAt } : {}),
  };
});

router.on('OPEN_TRADE_HISTORY', async () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/trade-history.html') });
  return { ok: true };
});

router.on('GET_TRADE_HISTORY_SYNC_STATE', async () => {
  const data = await chrome.storage.local.get([
    'csboard_trade_history_cursor',
    'csboard_trade_history_last_sync',
  ]);
  return {
    cursor: data['csboard_trade_history_cursor'] || null,
    lastSync: data['csboard_trade_history_last_sync'] || null,
  };
});

router.on('GET_PRICE_ENGINE_STATUS', async () => {
  await priceEngine.init();
  const settings = priceEngine.getSettings();
  return {
    loaded: priceEngine.isLoaded,
    count: priceEngine.itemCount,
    lastFetched: await priceEngine.getLastFetched(),
    currency: settings.currency,
    priceSource: settings.priceSource,
  };
});

const SETTINGS_SYNC_STATUS_KEY = 'csboard_settings_sync_status_v2';

function toPopupSettings(settings: Awaited<ReturnType<typeof getSettings>>): PopupSettingsV2 {
  return {
    schemaVersion: POPUP_SETTINGS_SCHEMA_VERSION,
    currency: isSupportedCurrency(settings.currency)
      ? settings.currency
      : DEFAULT_POPUP_SETTINGS.currency,
    priceSource: isSupportedPriceSource(settings.priceSource)
      ? settings.priceSource
      : DEFAULT_POPUP_SETTINGS.priceSource,
    followCsboardSettings: settings.followCsboardSettings,
    showCsboardPricesOnCsfloat: settings.showCsboardPricesOnCsfloat,
    showBetterBuffOnBuff: settings.showBetterBuffOnBuff,
    portfolioSyncEnabled: settings.portfolioSyncEnabled,
    portfolioSources: {
      ...settings.portfolioSources,
      tradeOffers: false,
      marketHistory: false,
    },
  };
}

async function getPreferenceSyncStatus(): Promise<PricePreferenceSyncStatus> {
  const result = await chrome.storage.local.get(SETTINGS_SYNC_STATUS_KEY);
  const candidate = result[SETTINGS_SYNC_STATUS_KEY] as Partial<PricePreferenceSyncStatus> | undefined;
  const allowed = new Set(['idle', 'syncing', 'success', 'warning', 'error', 'signed_out']);
  return {
    state: candidate?.state && allowed.has(candidate.state) ? candidate.state : 'idle',
    lastSyncedAt: typeof candidate?.lastSyncedAt === 'number' && candidate.lastSyncedAt > 0
      ? candidate.lastSyncedAt
      : null,
    ...(typeof candidate?.warningCode === 'string' && candidate.warningCode.length <= 96
      ? { warningCode: candidate.warningCode }
      : {}),
  };
}

async function setPreferenceSyncStatus(status: PricePreferenceSyncStatus): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_SYNC_STATUS_KEY]: status });
}

function validateSettingsPatch(
  value: unknown,
  currentSettings: Awaited<ReturnType<typeof getSettings>>,
): Partial<Awaited<ReturnType<typeof getSettings>>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_SETTINGS_PATCH');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'currency',
    'priceSource',
    'followCsboardSettings',
    'showCsboardPricesOnCsfloat',
    'showBetterBuffOnBuff',
    'portfolioSyncEnabled',
    'portfolioSources',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error('INVALID_SETTINGS_PATCH');
  }

  const patch: Partial<Awaited<ReturnType<typeof getSettings>>> = {};
  if (record['currency'] !== undefined) {
    if (!isSupportedCurrency(record['currency'])) throw new Error('INVALID_CURRENCY');
    patch.currency = record['currency'];
  }
  if (record['priceSource'] !== undefined) {
    if (!isSupportedPriceSource(record['priceSource'])) throw new Error('INVALID_PRICE_SOURCE');
    patch.priceSource = record['priceSource'];
  }
  for (const key of [
    'followCsboardSettings',
    'showCsboardPricesOnCsfloat',
    'showBetterBuffOnBuff',
    'portfolioSyncEnabled',
  ] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== 'boolean') throw new Error('INVALID_SETTINGS_PATCH');
      patch[key] = record[key];
    }
  }
  if (record['portfolioSources'] !== undefined) {
    const sources = record['portfolioSources'];
    if (!sources || typeof sources !== 'object' || Array.isArray(sources)) {
      throw new Error('INVALID_PORTFOLIO_SOURCES');
    }
    const sourceRecord = sources as Record<string, unknown>;
    const sourceKeys = ['inventory', 'tradeOffers', 'tradeHistory', 'marketHistory'] as const;
    if (Object.keys(sourceRecord).some((key) => !sourceKeys.includes(key as typeof sourceKeys[number]))) {
      throw new Error('INVALID_PORTFOLIO_SOURCES');
    }
    const next = { ...currentSettings.portfolioSources };
    for (const key of sourceKeys) {
      if (sourceRecord[key] !== undefined) {
        if (typeof sourceRecord[key] !== 'boolean') throw new Error('INVALID_PORTFOLIO_SOURCES');
        if ((key === 'tradeOffers' || key === 'marketHistory') && sourceRecord[key]) {
          throw new Error(key === 'tradeOffers'
            ? 'TRADE_OFFERS_MANAGED_AUTOMATICALLY'
            : 'MARKET_HISTORY_NOT_AVAILABLE');
        }
        next[key] = sourceRecord[key];
      }
    }
    patch.portfolioSources = next;
  }
  return patch;
}

router.on('GET_EXTENSION_SETTINGS', async (msg, sender) => {
  requirePopupSender(sender);
  if (msg.version !== 2) throw new Error('UNSUPPORTED_SETTINGS_VERSION');
  return {
    settings: toPopupSettings(await getSettings()),
    sync: await getPreferenceSyncStatus(),
  };
});

router.on('UPDATE_EXTENSION_SETTINGS', async (msg, sender) => {
  requirePopupSender(sender);
  if (msg.version !== 2) throw new Error('UNSUPPORTED_SETTINGS_VERSION');
  const currentSettings = await getSettings();
  const patch = validateSettingsPatch(msg.data.patch, currentSettings);
  if (portfolioUnpairing && patch.portfolioSyncEnabled === true) {
    throw new Error('UNPAIR_IN_PROGRESS');
  }
  const settings = await updateSettings(patch);
  if (patch.portfolioSyncEnabled === true) {
    // A fresh explicit opt-in is the only way to lift the local fail-closed
    // block left by a remote unpair failure.
    allowPortfolioUploadsAfterExplicitConsent();
  }
  if (!settings.portfolioSyncEnabled || !hasEnabledPortfolioSource(settings)) {
    await clearPortfolioAutoSyncState().catch((error) => {
      logger.warn('Could not clear automatic portfolio sync state', { error: String(error) });
    });
  }
  await priceEngine.init();
  await priceEngine.updateSettings({
    currency: settings.currency,
    priceSource: isSupportedPriceSource(settings.priceSource)
      ? settings.priceSource
      : DEFAULT_POPUP_SETTINGS.priceSource,
  });
  const sync = msg.data.syncFromCsboardNow && settings.followCsboardSettings
    ? await syncSettingsFromSite(true)
    : await getPreferenceSyncStatus();
  return { success: true as const, settings: toPopupSettings(await getSettings()), sync };
});

router.on('GET_PORTFOLIO_SYNC_STATUS', async (msg, sender) => {
  requirePopupSender(sender);
  if (msg.version !== 1) throw new Error('UNSUPPORTED_PORTFOLIO_VERSION');
  return { status: await buildPortfolioPopupStatus() };
});

router.on('PAIR_DEVICE', (msg, sender) => {
  requirePopupSender(sender);
  if (msg.version !== 1) return Promise.reject(new Error('UNSUPPORTED_PORTFOLIO_VERSION'));
  return pairPortfolioDevice(msg.data.code);
});

function pairPortfolioDevice(code: string) {
  if (portfolioUnpairing) return Promise.reject(new Error('UNPAIR_IN_PROGRESS'));
  if (portfolioPairingInFlight) return Promise.reject(new Error('PAIR_IN_PROGRESS'));
  const epoch = portfolioSyncEpoch;
  const pending = performPortfolioPairing(code, epoch);
  const tracked = pending.finally(() => {
    if (portfolioPairingInFlight === tracked) portfolioPairingInFlight = null;
  });
  portfolioPairingInFlight = tracked;
  return tracked;
}

async function performPortfolioPairing(code: string, epoch: number) {
  assertPortfolioPairingEpoch(epoch);
  const controller = await getGatewayController();
  assertPortfolioPairingEpoch(epoch);
  // A repeated CSFolder page message must never disable an already-paired
  // installation. Check before preparePortfolioPairing() clears local consent.
  if ((await controller.status()).paired) throw new Error('ALREADY_PAIRED');
  assertPortfolioPairingEpoch(epoch);
  // Pairing authorizes a device, not portfolio uploads. Persist a clean,
  // disabled baseline before creating a registration so stale settings from a
  // failed unpair can never become consent after an MV3 worker restart.
  await preparePortfolioPairing();
  assertPortfolioPairingEpoch(epoch);
  await controller.pair(code);
  assertPortfolioPairingEpoch(epoch);
  const pairedEpoch = portfolioSyncEpoch;
  assertPortfolioPairingEpoch(pairedEpoch);
  await writeStoredPortfolioUiStatus({
    ...EMPTY_PORTFOLIO_UI_STATUS,
    sourceRecords: {},
    sourceErrors: {},
    sourceWarnings: {},
  });
  assertPortfolioPairingEpoch(pairedEpoch);
  return { status: await buildPortfolioPopupStatus() };
}

async function preparePortfolioPairing(): Promise<void> {
  await updateSettings({
    portfolioSyncEnabled: false,
    portfolioSources: { ...DEFAULT_POPUP_SETTINGS.portfolioSources },
  });
  await clearPortfolioAutoSyncState();
  // An earlier unpair may have destroyed the old private key while its outbox
  // write failed. Never register a new key that could revive those envelopes.
  await clearGatewayOutbox();
}

let portfolioSyncEpoch = 0;
let portfolioUnpairing = false;
// Stays true after a failed remote revoke. The user explicitly asked uploads
// to stop, so only a later explicit opt-in may lift this local fail-closed gate.
let portfolioUploadsBlocked = false;
let portfolioSyncInFlight: Promise<void> | null = null;
let portfolioAutomaticSyncInFlight: Promise<void> | null = null;
let portfolioPairingInFlight: Promise<unknown> | null = null;

function beginPortfolioUnpairFence(): number {
  portfolioSyncEpoch += 1;
  portfolioUnpairing = true;
  portfolioUploadsBlocked = true;
  return portfolioSyncEpoch;
}

function finishPortfolioUnpairAttempt(): void {
  portfolioUnpairing = false;
}

function allowPortfolioUploadsAfterExplicitConsent(): void {
  if (!portfolioUploadsBlocked) return;
  portfolioUploadsBlocked = false;
  portfolioSyncEpoch += 1;
}

function assertPortfolioSyncEpoch(epoch: number): void {
  if (portfolioUnpairing || portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) {
    throw new PortfolioSyncCancelledError();
  }
}

function assertPortfolioPairingEpoch(epoch: number): void {
  if (portfolioUnpairing || epoch !== portfolioSyncEpoch) {
    throw new PortfolioSyncCancelledError();
  }
}

router.on('UNPAIR_DEVICE', async (msg, sender) => {
  requirePopupSender(sender);
  if (msg.version !== 1) throw new Error('UNSUPPORTED_PORTFOLIO_VERSION');
  beginPortfolioUnpairFence();
  const syncToFence = portfolioSyncInFlight;
  const automaticSyncToFence = portfolioAutomaticSyncInFlight;
  const pairingUiToFence = portfolioPairingInFlight;
  const controllerPromise = getGatewayController();
  let localDisableError: unknown;
  let controllerUnpairError: unknown;
  let localCleanupError: unknown;
  const disableLocalUploads = updateSettings({
    portfolioSyncEnabled: false,
    portfolioSources: { ...DEFAULT_POPUP_SETTINGS.portfolioSources },
  }).catch((error: unknown) => {
    localDisableError = error;
  });
  try {
    try {
      const controller = await controllerPromise;
      // Calling unpair raises the controller fence synchronously. The service
      // fence above already blocks every UI/manual/automatic entry point while
      // controller construction is still pending.
      await controller.unpair();
    } catch (error) {
      controllerUnpairError = error;
    }
  } finally {
    await disableLocalUploads;
    // Wait even when controller construction or remote revoke fails. A stale
    // pair or scheduler wrapper must settle before the final destructive pass,
    // otherwise it could recreate registration/UI state afterward.
    await Promise.allSettled([
      syncToFence,
      automaticSyncToFence,
      pairingUiToFence,
    ].filter((pending): pending is Promise<unknown> => pending !== null));
    clearSteamReadProvider();
    const cleanupOutcomes = await Promise.allSettled([
      clearLocalPortfolioPairingArtifacts(),
      chrome.storage.local.remove([
        PORTFOLIO_UI_STATUS_KEY,
        PORTFOLIO_AUTO_SYNC_STATE_KEY,
      ]),
    ]);
    if (cleanupOutcomes.some((outcome) => outcome.status === 'rejected')) {
      localCleanupError = new Error('LOCAL_UNPAIR_CLEANUP_FAILED');
    }
    finishPortfolioUnpairAttempt();
  }
  if (localCleanupError) throw localCleanupError;
  if (localDisableError) throw localDisableError;
  if (controllerUnpairError) throw controllerUnpairError;
  return { status: await buildPortfolioPopupStatus() };
});

async function clearLocalPortfolioPairingArtifacts(): Promise<void> {
  const outcomes = await Promise.allSettled([
    clearGatewayOutbox(),
    getGatewayDeviceKeys().deleteIdentity(),
  ]);
  if (outcomes.some((outcome) => outcome.status === 'rejected')) {
    throw new Error('LOCAL_PAIRING_ARTIFACT_CLEANUP_FAILED');
  }
}

type PortfolioSyncResult = Awaited<ReturnType<GatewayController['syncNow']>>;

function portfolioSyncSuccessStatus(
  previous: StoredPortfolioUiStatus,
  settings: ExtensionSettings,
  result: PortfolioSyncResult,
  attemptedAt: number,
  successfulAt: number,
): StoredPortfolioUiStatus {
  const failedSources = new Set(result.failedSources);
  const sourceRecords: Partial<Record<PortfolioSource, number>> = {
    ...previous.sourceRecords,
  };
  // Accepted offers are collected only as hidden Trade History enrichment.
  // Remove stale values rather than exposing a third source counter. Steam
  // Market history remains unavailable in 1.1.
  delete sourceRecords.tradeOffers;
  delete sourceRecords.marketHistory;
  if (settings.portfolioSources.inventory && !failedSources.has('inventory')) {
    sourceRecords.inventory = result.inventoryItems;
  }
  if (settings.portfolioSources.tradeHistory && !failedSources.has('tradeHistory')) {
    sourceRecords.tradeHistory = result.trades;
  }
  return {
    lastAttemptedAt: attemptedAt,
    lastSuccessfulAt: successfulAt,
    sourceRecords,
    sourceErrors: Object.fromEntries(
      result.failedSources
        .filter((source) => source !== 'tradeOffers')
        .map((source) => [source, 'STEAM_READ_FAILED']),
    ),
    sourceWarnings: {},
  };
}

/**
 * One sync path for both the button and the scheduler, so an automatic run can
 * never drift from the manual one in what it records or how it fails.
 */
async function runPortfolioSync(epoch = portfolioSyncEpoch): Promise<void> {
  if (portfolioUnpairing || portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) {
    throw new PortfolioSyncCancelledError();
  }
  if (portfolioSyncInFlight) return portfolioSyncInFlight;
  const pending = performPortfolioSync(epoch);
  const tracked = pending.finally(() => {
    if (portfolioSyncInFlight === tracked) portfolioSyncInFlight = null;
  });
  portfolioSyncInFlight = tracked;
  return tracked;
}

async function performPortfolioSync(epoch: number): Promise<void> {
  const settings = await getSettings();
  assertPortfolioSyncEpoch(epoch);
  const previous = await readStoredPortfolioUiStatus();
  assertPortfolioSyncEpoch(epoch);
  const attemptedAt = Date.now();
  // Record the attempt and clear the previous verdict BEFORE any guard can
  // throw. Bailing out earlier used to leave the last failure's text on screen
  // with "last attempt: never" beside it, so the popup described a run that had
  // already been superseded — and the user chased the wrong cause.
  const { errorCode: _cleared, ...carried } = previous;
  assertPortfolioSyncEpoch(epoch);
  await writeStoredPortfolioUiStatus({
    ...carried,
    lastAttemptedAt: attemptedAt,
    sourceRecords: previous.sourceRecords,
    sourceErrors: previous.sourceErrors,
    sourceWarnings: previous.sourceWarnings,
  });
  assertPortfolioSyncEpoch(epoch);

  if (!settings.portfolioSyncEnabled || !hasEnabledPortfolioSource(settings)) {
    assertPortfolioSyncEpoch(epoch);
    await writeStoredPortfolioUiStatus({
      ...carried,
      lastAttemptedAt: attemptedAt,
      sourceRecords: previous.sourceRecords,
      sourceErrors: previous.sourceErrors,
      sourceWarnings: previous.sourceWarnings,
      errorCode: 'SYNC_NOT_ENABLED',
    });
    assertPortfolioSyncEpoch(epoch);
    throw new Error('PORTFOLIO_SYNC_NOT_ENABLED');
  }
  try {
    const controller = await getGatewayController();
    assertPortfolioSyncEpoch(epoch);
    const result = await controller.syncNow();
    assertPortfolioSyncEpoch(epoch);
    await writeStoredPortfolioUiStatus(portfolioSyncSuccessStatus(
      previous,
      settings,
      result,
      attemptedAt,
      Date.now(),
    ));
    assertPortfolioSyncEpoch(epoch);
  } catch (error) {
    if (error instanceof PortfolioSyncCancelledError || epoch !== portfolioSyncEpoch) {
      throw new PortfolioSyncCancelledError();
    }
    const safeCode = safePortfolioErrorCode(error);
    let connectionOverride: StoredPortfolioUiStatus['connectionOverride'];
    if (safeCode === 'STEAM_ACCOUNT_MISMATCH') connectionOverride = 'mismatch';
    try {
      const status = await (await getGatewayController()).status();
      assertPortfolioSyncEpoch(epoch);
      if (status.lastFailureCode === 'device-revoked') connectionOverride = 'revoked';
    } catch {
      if (!connectionOverride) connectionOverride = 'error';
    }
    assertPortfolioSyncEpoch(epoch);
    await writeStoredPortfolioUiStatus({
      ...previous,
      lastAttemptedAt: attemptedAt,
      sourceRecords: previous.sourceRecords,
      sourceErrors: previous.sourceErrors,
      sourceWarnings: previous.sourceWarnings,
      errorCode: safeCode,
      ...(connectionOverride ? { connectionOverride } : {}),
    });
    assertPortfolioSyncEpoch(epoch);
    throw error;
  }
}

router.on('RUN_MANUAL_SYNC', async (msg, sender) => {
  requirePopupSender(sender);
  if (msg.version !== 1) throw new Error('UNSUPPORTED_PORTFOLIO_VERSION');
  await runPortfolioSync();
  await clearPortfolioAutoSyncState().catch((error) => {
    logger.warn('Could not clear automatic portfolio sync state', { error: String(error) });
  });
  return { status: await buildPortfolioPopupStatus() };
});

// --- P2P listing publication (normal CSBOARD cookie session only) ---
// The controller stores backend intent IDs and idempotency keys only in this
// service-worker process for at most two minutes. The popup receives an opaque
// review handle and must perform a second, separate confirmation gesture.
const p2pListingController = new P2PListingController();

router.on('GET_P2P_ELIGIBLE_ASSETS', async (msg, sender) => {
  requirePopupSender(sender);
  if (msg.version !== 1) throw new Error('UNSUPPORTED_P2P_VERSION');
  return { assets: await p2pListingController.listEligibleAssets() };
});

router.on('PREPARE_P2P_LISTING', async (msg, sender) => {
  requirePopupSender(sender);
  if (msg.version !== 1) throw new Error('UNSUPPORTED_P2P_VERSION');
  return { review: await p2pListingController.prepare(msg.data) };
});

router.on('CONFIRM_P2P_LISTING', async (msg, sender) => {
  requirePopupSender(sender);
  if (msg.version !== 1) throw new Error('UNSUPPORTED_P2P_VERSION');
  return p2pListingController.confirm(msg.data.reviewId);
});

router.on('CANCEL_P2P_LISTING_REVIEW', async (msg, sender) => {
  requirePopupSender(sender);
  if (msg.version !== 1) throw new Error('UNSUPPORTED_P2P_VERSION');
  p2pListingController.cancel(msg.data.reviewId);
  return { success: true as const };
});

// --- Fetch inventory with asset_properties (float, stickers, certificate) ---
router.on('FETCH_INVENTORY_WITH_PROPERTIES', async (msg) => {
  const contextId = msg.data.contextId ?? '2';
  if (contextId !== '2' && contextId !== '16') throw new Error('INVALID_CONTEXT');
  const provider = await getSteamReadProvider(msg.data.steamId, {
    token: msg.data.pageAccessToken,
    steamId: msg.data.pageSteamId,
  });
  const result = await provider.readInventoryContext(contextId);
  const items = result.items.map((item) => ({
    assetid: item.assetId,
    classid: item.classId,
    instanceid: item.instanceId,
    appid: item.appId,
    contextid: item.contextId,
    amount: item.amount,
    name: item.name ?? item.marketHashName,
    market_hash_name: item.marketHashName,
    icon_url: item.iconUrl ?? '',
    tradable: item.tradable ? 1 : 0,
    marketable: item.marketable ? 1 : 0,
    tags: [],
    descriptions: [],
    owner_descriptions: [],
    actions: [],
    floatValue: item.floatValue ?? null,
    paintSeed: item.paintSeed ?? null,
    defIndex: item.defIndex ?? null,
    paintIndex: item.paintIndex ?? null,
  }));
  return { items, totalCount: items.length };
});

router.on('UPDATE_PRICE_SETTINGS', async (msg) => {
  await priceEngine.init();
  const patch: Partial<PriceEngineSettings> = {};
  if (msg.data.currency !== undefined) {
    if (!isSupportedCurrency(msg.data.currency)) throw new Error('INVALID_CURRENCY');
    patch.currency = msg.data.currency;
  }
  if (msg.data.priceSource !== undefined) {
    if (!isSupportedPriceSource(msg.data.priceSource)) throw new Error('INVALID_PRICE_SOURCE');
    patch.priceSource = msg.data.priceSource;
  }
  await priceEngine.updateSettings(patch);
  return { success: true };
});

router.on('GET_STEAM_READ_SESSION_STATUS', async () => {
  return { ready: steamReadProvider !== null };
});

router.on('OFFER_STEAM_PAGE_CREDENTIAL', async (msg, sender) => {
  if (msg.version !== 1 ||
      !isTrustedSteamPageSender(sender, chrome.runtime.id)) {
    throw new Error('INVALID_STEAM_PAGE_SENDER');
  }
  const credential = normalizeSteamPageCredential(msg.data);
  if (!credential) throw new Error('INVALID_STEAM_PAGE_CREDENTIAL');

  const [registration, settings] = await Promise.all([
    getGatewayDeviceKeys().getRegistration().catch((): null => null),
    getSettings(),
  ]);
  // Do not retain a broad page credential when portfolio sync is not both
  // paired and explicitly enabled. The content script receives no account or
  // portfolio state in response.
  if (!registration || !settings.portfolioSyncEnabled ||
      !hasEnabledPortfolioSource(settings)) {
    return { accepted: true as const, syncTriggered: false };
  }

  await getSteamReadProvider(registration.steamId, {
    token: credential.pageAccessToken,
    steamId: credential.pageSteamId,
  });
  const syncTriggered = await runCredentialAssistedPortfolioSync(
    registration.pairedAt,
    registration.steamId,
    credential,
  );
  return { accepted: true as const, syncTriggered };
});

router.on('GET_TRADE_HOLD_ITEMS', async (msg) => {
  // For now, directly fetch from Steam without requiring stored token
  // The Steam community inventory endpoint uses browser cookies
  const result = await getTradeHoldItems(msg.data.steamId);

  if (result.ok) {
    return result.value;
  }

  // Return empty result on error (caller can decide to retry)
  logger.error('Failed to fetch trade hold items', {
    steamId: msg.data.steamId,
    error: result.error.message,
  });

  return {
    items: [],
    totalOnHold: 0,
    fetchedAt: Date.now(),
  };
});

router.on('CLEAR_STEAM_READ_SESSION', async () => {
  clearSteamReadProvider();
  logger.info('Private Steam read session cleared');
  return { success: true as const };
});

// --- Steam Trade Offers (IEconService — cs2trader approach) ---

router.on('FETCH_STEAM_TRADE_OFFERS', async (msg) => {
  const provider = await getSteamReadProvider(msg.data?.pageSteamId, {
    token: msg.data?.pageAccessToken,
    steamId: msg.data?.pageSteamId,
  });
  const includeSent = msg.data?.sent !== 0;
  const includeReceived = msg.data?.received !== 0;
  // The page-facing read, NOT `readTradeOffers`: that one returns the portfolio
  // DTO, which carries ids and a market name only. Routing the offers page
  // through it dropped `descriptions`, `tags` and `icon_url`, which is what
  // silently killed sticker totals, rarity colours and Doppler phases here.
  const { offers } = await provider.readTradeOffersForDisplay({
    sent: includeSent,
    received: includeReceived,
  });
  const selected = offers.filter((offer) =>
    (offer.direction === 'sent' ? includeSent : includeReceived));

  const rawOffers = selected.map((offer) => ({
    tradeofferid: offer.tradeofferid,
    accountid_other: offer.accountid_other,
    trade_offer_state: offer.trade_offer_state,
    time_created: offer.time_created,
    ...(offer.expiration_time !== undefined
      ? { expiration_time: offer.expiration_time }
      : {}),
    ...(offer.escrow_end_date !== undefined
      ? { escrow_end_date: offer.escrow_end_date }
      : {}),
    items_to_give: offer.items_to_give,
    items_to_receive: offer.items_to_receive,
  }));

  const items: Array<Record<string, unknown>> = [];
  for (const offer of selected) {
    const collect = (
      sideItems: readonly SteamOfferDisplayItem[],
      side: 'your' | 'their',
    ) => {
      for (const item of sideItems) {
        items.push({
          ...item,
          // `position` already comes from the provider as the item's index
          // inside its side of the offer — the key the page matches DOM tiles
          // on. Recomputing it here would break once a row is skipped.
          name: item.name ?? item.market_hash_name,
          side,
          inOffer: offer.tradeofferid,
          accountid_other: offer.accountid_other,
          offerOrigin: offer.direction,
        });
      }
    };
    collect(offer.items_to_give, 'your');
    collect(offer.items_to_receive, 'their');
  }
  return {
    offers: {
      trade_offers_received: rawOffers.filter((_, index) => selected[index]?.direction === 'received'),
      trade_offers_sent: rawOffers.filter((_, index) => selected[index]?.direction === 'sent'),
    },
    items,
  };
});

// Start listening
router.listen();

// The complete externally-connectable surface is one static, read-only status
// probe for CSBOARD plus bounded CSFolder fresh-pair and paired-reactivation
// actions. No
// external caller can unpair, run arbitrary syncs, change sources or reach a
// Steam credential-bearing provider.
registerExternalStatusRouter({
  statusAllowedOrigins: ['https://csboard.com', 'https://csboard.trade'],
  pairingAllowedOrigins: ['https://csfolder.com'],
  extensionVersion: chrome.runtime.getManifest().version,
  handlers: {
    async isPaired() {
      if (portfolioUnpairing) return false;
      const controller = await getGatewayController();
      if (portfolioUnpairing) return false;
      return (await controller.status()).paired;
    },
    async pair(code) {
      await pairPortfolioDevice(code);
    },
    async enablePortfolioSync() {
      if (portfolioUnpairing) throw new Error('UNPAIR_IN_PROGRESS');
      // Clear scheduler residue before consent becomes true, so there is no
      // interval in which an old alarm can observe a partially activated state.
      await clearPortfolioAutoSyncState();
      await updateSettings({
        portfolioSyncEnabled: true,
        portfolioSources: {
          inventory: true,
          tradeOffers: false,
          tradeHistory: true,
          marketHistory: false,
        },
      });
      allowPortfolioUploadsAfterExplicitConsent();
    },
    async syncNow() {
      const epoch = portfolioSyncEpoch;
      // The external response means "triggered", not "all Steam reads have
      // completed". Keep the CSFolder click bounded while the existing fenced
      // sync path records success/failure and the hourly retry path remains in
      // charge of transient Steam/network failures.
      void runPortfolioSync(epoch).catch((error) => {
        if (!(error instanceof PortfolioSyncCancelledError)) {
          logger.warn('Initial CSFolder portfolio sync did not complete', {
            error: safePortfolioErrorCode(error),
          });
        }
      });
    },
    async disablePortfolioSync() {
      // Raise the process fence before storage I/O. If persisting the disabled
      // state fails, destroy the local pairing so an MV3 restart still cannot
      // resume uploads from stale enabled settings.
      portfolioUploadsBlocked = true;
      portfolioSyncEpoch += 1;
      try {
        await updateSettings({
          portfolioSyncEnabled: false,
          portfolioSources: { ...DEFAULT_POPUP_SETTINGS.portfolioSources },
        });
        await clearPortfolioAutoSyncState();
      } catch (error) {
        try {
          await (await getGatewayController()).unpair();
        } finally {
          await clearLocalPortfolioPairingArtifacts().catch(() => undefined);
        }
        throw error;
      }
    },
  },
});

// ============================================================
// Price Refresh Functions
// ============================================================

async function refreshAllPrices(): Promise<{ success: boolean; count: number }> {
  try {
    const etag = await priceEngine.getStoredEtag();
    const headers: Record<string, string> = {
      'Accept-Encoding': 'gzip',
    };
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    const apiBase = await getApiBase();
    const response = await fetch(`${apiBase}/extension/prices`, {
      headers,
    });

    // 304 Not Modified — prices haven't changed
    if (response.status === 304) {
      logger.debug('Prices unchanged (304)');
      return { success: true, count: priceEngine.itemCount };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const newEtag = response.headers.get('ETag') || `${Date.now()}`;

    await priceEngine.storePrices(data as Record<string, CompactPrice>, newEtag);
    logger.info('Prices refreshed', { count: Object.keys(data).length });

    return { success: true, count: Object.keys(data).length };
  } catch (err) {
    logger.error('Failed to refresh prices', { error: String(err) });
    return { success: false, count: priceEngine.itemCount };
  }
}

// CSBOARD's OWN minAsk per item — reuses the public csgoskins.gg partner feed
// (GET /api/csgoskinsgg), which serves exactly what an anonymous visitor pays on
// checkout (cheapest_price), one row per Doppler phase. Stored as a compact
// { "name|phase": cents } map for the CSFloat panel to read. This is the REAL
// CSBOARD price (not buff163, which the price-engine carries).
const CSBOARD_PRICES_KEY = 'csboard_prices';

async function refreshCsboardPrices(): Promise<{ success: boolean; count: number }> {
  try {
    const apiBase = await getApiBase(); // https://csboard.com/api
    const response = await fetch(`${apiBase}/csgoskinsgg`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = (await response.json()) as Array<{
      market_hash_name?: string;
      phase?: string | null;
      cheapest_price?: number;
    }>;
    const map: Record<string, number> = {};
    for (const r of rows) {
      if (!r.market_hash_name || typeof r.cheapest_price !== 'number' || r.cheapest_price <= 0) continue;
      const key = `${r.market_hash_name}|${r.phase ?? ''}`;
      const cents = Math.round(r.cheapest_price * 100);
      if (map[key] === undefined || cents < map[key]!) map[key] = cents;
    }
    await chrome.storage.local.set({ [CSBOARD_PRICES_KEY]: map });
    logger.info('CSBOARD prices refreshed', { count: Object.keys(map).length });
    return { success: true, count: Object.keys(map).length };
  } catch (err) {
    logger.error('Failed to refresh CSBOARD prices', { error: String(err) });
    return { success: false, count: 0 };
  }
}

async function refreshExchangeRates(): Promise<void> {
  try {
    const apiBase = await getApiBase();
    const response = await fetch(`${apiBase}/extension/exchange-rates`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rates = await response.json();
    await priceEngine.storeExchangeRates(rates);
    logger.info('Exchange rates refreshed');
  } catch (err) {
    logger.error('Failed to refresh exchange rates', { error: String(err) });
  }
}

// ============================================================
// (Trade Verification Handlers removed — TB feature stripped from prod build)
// Periodic Tasks (Alarms)
// ============================================================

// Register alarms on install AND startup (MV3 service worker restarts)
chrome.runtime.onInstalled.addListener(async (details) => {
  logger.info('Extension installed/updated', { reason: details.reason });

  // Run storage migrations
  await runMigrations();

  // Register alarms
  await registerAlarms();

  // Load prices immediately
  refreshAllPrices().catch(err => logger.error('Initial price load failed', { error: String(err) }));
  refreshCsboardPrices().catch(err => logger.error('Initial CSBOARD price load failed', { error: String(err) }));
  refreshExchangeRates().catch(err => logger.error('Initial rates load failed', { error: String(err) }));

  // Sync settings from CSBoard site (currency, priceSource)
  syncSettingsFromSite().catch(() => {});

  if (details.reason === 'install') {
    chrome.tabs.create({ url: `${SITE_BASE}/extension/welcome` });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  logger.info('Extension startup (service worker wake)');
  await runMigrations();
  await registerAlarms();
  refreshAllPrices().catch(err => logger.error('Startup price load failed', { error: String(err) }));
  refreshCsboardPrices().catch(err => logger.error('Startup CSBOARD price load failed', { error: String(err) }));
  refreshExchangeRates().catch(err => logger.error('Startup rates load failed', { error: String(err) }));
  syncSettingsFromSite().catch(() => {});
});

// Sync user settings (currency, priceSource) from CSBoard /auth/me
async function syncSettingsFromSite(force = false): Promise<PricePreferenceSyncStatus> {
  const local = await getSettings();
  const previous = await getPreferenceSyncStatus();
  if (!local.followCsboardSettings && !force) {
    const idle: PricePreferenceSyncStatus = {
      state: 'idle',
      lastSyncedAt: previous.lastSyncedAt,
    };
    await setPreferenceSyncStatus(idle);
    return idle;
  }

  await setPreferenceSyncStatus({
    state: 'syncing',
    lastSyncedAt: previous.lastSyncedAt,
  });
  try {
    const apiBase = await getApiBase();
    const response = await fetch(`${apiBase}/auth/me`, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
    if (response.status === 401 || response.status === 403) {
      const signedOut: PricePreferenceSyncStatus = {
        state: 'signed_out',
        lastSyncedAt: previous.lastSyncedAt,
      };
      await setPreferenceSyncStatus(signedOut);
      return signedOut;
    }
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const parsed: unknown = await response.json();
    const user = unwrapAuthMeUserPayload(parsed);
    if (!user) {
      throw new Error('INVALID_REMOTE_SETTINGS');
    }

    const updates: {
      currency?: PopupSettingsV2['currency'];
      priceSource?: PopupSettingsV2['priceSource'];
    } = {};
    const rejected: string[] = [];
    if (user['priceSource'] !== undefined) {
      if (isSupportedPriceSource(user['priceSource'])) updates.priceSource = user['priceSource'];
      else rejected.push('priceSource');
    }
    if (user['currency'] !== undefined) {
      if (isSupportedCurrency(user['currency'])) updates.currency = user['currency'];
      else rejected.push('currency');
    }

    if (Object.keys(updates).length > 0) {
      const next = await updateSettings(updates);
      await priceEngine.init();
      await priceEngine.updateSettings({
        currency: next.currency,
        priceSource: isSupportedPriceSource(next.priceSource)
          ? next.priceSource
          : DEFAULT_POPUP_SETTINGS.priceSource,
      });
      logger.info('Settings synced from site', {
        fields: Object.keys(updates),
        rejectedFields: rejected,
      });
    }

    const status: PricePreferenceSyncStatus = {
      state: rejected.length > 0 ? 'warning' : 'success',
      lastSyncedAt: Date.now(),
      ...(rejected.length > 0 ? { warningCode: 'UNSUPPORTED_REMOTE_PREFERENCE' } : {}),
    };
    await setPreferenceSyncStatus(status);
    return status;
  } catch (error) {
    const status: PricePreferenceSyncStatus = {
      state: 'error',
      lastSyncedAt: previous.lastSyncedAt,
      warningCode: 'CSBOARD_SETTINGS_UNAVAILABLE',
    };
    await setPreferenceSyncStatus(status);
    logger.warn('Could not sync CSBOARD settings; retained last valid values', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return status;
  }
}

/**
 * Portfolio syncs on a schedule so the user never has to press anything. The
 * period is deliberately unhurried: a portfolio is not a live feed, and every
 * run costs several Steam reads that are rate-limited per account.
 */
const PORTFOLIO_AUTO_SYNC_MINUTES = 60;
const PORTFOLIO_AUTO_SYNC_ALARM = 'portfolio-auto-sync';
const PORTFOLIO_AUTO_SYNC_STATE_KEY = 'csboard_portfolio_auto_sync_v1';
const PORTFOLIO_AUTO_SYNC_BASE_BACKOFF_MS = 60 * 60 * 1_000;
const PORTFOLIO_AUTO_SYNC_MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;
const PORTFOLIO_AUTO_SYNC_MAX_FAILURES = 8;
const PORTFOLIO_CREDENTIAL_SYNC_STATE_KEY = 'csboard_portfolio_page_sync_throttle_v1';
const PORTFOLIO_CREDENTIAL_SYNC_THROTTLE_MS = 60 * 60 * 1_000;

interface StoredPortfolioAutoSyncState {
  readonly consecutiveFailures: number;
  readonly nextAttemptAt: number | null;
  /** Device revocation is terminal until the user explicitly pairs again. */
  readonly suspended: boolean;
}

const EMPTY_PORTFOLIO_AUTO_SYNC_STATE: StoredPortfolioAutoSyncState = {
  consecutiveFailures: 0,
  nextAttemptAt: null,
  suspended: false,
};

async function readPortfolioAutoSyncState(): Promise<StoredPortfolioAutoSyncState> {
  const stored = await chrome.storage.local.get(PORTFOLIO_AUTO_SYNC_STATE_KEY);
  const value = stored[PORTFOLIO_AUTO_SYNC_STATE_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return EMPTY_PORTFOLIO_AUTO_SYNC_STATE;
  }
  const record = value as Record<string, unknown>;
  const rawNextAttemptAt = record['nextAttemptAt'];
  // A corrupt or implausibly distant timestamp must not disable sync forever.
  const nextAttemptAt = typeof rawNextAttemptAt === 'number' &&
      Number.isSafeInteger(rawNextAttemptAt) && rawNextAttemptAt > 0 &&
      rawNextAttemptAt <= Date.now() + PORTFOLIO_AUTO_SYNC_MAX_BACKOFF_MS
    ? rawNextAttemptAt
    : null;
  const rawFailures = record['consecutiveFailures'];
  const consecutiveFailures = typeof rawFailures === 'number' &&
      Number.isSafeInteger(rawFailures) && rawFailures >= 0 &&
      rawFailures <= PORTFOLIO_AUTO_SYNC_MAX_FAILURES
    ? rawFailures
    // Preserve the hold written by the initial scheduler implementation.
    : nextAttemptAt === null ? 0 : 1;
  return {
    consecutiveFailures,
    nextAttemptAt,
    suspended: record['suspended'] === true,
  };
}

async function clearPortfolioAutoSyncState(): Promise<void> {
  await chrome.storage.local.remove(PORTFOLIO_AUTO_SYNC_STATE_KEY);
}

function portfolioAutoSyncBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(
    PORTFOLIO_AUTO_SYNC_MAX_BACKOFF_MS,
    PORTFOLIO_AUTO_SYNC_BASE_BACKOFF_MS * (2 ** exponent),
  );
}

async function persistPortfolioAutoSyncFailure(
  previous: StoredPortfolioAutoSyncState,
  error: unknown,
): Promise<void> {
  const state = portfolioAutoSyncFailureState(previous, error);
  await chrome.storage.local.set({ [PORTFOLIO_AUTO_SYNC_STATE_KEY]: state });
}

function portfolioAutoSyncFailureState(
  previous: StoredPortfolioAutoSyncState,
  error: unknown,
  now = Date.now(),
): StoredPortfolioAutoSyncState {
  const consecutiveFailures = Math.min(
    PORTFOLIO_AUTO_SYNC_MAX_FAILURES,
    previous.consecutiveFailures + 1,
  );
  const suspended = safePortfolioErrorCode(error) === 'DEVICE_REVOKED';
  return {
    consecutiveFailures,
    nextAttemptAt: suspended
      ? null
      : now + portfolioAutoSyncBackoffMs(consecutiveFailures),
    suspended,
  };
}

function runAutomaticPortfolioSync(): Promise<void> {
  if (portfolioAutomaticSyncInFlight) return portfolioAutomaticSyncInFlight;
  const epoch = portfolioSyncEpoch;
  const pending = performAutomaticPortfolioSync(epoch);
  const tracked = pending.finally(() => {
    if (portfolioAutomaticSyncInFlight === tracked) {
      portfolioAutomaticSyncInFlight = null;
    }
  });
  portfolioAutomaticSyncInFlight = tracked;
  return tracked;
}

interface StoredPortfolioCredentialSyncState {
  readonly lastAttemptedAt: number;
}

let portfolioCredentialSyncInFlight: Promise<boolean> | null = null;

async function readPortfolioCredentialSyncState(): Promise<StoredPortfolioCredentialSyncState | null> {
  const stored = await chrome.storage.local.get(PORTFOLIO_CREDENTIAL_SYNC_STATE_KEY);
  const value = stored[PORTFOLIO_CREDENTIAL_SYNC_STATE_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lastAttemptedAt = (value as Record<string, unknown>)['lastAttemptedAt'];
  if (typeof lastAttemptedAt !== 'number' || !Number.isSafeInteger(lastAttemptedAt) ||
      lastAttemptedAt <= 0 || lastAttemptedAt > Date.now() + 60_000) {
    return null;
  }
  return { lastAttemptedAt };
}

/**
 * A fresh first-party credential is a change in prerequisites, so it must
 * bypass a stale exponential backoff (including the old 8-failure ceiling).
 * The separate durable timestamp still enforces the disclosed hourly cadence
 * across MV3 service-worker restarts and multiple Steam tabs.
 */
function runCredentialAssistedPortfolioSync(
  pairedAt: number,
  expectedSteamId: string,
  credential: { readonly pageAccessToken: string; readonly pageSteamId: string },
): Promise<boolean> {
  if (portfolioCredentialSyncInFlight) return portfolioCredentialSyncInFlight;
  const epoch = portfolioSyncEpoch;
  const pending = performCredentialAssistedPortfolioSync(
    epoch,
    pairedAt,
    expectedSteamId,
    credential,
  );
  const tracked = pending.finally(() => {
    if (portfolioCredentialSyncInFlight === tracked) {
      portfolioCredentialSyncInFlight = null;
    }
  });
  portfolioCredentialSyncInFlight = tracked;
  return tracked;
}

async function performCredentialAssistedPortfolioSync(
  epoch: number,
  pairedAt: number,
  expectedSteamId: string,
  credential: { readonly pageAccessToken: string; readonly pageSteamId: string },
): Promise<boolean> {
  if (portfolioUnpairing || portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) return false;
  const now = Date.now();
  const credentialState = await readPortfolioCredentialSyncState().catch(() => null);
  if (portfolioUnpairing || portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) return false;
  if (credentialState && credentialState.lastAttemptedAt >= pairedAt &&
      now - credentialState.lastAttemptedAt < PORTFOLIO_CREDENTIAL_SYNC_THROTTLE_MS) {
    return false;
  }

  // A manual/alarm run may already be past its Steam-session probe when the
  // first-party credential arrives. Joining that old promise and claiming the
  // hourly slot immediately used to lose the credential: the old run rejected,
  // cleared the provider and suppressed the only useful retry for an hour.
  // Let the old verdict settle first. Success means the data is already fresh;
  // only a session failure warrants one new credential-backed run.
  const overlappingSync = portfolioSyncInFlight;
  const overlappingAutomaticSync = portfolioAutomaticSyncInFlight;
  if (overlappingSync) {
    try {
      await overlappingSync;
      if (overlappingAutomaticSync) await overlappingAutomaticSync;
      if (portfolioUnpairing || portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) {
        return false;
      }
      await chrome.storage.local.set({
        [PORTFOLIO_CREDENTIAL_SYNC_STATE_KEY]: { lastAttemptedAt: Date.now() },
      });
      await clearPortfolioAutoSyncState().catch((error) => {
        logger.warn('Could not clear automatic portfolio sync state after overlapping success', {
          error: String(error),
        });
      });
      return false;
    } catch (error) {
      if (error instanceof PortfolioSyncCancelledError || portfolioUnpairing ||
          portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) {
        return false;
      }
      if (safePortfolioErrorCode(error) !== 'STEAM_SESSION_REQUIRED') {
        // The page credential cannot repair a gateway/network/data failure.
        // Still consume this bridge cadence so the four-minute page refresh
        // cannot bypass the scheduler's backoff and hammer the same failure.
        await chrome.storage.local.set({
          [PORTFOLIO_CREDENTIAL_SYNC_STATE_KEY]: { lastAttemptedAt: Date.now() },
        });
        return false;
      }

      // The automatic wrapper persists the old failure after the shared sync
      // promise rejects. Wait for that bookkeeping before the recovery run so
      // it cannot recreate stale backoff after a later successful retry.
      if (overlappingAutomaticSync) await Promise.allSettled([overlappingAutomaticSync]);
      if (portfolioUnpairing || portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) {
        return false;
      }
      // The failed old run may have forgotten the provider. Re-offer the
      // still-memory-only credential and bind it to the paired Steam account.
      await getSteamReadProvider(expectedSteamId, {
        token: credential.pageAccessToken,
        steamId: credential.pageSteamId,
      });
      if (portfolioUnpairing || portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) {
        return false;
      }
    }
  }

  // Claim the hourly slot before any network read. This record contains only a
  // timestamp; the Steam token and account credential remain process-memory-only.
  await chrome.storage.local.set({
    [PORTFOLIO_CREDENTIAL_SYNC_STATE_KEY]: { lastAttemptedAt: Date.now() },
  });
  if (portfolioUnpairing || portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) return false;

  const previousAutoState = await readPortfolioAutoSyncState()
    .catch(() => EMPTY_PORTFOLIO_AUTO_SYNC_STATE);
  try {
    // Deliberately call the shared fenced path directly instead of the alarm
    // wrapper: a fresh credential must recover immediately from nextAttemptAt.
    await runPortfolioSync(epoch);
    await clearPortfolioAutoSyncState().catch((error) => {
      logger.warn('Could not clear automatic portfolio sync state after credential recovery', {
        error: String(error),
      });
    });
  } catch (error) {
    if (error instanceof PortfolioSyncCancelledError || portfolioUnpairing ||
        portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) {
      return false;
    }
    await persistPortfolioAutoSyncFailure(previousAutoState, error).catch((storageError) => {
      logger.warn('Could not persist credential-assisted sync backoff', {
        error: String(storageError),
      });
    });
    logger.warn('Credential-assisted portfolio sync failed', {
      error: safePortfolioErrorCode(error),
    });
  }
  return true;
}

async function performAutomaticPortfolioSync(epoch: number): Promise<void> {
  let state = EMPTY_PORTFOLIO_AUTO_SYNC_STATE;
  try {
    const settings = await getSettings();
    if (portfolioUnpairing || portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) return;
    if (!settings.portfolioSyncEnabled || !hasEnabledPortfolioSource(settings)) return;

    // No paired device means nothing to upload to, and asking would only log
    // noise on every tick.
    const paired = await getGatewayDeviceKeys().getRegistration().catch((): null => null);
    if (portfolioUnpairing || portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) return;
    if (!paired) return;

    state = await readPortfolioAutoSyncState();
    if (portfolioUnpairing || portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) return;
    if (state.suspended || (state.nextAttemptAt !== null && Date.now() < state.nextAttemptAt)) {
      return;
    }

    await runPortfolioSync(epoch);
    if (portfolioUnpairing || portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) return;
    await clearPortfolioAutoSyncState().catch((error) => {
      logger.warn('Could not clear automatic portfolio sync state after success', {
        error: String(error),
      });
    });
  } catch (error) {
    if (
      error instanceof PortfolioSyncCancelledError ||
      portfolioUnpairing ||
      portfolioUploadsBlocked ||
      epoch !== portfolioSyncEpoch
    ) return;
    // The encrypted outbox owns per-envelope retries. This scheduler backoff
    // only prevents creating fresh snapshots while those retries settle.
    try {
      if (portfolioUnpairing || portfolioUploadsBlocked || epoch !== portfolioSyncEpoch) return;
      await persistPortfolioAutoSyncFailure(state, error);
    } catch (storageError) {
      logger.warn('Could not persist automatic portfolio sync backoff', {
        error: String(storageError),
      });
    }
    logger.warn('Automatic portfolio sync failed', { error: String(error) });
  }
}

async function registerAlarms() {
  chrome.alarms.create(PORTFOLIO_AUTO_SYNC_ALARM, {
    periodInMinutes: PORTFOLIO_AUTO_SYNC_MINUTES,
    delayInMinutes: 5,
  });
  chrome.alarms.create('refresh-prices', { periodInMinutes: 5 });
  chrome.alarms.create('refresh-csboard-prices', { periodInMinutes: 10 });
  chrome.alarms.create('refresh-exchange-rates', { periodInMinutes: 60 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  switch (alarm.name) {
    case 'refresh-prices':
      await refreshAllPrices();
      return;
    case 'refresh-csboard-prices':
      await refreshCsboardPrices();
      return;
    case 'refresh-exchange-rates':
      await refreshExchangeRates();
      return;
    case PORTFOLIO_AUTO_SYNC_ALARM:
      await runAutomaticPortfolioSync();
      return;
  }
});
