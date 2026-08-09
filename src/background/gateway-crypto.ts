import {
  Aes256Gcm,
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256,
} from '@hpke/core';
import {
  DEFAULT_GATEWAY_TTL_SECONDS,
  GATEWAY_HPKE_INFO,
  GATEWAY_HPKE_SUITE,
  GATEWAY_OPERATION_BINDINGS,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SIGNATURE_ALGORITHM,
  GatewayPayloadError,
  MAX_GATEWAY_CHUNKS_PER_RUN,
  MAX_GATEWAY_PLAINTEXT_BYTES,
  MAX_GATEWAY_SERIALIZED_BODY_BYTES,
  MAX_GATEWAY_TTL_SECONDS,
  assertSafeGatewayPayload,
  canonicalStringify,
  base64UrlEncode,
  canonicalJson,
  createRandomId,
  sha256Base64Url,
  utf8Bytes,
  type GatewayEncryptedEnvelope,
  type GatewayOperation,
  type GatewayProtectedMetadata,
  type GatewayRecipientPublicKey,
} from '../shared/gateway-dto';

const MAX_BASE64URL_CIPHERTEXT_LENGTH =
  Math.ceil((MAX_GATEWAY_PLAINTEXT_BYTES + 16) / 3) * 4;

export interface GatewaySealOptions {
  readonly operation: GatewayOperation;
  readonly recipient: GatewayRecipientPublicKey | null | undefined;
  readonly deviceId?: string;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly requestId?: string;
  readonly idempotencyKey?: string;
  readonly issuedAt?: number;
  readonly ttlSeconds?: number;
}

export interface GatewayCryptoDependencies {
  readonly deviceKeys: GatewayDeviceKeySigner;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

export interface GatewayDeviceKeySigner {
  getOrCreateIdentity(): Promise<{ readonly deviceKeyId: string }>;
  sign(data: Uint8Array): Promise<{ readonly deviceKeyId: string; readonly signature: string }>;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function assertToken(value: string, path: string, min = 16, max = 128): void {
  if (value.length < min || value.length > max || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path });
  }
}

/** Removes optional JWK metadata so key usage declarations cannot conflict with HPKE. */
function normalizeRecipientJwk(recipient: GatewayRecipientPublicKey): JsonWebKey {
  const jwk = recipient.publicJwk;
  if (!recipient.keyId) {
    throw new GatewayPayloadError('GATEWAY_UNCONFIGURED', { reason: 'missing-recipient-key-id' });
  }
  assertToken(recipient.keyId, '$.recipient.keyId', 1, 128);
  if (jwk.kty !== 'OKP' || jwk.crv !== 'X25519' ||
      typeof jwk.x !== 'string' || jwk.y !== undefined || jwk.d !== undefined) {
    throw new GatewayPayloadError('INVALID_KEY', { reason: 'invalid-hpke-recipient-key' });
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(jwk.x)) {
    throw new GatewayPayloadError('INVALID_KEY', { reason: 'invalid-hpke-recipient-coordinate' });
  }
  return { kty: 'OKP', crv: 'X25519', x: jwk.x, ext: true };
}

function assertOperationHasDeviceId(operation: GatewayOperation, deviceId?: string): void {
  if (operation === 'device.pair') {
    if (deviceId !== undefined) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.deviceId' });
    }
    return;
  }
  if (!deviceId) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.deviceId' });
  }
  assertToken(deviceId, '$.deviceId');
}

interface PayloadBinding {
  readonly payloadSchema: 'device.pair.v1' | 'device.unpair.v1' | 'portfolio.sync.chunk.v1';
  readonly syncRunId?: string;
  readonly chunkIndex?: number;
  readonly chunkCount?: number;
  readonly pairDeviceKeyId?: string;
}

