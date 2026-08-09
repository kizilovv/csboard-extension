import {
  GATEWAY_HPKE_SUITE,
  GATEWAY_PROTOCOL_VERSION,
  GatewayPayloadError,
  MAX_GATEWAY_CLOCK_SKEW_SECONDS,
  MAX_GATEWAY_SERIALIZED_BODY_BYTES,
  base64UrlEncode,
  canonicalJson,
  isSteamId64,
  utf8Bytes,
  type DevicePairPayload,
  type GatewayEncryptedEnvelope,
  type GatewayOperation,
  type GatewayRecipientPublicKey,
} from '../shared/gateway-dto';
import type { DeviceRegistration, IndexedDbDeviceKeyStore } from './device-key-store';
import { assertGatewayEncryptedEnvelope, sealGatewayPayload } from './gateway-crypto';
import type {
  GatewayDeliveryFailureCode,
  GatewayEnvelopeSenderResult,
} from './sync-outbox';

const DISCOVERY_PATH = '/api/extension/v2/gateway/keys';
const MAX_DISCOVERY_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BODY_BYTES = 32 * 1024;
const MAX_DISCOVERY_LIFETIME_SECONDS = 24 * 60 * 60;

export interface PinnedGatewayRoot {
  readonly keyId: string;
  readonly publicJwk: Readonly<JsonWebKey>;
}

export interface GatewayClientConfig {
  readonly gatewayOrigin: string;
  readonly allowedGatewayOrigins: readonly string[];
  readonly pinnedDiscoveryRoot: PinnedGatewayRoot | null | undefined;
  readonly extensionId: string;
  readonly extensionVersion: string;
}

interface GatewayDiscoveryKey {
  readonly keyId: string;
  readonly status: 'active' | 'retiring';
  readonly publicJwk: Readonly<JsonWebKey>;
}

interface GatewayDiscoveryDocument {
  readonly version: 1;
  readonly suite: typeof GATEWAY_HPKE_SUITE;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly keys: readonly GatewayDiscoveryKey[];
}

export class GatewayClientError extends Error {
  readonly code:
    | 'UNCONFIGURED'
    | 'DISCOVERY_REJECTED'
    | 'NETWORK_ERROR'
    | 'DEVICE_REVOKED'
    | 'GATEWAY_REJECTED';
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: GatewayClientError['code'],
    retryable: boolean,
    status?: number,
  ) {
    super(code);
    this.name = 'GatewayClientError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new GatewayClientError('DISCOVERY_REJECTED', false);
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new GatewayClientError('DISCOVERY_REJECTED', false);
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseJsonObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new GatewayClientError('DISCOVERY_REJECTED', false);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GatewayClientError('DISCOVERY_REJECTED', false);
  }
  return parsed as Record<string, unknown>;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateGatewayOrigin(config: GatewayClientConfig): string {
  const allowed = new Set(config.allowedGatewayOrigins.map((entry) => {
    const url = new URL(entry);
    if (url.protocol !== 'https:' || url.origin !== entry) {
      throw new GatewayClientError('UNCONFIGURED', false);
    }
    return url.origin;
  }));
  let origin: URL;
  try {
    origin = new URL(config.gatewayOrigin);
  } catch {
    throw new GatewayClientError('UNCONFIGURED', false);
  }
  if (origin.protocol !== 'https:' || origin.origin !== config.gatewayOrigin ||
      !allowed.has(origin.origin)) {
    throw new GatewayClientError('UNCONFIGURED', false);
  }
  return origin.origin;
}

function validateRoot(root: PinnedGatewayRoot | null | undefined): PinnedGatewayRoot {
  if (!root || !/^[A-Za-z0-9._-]{1,128}$/.test(root.keyId)) {
    throw new GatewayClientError('UNCONFIGURED', false);
  }
  const jwk = root.publicJwk;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' ||
      typeof jwk.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x) ||
      typeof jwk.y !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.y) ||
      jwk.d !== undefined) {
    throw new GatewayClientError('UNCONFIGURED', false);
  }
  return root;
}

