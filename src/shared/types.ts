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

export type SteamId64 = Brand<string, 'SteamId64'>;
export type TradeOfferId = Brand<string, 'TradeOfferId'>;
export type TradeBoardId = Brand<string, 'TradeBoardId'>;
export type AssetId = Brand<string, 'AssetId'>;
export type ClassId = Brand<string, 'ClassId'>;
export type InstanceId = Brand<string, 'InstanceId'>;
export type AuthToken = Brand<string, 'AuthToken'>;
export type MarketHashName = Brand<string, 'MarketHashName'>;
export type AccessToken = Brand<string, 'AccessToken'>;

// Brand constructors (runtime no-ops, compile-time safety)
export const SteamId64 = (v: string) => v as SteamId64;
export const TradeOfferId = (v: string) => v as TradeOfferId;
export const TradeBoardId = (v: string) => v as TradeBoardId;
export const AssetId = (v: string) => v as AssetId;
export const ClassId = (v: string) => v as ClassId;
export const InstanceId = (v: string) => v as InstanceId;
export const AuthToken = (v: string) => v as AuthToken;
export const MarketHashName = (v: string) => v as MarketHashName;
export const AccessToken = (v: string) => v as AccessToken;

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
  readonly steamId: SteamId64;
  readonly name: string;
  readonly avatar: string;
  readonly isPremium: boolean;
  readonly balance: number;
  readonly frozenBalance: number;
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
  // Trade Hold (Steam access token management)
  | { type: 'SET_ACCESS_TOKEN'; data: { accessToken: AccessToken } }
  | { type: 'GET_ACCESS_TOKEN_STATUS' }
  | { type: 'GET_TRADE_HOLD_ITEMS'; data: { steamId: SteamId64 } }
  | { type: 'CLEAR_ACCESS_TOKEN' }
  // Steam Trade Offer (CSFloat-style direct trade creation)
  | { type: 'CREATE_STEAM_TRADE'; data: CreateSteamTradeData }
  | { type: 'GET_STEAM_SESSION' }
  // Steam Trade Offers (IEconService — cs2trader approach)
  | { type: 'FETCH_STEAM_TRADE_OFFERS'; data: { accessToken: string; activesOnly?: number; sent?: number; received?: number } }
  | { type: 'VALIDATE_STEAM_TOKEN'; data: { accessToken: string } }
  // Steam access token auto-refresh (re-mint via cookies when bound IP changes)
  | { type: 'REFRESH_STEAM_ACCESS_TOKEN' }
  // Trade History (csboard page + sync to server)
  | { type: 'FETCH_TRADE_HISTORY'; data: { accessToken: string; maxTrades: number; startAfterTime?: number; startAfterTradeId?: string } }
  | { type: 'OPEN_TRADE_HISTORY' }
  | { type: 'SYNC_TRADE_HISTORY'; data: { accessToken: string } }
  | { type: 'GET_TRADE_HISTORY_SYNC_STATE' }
  // Inventory enrichment (float, paint seed, stickers)
  | { type: 'FETCH_INVENTORY_WITH_PROPERTIES'; data: { accessToken: string; steamId: string; contextId?: string } }
  // P2P Market — trade annotation & status polling
  | { type: 'P2P_CREATE_AND_ANNOTATE'; data: P2PTradeRequest }
  | { type: 'P2P_REPORT_TRADE_STATUS'; data: { orderId: string; steamTradeOfferId: string; state: number } }
  | { type: 'P2P_VERIFY_MOBILE_AUTH' };

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
  SET_ACCESS_TOKEN: { success: true };
  GET_ACCESS_TOKEN_STATUS: { isSet: boolean };
  GET_TRADE_HOLD_ITEMS: TradeHoldStatus;
  CLEAR_ACCESS_TOKEN: { success: true };
  CREATE_STEAM_TRADE: SteamTradeResult;
  GET_STEAM_SESSION: SteamSessionResult;
  FETCH_STEAM_TRADE_OFFERS: { offers: { trade_offers_received: any[]; trade_offers_sent: any[] }; items: any[] };
  VALIDATE_STEAM_TOKEN: { valid: boolean };
  P2P_CREATE_AND_ANNOTATE: P2PAnnotateResult;
  P2P_REPORT_TRADE_STATUS: { success: boolean };
  P2P_VERIFY_MOBILE_AUTH: { success: boolean; hasMobileAuth?: boolean; myEscrowSeconds?: number; error?: string };
  REFRESH_STEAM_ACCESS_TOKEN: { accessToken: string };
  FETCH_TRADE_HISTORY: { trades: unknown[]; totalTrades: number; hasMore: boolean; lastTradeId?: string; lastTradeTime?: number };
  OPEN_TRADE_HISTORY: { ok: true };
  SYNC_TRADE_HISTORY: { synced: number; skipped: number; totalTrades: number };
  GET_TRADE_HISTORY_SYNC_STATE: { cursor: unknown; lastSync: number | null };
  FETCH_INVENTORY_WITH_PROPERTIES: { items: unknown[]; totalCount: number };
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
  // Trade Hold Token (encrypted)
  ENCRYPTED_ACCESS_TOKEN: 'csboard_encrypted_access_token',
  ACCESS_TOKEN_IV: 'csboard_access_token_iv',
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
  [STORAGE_KEYS.ENCRYPTED_ACCESS_TOKEN]: string; // base64 ciphertext
  [STORAGE_KEYS.ACCESS_TOKEN_IV]: string; // base64 IV
  [STORAGE_KEYS.P2P_ACTIVE_TRADES]: P2PActiveTrade[];
}

export interface ExtensionSettings {
  showPriceOverlays: boolean;
  showFloatValues: boolean;
  notifyNewBoards: boolean;
  priceSource: 'buff163' | 'steam' | 'csboard' | 'buff163_buy' | 'skinport' | 'dmarket' | 'csfloat' | 'youpin' | 'lisskins';
  currency: string;
  showBuffBuyOrder: boolean;
  checkBoardsIntervalMinutes: number;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  showPriceOverlays: true,
  showFloatValues: true,
  notifyNewBoards: true,
  priceSource: 'buff163',
  currency: 'USD',
  showBuffBuyOrder: true,
  checkBoardsIntervalMinutes: 1,
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
