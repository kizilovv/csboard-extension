#!/usr/bin/env node

import { createPublicKey } from 'node:crypto';

const fail = (message) => {
  console.error(`[store-config] ${message}`);
  process.exitCode = 1;
};

if (process.env.CSBOARD_EXTENSION_BUILD_PROFILE !== 'store') {
  fail('CSBOARD_EXTENSION_BUILD_PROFILE must be exactly "store"');
}

const hosts = (process.env.CSBOARD_GATEWAY_HOSTS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const allowed = new Set([
  'https://csboard.com',
  'https://csboard.trade',
]);

if (hosts.length !== allowed.size ||
    new Set(hosts).size !== allowed.size ||
    hosts.some((host) => !allowed.has(host))) {
  fail('CSBOARD_GATEWAY_HOSTS must contain only the two exact production HTTPS origins');
}

let rootJwk;
try {
  rootJwk = JSON.parse(process.env.CSBOARD_GATEWAY_ROOT_JWK || '');
} catch {
  fail('CSBOARD_GATEWAY_ROOT_JWK must be valid JSON');
}

if (!rootJwk || typeof rootJwk !== 'object' || Array.isArray(rootJwk)) {
  fail('CSBOARD_GATEWAY_ROOT_JWK must be a public P-256 JWK object');
} else {
  const allowedFields = new Set(['kty', 'crv', 'kid', 'x', 'y', 'alg', 'use', 'key_ops', 'ext']);
  const unknownFields = Object.keys(rootJwk).filter((key) => !allowedFields.has(key));
  if (unknownFields.length > 0) {
    fail(`Pinned gateway root contains unsupported fields: ${unknownFields.join(', ')}`);
  }
  if (rootJwk.kty !== 'EC' || rootJwk.crv !== 'P-256' ||
      typeof rootJwk.x !== 'string' || typeof rootJwk.y !== 'string') {
    fail('Pinned gateway root must be an EC P-256 public JWK');
  }
  if ('d' in rootJwk || 'k' in rootJwk) {
    fail('Pinned gateway root must not contain private/symmetric key material');
  }
  if (typeof rootJwk.kid !== 'string' || !/^[A-Za-z0-9._-]{3,128}$/.test(rootJwk.kid)) {
    fail('Pinned gateway root must have a stable kid');
  }
  if (/test|dev|local|example/i.test(rootJwk.kid)) {
    fail('Pinned gateway root kid must not be a test/dev/local/example key');
  }
  const coordPattern = /^[A-Za-z0-9_-]{43}$/;
  if (!coordPattern.test(String(rootJwk.x)) || !coordPattern.test(String(rootJwk.y))) {
    fail('Pinned gateway root x/y coordinates must be unpadded base64url P-256 coordinates');
  }
  if (rootJwk.alg !== undefined && rootJwk.alg !== 'ES256') {
    fail('Pinned gateway root alg must be ES256 when present');
  }
  if (rootJwk.use !== undefined && rootJwk.use !== 'sig') {
    fail('Pinned gateway root use must be sig when present');
  }
  if (rootJwk.ext !== undefined && rootJwk.ext !== true) {
    fail('Pinned gateway root ext must be true when present');
  }
  if (rootJwk.key_ops !== undefined &&
      (!Array.isArray(rootJwk.key_ops) || rootJwk.key_ops.length !== 1 ||
       rootJwk.key_ops[0] !== 'verify')) {
    fail('Pinned gateway root key_ops must be exactly ["verify"] when present');
  }
  try {
    const key = createPublicKey({ key: rootJwk, format: 'jwk' });
    const exported = key.export({ format: 'jwk' });
    if (exported.kty !== 'EC' || exported.crv !== 'P-256' ||
        exported.x !== rootJwk.x || exported.y !== rootJwk.y) {
      fail('Pinned gateway root coordinates do not match the imported P-256 key');
    }
  } catch {
    fail('Pinned gateway root is not an importable P-256 public key');
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log('[store-config] production gateway configuration is fail-closed and valid');