function validateRecipientJwk(value: unknown): Readonly<JsonWebKey> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GatewayClientError('DISCOVERY_REJECTED', false);
  }
  const jwk = value as JsonWebKey;
  if (!hasExactKeys(jwk as Record<string, unknown>, ['kty', 'crv', 'x']) ||
      jwk.kty !== 'OKP' || jwk.crv !== 'X25519' ||
      typeof jwk.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x)) {
    throw new GatewayClientError('DISCOVERY_REJECTED', false);
  }
  return { kty: 'OKP', crv: 'X25519', x: jwk.x };
}

function validateDiscoveryDocument(
  value: Record<string, unknown>,
  now: number,
): { readonly document: GatewayDiscoveryDocument; readonly active: GatewayRecipientPublicKey } {
  if (!hasExactKeys(value, ['version', 'suite', 'issuedAt', 'expiresAt', 'keys']) ||
      value['version'] !== GATEWAY_PROTOCOL_VERSION || value['suite'] !== GATEWAY_HPKE_SUITE ||
      !Number.isSafeInteger(value['issuedAt']) || !Number.isSafeInteger(value['expiresAt']) ||
      (value['issuedAt'] as number) > now + MAX_GATEWAY_CLOCK_SKEW_SECONDS ||
      (value['expiresAt'] as number) <= now ||
      (value['expiresAt'] as number) - (value['issuedAt'] as number) >
        MAX_DISCOVERY_LIFETIME_SECONDS ||
      !Array.isArray(value['keys']) || value['keys'].length < 1 || value['keys'].length > 3) {
    throw new GatewayClientError('DISCOVERY_REJECTED', false);
  }
  const keys = value['keys'].map((entry): GatewayDiscoveryKey => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new GatewayClientError('DISCOVERY_REJECTED', false);
    }
    const key = entry as Record<string, unknown>;
    if (!hasExactKeys(key, ['keyId', 'status', 'publicJwk']) ||
        typeof key['keyId'] !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(key['keyId']) ||
        (key['status'] !== 'active' && key['status'] !== 'retiring')) {
      throw new GatewayClientError('DISCOVERY_REJECTED', false);
    }
    return {
      keyId: key['keyId'],
      status: key['status'],
      publicJwk: validateRecipientJwk(key['publicJwk']),
    };
  });
  if (new Set(keys.map((key) => key.keyId)).size !== keys.length) {
    throw new GatewayClientError('DISCOVERY_REJECTED', false);
  }
  const activeKeys = keys.filter((key) => key.status === 'active');
  if (activeKeys.length !== 1) {
    throw new GatewayClientError('DISCOVERY_REJECTED', false);
  }
  const active = activeKeys[0];
  if (!active) throw new GatewayClientError('DISCOVERY_REJECTED', false);
  return {
    document: {
      version: 1,
      suite: GATEWAY_HPKE_SUITE,
      issuedAt: value['issuedAt'] as number,
      expiresAt: value['expiresAt'] as number,
      keys,
    },
    active: { keyId: active.keyId, publicJwk: active.publicJwk },
  };
}

async function verifyDiscoveryJws(
  compactJws: string,
  pinnedRoot: PinnedGatewayRoot,
  now: number,
): Promise<{ readonly document: GatewayDiscoveryDocument; readonly active: GatewayRecipientPublicKey }> {
  if (compactJws.length > MAX_DISCOVERY_BODY_BYTES || compactJws.split('.').length !== 3) {
    throw new GatewayClientError('DISCOVERY_REJECTED', false);
  }
  const [protectedPart, payloadPart, signaturePart] = compactJws.split('.');
  if (!protectedPart || !payloadPart || !signaturePart) {
    throw new GatewayClientError('DISCOVERY_REJECTED', false);
  }
  const header = parseJsonObject(new TextDecoder().decode(base64UrlDecode(protectedPart)));
  if (!hasExactKeys(header, ['alg', 'kid', 'typ']) || header['alg'] !== 'ES256' ||
      header['kid'] !== pinnedRoot.keyId || header['typ'] !== 'CSBOARD-GATEWAY-JWKS+JWS') {
    throw new GatewayClientError('DISCOVERY_REJECTED', false);
  }
  const rootJwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: pinnedRoot.publicJwk.x,
    y: pinnedRoot.publicJwk.y,
    ext: true,
    key_ops: ['verify'],
  };
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    rootJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const signature = base64UrlDecode(signaturePart);
  if (signature.byteLength !== 64) throw new GatewayClientError('DISCOVERY_REJECTED', false);
  const verified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    toArrayBuffer(signature),
    toArrayBuffer(utf8Bytes(`${protectedPart}.${payloadPart}`)),
  );
  if (!verified) throw new GatewayClientError('DISCOVERY_REJECTED', false);
  const document = parseJsonObject(new TextDecoder().decode(base64UrlDecode(payloadPart)));
  return validateDiscoveryDocument(document, now);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new GatewayClientError('GATEWAY_REJECTED', false, response.status);
  }
  const text = await response.text();
  if (utf8Bytes(text).byteLength > maxBytes) {
    throw new GatewayClientError('GATEWAY_REJECTED', false, response.status);
  }
  return text;
}