function getPayloadBinding(payload: unknown, operation: GatewayOperation): PayloadBinding {
  if (typeof payload !== 'object' || payload === null || !('kind' in payload)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.kind' });
  }
  const record = payload as Record<string, unknown>;
  const binding = GATEWAY_OPERATION_BINDINGS[operation];
  if (record['kind'] !== binding.payloadSchema) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.kind' });
  }
  if (operation === 'portfolio.sync') {
    if (typeof record['syncRunId'] !== 'string' ||
        !/^[A-Za-z0-9_-]{22,86}$/.test(record['syncRunId']) ||
        !Number.isSafeInteger(record['chunkIndex']) ||
        !Number.isSafeInteger(record['chunkCount']) ||
        (record['chunkIndex'] as number) < 0 ||
        (record['chunkCount'] as number) < 1 ||
        (record['chunkCount'] as number) > MAX_GATEWAY_CHUNKS_PER_RUN ||
        (record['chunkIndex'] as number) >= (record['chunkCount'] as number)) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-sync-binding' });
    }
    return {
      payloadSchema: binding.payloadSchema,
      syncRunId: record['syncRunId'],
      chunkIndex: record['chunkIndex'] as number,
      chunkCount: record['chunkCount'] as number,
    };
  }
  if (operation === 'device.pair') {
    const device = typeof record['device'] === 'object' && record['device'] !== null
      ? record['device'] as Record<string, unknown>
      : null;
    if (!device || typeof device['deviceKeyId'] !== 'string') {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.device.deviceKeyId' });
    }
    return { payloadSchema: binding.payloadSchema, pairDeviceKeyId: device['deviceKeyId'] };
  }
  return { payloadSchema: binding.payloadSchema };
}

function assertExtensionIdentity(extensionId: string, extensionVersion: string): void {
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.extensionId' });
  }
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/.test(extensionVersion)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.extensionVersion' });
  }
}

/**
 * RFC 9180 base mode using the fixed v1 suite. A new sender context is created
 * per request; contexts are never cached or shared, preventing nonce reuse.
 */
