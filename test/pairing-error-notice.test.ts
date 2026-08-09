import assert from 'node:assert/strict';
import test from 'node:test';

import { pairingFailureNotice } from '../src/popup/pairing-error-notice.js';

test('pairing failures distinguish build, discovery, backend and network faults', () => {
  assert.match(
    pairingFailureNotice(new Error('GATEWAY_BUILD_CONFIG_UNAVAILABLE')),
    /production-configured build/i,
  );
  assert.match(
    pairingFailureNotice(new Error('DISCOVERY_REJECTED')),
    /security key does not match/i,
  );
  assert.match(
    pairingFailureNotice(new Error('GATEWAY_REJECTED')),
    /generate a fresh code in CSFolder/i,
  );
  assert.match(
    pairingFailureNotice(new Error('NETWORK_ERROR')),
    /could not reach CSBOARD/i,
  );
});

test('unknown pairing failures keep the safe fresh-code fallback', () => {
  assert.equal(
    pairingFailureNotice(new Error('unknown-internal-detail')),
    'Pairing failed. Generate a fresh code in CSFolder and try again.',
  );
});
