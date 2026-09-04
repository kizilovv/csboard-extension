// ============================================================
// CSBOARD Extension — Shared Types
// ============================================================
// Senior-level type system:
// - Branded types prevent mixing up string IDs
// - Discriminated unions for messages — no `any` anywhere
// - Const enums for zero-cost runtime abstractions

// --- Branded Types ---
// Prevents accidentally passing a SteamId where a TradeOfferId is expected

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

import type {
  PopupSettingsV2,
  PricePreferenceSyncStatus,
  PortfolioSyncStatus as PopupPortfolioSyncStatus,
} from '../popup/contracts';

export type SteamId64 = Brand<string, 'SteamId64'>;
export type TradeOfferId = Brand<string, 'TradeOfferId'>;
export type TradeBoardId = Brand<string, 'TradeBoardId'>;
export type AssetId = Brand<string, 'AssetId'>;
export type ClassId = Brand<string, 'ClassId'>;
export type InstanceId = Brand<string, 'InstanceId'>;
export type AuthToken = Brand<string, 'AuthToken'>;
export type MarketHashName = Brand<string, 'MarketHashName'>;

// Brand constructors (runtime no-ops, compile-time safety)
export const SteamId64 = (v: string) => v as SteamId64;
export const TradeOfferId = (v: string) => v as TradeOfferId;
export const TradeBoardId = (v: string) => v as TradeBoardId;
export const AssetId = (v: string) => v as AssetId;
export const ClassId = (v: string) => v as ClassId;
export const InstanceId = (v: string) => v as InstanceId;
export const AuthToken = (v: string) => v as AuthToken;
export const MarketHashName = (v: string) => v as MarketHashName;

// --- Trade Board Status (finite state machine) ---

export const TRADE_BOARD_STATUSES = [
  'open',
  'accepted',
  'trade_pending',
  'trade_verified',
  'escrow_hold',
  'completed',
  'reversed',
  'cancelled',
  'expired',
  'disputed',
] as const;

export type TradeBoardStatus = typeof TRADE_BOARD_STATUSES[number];

// Valid state transitions (enforced on server, documented here)
export const VALID_TRANSITIONS: Record<TradeBoardStatus, readonly TradeBoardStatus[]> = {
  open:           ['accepted', 'cancelled', 'expired'],
  accepted:       ['trade_pending', 'cancelled'],
  trade_pending:  ['trade_verified', 'cancelled'],
  trade_verified: ['escrow_hold'],
  escrow_hold:    ['completed', 'reversed', 'disputed'],
  completed:      [],
  reversed:       [],
  cancelled:      [],
  expired:        [],
  disputed:       ['completed', 'reversed'],
} as const;

// --- Domain Models ---

export interface SkinItem {
  readonly marketHashName: MarketHashName;
  readonly assetId?: AssetId;
  readonly classId?: ClassId;
  readonly instanceId?: InstanceId;
  readonly iconUrl?: string;
  readonly floatValue?: number;
  readonly paintSeed?: number;
  readonly price?: number; // estimated USDT
}

export interface TradeOfferItem {
  readonly appId: string;
  readonly contextId: string;
  readonly assetId: AssetId;
  readonly classId: ClassId;
  readonly instanceId: InstanceId;
  readonly amount: string;
  readonly marketHashName?: MarketHashName;
}

export interface TradeOfferEvent {
  readonly tradeOfferId: TradeOfferId;
  readonly partnerSteamId: SteamId64;
  readonly myItems: readonly TradeOfferItem[];
  readonly theirItems: readonly TradeOfferItem[];
  readonly timestamp: number;
}

export type OverpayDirection = 'creator_pays' | 'creator_wants';

export interface TradeBoard {
  readonly id: TradeBoardId;
  readonly creatorId: string;
  readonly creatorSteamId: SteamId64;
  readonly creatorName: string;
  readonly creatorAvatar?: string;
  readonly status: TradeBoardStatus;

  // What creator offers (skins)
  readonly offerItems: readonly SkinItem[];
  // What creator wants
  readonly wantDescription: string;
  readonly wantItems?: readonly SkinItem[];

  // Crypto overpay
  readonly overpayAmount: number;
  readonly overpayDirection: OverpayDirection;

