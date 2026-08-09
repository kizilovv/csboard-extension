import {
  Aes256Gcm,
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256,
} from '@hpke/core';

const recipientPrivateJwk = {
  kty: 'OKP',
  crv: 'X25519',
  d: 'GGts5cEvnyy7DbaejAc8NF-H5H6cYKK6FgqL7bWD3F0',
  x: 'vFaGnAIvXNwC6IKKBCFal-eBr5D7msVuZBTYY-EmfgU',
};
const recipientPublicJwk = {
  kty: 'OKP',
  crv: 'X25519',
  x: recipientPrivateJwk.x,
};
const devicePrivateJwk = {
  kty: 'EC',
  crv: 'P-256',
  d: 'ogX7MaT91p0xZOTTgYexKf4M2MMUl4rLbRt6z6GScIQ',
  x: 'IXhoNqIVc_xWRYXTYwLAIxLX_AsXPU-Z3dGJ27RTAEc',
  y: 'Ib5bxRqmJEltb4hNfHjiCXfWAvNrFXRaqAqiURqsOMQ',
};
const devicePublicJwk = {
  kty: 'EC',
  crv: 'P-256',
  x: devicePrivateJwk.x,
  y: devicePrivateJwk.y,
  ext: true,
  key_ops: ['verify'],
  alg: 'ES256',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function sha256(value) {
  return base64Url(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

const payload = {
  kind: 'portfolio.sync.chunk.v1',
  syncRunId: 'fixture_sync_run_0123456789012345',
  steamId: '76561198000000000',
  capturedAt: 1_700_000_000,
  chunkIndex: 0,
  chunkCount: 1,
  completeness: {
    inventoryContext2: true,
    inventoryContext16: true,
    trades: true,
    offers: true,
  },
  inventoryItems: [{
    appId: '730',
    contextId: '2',
    assetId: '10001',
    classId: '20001',
    instanceId: '0',
    amount: '1',
    marketHashName: 'AK-47 | Redline (Field-Tested)',
    tradable: true,
    marketable: true,
    onHold: false,
    floatValue: 0.2112,
  }],
  trades: [],
  offers: [],
};

const plaintextCanonical = canonicalJson(payload);
const deviceKeyId = await sha256(canonicalJson(devicePublicJwk));
const protectedMetadata = {
  version: 1,
  suite: 'DHKEM-X25519-HKDF-SHA256/HKDF-SHA256/AES-256-GCM',
  operation: 'portfolio.sync',
  httpMethod: 'POST',
  httpPath: '/api/extension/v2/portfolio/sync',
  extensionId: 'abcdefghijklmnopabcdefghijklmnop',
  extensionVersion: '1.1.0',
  payloadSchema: 'portfolio.sync.chunk.v1',
  recipientKeyId: 'gateway-fixture-2026-08',
  deviceKeyId,
  deviceIdHash: await sha256('fixture-device-0123456789'),
  syncRunId: payload.syncRunId,
  chunkIndex: payload.chunkIndex,
  chunkCount: payload.chunkCount,
  requestId: 'fixture_request_0123456789012345',
  idempotencyKey: 'fixture_idempotency_012345678901',
  nonce: 'fixture_nonce_0123456789012345678',
  issuedAt: 1_700_000_000,
  expiresAt: 1_700_000_120,
  plaintextBytes: encoder.encode(plaintextCanonical).byteLength,
  payloadSha256: await sha256(plaintextCanonical),
};
const aadCanonical = canonicalJson(protectedMetadata);

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});
const recipientPublicKey = await suite.kem.importKey('jwk', recipientPublicJwk, true);
const sender = await suite.createSenderContext({
  recipientPublicKey,
  info: encoder.encode('csboard.gateway.hpke.v1'),
  // Fixed RFC 9180 ephemeral IKM makes HPKE output reproducible for this fixture.
  ekm: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
});
const ciphertextBytes = await sender.seal(
  encoder.encode(plaintextCanonical),
  encoder.encode(aadCanonical),
);
const encapsulatedKey = base64Url(sender.enc);
const ciphertext = base64Url(ciphertextBytes);
const proofCanonical = canonicalJson({
  domain: 'csboard.gateway.proof.v1',
  protected: protectedMetadata,
  encapsulatedKey,
  ciphertext,
});
const devicePrivateKey = await crypto.subtle.importKey(
  'jwk',
  { ...devicePrivateJwk, ext: false, key_ops: ['sign'] },
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign'],
);
const signature = base64Url(await crypto.subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' },
  devicePrivateKey,
  encoder.encode(proofCanonical),
));

const envelope = {
  version: 1,
  protected: protectedMetadata,
  encapsulatedKey,
  ciphertext,
  proof: { algorithm: 'ES256', deviceKeyId, signature },
};

// Generator self-check: decrypt the result before it is copied into the fixture.
const recipientPrivateKey = await suite.kem.importKey('jwk', recipientPrivateJwk, false);
const recipient = await suite.createRecipientContext({
  recipientKey: recipientPrivateKey,
  enc: sender.enc,
  info: encoder.encode('csboard.gateway.hpke.v1'),
});
const opened = await recipient.open(ciphertextBytes, encoder.encode(aadCanonical));
if (decoder.decode(opened) !== plaintextCanonical) throw new Error('fixture HPKE self-check failed');

console.log(JSON.stringify({
  description: 'TEST ONLY — CSBOARD gateway v1 X25519/AES-256 cross-runtime fixture',
  hpkeInfo: 'csboard.gateway.hpke.v1',
  recipientPrivateJwk,
  recipientPublicJwk,
  devicePublicJwk,
  plaintext: payload,
  plaintextCanonical,
  aadCanonical,
  proofCanonical,
  envelope,
}, null, 2));
