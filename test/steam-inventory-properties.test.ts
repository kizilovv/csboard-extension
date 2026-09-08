import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchInventoryAssetProperties } from '../src/shared/steam-inventory-properties.ts';

const PARTNER = '76561199832227436';

/** One asset with a wear rating, one container that legitimately has none. */
const page = (overrides: Record<string, unknown> = {}) => ({
  assets: [
    { assetid: '53604992376', classid: '1', instanceid: '0' },
    { assetid: '53442217566', classid: '2', instanceid: '0' },
  ],
  asset_properties: [
    {
      appid: 730,
      contextid: '2',
      assetid: '53604992376',
      asset_properties: [
        { propertyid: 1, int_value: '522', name: 'Pattern Template' },
        { propertyid: 2, float_value: '0.0765415504574775696', name: 'Wear Rating' },
      ],
    },
  ],
  ...overrides,
});

const withFetch = async <T>(
  handler: (url: string) => { status?: number; body?: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; urls: string[] }> => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    const { status = 200, body = {} } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;

  try {
    return { result: await run(), urls };
  } finally {
    globalThis.fetch = original;
  }
};

test('A public inventory read yields the partner float, keyed by asset id', async () => {
  const { result } = await withFetch(
    () => ({ body: page() }),
    () => fetchInventoryAssetProperties(PARTNER),
  );

  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.ok(Math.abs((result.properties.get('53604992376')?.floatValue ?? 0) - 0.07654155) < 1e-7);
  assert.equal(result.properties.get('53604992376')?.paintSeed, 522);
  // A container carries no wear, so it must not be invented as a zero float.
  assert.equal(result.properties.has('53442217566'), false);
});

test('A private profile is reported as unavailable, not as an error to retry', async () => {
  const { result, urls } = await withFetch(
    () => ({ status: 403, body: {} }),
    () => fetchInventoryAssetProperties(PARTNER),
  );

  assert.equal(result.status, 'unavailable');
  assert.equal(urls.length, 1);
});

test('Rate limiting is reported separately so the queue can back off', async () => {
  const { result } = await withFetch(
    () => ({ status: 429, body: {} }),
    () => fetchInventoryAssetProperties(PARTNER),
  );

  assert.equal(result.status, 'throttled');
});

test('Paging stops as soon as every wanted asset has been seen', async () => {
  const { result, urls } = await withFetch(
    () => ({ body: page({ more_items: 1, last_assetid: '53604992376' }) }),
    () => fetchInventoryAssetProperties(PARTNER, {
      neededAssetIds: new Set(['53604992376']),
    }),
  );

  assert.equal(result.status, 'ok');
  assert.equal(urls.length, 1, 'the wanted asset was on page one; a second read is wasted quota');
});

test('Paging continues while a wanted asset is still missing, up to the page cap', async () => {
  const { urls } = await withFetch(
    () => ({ body: page({ more_items: 1, last_assetid: '53604992376' }) }),
    () => fetchInventoryAssetProperties(PARTNER, {
      neededAssetIds: new Set(['99999999999']),
    }),
  );

  assert.equal(urls.length, 3);
  assert.ok(urls[1].includes('start_assetid=53604992376'));
});

test('A malformed steam id never reaches Steam', async () => {
  const { result, urls } = await withFetch(
    () => ({ body: page() }),
    () => fetchInventoryAssetProperties('not-a-steamid'),
  );

  assert.equal(result.status, 'error');
  assert.equal(urls.length, 0);
});
