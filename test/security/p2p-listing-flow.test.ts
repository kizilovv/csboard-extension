import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchExternalStatus } from '../../src/background/external-router.ts';
import {
  P2P_LISTING_TERMS_VERSION,
  P2PListingController,
} from '../../src/background/p2p-listing-client.ts';

const API_BASE = 'https://csboard.com/api';
const IDEMPOTENCY_KEY = '123e4567-e89b-42d3-a456-426614174000';
const REVIEW_ID = 'review_1234567890abcdef';
const ASSET_REVISION = `sha256:${'a'.repeat(64)}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function eligibleAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationalAssetId: 'inventory-item-42',
    assetRevision: ASSET_REVISION,
    marketHashName: 'AK-47 | Redline (Field-Tested)',
    contextId: '2',
    eligibility: true,
    reasons: [],
    currency: 'USD',
    listingId: null,
    listingState: null,
    snapshotCompletedAt: '2026-08-07T10:00:00.000Z',
    ...overrides,
  };
}

test('P2P review binds the exact asset, revision, price, currency, terms and idempotency key', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const controller = new P2PListingController({
    apiBase: async () => API_BASE,
    now: () => Date.parse('2026-08-07T10:01:00.000Z'),
    randomUuid: () => IDEMPOTENCY_KEY,
    randomReviewId: () => REVIEW_ID,
    fetchImpl: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/p2p/my/eligible-assets')) {
        return jsonResponse({ assets: [eligibleAsset()] });
      }
      if (url.endsWith('/p2p/listing-intents')) {
        assert.equal(init.method, 'POST');
        assert.equal((init.headers as Record<string, string>)['Idempotency-Key'], IDEMPOTENCY_KEY);
        assert.deepEqual(JSON.parse(String(init.body)), {
          action: 'create',
          operationalAssetId: 'inventory-item-42',
          assetRevision: ASSET_REVISION,
          priceMinor: 12_345,
          currency: 'USD',
          termsVersion: P2P_LISTING_TERMS_VERSION,
        });
        return jsonResponse({
          intentId: '42eb5878-3b9d-4b0b-9cb7-43dadcab6890',
          action: 'create',
          idempotencyKey: IDEMPOTENCY_KEY,
          termsVersion: P2P_LISTING_TERMS_VERSION,
          operationalAssetId: 'inventory-item-42',
          listingId: null,
          assetRevision: ASSET_REVISION,
          marketHashName: 'AK-47 | Redline (Field-Tested)',
          priceMinor: 12_345,
          currency: 'USD',
          expiresAt: '2026-08-07T10:03:00.000Z',
          replay: false,
        });
      }
      if (url.endsWith('/p2p/listings')) {
        assert.equal(init.method, 'POST');
        assert.equal((init.headers as Record<string, string>)['Idempotency-Key'], IDEMPOTENCY_KEY);
        assert.deepEqual(JSON.parse(String(init.body)), {
          intentId: '42eb5878-3b9d-4b0b-9cb7-43dadcab6890',
          termsVersion: P2P_LISTING_TERMS_VERSION,
          operationalAssetId: 'inventory-item-42',
          listingId: null,
          assetRevision: ASSET_REVISION,
          priceMinor: 12_345,
          currency: 'USD',
        });
        return jsonResponse({ id: 'listing-42' });
      }
      return jsonResponse({ error: 'unexpected request' }, 500);
    },
  });

  const review = await controller.prepare({
    action: 'create',
    operationalAssetId: 'inventory-item-42',
    assetRevision: ASSET_REVISION,
    priceMinor: 12_345,
  });
  assert.equal(review.reviewId, REVIEW_ID);
  assert.equal(review.expiresAt, Date.parse('2026-08-07T10:03:00.000Z'));

  const result = await controller.confirm(REVIEW_ID);
  assert.deepEqual(result, { success: true, action: 'create', listingId: 'listing-42' });
  assert.equal(calls.length, 3);
  assert.equal(calls.every(({ init }) => init.credentials === 'include'), true);
  assert.equal(calls.every(({ init }) => init.redirect === 'error'), true);
  assert.equal(calls.every(({ init }) => {
    const headers = init.headers as Record<string, string>;
    return !('Authorization' in headers) && !('X-Device-Id' in headers);
  }), true);
  await assert.rejects(controller.confirm(REVIEW_ID), /P2P_REVIEW_NOT_FOUND/);
});

test('P2P review fails closed when backend changes any reviewed field', async () => {
  const controller = new P2PListingController({
    apiBase: async () => API_BASE,
    now: () => Date.parse('2026-08-07T10:01:00.000Z'),
    randomUuid: () => IDEMPOTENCY_KEY,
    randomReviewId: () => REVIEW_ID,
    fetchImpl: async (input) => String(input).endsWith('/p2p/my/eligible-assets')
      ? jsonResponse({ assets: [eligibleAsset()] })
      : jsonResponse({
        intentId: '42eb5878-3b9d-4b0b-9cb7-43dadcab6890',
        action: 'create',
        idempotencyKey: IDEMPOTENCY_KEY,
        termsVersion: P2P_LISTING_TERMS_VERSION,
        operationalAssetId: 'inventory-item-42',
        listingId: null,
        assetRevision: ASSET_REVISION,
        marketHashName: 'AK-47 | Redline (Field-Tested)',
        priceMinor: 12_344,
        currency: 'USD',
        expiresAt: '2026-08-07T10:03:00.000Z',
        replay: false,
      }),
  });

  await assert.rejects(controller.prepare({
    action: 'create',
    operationalAssetId: 'inventory-item-42',
    assetRevision: ASSET_REVISION,
    priceMinor: 12_345,
  }), /P2P_REVIEW_BINDING_MISMATCH/);
  await assert.rejects(controller.confirm(REVIEW_ID), /P2P_REVIEW_NOT_FOUND/);
});

test('P2P review is memory-only, expires within two minutes, and cannot be confirmed twice', async () => {
  let now = Date.parse('2026-08-07T10:01:00.000Z');
  let commitCalls = 0;
  const controller = new P2PListingController({
    apiBase: async () => API_BASE,
    now: () => now,
    randomUuid: () => IDEMPOTENCY_KEY,
    randomReviewId: () => REVIEW_ID,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/p2p/my/eligible-assets')) {
        return jsonResponse({ assets: [eligibleAsset()] });
      }
      if (url.endsWith('/p2p/listing-intents')) {
        return jsonResponse({
          intentId: '42eb5878-3b9d-4b0b-9cb7-43dadcab6890',
          action: 'create',
          idempotencyKey: IDEMPOTENCY_KEY,
          termsVersion: P2P_LISTING_TERMS_VERSION,
          operationalAssetId: 'inventory-item-42',
          listingId: null,
          assetRevision: ASSET_REVISION,
          marketHashName: 'AK-47 | Redline (Field-Tested)',
          priceMinor: 1_000,
          currency: 'USD',
          expiresAt: '2026-08-07T11:00:00.000Z',
          replay: false,
        });
      }
      commitCalls += 1;
      return jsonResponse({ id: 'listing-42' });
    },
  });

  const review = await controller.prepare({
    action: 'create',
    operationalAssetId: 'inventory-item-42',
    assetRevision: ASSET_REVISION,
    priceMinor: 1_000,
  });
  assert.equal(review.expiresAt, Date.parse('2026-08-07T10:03:00.000Z'));

  now = review.expiresAt + 1;
  await assert.rejects(controller.confirm(REVIEW_ID), /P2P_REVIEW_EXPIRED/);
  assert.equal(commitCalls, 0);
});

test('unpublish confirmation uses the reviewed listing path and canonical response terms', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const controller = new P2PListingController({
    apiBase: async () => API_BASE,
    now: () => Date.parse('2026-08-07T10:01:00.000Z'),
    randomUuid: () => IDEMPOTENCY_KEY,
    randomReviewId: () => REVIEW_ID,
    fetchImpl: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/p2p/my/eligible-assets')) {
        return jsonResponse({ assets: [eligibleAsset({
          eligibility: false,
          reasons: [{ code: 'already_listed', message: 'Asset already listed' }],
          listingId: 'listing-42',
          listingState: 'active',
        })] });
      }
      if (url.endsWith('/p2p/listing-intents')) {
        assert.deepEqual(JSON.parse(String(init.body)), {
          action: 'unpublish',
          operationalAssetId: 'inventory-item-42',
          listingId: 'listing-42',
          assetRevision: ASSET_REVISION,
          termsVersion: P2P_LISTING_TERMS_VERSION,
        });
        return jsonResponse({
          intentId: '42eb5878-3b9d-4b0b-9cb7-43dadcab6890',
          action: 'unpublish',
          idempotencyKey: IDEMPOTENCY_KEY,
          termsVersion: P2P_LISTING_TERMS_VERSION,
          operationalAssetId: 'inventory-item-42',
          listingId: 'listing-42',
          assetRevision: ASSET_REVISION,
          marketHashName: 'AK-47 | Redline (Field-Tested)',
          priceMinor: 9_999,
          currency: 'USD',
          expiresAt: '2026-08-07T10:03:00.000Z',
          replay: false,
        });
      }
      assert.equal(url, `${API_BASE}/p2p/listings/listing-42`);
      assert.equal(init.method, 'DELETE');
      return jsonResponse({ success: true, listingId: 'listing-42' });
    },
  });

  const review = await controller.prepare({
    action: 'unpublish',
    operationalAssetId: 'inventory-item-42',
    assetRevision: ASSET_REVISION,
    listingId: 'listing-42',
  });
  const result = await controller.confirm(review.reviewId);
  assert.deepEqual(result, { success: true, action: 'unpublish', listingId: 'listing-42' });
  assert.equal(calls.length, 3);
});

test('assets without a complete snapshot remain visible but cannot be reviewed for publish', async () => {
  let intentCalls = 0;
  const controller = new P2PListingController({
    apiBase: async () => API_BASE,
    now: () => Date.parse('2026-08-07T10:01:00.000Z'),
    randomUuid: () => IDEMPOTENCY_KEY,
    randomReviewId: () => REVIEW_ID,
    fetchImpl: async (input) => {
      if (String(input).endsWith('/p2p/my/eligible-assets')) {
        return jsonResponse({ assets: [eligibleAsset({
          eligibility: false,
          reasons: [{ code: 'snapshot_missing', message: 'Complete snapshot required' }],
          snapshotCompletedAt: null,
        })] });
      }
      intentCalls += 1;
      return jsonResponse({ error: 'unexpected request' }, 500);
    },
  });

  const assets = await controller.listEligibleAssets();
  assert.equal(assets[0]?.snapshotCompletedAt, null);
  assert.equal(assets[0]?.eligibility, false);
  await assert.rejects(controller.prepare({
    action: 'create',
    operationalAssetId: 'inventory-item-42',
    assetRevision: ASSET_REVISION,
    priceMinor: 1_000,
  }), /P2P_ASSET_INELIGIBLE/);
  assert.equal(intentCalls, 0);
});

test('transport and 5xx commit ambiguity retain the exact review and idempotency binding', async () => {
  for (const firstFailure of ['transport', 'server'] as const) {
    let commitCalls = 0;
    const commitKeys: string[] = [];
    const controller = new P2PListingController({
      apiBase: async () => API_BASE,
      now: () => Date.parse('2026-08-07T10:01:00.000Z'),
      randomUuid: () => IDEMPOTENCY_KEY,
      randomReviewId: () => REVIEW_ID,
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith('/p2p/my/eligible-assets')) {
          return jsonResponse({ assets: [eligibleAsset()] });
        }
        if (url.endsWith('/p2p/listing-intents')) {
          return jsonResponse({
            intentId: '42eb5878-3b9d-4b0b-9cb7-43dadcab6890',
            action: 'create',
            idempotencyKey: IDEMPOTENCY_KEY,
            termsVersion: P2P_LISTING_TERMS_VERSION,
            operationalAssetId: 'inventory-item-42',
            listingId: null,
            assetRevision: ASSET_REVISION,
            marketHashName: 'AK-47 | Redline (Field-Tested)',
            priceMinor: 1_000,
            currency: 'USD',
            expiresAt: '2026-08-07T10:03:00.000Z',
            replay: false,
          });
        }
        commitCalls += 1;
        commitKeys.push((init.headers as Record<string, string>)['Idempotency-Key'] ?? '');
        if (commitCalls === 1) {
          if (firstFailure === 'transport') {
            throw new TypeError('transport reset after possible commit');
          }
          return jsonResponse({ code: 'temporarily_unavailable' }, 503);
        }
        return jsonResponse({ id: 'listing-42' });
      },
    });

    const review = await controller.prepare({
      action: 'create',
      operationalAssetId: 'inventory-item-42',
      assetRevision: ASSET_REVISION,
      priceMinor: 1_000,
    });
    await assert.rejects(controller.confirm(review.reviewId), /P2P_BACKEND_UNAVAILABLE/);
    assert.deepEqual(await controller.confirm(review.reviewId), {
      success: true,
      action: 'create',
      listingId: 'listing-42',
    });
    assert.deepEqual(commitKeys, [IDEMPOTENCY_KEY, IDEMPOTENCY_KEY]);
    await assert.rejects(controller.confirm(review.reviewId), /P2P_REVIEW_NOT_FOUND/);
  }
});

test('concurrent confirm calls share one in-flight commit and terminal 4xx clears the review', async () => {
  let commitCalls = 0;
  let releaseCommit: (() => void) | null = null;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const controller = new P2PListingController({
    apiBase: async () => API_BASE,
    now: () => Date.parse('2026-08-07T10:01:00.000Z'),
    randomUuid: () => IDEMPOTENCY_KEY,
    randomReviewId: () => REVIEW_ID,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/p2p/my/eligible-assets')) {
        return jsonResponse({ assets: [eligibleAsset()] });
      }
      if (url.endsWith('/p2p/listing-intents')) {
        return jsonResponse({
          intentId: '42eb5878-3b9d-4b0b-9cb7-43dadcab6890',
          action: 'create',
          idempotencyKey: IDEMPOTENCY_KEY,
          termsVersion: P2P_LISTING_TERMS_VERSION,
          operationalAssetId: 'inventory-item-42',
          listingId: null,
          assetRevision: ASSET_REVISION,
          marketHashName: 'AK-47 | Redline (Field-Tested)',
          priceMinor: 1_000,
          currency: 'USD',
          expiresAt: '2026-08-07T10:03:00.000Z',
          replay: false,
        });
      }
      commitCalls += 1;
      await commitGate;
      return jsonResponse({ code: 'intent_mismatch' }, 409);
    },
  });

  const review = await controller.prepare({
    action: 'create',
    operationalAssetId: 'inventory-item-42',
    assetRevision: ASSET_REVISION,
    priceMinor: 1_000,
  });
  const first = controller.confirm(review.reviewId);
  const second = controller.confirm(review.reviewId);
  assert.equal(first, second);
  releaseCommit?.();
  await assert.rejects(first, /P2P_REVIEW_STALE/);
  assert.equal(commitCalls, 1);
  await assert.rejects(controller.confirm(review.reviewId), /P2P_REVIEW_NOT_FOUND/);
});

test('external status router rejects P2P publish, unpublish, buy and Steam-action messages', () => {
  for (const type of [
    'GET_P2P_ELIGIBLE_ASSETS',
    'PREPARE_P2P_LISTING',
    'CONFIRM_P2P_LISTING',
    'P2P_BUY',
    'CREATE_STEAM_TRADE',
  ]) {
    const response = dispatchExternalStatus({
      version: 1,
      type,
      requestId: `request_${type}`,
      payload: {},
    }, 'https://csboard.com', {
      allowedOrigins: new Set(['https://csboard.com']),
      extensionVersion: '1.1.0',
    });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'INVALID_MESSAGE');
  }
});