export async function sealGatewayPayload(
  payload: unknown,
  options: GatewaySealOptions,
  dependencies: GatewayCryptoDependencies,
): Promise<GatewayEncryptedEnvelope> {
  if (!options.recipient) {
    throw new GatewayPayloadError('GATEWAY_UNCONFIGURED', { reason: 'missing-recipient-key' });
  }
  assertSafeGatewayPayload(payload);
  const payloadBinding = getPayloadBinding(payload, options.operation);
  assertOperationHasDeviceId(options.operation, options.deviceId);
  assertExtensionIdentity(options.extensionId, options.extensionVersion);

  const plaintext = utf8Bytes(canonicalJson(payload));
  if (plaintext.byteLength > MAX_GATEWAY_PLAINTEXT_BYTES) {
    throw new GatewayPayloadError('PAYLOAD_TOO_LARGE', { bytes: plaintext.byteLength });
  }

  const identity = await dependencies.deviceKeys.getOrCreateIdentity();
  if (payloadBinding.pairDeviceKeyId !== undefined &&
      payloadBinding.pairDeviceKeyId !== identity.deviceKeyId) {
    throw new GatewayPayloadError('INVALID_KEY', { reason: 'pair-device-key-mismatch' });
  }
  const now = options.issuedAt ?? Math.floor((dependencies.now?.() ?? Date.now()) / 1_000);
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_GATEWAY_TTL_SECONDS;
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 30 || ttlSeconds > MAX_GATEWAY_TTL_SECONDS) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-envelope-time' });
  }

  const randomId = dependencies.randomId ?? createRandomId;
  const requestId = options.requestId ?? randomId();
  const idempotencyKey = options.idempotencyKey ?? randomId();
  const nonce = randomId();
  assertToken(requestId, '$.requestId');
  assertToken(idempotencyKey, '$.idempotencyKey');
  assertToken(nonce, '$.nonce');
  if (new Set([requestId, idempotencyKey, nonce]).size !== 3) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'non-unique-replay-identifiers' });
  }

  const recipientJwk = normalizeRecipientJwk(options.recipient);
  const payloadSha256 = await sha256Base64Url(plaintext);
  const operationBinding = GATEWAY_OPERATION_BINDINGS[options.operation];
  const deviceIdHash = options.deviceId
    ? await sha256Base64Url(utf8Bytes(options.deviceId))
    : undefined;
  const protectedMetadata: GatewayProtectedMetadata = {
    version: GATEWAY_PROTOCOL_VERSION,
    suite: GATEWAY_HPKE_SUITE,
    operation: options.operation,
    httpMethod: operationBinding.httpMethod,
    httpPath: operationBinding.httpPath,
    extensionId: options.extensionId,
    extensionVersion: options.extensionVersion,
    payloadSchema: payloadBinding.payloadSchema,
    recipientKeyId: options.recipient.keyId,
    deviceKeyId: identity.deviceKeyId,
    ...(deviceIdHash ? { deviceIdHash } : {}),
    ...(payloadBinding.syncRunId ? { syncRunId: payloadBinding.syncRunId } : {}),
    ...(payloadBinding.chunkIndex !== undefined ? { chunkIndex: payloadBinding.chunkIndex } : {}),
    ...(payloadBinding.chunkCount !== undefined ? { chunkCount: payloadBinding.chunkCount } : {}),
    requestId,
    idempotencyKey,
    nonce,
    issuedAt: now,
    expiresAt: now + ttlSeconds,
    plaintextBytes: plaintext.byteLength,
    payloadSha256,
  };
  const aad = utf8Bytes(canonicalJson(protectedMetadata));

  const suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
  const recipientPublicKey = await suite.kem.importKey('jwk', recipientJwk, true);
  const sender = await suite.createSenderContext({
    recipientPublicKey,
    info: toArrayBuffer(utf8Bytes(GATEWAY_HPKE_INFO)),
  });
  const ciphertextBytes = await sender.seal(toArrayBuffer(plaintext), toArrayBuffer(aad));
  const encapsulatedKey = base64UrlEncode(sender.enc);
  const ciphertext = base64UrlEncode(ciphertextBytes);

  // Encoding only: this object is ours and carries the sealed ciphertext, whose
  // base64 runs to ~175 KB. The plaintext was already content-scanned above,
  // and the backend builds this exact string to verify the signature, so the
  // bytes must not change.
  const proofInput = utf8Bytes(canonicalStringify({
    domain: 'csboard.gateway.proof.v1',
    protected: protectedMetadata,
    encapsulatedKey,
    ciphertext,
  }));
  const proof = await dependencies.deviceKeys.sign(proofInput);
  if (proof.deviceKeyId !== identity.deviceKeyId) {
    throw new GatewayPayloadError('INVALID_KEY', { reason: 'device-key-changed-during-seal' });
  }

  const envelope: GatewayEncryptedEnvelope = {
    version: GATEWAY_PROTOCOL_VERSION,
    protected: protectedMetadata,
    encapsulatedKey,
    ciphertext,
    proof: {
      algorithm: GATEWAY_SIGNATURE_ALGORITHM,
      deviceKeyId: proof.deviceKeyId,
      signature: proof.signature,
    },
  };
  assertGatewayEncryptedEnvelope(envelope);
  if (utf8Bytes(JSON.stringify(envelope)).byteLength > MAX_GATEWAY_SERIALIZED_BODY_BYTES) {
    throw new GatewayPayloadError('PAYLOAD_TOO_LARGE', { reason: 'encrypted-body-too-large' });
  }
  return envelope;
}

