/**
 * Wire contract for the CSBOARD extension gateway.
 *
 * Only normalized portfolio facts are allowed in these DTOs. Steam credentials,
 * cookies, HTML and inspect links must never cross this boundary, even inside an
 * encrypted envelope.
 */

export const GATEWAY_PROTOCOL_VERSION = 1 as const;
export const GATEWAY_HPKE_SUITE =
  'DHKEM-X25519-HKDF-SHA256/HKDF-SHA256/AES-256-GCM' as const;
export const GATEWAY_SIGNATURE_ALGORITHM = 'ES256' as const;
export const GATEWAY_HPKE_INFO = 'csboard.gateway.hpke.v1' as const;

/** Hard upper bound required by the ingestion gateway. */
export const MAX_GATEWAY_PLAINTEXT_BYTES = 192 * 1024;
/** Leaves room for the chunk DTO itself below the hard plaintext limit. */
export const TARGET_GATEWAY_CHUNK_BYTES = 128 * 1024;
export const MAX_GATEWAY_SERIALIZED_BODY_BYTES = 320 * 1024;
/** Backend refuses snapshots that would require more independent requests. */
export const MAX_GATEWAY_CHUNKS_PER_RUN = 64;
/** Aggregate limits apply to the whole sync run, not independently per chunk. */
export const MAX_PORTFOLIO_INVENTORY_ITEMS_PER_RUN = 5_000;
export const MAX_PORTFOLIO_TRADES_PER_RUN = 100;
export const MAX_PORTFOLIO_OFFERS_PER_RUN = 1_000;
export const MAX_GATEWAY_CLOCK_SKEW_SECONDS = 5 * 60;
export const GATEWAY_REPLAY_WINDOW_SECONDS = 10 * 60;
export const GATEWAY_IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;
export const DEFAULT_GATEWAY_TTL_SECONDS = 120;
export const MAX_GATEWAY_TTL_SECONDS = 300;

export type GatewayOperation =
  | 'device.pair'
  | 'device.unpair'
  | 'portfolio.sync';

export type GatewayHttpPath =
  | '/api/extension/v2/pair/confirm'
  | '/api/extension/v2/pair/revoke'
  | '/api/extension/v2/portfolio/sync';

export type GatewayPayloadSchema =
  | 'device.pair.v1'
  | 'device.unpair.v1'
  | 'portfolio.sync.chunk.v1';

export const GATEWAY_OPERATION_BINDINGS: Readonly<Record<GatewayOperation, {
  readonly httpMethod: 'POST';
  readonly httpPath: GatewayHttpPath;
  readonly payloadSchema: GatewayPayloadSchema;
}>> = {
  'device.pair': {
    httpMethod: 'POST',
    httpPath: '/api/extension/v2/pair/confirm',
    payloadSchema: 'device.pair.v1',
  },
  'device.unpair': {
    httpMethod: 'POST',
    httpPath: '/api/extension/v2/pair/revoke',
    payloadSchema: 'device.unpair.v1',
  },
  'portfolio.sync': {
    httpMethod: 'POST',
    httpPath: '/api/extension/v2/portfolio/sync',
    payloadSchema: 'portfolio.sync.chunk.v1',
  },
};

export interface GatewayProtectedMetadata {
  readonly version: typeof GATEWAY_PROTOCOL_VERSION;
  readonly suite: typeof GATEWAY_HPKE_SUITE;
  readonly operation: GatewayOperation;
  readonly httpMethod: 'POST';
  readonly httpPath: GatewayHttpPath;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly payloadSchema: GatewayPayloadSchema;
  readonly recipientKeyId: string;
  readonly deviceKeyId: string;
  /** SHA-256 of the opaque server device ID; omitted during initial pairing. */
  readonly deviceIdHash?: string;
  readonly syncRunId?: string;
  readonly chunkIndex?: number;
  readonly chunkCount?: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly plaintextBytes: number;
  readonly payloadSha256: string;
}

export interface GatewayDeviceProof {
  readonly algorithm: typeof GATEWAY_SIGNATURE_ALGORITHM;
  readonly deviceKeyId: string;
  /** WebCrypto ECDSA P-256 signature (IEEE P1363 r || s), base64url encoded. */
  readonly signature: string;
}

/**
 * The only body sent to the protected gateway. A fresh HPKE encapsulation is
 * created for every instance.
 */
export interface GatewayEncryptedEnvelope {
  readonly version: typeof GATEWAY_PROTOCOL_VERSION;
  readonly protected: GatewayProtectedMetadata;
  readonly encapsulatedKey: string;
  readonly ciphertext: string;
  readonly proof: GatewayDeviceProof;
}

export interface GatewayRecipientPublicKey {
  readonly keyId: string;
  /** X25519 HPKE recipient public key. Private `d` is forbidden. */
  readonly publicJwk: Readonly<JsonWebKey>;
}

export interface DevicePublicIdentity {
  readonly deviceKeyId: string;
  readonly publicJwk: Readonly<JsonWebKey>;
}

