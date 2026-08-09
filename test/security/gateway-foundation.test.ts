import test from 'node:test';

test('encrypted gateway foundation contract', async () => {
  await import('../../tests/gateway-foundation.test.ts');
});
