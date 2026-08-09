import test from 'node:test';
import assert from 'node:assert/strict';
import { redactLogData } from '../../src/shared/logger';

test('redacts credential keys and secret-bearing strings recursively', () => {
  const redacted = redactLogData({
    requestId: 'safe-request',
    accessToken: 'secret-token',
    nested: {
      cookie: 'sessionid=abc',
      safe: 'ok',
      url: 'https://api.steampowered.com/x?access_token=abc',
    },
  });

  assert.deepEqual(redacted, {
    requestId: 'safe-request',
    accessToken: '[REDACTED]',
    nested: {
      cookie: '[REDACTED]',
      safe: 'ok',
      url: '[REDACTED]',
    },
  });
});

test('bounds attacker-controlled diagnostic values', () => {
  const redacted = redactLogData({ detail: 'x'.repeat(2_000) });
  assert.match(String(redacted?.detail), /\[TRUNCATED:2000\]$/);
  assert.ok(String(redacted?.detail).length < 150);
});