/** Structural validation for encrypted records before persistence/transmission. */
export function assertGatewayEncryptedEnvelope(envelope: GatewayEncryptedEnvelope): void {
  const hasExactKeys = (value: object, expected: readonly string[]): boolean => {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
  };
  const protectedKeys = [
    'version', 'suite', 'operation', 'httpMethod', 'httpPath',
    'extensionId', 'extensionVersion', 'payloadSchema',
    'recipientKeyId', 'deviceKeyId',
    ...(envelope.protected.deviceIdHash === undefined ? [] : ['deviceIdHash']),
    ...(envelope.protected.syncRunId === undefined ? [] : ['syncRunId']),
    ...(envelope.protected.chunkIndex === undefined ? [] : ['chunkIndex']),
    ...(envelope.protected.chunkCount === undefined ? [] : ['chunkCount']),
    'requestId', 'idempotencyKey', 'nonce', 'issuedAt', 'expiresAt',
    'plaintextBytes', 'payloadSha256',
  ];
  if (!hasExactKeys(envelope, ['version', 'protected', 'encapsulatedKey', 'ciphertext', 'proof']) ||
      !hasExactKeys(envelope.protected, protectedKeys) ||
      !hasExactKeys(envelope.proof, ['algorithm', 'deviceKeyId', 'signature'])) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'unexpected-envelope-field' });
  }
  assertSafeGatewayPayload(envelope.protected);
  assertSafeGatewayPayload(envelope.proof);
  if (envelope.version !== GATEWAY_PROTOCOL_VERSION ||
      envelope.protected.version !== GATEWAY_PROTOCOL_VERSION ||
      envelope.protected.suite !== GATEWAY_HPKE_SUITE ||
      envelope.proof.algorithm !== GATEWAY_SIGNATURE_ALGORITHM ||
      envelope.proof.deviceKeyId !== envelope.protected.deviceKeyId) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-envelope-header' });
  }
  if (!(['device.pair', 'device.unpair', 'portfolio.sync'] as const)
    .includes(envelope.protected.operation)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-operation' });
  }
  const operationBinding = GATEWAY_OPERATION_BINDINGS[envelope.protected.operation];
  if (envelope.protected.httpMethod !== operationBinding.httpMethod ||
      envelope.protected.httpPath !== operationBinding.httpPath ||
      envelope.protected.payloadSchema !== operationBinding.payloadSchema) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-http-binding' });
  }
  assertExtensionIdentity(
    envelope.protected.extensionId,
    envelope.protected.extensionVersion,
  );
  if (!/^[A-Za-z0-9_-]{43}$/.test(envelope.encapsulatedKey)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-encapsulated-key' });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(envelope.ciphertext) ||
      envelope.ciphertext.length > MAX_BASE64URL_CIPHERTEXT_LENGTH) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-ciphertext' });
  }
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(envelope.proof.signature)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-device-proof' });
  }
  if (!Number.isSafeInteger(envelope.protected.issuedAt) ||
      !Number.isSafeInteger(envelope.protected.expiresAt) ||
      !Number.isSafeInteger(envelope.protected.plaintextBytes) ||
      envelope.protected.expiresAt <= envelope.protected.issuedAt ||
      envelope.protected.expiresAt - envelope.protected.issuedAt > MAX_GATEWAY_TTL_SECONDS ||
      envelope.protected.plaintextBytes < 0 ||
      envelope.protected.plaintextBytes > MAX_GATEWAY_PLAINTEXT_BYTES ||
      !/^[A-Za-z0-9_-]{43}$/.test(envelope.protected.payloadSha256)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-protected-metadata' });
  }
  assertToken(envelope.protected.requestId, '$.protected.requestId');
  assertToken(envelope.protected.idempotencyKey, '$.protected.idempotencyKey');
  assertToken(envelope.protected.nonce, '$.protected.nonce');
  assertToken(envelope.protected.deviceKeyId, '$.protected.deviceKeyId', 22, 86);
  assertToken(envelope.protected.recipientKeyId, '$.protected.recipientKeyId', 1, 128);
  if (envelope.protected.operation === 'device.pair') {
    if (envelope.protected.deviceIdHash !== undefined ||
        envelope.protected.syncRunId !== undefined ||
        envelope.protected.chunkIndex !== undefined ||
        envelope.protected.chunkCount !== undefined) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-pair-binding' });
    }
  } else if (!envelope.protected.deviceIdHash ||
      !/^[A-Za-z0-9_-]{43}$/.test(envelope.protected.deviceIdHash)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'missing-device-id-hash' });
  }
  if (envelope.protected.operation === 'portfolio.sync') {
    if (!envelope.protected.syncRunId ||
        !Number.isSafeInteger(envelope.protected.chunkIndex) ||
        !Number.isSafeInteger(envelope.protected.chunkCount) ||
        (envelope.protected.chunkIndex as number) < 0 ||
        (envelope.protected.chunkCount as number) < 1 ||
        (envelope.protected.chunkCount as number) > MAX_GATEWAY_CHUNKS_PER_RUN ||
        (envelope.protected.chunkIndex as number) >= (envelope.protected.chunkCount as number)) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-sync-binding' });
    }
  } else if (envelope.protected.syncRunId !== undefined ||
      envelope.protected.chunkIndex !== undefined ||
      envelope.protected.chunkCount !== undefined) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'unexpected-sync-binding' });
  }
  if (utf8Bytes(JSON.stringify(envelope)).byteLength > MAX_GATEWAY_SERIALIZED_BODY_BYTES) {
    throw new GatewayPayloadError('PAYLOAD_TOO_LARGE', { reason: 'encrypted-body-too-large' });
  }
}
