import {
  GATEWAY_HPKE_SUITE,
  GatewayPayloadError,
  MAX_GATEWAY_PLAINTEXT_BYTES,
  assertSafeGatewayPayload,
  base64UrlEncode,
  byteLengthOfCanonicalJson,
  canonicalJson,
  type DevicePairPayload,
  type GatewayEncryptedEnvelope,
  type PortfolioItemDto,
  type PortfolioSnapshot,
} from '../src/shared/gateway-dto';
import { chunkPortfolioSnapshot } from '../src/shared/portfolio-dto';
import { sealGatewayPayload } from '../src/background/gateway-crypto';
import { dispatchExternalStatus } from '../src/background/external-router';
import {
  ProtectedGatewayClient,
  signGatewayDiscoveryForTest,
} from '../src/background/gateway-client';
import { createSteamReadSessionProvider } from '../src/background/steam-read-session-provider';
import {
  drainGatewayOutbox,
  enqueueGatewayEnvelope,
  type GatewayOutboxRecord,
  type GatewayOutboxStorage,
} from '../src/background/sync-outbox';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function expectGatewayError(fn: () => void, code: GatewayPayloadError['code']): void {
  try {
    fn();
  } catch (error) {
    const actualCode = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
    assert(
      error instanceof GatewayPayloadError ||
        (error instanceof Error && error.name === 'GatewayPayloadError'),
      `expected GatewayPayloadError, got ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`,
    );
    assert(actualCode === code, `expected ${code}, got ${String(actualCode)}`);
    return;
  }
  throw new Error(`Expected ${code}`);
}

async function expectGatewayErrorAsync(
  fn: () => Promise<unknown>,
  code: GatewayPayloadError['code'],
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const actualCode = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
    assert(
      error instanceof GatewayPayloadError ||
        (error instanceof Error && error.name === 'GatewayPayloadError'),
      'expected async GatewayPayloadError',
    );
    assert(actualCode === code, `expected ${code}, got ${String(actualCode)}`);
    return;
  }
  throw new Error(`Expected ${code}`);
}

function inventoryItem(index: number): PortfolioItemDto {
  return {
    appId: '730',
    contextId: index % 2 === 0 ? '2' : '16',
    assetId: String(10_000 + index),
    classId: String(20_000 + index),
    instanceId: '0',
    amount: '1',
    marketHashName: `AK-47 | Test Pattern ${String(index).padStart(4, '0')} (${'.'.repeat(180)})`,
    tradable: index % 2 === 0,
    marketable: true,
    onHold: index % 2 !== 0,
  };
}

function snapshot(itemCount: number): PortfolioSnapshot {
  return {
    kind: 'portfolio.snapshot.v1',
    syncRunId: 'sync_run_012345678901234567890123',
    steamId: '76561198000000000',
    capturedAt: 1_700_000_000,
    completeness: {
      inventoryContext2: true,
      inventoryContext16: true,
      trades: true,
      offers: true,
    },
    inventoryItems: Array.from({ length: itemCount }, (_, index) => inventoryItem(index)),
    trades: [],
    offers: [],
  };
}

async function createTestEnvelope(extensionVersion = '1.1.0'): Promise<GatewayEncryptedEnvelope> {
  const recipient = await crypto.subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;
  const recipientPublicJwk = await crypto.subtle.exportKey('jwk', recipient.publicKey);
  const signingPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const devicePublicJwk = await crypto.subtle.exportKey('jwk', signingPair.publicKey);
  const deviceKeyId = 'device_key_012345678901234567890123456789';
  const ids = [
    'request_012345678901234567890123',
    'idempotency_01234567890123456789',
    'nonce_01234567890123456789012345',
  ];
  let idIndex = 0;
  const payload: DevicePairPayload = {
    kind: 'device.pair.v1',
    pairingCode: 'PAIR-123456',
    device: {
      deviceKeyId,
      publicJwk: {
        kty: 'EC',
        crv: 'P-256',
        x: devicePublicJwk.x,
        y: devicePublicJwk.y,
      },
    },
    client: {
      extensionVersion,
      platform: 'chromium-mv3',
      capabilities: [
        'inventory-context-2',
        'inventory-context-16',
        'recent-trades',
      ],
    },
  };
  return sealGatewayPayload(payload, {
    operation: 'device.pair',
    recipient: { keyId: 'gateway-2026-08', publicJwk: recipientPublicJwk },
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    extensionVersion,
  }, {
    now: () => 1_700_000_000_000,
    randomId: () => ids[idIndex++] ?? 'unexpected_random_identifier_000',
    deviceKeys: {
      async getOrCreateIdentity() {
        return { deviceKeyId };
      },
      async sign(data) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        const signature = await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          signingPair.privateKey,
          copy.buffer,
        );
        return { deviceKeyId, signature: base64UrlEncode(signature) };
      },
    },
  });
}