  // Acceptor (populated after acceptance)
  readonly acceptorId?: string;
  readonly acceptorSteamId?: SteamId64;
  readonly acceptorName?: string;

  // Verification
  readonly steamTradeOfferId?: TradeOfferId;
  readonly tradeVerifiedAt?: string;

  // Escrow
  readonly escrowExpiresAt?: string;

  // Meta
  readonly description?: string;
  readonly broadcastToAll: boolean;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly completedAt?: string;
}

// --- Pricing ---

export interface PriceData {
  readonly marketHashName: MarketHashName;
  readonly steam?: number;
  readonly buff163?: number;
  readonly buff163_buy?: number;
  readonly csboard?: number;
  readonly csfloat?: number;
  readonly skinport?: number;
  readonly dmarket?: number;
  readonly youpin?: number;
  readonly lisskins?: number;
  readonly updatedAt: string;
}

export interface FloatData {
  readonly assetId: AssetId;
  readonly floatValue: number;
  readonly paintSeed: number;
  readonly paintIndex: number;
  readonly defIndex: number;
  readonly origin: number;
  readonly rarity: number;
  readonly quality: number;
  readonly rank?: number;
}

// --- Trade Hold ---

export interface TradeHoldItem {
  readonly assetId: AssetId;
  readonly classId: ClassId;
  readonly instanceId: InstanceId;
  readonly marketHashName: MarketHashName;
  readonly iconUrl: string;
  readonly tradableAfter?: number; // Unix timestamp (seconds)
  readonly tradeHoldDays?: number; // Days remaining
}

export interface TradeHoldStatus {
  readonly items: readonly TradeHoldItem[];
  readonly totalOnHold: number;
  readonly fetchedAt: number;
}

// --- P2P Market ---

export interface P2PTradeRequest {
  readonly orderId: string;
  readonly partnerSteamId64: string;
  readonly tradeToken: string;
  readonly assetIdsToGive: readonly string[];
  readonly assetIdsToReceive: readonly string[]; // usually empty for P2P sell
  readonly message?: string;
}

export interface P2PAnnotateResult {
  readonly success: boolean;
  readonly tradeOfferId?: string;
  readonly error?: string;
}

// --- Steam Trade Creation ---

export interface CreateSteamTradeData {
  readonly partnerSteamId64: string;
  readonly tradeToken: string;
  readonly assetIdsToGive: readonly string[];
  readonly assetIdsToReceive: readonly string[];
  readonly message?: string;
}

export interface SteamTradeResult {
  readonly success: boolean;
  readonly tradeOfferId?: string;
  readonly needsMobileConfirmation?: boolean;
  readonly needsEmailConfirmation?: boolean;
  readonly error?: string;
}

export interface SteamSessionResult {
  readonly isLoggedIn: boolean;
  readonly steamId?: string;
  readonly hasSessionId: boolean;
}

// --- Auth ---

export interface UserProfile {
  readonly id: string;
  readonly steamId: SteamId64 | null;
  readonly name: string;
  readonly avatar: string | null;
  readonly isPremium: boolean;
  readonly balance: number;
  readonly frozenBalance: number;
}

/**
 * Normalizes an untrusted remote avatar URL before it reaches an image element.
 * User-info responses are server controlled, but keeping this boundary strict
 * prevents insecure HTTP, `data:`, `javascript:`, credential-bearing, and malformed URLs from
 * becoming extension-page requests if the upstream value is ever corrupted.
 */