function failureCodeForStatus(status: number): GatewayDeliveryFailureCode {
  if (status === 401 || status === 403) return 'device-revoked';
  if (status === 429) return 'gateway-rate-limited';
  if (status >= 500) return 'gateway-temporary-error';
  return 'gateway-rejected';
}

function isSuccessfulEnvelopeAck(
  envelope: GatewayEncryptedEnvelope,
  body: Record<string, unknown>,
): boolean {
  if (envelope.protected.operation === 'portfolio.sync') {
    if (!hasExactKeys(body, [
      'accepted', 'cached', 'requestId', 'syncRunId', 'chunkIndex', 'chunkCount',
      'assembled', 'eventCount', 'queuedAt',
    ])) return false;
    return body['accepted'] === true &&
      typeof body['cached'] === 'boolean' &&
      body['requestId'] === envelope.protected.requestId &&
      body['syncRunId'] === envelope.protected.syncRunId &&
      body['chunkIndex'] === envelope.protected.chunkIndex &&
      body['chunkCount'] === envelope.protected.chunkCount &&
      typeof body['assembled'] === 'boolean' &&
      Number.isSafeInteger(body['eventCount']) && (body['eventCount'] as number) >= 0 &&
      typeof body['queuedAt'] === 'string' && body['queuedAt'].length <= 64 &&
      Number.isFinite(Date.parse(body['queuedAt']));
  }
  if (envelope.protected.operation === 'device.unpair') {
    return hasExactKeys(body, ['revoked', 'cached', 'deviceId']) &&
      body['revoked'] === true && typeof body['cached'] === 'boolean' &&
      typeof body['deviceId'] === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(body['deviceId']);
  }
  // Pairing has a richer registration response and is handled by confirmPair().
  return false;
}

export class ProtectedGatewayClient {
  private readonly config: GatewayClientConfig;
  private readonly deviceKeys: IndexedDbDeviceKeyStore;
  private readonly gatewayOrigin: string;
  private readonly pinnedRoot: PinnedGatewayRoot;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cachedRecipient: { key: GatewayRecipientPublicKey; expiresAt: number } | null = null;

