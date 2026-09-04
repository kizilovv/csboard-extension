// ============================================================
// CSBOARD Popup — internal message contract
// ============================================================
// These messages are extension-internal only. They must be registered on the
// internal runtime router and must never be exposed through onMessageExternal.

export const POPUP_SETTINGS_SCHEMA_VERSION = 2 as const;
export const POPUP_PORTFOLIO_PROTOCOL_VERSION = 1 as const;

export const SUPPORTED_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'CNY',
  'RUB',
  'UAH',
  'BRL',
  'TRY',
  'PLN',
  'KZT',
  'CAD',
  'AUD',
  'JPY',
  'KRW',
  'INR',
] as const;

export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

export const SUPPORTED_PRICE_SOURCES = [
  'buff163',
  'buff163_buy',
  'steam',
  'skinport',
  'dmarket',
  'csfloat',
  'youpin',
  'lisskins',
] as const;

export type SupportedPriceSource = typeof SUPPORTED_PRICE_SOURCES[number];

export interface PortfolioSources {
  readonly inventory: boolean;
  readonly tradeOffers: boolean;
  readonly tradeHistory: boolean;
  readonly marketHistory: boolean;
}

export interface PopupSettingsV2 {
  readonly schemaVersion: typeof POPUP_SETTINGS_SCHEMA_VERSION;
  readonly currency: SupportedCurrency;
  readonly priceSource: SupportedPriceSource;
  /** Master switch for every on-page enhancement. Delivery is unaffected. */
  readonly enhancementsEnabled: boolean;
  /** Desktop notification when a sale needs the seller. */
  readonly salesNotifications: boolean;
  readonly followCsboardSettings: boolean;
  /** Per-site draw switches. The popup shows exactly these three. */
  readonly showOnSteam: boolean;
  readonly showCsboardPricesOnCsfloat: boolean;
  readonly showBetterBuffOnBuff: boolean;
  readonly portfolioSyncEnabled: boolean;
  readonly portfolioSources: PortfolioSources;
}

export type PricePreferenceSyncState =
  | 'idle'
  | 'syncing'
  | 'success'
  | 'warning'
  | 'error'
  | 'signed_out';

export interface PricePreferenceSyncStatus {
  readonly state: PricePreferenceSyncState;
  readonly lastSyncedAt: number | null;
  readonly warningCode?: string;
}

export const DEFAULT_POPUP_SETTINGS: PopupSettingsV2 = {
  schemaVersion: POPUP_SETTINGS_SCHEMA_VERSION,
  currency: 'USD',
  priceSource: 'buff163',
  // Existing installs currently follow /auth/me. Migration must preserve that
  // behaviour unless the user explicitly turns it off.
  enhancementsEnabled: true,
  salesNotifications: true,
  followCsboardSettings: true,
  showOnSteam: true,
  showCsboardPricesOnCsfloat: true,
  showBetterBuffOnBuff: false,
  // Portfolio upload is a separate, explicit opt-in and is never enabled by
  // installing/upgrading the extension or by pairing a device.
  portfolioSyncEnabled: false,
  portfolioSources: {
    inventory: false,
    tradeOffers: false,
    tradeHistory: false,
    marketHistory: false,
  },
};

export type PortfolioSource =
  | 'inventory'
  | 'tradeOffers'
  | 'tradeHistory'
  | 'marketHistory';

export type PortfolioConnectionState =
  | 'unpaired'
  | 'paired'
  | 'revoked'
  | 'mismatch'
  | 'error';

export type PortfolioSourceRunState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'success'
  | 'error'
  | 'disabled';

export interface PortfolioSourceStatus {
  readonly enabled: boolean;
  readonly state: PortfolioSourceRunState;
  readonly records?: number;
  readonly errorCode?: string;
  /** Sanitized non-fatal source warning (for example, a bounded Steam result set). */
  readonly warningCode?: string;
}

export interface PortfolioSyncStatus {
  readonly connectionState: PortfolioConnectionState;
  readonly steamId: string | null;
  readonly paused: boolean;
  readonly sources: Readonly<Record<PortfolioSource, PortfolioSourceStatus>>;
  readonly lastAttemptedAt: number | null;
  readonly lastSuccessfulAt: number | null;
  readonly queuedRecords: number;
  readonly retryAt: number | null;
  readonly errorCode?: string;
}

export const DEFAULT_PORTFOLIO_STATUS: PortfolioSyncStatus = {
  connectionState: 'unpaired',
  steamId: null,
  paused: false,
  sources: {
    inventory: { enabled: false, state: 'disabled' },
    tradeOffers: { enabled: false, state: 'disabled' },
    tradeHistory: { enabled: false, state: 'disabled' },
    marketHistory: { enabled: false, state: 'disabled' },
  },
  lastAttemptedAt: null,
  lastSuccessfulAt: null,
  queuedRecords: 0,
  retryAt: null,
};

export type PopupInternalRequest =
  | { type: 'GET_EXTENSION_SETTINGS'; version: 2 }
  | {
      type: 'UPDATE_EXTENSION_SETTINGS';
      version: 2;
      data: {
        patch: Partial<Omit<PopupSettingsV2, 'schemaVersion'>>;
        syncFromCsboardNow?: boolean;
      };
    }
  | { type: 'GET_PORTFOLIO_SYNC_STATUS'; version: 1 }
  | { type: 'PAIR_DEVICE'; version: 1; data: { code: string } }
  | { type: 'UNPAIR_DEVICE'; version: 1 }
  | { type: 'RUN_MANUAL_SYNC'; version: 1 };

export interface PopupSettingsResponse {
  readonly settings: PopupSettingsV2;
  readonly sync: PricePreferenceSyncStatus;
}

export interface PopupSettingsUpdateResponse {
  readonly success: true;
  readonly settings: PopupSettingsV2;
  readonly sync?: PricePreferenceSyncStatus;
}

export interface PortfolioStatusResponse {
  readonly status: PortfolioSyncStatus;
}

export type PopupInternalResponseMap = {
  GET_EXTENSION_SETTINGS: PopupSettingsResponse;
  UPDATE_EXTENSION_SETTINGS: PopupSettingsUpdateResponse;
  GET_PORTFOLIO_SYNC_STATUS: PortfolioStatusResponse;
  PAIR_DEVICE: PortfolioStatusResponse;
  UNPAIR_DEVICE: PortfolioStatusResponse;
  RUN_MANUAL_SYNC: PortfolioStatusResponse;
};

export type PopupInternalMessageType = PopupInternalRequest['type'];

export type PopupResponseFor<T extends PopupInternalMessageType> =
  PopupInternalResponseMap[T];

export function isSupportedCurrency(value: unknown): value is SupportedCurrency {
  return typeof value === 'string'
    && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export function isSupportedPriceSource(value: unknown): value is SupportedPriceSource {
  return typeof value === 'string'
    && (SUPPORTED_PRICE_SOURCES as readonly string[]).includes(value);
}
