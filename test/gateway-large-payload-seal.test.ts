import assert from 'node:assert/strict';
import test from 'node:test';

import { assertSafeGatewayPayload, canonicalJson, canonicalStringify } from '../src/shared/gateway-dto.ts';

test('encoding a sealed envelope must not run the user-content scan', () => {
  // The device proof signs over the ciphertext, whose base64 for a 128 KB chunk
  // is ~175k characters. Routing that through the content scan — which caps
  // strings at 4 KB because user data has no business being longer — rejected
  // every portfolio sync before the request left the browser, while pairing
  // (a tiny payload) kept working and hid the cause.
  const ciphertext = 'A'.repeat(175_000);
  const proofInput = {
    domain: 'csboard.gateway.proof.v1',
    protected: { version: 1, operation: 'portfolio.sync' },
    encapsulatedKey: 'B'.repeat(43),
    ciphertext,
  };

  assert.throws(() => canonicalJson(proofInput), /INVALID_PAYLOAD|string/i);
  const encoded = canonicalStringify(proofInput);
  assert.ok(encoded.includes(ciphertext), 'the ciphertext must survive encoding intact');
});

test('the two encoders agree byte for byte on anything the scan accepts', () => {
  // The backend rebuilds this string to verify the signature, so dropping the
  // scan must not change a single byte of the output.
  const payload = {
    b: 2,
    a: 'ok',
    nested: { z: [1, 2, 3], y: 'fine' },
  };
  assert.equal(canonicalStringify(payload), canonicalJson(payload));
});

test('the content scan still rejects an oversized string in user data', () => {
  assert.throws(
    () => assertSafeGatewayPayload({ marketHashName: 'x'.repeat(5_000) }),
    /INVALID_PAYLOAD|string/i,
  );
});