export interface DevicePairPayload {
  readonly kind: 'device.pair.v1';
  readonly pairingCode: string;
  readonly device: DevicePublicIdentity;
  readonly client: {
    readonly extensionVersion: string;
    readonly platform: 'chromium-mv3';
    readonly capabilities: readonly [
      'inventory-context-2',
      'inventory-context-16',
      'recent-trades',
    ];
  };
}

export interface DeviceUnpairPayload {
  readonly kind: 'device.unpair.v1';
  readonly reason: 'user-request';
}

export type SteamInventoryContextId = '2' | '16';

export interface PortfolioSourceSelection {
  readonly inventory: boolean;
  readonly tradeHistory: boolean;
  readonly tradeOffers: boolean;
}

export interface PortfolioItemDto {
  readonly appId: '730';
  readonly contextId: SteamInventoryContextId;
  readonly assetId: string;
  readonly classId: string;
  readonly instanceId: string;
  readonly amount: string;
  readonly marketHashName: string;
  readonly name?: string;
  readonly iconUrl?: string;
  readonly tradable: boolean;
  readonly marketable: boolean;
  readonly onHold: boolean;
  readonly tradableAfter?: number;
  readonly floatValue?: number;
  readonly paintSeed?: number;
  readonly paintIndex?: number;
  readonly defIndex?: number;
  readonly stickers?: readonly PortfolioStickerDto[];
}

export interface PortfolioStickerDto {
  readonly slot: number;
  readonly name: string;
  readonly wear?: number;
}

export interface PortfolioTradeItemDto {
  readonly appId: '730';
  readonly contextId: string;
  readonly assetId: string;
  readonly classId: string;
  readonly instanceId: string;
  readonly amount: string;
  readonly marketHashName?: string;
  /** Trusted Steam Economy image; exact Doppler/Gamma phase evidence. */
  readonly iconUrl?: string;
}

export interface PortfolioTradeDto {
  readonly tradeId: string;
  readonly partnerSteamId: string;
  readonly occurredAt: number;
  readonly itemsGiven: readonly PortfolioTradeItemDto[];
  readonly itemsReceived: readonly PortfolioTradeItemDto[];
}

export type PortfolioMarketplaceHint = 'buff163' | 'csfloat';

export interface PortfolioOfferDto {
  readonly offerId: string;
  readonly direction: 'sent' | 'received';
  readonly partnerAccountId: string;
  readonly state: number;
  readonly createdAt: number;
  /** Accepted Steam offer -> completed economy trade correlation, when Steam exposes it. */
  readonly completedTradeId?: string;
  /** Privacy-preserving local classification; the raw user-written offer message is never uploaded. */
  readonly marketplaceHint?: PortfolioMarketplaceHint;
  readonly expiresAt?: number;
  readonly escrowEndAt?: number;
  readonly itemsToGive: readonly PortfolioTradeItemDto[];
  readonly itemsToReceive: readonly PortfolioTradeItemDto[];
}

export interface PortfolioSnapshot {
  readonly kind: 'portfolio.snapshot.v1';
  readonly syncRunId: string;
  readonly steamId: string;
  readonly capturedAt: number;
  readonly sources?: PortfolioSourceSelection;
  readonly completeness: {
    readonly inventoryContext2: boolean;
    readonly inventoryContext16: boolean;
    readonly trades: boolean;
    readonly offers: boolean;
  };
  readonly inventoryItems: readonly PortfolioItemDto[];
  readonly trades: readonly PortfolioTradeDto[];
  readonly offers: readonly PortfolioOfferDto[];
}

/** One independently encrypted request in a complete snapshot run. */
export interface PortfolioSyncChunkPayload {
  readonly kind: 'portfolio.sync.chunk.v1';
  readonly syncRunId: string;
  readonly steamId: string;
  readonly capturedAt: number;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly sources?: PortfolioSourceSelection;
  readonly completeness: PortfolioSnapshot['completeness'];
  readonly inventoryItems: readonly PortfolioItemDto[];
  readonly trades: readonly PortfolioTradeDto[];
  readonly offers: readonly PortfolioOfferDto[];
}

export class GatewayPayloadError extends Error {
  readonly code:
    | 'INVALID_PAYLOAD'
    | 'FORBIDDEN_SECRET'
    | 'PAYLOAD_TOO_LARGE'
    | 'INVALID_KEY'
    | 'GATEWAY_UNCONFIGURED';
  /** Safe context only: paths/counts, never rejected values. */
  readonly safeContext: Readonly<Record<string, string | number>>;

  constructor(
    code:
      | 'INVALID_PAYLOAD'
      | 'FORBIDDEN_SECRET'
      | 'PAYLOAD_TOO_LARGE'
      | 'INVALID_KEY'
      | 'GATEWAY_UNCONFIGURED',
    safeContext: Readonly<Record<string, string | number>> = {},
  ) {
    super(code);
    this.name = 'GatewayPayloadError';
    this.code = code;
    this.safeContext = safeContext;
  }
}