export function normalizeAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 2_048 || /[\u0000-\u001f\u007f]/.test(candidate)) {
    return null;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export type AuthState =
  | { readonly isLoggedIn: false }
  | { readonly isLoggedIn: true; readonly user: UserProfile };

// --- Extension Messages (discriminated union — NO `any`) ---

// Each message type has a strictly typed payload.
// This is the SINGLE source of truth for all inter-context communication.

export type ExtensionMessage =
  // Auth
  | { type: 'GET_AUTH_STATUS' }
  | { type: 'LOGOUT' }
  // Trade Boards
  | { type: 'GET_BOARDS'; data: { status?: string; limit?: number; offset?: number } }
  // Trade Verification (from content scripts)
  | { type: 'TRADE_OFFER_SENT'; data: TradeOfferEvent }
  | { type: 'TRADE_OFFER_ACCEPTED'; data: { tradeOfferId: TradeOfferId } }
  | { type: 'TRADE_OFFER_DECLINED'; data: { tradeOfferId: TradeOfferId } }
  // Pricing
  | { type: 'GET_PRICES'; data: { items: MarketHashName[] } }
  | { type: 'GET_FLOAT'; data: { inspectLink: string } }
  // Price Engine (preloaded prices)
  | { type: 'REFRESH_PRICES' }
  | { type: 'GET_PRICE_ENGINE_STATUS' }
  | { type: 'UPDATE_PRICE_SETTINGS'; data: { currency?: string; priceSource?: string } }
  | { type: 'GET_EXTENSION_SETTINGS'; version: 2 }
  | {
      type: 'UPDATE_EXTENSION_SETTINGS';
      version: 2;
      data: {
        patch: Partial<Omit<PopupSettingsV2, 'schemaVersion'>>;
        syncFromCsboardNow?: boolean;
      };
    }
  // Fixed Steam read-session operations. The page credential crosses only the
  // exact-origin internal content-script boundary and is never stored, logged,
  // returned, or exposed through onMessageExternal.
  | { type: 'GET_STEAM_READ_SESSION_STATUS' }
  | { type: 'GET_TRADE_HOLD_ITEMS'; data: { steamId: SteamId64 } }
  | { type: 'CLEAR_STEAM_READ_SESSION' }
  | {
      type: 'OFFER_STEAM_PAGE_CREDENTIAL';
      version: 1;
      data: { pageAccessToken: string; pageSteamId: string };
    }
  // Steam Trade Offers (IEconService — cs2trader approach)
  // `pageAccessToken`/`pageSteamId` come from the content script's own DOM
  // (`#application_config`). The service worker cannot always mint one itself:
  // its fetch to steamcommunity.com is cross-site from `chrome-extension://`,
  // so blocked third-party cookies make it look logged out.
  | { type: 'FETCH_STEAM_TRADE_OFFERS'; data?: { activesOnly?: number; sent?: number; received?: number; pageAccessToken?: string; pageSteamId?: string } }
  // Trade History (local read; portfolio upload is a separate opt-in controller)
  | { type: 'FETCH_TRADE_HISTORY'; data: { maxTrades: number; startAfterTime?: number; startAfterTradeId?: string } }
  | { type: 'OPEN_TRADE_HISTORY' }
  | { type: 'GET_TRADE_HISTORY_SYNC_STATE' }
  // Inventory enrichment (float, paint seed, stickers)
  | { type: 'FETCH_INVENTORY_WITH_PROPERTIES'; data: { steamId: string; contextId?: string; pageAccessToken?: string; pageSteamId?: string } }
  // Portfolio gateway. These messages are accepted only by the extension's internal router.
  | { type: 'PAIR_DEVICE'; version: 1; data: { code: string } }
  | { type: 'UNPAIR_DEVICE'; version: 1 }
  | { type: 'RUN_MANUAL_SYNC'; version: 1 }
  | { type: 'GET_PORTFOLIO_SYNC_STATUS'; version: 1 }
  ;

// Extract the type string for runtime checks
export type MessageType = ExtensionMessage['type'];

// Response types mapped to message types
export type MessageResponseMap = {
  GET_AUTH_STATUS: AuthState;
  LOGOUT: { success: true };
  GET_BOARDS: { boards: TradeBoard[]; total: number };
  TRADE_OFFER_SENT: { verified: boolean; tradeBoardId?: TradeBoardId };
  TRADE_OFFER_ACCEPTED: { verified: boolean; tradeBoardId?: TradeBoardId };
  TRADE_OFFER_DECLINED: { verified: boolean };
  GET_PRICES: Record<string, PriceData>;
  GET_FLOAT: { floatValue: number; paintSeed: number; paintIndex: number };
  REFRESH_PRICES: { success: boolean; count: number };
  GET_PRICE_ENGINE_STATUS: { loaded: boolean; count: number; lastFetched: number; currency: string; priceSource: string };
  UPDATE_PRICE_SETTINGS: { success: boolean };
  GET_EXTENSION_SETTINGS: { settings: PopupSettingsV2; sync: PricePreferenceSyncStatus };
  UPDATE_EXTENSION_SETTINGS: {
    success: true;
    settings: PopupSettingsV2;
    sync?: PricePreferenceSyncStatus;
  };
  GET_STEAM_READ_SESSION_STATUS: { ready: boolean };
  GET_TRADE_HOLD_ITEMS: TradeHoldStatus;
  CLEAR_STEAM_READ_SESSION: { success: true };
  OFFER_STEAM_PAGE_CREDENTIAL: { accepted: true; syncTriggered: boolean };
  FETCH_STEAM_TRADE_OFFERS: { offers: { trade_offers_received: unknown[]; trade_offers_sent: unknown[] }; items: unknown[] };
  FETCH_TRADE_HISTORY: { trades: unknown[]; totalTrades: number; hasMore: boolean; lastTradeId?: string; lastTradeTime?: number };
  OPEN_TRADE_HISTORY: { ok: true };
  GET_TRADE_HISTORY_SYNC_STATE: { cursor: unknown; lastSync: number | null };
  FETCH_INVENTORY_WITH_PROPERTIES: { items: unknown[]; totalCount: number };
  PAIR_DEVICE: { status: PopupPortfolioSyncStatus };
  UNPAIR_DEVICE: { status: PopupPortfolioSyncStatus };
  RUN_MANUAL_SYNC: { status: PopupPortfolioSyncStatus };
  GET_PORTFOLIO_SYNC_STATUS: { status: PopupPortfolioSyncStatus };
};

// Type-safe response extraction
export type ResponseFor<T extends MessageType> = MessageResponseMap[T];

// --- Page Script Events (window.postMessage bridge) ---

export type PageScriptEvent =
  | {
      type: 'CSBOARD_TRADE_CONFIRM';
      data: {
        partnerId: string | null;
        tradeOfferId: string | null;
        myItems: ReadonlyArray<Record<string, unknown>>;
        theirItems: ReadonlyArray<Record<string, unknown>>;
      };
    }
  | {
      type: 'CSBOARD_TRADE_ACCEPT';
      data: { tradeOfferId: string | null; accepted: true };
    }
  | {
      type: 'CSBOARD_TRADE_DECLINE';
      data: { tradeOfferId: string | null };
    };

export type PageScriptEventType = PageScriptEvent['type'];

// --- Storage Keys (typed for storage wrapper) ---

export const STORAGE_KEYS = {
  // No AUTH_TOKEN — we use cookie-based auth (credentials: 'include')
  USER_DATA: 'csboard_user_data',
  PRICE_CACHE: 'csboard_price_cache',
  SETTINGS: 'csboard_settings',
  PENDING_VERIFICATIONS: 'csboard_pending_verifications',
  LAST_SEEN_BOARD: 'csboard_last_seen_board',
  STORAGE_VERSION: 'csboard_storage_version',
  // P2P active trades — polled by alarm for status changes
  P2P_ACTIVE_TRADES: 'csboard_p2p_active_trades',
} as const;

export type StorageKey = typeof STORAGE_KEYS[keyof typeof STORAGE_KEYS];

/** A P2P trade awaiting buyer action — polled every 3 min until terminal state. */
export interface P2PActiveTrade {
  orderId: string;
  tradeOfferId: string;
  sentAt: number; // ms since epoch — for expiry cleanup
  lastReportedState?: number; // last state we told backend about (dedupe)
  // After trade accepted: Steam's time_escrow_end (ms epoch).
  // Extension keeps polling trade history for rollback detection until this time + buffer.
  tradableAt?: number;
  acceptedAt?: number; // when ETradeOfferState became 3 (Accepted)
  // Original trade direction for rollback detection
  sellerSteamId?: string;
  buyerSteamId?: string;
  assetId?: string;
}

// Storage schema — what each key maps to
export interface StorageSchema {
  [STORAGE_KEYS.USER_DATA]: UserProfile;
  [STORAGE_KEYS.PRICE_CACHE]: Record<string, PriceData & { cachedAt: number }>;
  [STORAGE_KEYS.SETTINGS]: ExtensionSettings;
  [STORAGE_KEYS.PENDING_VERIFICATIONS]: PendingVerification[];
  [STORAGE_KEYS.LAST_SEEN_BOARD]: string; // ISO timestamp
  [STORAGE_KEYS.STORAGE_VERSION]: number;
  [STORAGE_KEYS.P2P_ACTIVE_TRADES]: P2PActiveTrade[];
}

export interface PortfolioSourceSettings {
  inventory: boolean;
  tradeOffers: boolean;
  tradeHistory: boolean;
  marketHistory: boolean;
}

export interface PortfolioSyncStatus {
  paired: boolean;
  deviceId?: string;
  running: boolean;
  lastSuccessAt?: number;
  lastErrorCode?: string;
  queuedChunks: number;
  sources: PortfolioSourceSettings;
}

export interface ExtensionSettings {
  /*
    The master switch for everything this extension DRAWS.

    Off means no content script touches a page: no overlays, no float badges,
    no comparison links, on Steam, CSFloat or Buff alike. The per-site toggles
    below stay as they are and take effect again the moment it is switched back
    on — this is a mute, not a reset.

    It deliberately does NOT stop P2P delivery. A seller who wanted the page
    decorations gone would otherwise silently stop delivering the sales he has
    already accepted, and cancelling a Steam offer for an order csboard has
    closed is the one job only his browser can do. Those run regardless.
  */
  enhancementsEnabled: boolean;
  /*
    Desktop notification when a sale arrives and needs the seller.

    Separate from the master switch above, which is about pages: this one leaves
    the browser entirely and lands on the operating system, so it gets its own
    consent rather than riding on a toggle about overlays.
  */
  salesNotifications: boolean;
  showPriceOverlays: boolean;
  showFloatValues: boolean;
  notifyNewBoards: boolean;
  priceSource: 'buff163' | 'steam' | 'csboard' | 'buff163_buy' | 'skinport' | 'dmarket' | 'csfloat' | 'youpin' | 'lisskins';
  currency: string;
  showBuffBuyOrder: boolean;
  checkBoardsIntervalMinutes: number;
  /** One-way CSBOARD -> extension currency/source sync. Existing behavior stays on. */
  followCsboardSettings: boolean;
  /*
    Per-site switches for what the extension DRAWS, one per host surface.

    They replaced a single master switch: "off everywhere" was the only shape
    the old control could express, and the popup then needed a second row per
    site anyway. `enhancementsEnabled` above is still honoured as an AND, so a
    profile stored before this split keeps whatever it had until migration 4
    folds it into these three.
  */
  showOnSteam: boolean;
  /** Show CSBOARD price comparison UI on csfloat.com. */
  showCsboardPricesOnCsfloat: boolean;
  /** Opt-in BetterBuff-style read-only enhancements on buff.163.com. */
  showBetterBuffOnBuff: boolean;
  /** Explicit opt-in master switch. Pairing alone never uploads. */
  portfolioSyncEnabled: boolean;
  portfolioSources: PortfolioSourceSettings;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enhancementsEnabled: true,
  salesNotifications: true,
  showPriceOverlays: true,
  showFloatValues: true,
  notifyNewBoards: true,
  priceSource: 'buff163',
  currency: 'USD',
  showBuffBuyOrder: true,
  checkBoardsIntervalMinutes: 1,
  followCsboardSettings: true,
  showOnSteam: true,
  showCsboardPricesOnCsfloat: true,
  showBetterBuffOnBuff: false,
  portfolioSyncEnabled: false,
  portfolioSources: {
    inventory: false,
    tradeOffers: false,
    tradeHistory: false,
    marketHistory: false,
  },
};

export interface PendingVerification extends TradeOfferEvent {
  readonly eventType: 'trade_sent' | 'trade_accepted' | 'trade_declined';
  readonly verifiedAt: string | null;
}

// --- Error Types ---

export class CSBoardError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly retryable: boolean = false,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CSBoardError';
  }
}

export type ErrorCode =
  | 'NETWORK_ERROR'
  | 'AUTH_EXPIRED'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'API_ERROR'
  | 'VALIDATION_ERROR'
  | 'STEAM_DOM_ERROR'
  | 'STORAGE_ERROR'
  | 'UNKNOWN';