async function run(): Promise<void> {
  assert(
    canonicalJson({ z: 1, a: { y: 2, b: 3 } }) === '{"a":{"b":3,"y":2},"z":1}',
    'canonical object ordering',
  );
  assertSafeGatewayPayload({ marketHashName: '★ Karambit | Doppler', tradable: true });
  expectGatewayError(
    () => assertSafeGatewayPayload({ nested: { accessToken: 'do-not-send' } }),
    'FORBIDDEN_SECRET',
  );

  const externalStatus = dispatchExternalStatus({
    version: 1,
    type: 'GET_EXTENSION_STATUS',
    requestId: 'status_request_1',
    payload: {},
  }, 'https://csboard.com', {
    allowedOrigins: new Set(['https://csboard.com', 'https://csboard.trade']),
    extensionVersion: '1.1.0',
  });
  assert(externalStatus.ok && Object.keys(externalStatus.data).sort().join(',') ===
    'capabilityVersion,extensionVersion,installed', 'external response is status-only');
  const forbiddenExternal = dispatchExternalStatus({
    version: 1,
    type: 'GET_EXTENSION_STATUS',
    requestId: 'status_request_2',
    payload: { accessToken: 'requested' },
  }, 'https://csboard.com', {
    allowedOrigins: new Set(['https://csboard.com']),
    extensionVersion: '1.1.0',
  });
  assert(!forbiddenExternal.ok && forbiddenExternal.error.code === 'INVALID_MESSAGE',
    'external payload fields are rejected');
  expectGatewayError(
    () => assertSafeGatewayPayload({ note: '<html><script>secret</script></html>' }),
    'FORBIDDEN_SECRET',
  );
  expectGatewayError(
    () => assertSafeGatewayPayload({ value: 'steam://rungame/730/123/+csgo_econ_action_preview S1A2D3' }),
    'FORBIDDEN_SECRET',
  );

  const original = snapshot(700);
  const chunks = chunkPortfolioSnapshot(original, 16 * 1024);
  assert(chunks.length > 1, 'large snapshot is chunked');
  assert(chunks.every((chunk) => byteLengthOfCanonicalJson(chunk) <= MAX_GATEWAY_PLAINTEXT_BYTES),
    'every chunk respects the hard plaintext cap');
  assert(chunks.every((chunk, index) => chunk.chunkIndex === index &&
    chunk.chunkCount === chunks.length), 'chunk indexes are contiguous');
  assert(chunks.reduce((total, chunk) => total + chunk.inventoryItems.length, 0) === 700,
    'chunking neither loses nor duplicates inventory items');
  expectGatewayError(
    () => chunkPortfolioSnapshot({
      ...snapshot(1),
      inventoryItems: [{ ...inventoryItem(0), amount: '1001' }],
    }),
    'INVALID_PAYLOAD',
  );
  expectGatewayError(
    () => chunkPortfolioSnapshot(snapshot(5_000), 16 * 1024),
    'PAYLOAD_TOO_LARGE',
  );
  expectGatewayError(
    () => chunkPortfolioSnapshot(snapshot(5_001)),
    'PAYLOAD_TOO_LARGE',
  );

  const envelope = await createTestEnvelope();
  await createTestEnvelope('1.1.0.8');
  await expectGatewayErrorAsync(() => createTestEnvelope('01.1.0'), 'INVALID_PAYLOAD');
  assert(envelope.protected.suite === GATEWAY_HPKE_SUITE, 'fixed RFC 9180 suite');
  assert(envelope.protected.requestId !== envelope.protected.nonce, 'fresh replay nonce');
  assert(envelope.ciphertext.length > 0 && envelope.encapsulatedKey.length > 0,
    'HPKE produced ciphertext and encapsulated key');

  const discoveryRoot = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const rootPublicJwk = await crypto.subtle.exportKey('jwk', discoveryRoot.publicKey);
  const recipient = await crypto.subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;
  const recipientJwk = await crypto.subtle.exportKey('jwk', recipient.publicKey);
  const discoveryJws = await signGatewayDiscoveryForTest({
    version: 1,
    suite: GATEWAY_HPKE_SUITE,
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_003_600,
    keys: [{
      keyId: 'active-gateway-key',
      status: 'active',
      publicJwk: { kty: 'OKP', crv: 'X25519', x: recipientJwk.x },
    }],
  }, 'offline-root-v1', discoveryRoot.privateKey);
  const client = new ProtectedGatewayClient({
    gatewayOrigin: 'https://csboard.com',
    allowedGatewayOrigins: ['https://csboard.com'],
    pinnedDiscoveryRoot: { keyId: 'offline-root-v1', publicJwk: rootPublicJwk },
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    extensionVersion: '1.1.0',
  }, {} as never, {
    now: () => 1_700_000_100_000,
    fetchImpl: async () => new Response(JSON.stringify({ jws: discoveryJws }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  const discovered = await client.discoverRecipientKey();
  assert(discovered.keyId === 'active-gateway-key' && discovered.publicJwk.x === recipientJwk.x,
    'signed discovery selects exactly the active X25519 key');

  const conflictClient = new ProtectedGatewayClient({
    gatewayOrigin: 'https://csboard.com',
    allowedGatewayOrigins: ['https://csboard.com'],
    pinnedDiscoveryRoot: { keyId: 'offline-root-v1', publicJwk: rootPublicJwk },
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    extensionVersion: '1.1.0',
  }, {} as never, {
    fetchImpl: async () => new Response(JSON.stringify({ error: 'SYNC_CHUNK_CONFLICT' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  const conflictDelivery = await conflictClient.sendEnvelope(envelope);
  assert(!conflictDelivery.accepted && !conflictDelivery.retryable,
    'HTTP 409 conflicts are never treated as successful delivery');

  const steamFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://steamcommunity.com/')) {
      const response = new Response(
        '<div data-loyalty_webapi_token="abcdefghijklmnopqrstuvwxyz123456"></div>',
        { status: 200 },
      );
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }
    return new Response(JSON.stringify({
      response: {
        assets: [{ assetid: '1', classid: '2', instanceid: '0', amount: '1' }],
        descriptions: [{
          classid: '2',
          instanceid: '0',
          market_hash_name: 'AK-47 | Redline (Field-Tested)',
          name: 'AK-47 | Redline',
          icon_url: 'safeSteamHash_123/360fx360f',
          tradable: 1,
          marketable: 1,
        }],
        asset_properties: [],
        more_items: false,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const steamProvider = createSteamReadSessionProvider({
    steamId: '76561198000000000',
    fetchImpl: steamFetch,
    now: () => 1_700_000_000_000,
  });
  const steamInventory = await steamProvider.readInventoryContext('2');
  assert(steamInventory.items[0]?.iconUrl ===
    'https://community.cloudflare.steamstatic.com/economy/image/safeSteamHash_123/360fx360f',
  'normal Steam image render suffixes are preserved');

  let outbox: readonly GatewayOutboxRecord[] = [];
  const storage: GatewayOutboxStorage = {
    async read() { return outbox; },
    async write(records) { outbox = structuredClone(records); },
  };
  const first = await enqueueGatewayEnvelope(envelope, { storage, now: () => 1_000 });
  const duplicate = await enqueueGatewayEnvelope(envelope, { storage, now: () => 2_000 });
  assert(first.queued && !duplicate.queued && outbox.length === 1,
    'outbox deduplicates request and idempotency IDs');
  const drain = await drainGatewayOutbox(async () => ({ accepted: true, retryable: false }), {
    storage,
    now: () => 2_000,
  });
  assert(drain.delivered === 1 && outbox.length === 0, 'accepted ciphertext leaves outbox');

  console.log('gateway-foundation.test.ts: ok');
}

await run();