const FORBIDDEN_KEY_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'cookies',
  'setcookie',
  'session',
  'sessionid',
  'steamsession',
  'steamsessionid',
  'accesstoken',
  'steamaccesstoken',
  'loyaltywebapitoken',
  'steamguard',
  'steamguardcode',
  'sharedsecret',
  'identitysecret',
  'password',
  'passwd',
  'rawhtml',
  'html',
  'inspectlink',
  'inspecturl',
  'inspectsecret',
  'privatekey',
  'privatejwk',
  'd',
]);

const FORBIDDEN_STRING_PATTERNS: readonly RegExp[] = [
  /(?:^|[?&])access_token=/i,
  /\b(?:authorization|proxy-authorization)\s*:/i,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:steamLoginSecure|sessionid)=/i,
  /data-loyalty_webapi_token/i,
  /steam:\/\/rungame\/730\//i,
  /csgo_econ_action_preview\s+[sm]\d+a\d+d\d+/i,
  /<(?:!doctype|html|body|script|meta)\b/i,
];

const MAX_VALIDATION_DEPTH = 32;
const MAX_NORMALIZED_STRING_LENGTH = 4_096;

function normalizeKeyName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Rejects secret-shaped fields and values before encryption. It deliberately
 * rejects unknown runtime objects so credentials cannot hide in class instances.
 */
export function assertSafeGatewayPayload(value: unknown): void {
  const ancestors = new Set<object>();

  const visit = (current: unknown, path: string, depth: number): void => {
    if (depth > MAX_VALIDATION_DEPTH) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path, reason: 'max-depth' });
    }

    if (current === null || typeof current === 'boolean') return;

    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new GatewayPayloadError('INVALID_PAYLOAD', { path, reason: 'non-finite-number' });
      }
      return;
    }

    if (typeof current === 'string') {
      if (current.length > MAX_NORMALIZED_STRING_LENGTH) {
        throw new GatewayPayloadError('INVALID_PAYLOAD', { path, reason: 'string-too-long' });
      }
      if (FORBIDDEN_STRING_PATTERNS.some((pattern) => pattern.test(current))) {
        throw new GatewayPayloadError('FORBIDDEN_SECRET', { path });
      }
      if (/[\u0000-\u001f\u007f]/.test(current)) {
        throw new GatewayPayloadError('INVALID_PAYLOAD', { path, reason: 'control-character' });
      }
      return;
    }

    if (typeof current !== 'object') {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path, reason: typeof current });
    }

    if (ancestors.has(current)) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path, reason: 'cyclic-value' });
    }
    ancestors.add(current);

    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      ancestors.delete(current);
      return;
    }

    if (!isPlainObject(current)) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path, reason: 'non-plain-object' });
    }

    for (const [key, entry] of Object.entries(current)) {
      const childPath = path === '$' ? `$.${key}` : `${path}.${key}`;
      if (FORBIDDEN_KEY_NAMES.has(normalizeKeyName(key))) {
        throw new GatewayPayloadError('FORBIDDEN_SECRET', { path: childPath });
      }
      if (entry === undefined) {
        throw new GatewayPayloadError('INVALID_PAYLOAD', { path: childPath, reason: 'undefined' });
      }
      visit(entry, childPath, depth + 1);
    }

    ancestors.delete(current);
  };

  visit(value, '$', 0);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

/**
 * Deterministic encoding only.
 *
 * 🔴 Use this for structures we build ourselves that legitimately carry opaque
 * base64 — a signature proof over a sealed envelope, for instance. The content
 * scan below caps every string at 4 KB, which is right for user data and fatal
 * for a 175 KB ciphertext: it turned every portfolio sync into
 * "invalid payload: string too long" before the request ever left the browser.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Deterministic encoding plus the content-safety scan, for user payloads. */
export function canonicalJson(value: unknown): string {
  assertSafeGatewayPayload(value);
  return canonicalStringify(value);
}

export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function byteLengthOfCanonicalJson(value: unknown): number {
  return utf8Bytes(canonicalJson(value)).byteLength;
}

export function base64UrlEncode(bytes: ArrayBuffer | ArrayBufferView): string {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let binary = '';
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function sha256Base64Url(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
  return base64UrlEncode(digest);
}

export function createRandomId(byteCount = 18): string {
  if (!Number.isSafeInteger(byteCount) || byteCount < 16 || byteCount > 64) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-random-id-size' });
  }
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return base64UrlEncode(bytes);
}

export function assertSteamId64(value: string): void {
  if (!isSteamId64(value)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.steamId' });
  }
}

const MIN_STEAM_ID64 = 76_561_197_960_265_728n;
const MAX_STEAM_ID64 = 76_561_202_255_233_023n;

export function isSteamId64(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{17}$/.test(value)) return false;
  try {
    const numeric = BigInt(value);
    return numeric >= MIN_STEAM_ID64 && numeric <= MAX_STEAM_ID64;
  } catch {
    return false;
  }
}

export function assertPairingCode(value: string): void {
  if (!/^CSF-[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){3}$/.test(value)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.pairingCode' });
  }
}
