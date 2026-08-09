import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildP2PAssetOption,
  p2pAssetOptionsMatch,
} from '../src/popup/p2p-view-model.ts';
import type { P2PEligibleAsset } from '../src/popup/contracts.ts';

const BASE_ASSET: P2PEligibleAsset = {
  operationalAssetId: 'asset-42',
  assetRevision: `sha256:${'a'.repeat(64)}`,
  marketHashName: 'AK-47 | Redline (Field-Tested)',
  contextId: '2',
  eligibility: true,
  reasons: [],
  listingId: null,
  listingState: null,
  currency: 'USD',
  snapshotCompletedAt: '2026-08-07T10:00:00.000Z',
};

test('P2P option refresh detects listing-state and label changes for the same asset ID', () => {
  const before = buildP2PAssetOption(BASE_ASSET);
  const listed = buildP2PAssetOption({
    ...BASE_ASSET,
    eligibility: false,
    reasons: [{ code: 'already_listed', message: 'Asset already listed' }],
    listingId: 'listing-42',
    listingState: 'active',
  });

  assert.deepEqual(before, {
    value: 'asset-42',
    label: 'AK-47 | Redline (Field-Tested)',
  });
  assert.deepEqual(listed, {
    value: 'asset-42',
    label: '[Listed] AK-47 | Redline (Field-Tested)',
  });
  assert.equal(p2pAssetOptionsMatch([before], [listed]), false);
  assert.equal(p2pAssetOptionsMatch([listed], [listed]), true);
});

test('P2P option labels mark ineligible unlisted assets as blocked', () => {
  assert.equal(buildP2PAssetOption({
    ...BASE_ASSET,
    eligibility: false,
    reasons: [{ code: 'on_hold', message: 'Asset is on hold' }],
  }).label, '[Blocked] AK-47 | Redline (Field-Tested)');
});