  constructor(
    config: GatewayClientConfig,
    deviceKeys: IndexedDbDeviceKeyStore,
    options: { readonly fetchImpl?: typeof fetch; readonly now?: () => number } = {},
  ) {
    this.config = config;
    this.deviceKeys = deviceKeys;
    this.gatewayOrigin = validateGatewayOrigin(config);
    this.pinnedRoot = validateRoot(config.pinnedDiscoveryRoot);
    // 🔴 `fetch` must keep its global receiver. Stored bare and invoked as
    // `this.fetchImpl(...)` the service worker rejects every call with
    // "Illegal invocation": `this` is the instance, not WorkerGlobalScope.
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  get origin(): string {
    return this.gatewayOrigin;
  }

  async discoverRecipientKey(): Promise<GatewayRecipientPublicKey> {
    const now = Math.floor(this.now() / 1_000);
    if (this.cachedRecipient && this.cachedRecipient.expiresAt > now + 30) {
      return this.cachedRecipient.key;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayOrigin}${DISCOVERY_PATH}`, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' },
      });
    } catch {
      throw new GatewayClientError('NETWORK_ERROR', true);
    }
    if (!response.ok) {
      throw new GatewayClientError('NETWORK_ERROR', response.status >= 500, response.status);
    }
    const body = parseJsonObject(await readBoundedText(response, MAX_DISCOVERY_BODY_BYTES));
    if (!hasExactKeys(body, ['jws']) || typeof body['jws'] !== 'string') {
      throw new GatewayClientError('DISCOVERY_REJECTED', false);
    }
    const verified = await verifyDiscoveryJws(body['jws'], this.pinnedRoot, now);
    this.cachedRecipient = { key: verified.active, expiresAt: verified.document.expiresAt };
    return verified.active;
  }

  async seal(
    payload: unknown,
    operation: GatewayOperation,
    options: {
      readonly deviceId?: string;
      readonly idempotencyKey?: string;
      readonly requestId?: string;
    } = {},
  ): Promise<GatewayEncryptedEnvelope> {
    const recipient = await this.discoverRecipientKey();
    return sealGatewayPayload(payload, {
      operation,
      recipient,
      extensionId: this.config.extensionId,
      extensionVersion: this.config.extensionVersion,
      deviceId: options.deviceId,
      idempotencyKey: options.idempotencyKey,
      requestId: options.requestId,
    }, { deviceKeys: this.deviceKeys, now: this.now });
  }

  async sendEnvelope(envelope: GatewayEncryptedEnvelope): Promise<GatewayEnvelopeSenderResult> {
    assertGatewayEncryptedEnvelope(envelope);
    const body = JSON.stringify(envelope);
    if (utf8Bytes(body).byteLength > MAX_GATEWAY_SERIALIZED_BODY_BYTES) {
      throw new GatewayPayloadError('PAYLOAD_TOO_LARGE', { reason: 'encrypted-body-too-large' });
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayOrigin}${envelope.protected.httpPath}`, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch {
      return { accepted: false, retryable: true, failureCode: 'network-unavailable' };
    }
    if (response.ok) {
      try {
        const responseBody = parseJsonObject(
          await readBoundedText(response, MAX_RESPONSE_BODY_BYTES),
        );
        if (isSuccessfulEnvelopeAck(envelope, responseBody)) {
          return { accepted: true, retryable: false };
        }
      } catch {
        // A 2xx without the operation-bound acknowledgement is not delivery.
      }
      return { accepted: false, retryable: false, failureCode: 'gateway-rejected' };
    }
    const retryAfterHeader = Number(response.headers.get('retry-after'));
    return {
      accepted: false,
      retryable: response.status === 429 || response.status >= 500,
      failureCode: failureCodeForStatus(response.status),
      ...(Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? { retryAfterMs: Math.min(retryAfterHeader * 1_000, 30 * 60 * 1_000) }
        : {}),
    };
  }

  async confirmPair(payload: DevicePairPayload): Promise<DeviceRegistration> {
    const envelope = await this.seal(payload, 'device.pair');
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayOrigin}${envelope.protected.httpPath}`, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      });
    } catch {
      throw new GatewayClientError('NETWORK_ERROR', true);
    }
    if (!response.ok) {
      throw new GatewayClientError(
        response.status === 401 || response.status === 403 ? 'DEVICE_REVOKED' : 'GATEWAY_REJECTED',
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    const body = parseJsonObject(await readBoundedText(response, MAX_RESPONSE_BODY_BYTES));
    if (body['ok'] !== true || body['paired'] !== true ||
        typeof body['deviceId'] !== 'string' ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(body['deviceId']) ||
        !isSteamId64(body['steamId'])) {
      throw new GatewayClientError('GATEWAY_REJECTED', false, response.status);
    }
    return {
      id: 'registration',
      deviceId: body['deviceId'],
      steamId: body['steamId'],
      gatewayOrigin: this.gatewayOrigin,
      recipientKeyId: envelope.protected.recipientKeyId,
      pairedAt: this.now(),
    };
  }
}

export async function signGatewayDiscoveryForTest(
  document: GatewayDiscoveryDocument,
  rootKeyId: string,
  rootPrivateKey: CryptoKey,
): Promise<string> {
  const protectedPart = base64UrlEncode(utf8Bytes(canonicalJson({
    alg: 'ES256',
    kid: rootKeyId,
    typ: 'CSBOARD-GATEWAY-JWKS+JWS',
  })));
  const payloadPart = base64UrlEncode(utf8Bytes(canonicalJson(document)));
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    rootPrivateKey,
    toArrayBuffer(utf8Bytes(`${protectedPart}.${payloadPart}`)),
  );
  return `${protectedPart}.${payloadPart}.${base64UrlEncode(signature)}`;
}
