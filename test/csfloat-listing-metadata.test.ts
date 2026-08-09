import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildListingMetadataView,
  formatCsfloatRelativeTime,
  parseCsfloatTimestamp,
} from '../src/shared/csfloat-listing-metadata';

const NOW = Date.parse('2026-08-08T12:00:00.000Z');

test('CSFloat relative listing time keeps BetterFloat-compatible minute/hour/day boundaries', () => {
  assert.equal(formatCsfloatRelativeTime(new Date(NOW - 119 * 60_000), NOW), '119min ago');
  assert.equal(formatCsfloatRelativeTime(new Date(NOW - 120 * 60_000), NOW), '2h ago');
  assert.equal(formatCsfloatRelativeTime(new Date(NOW - 48 * 60 * 60_000), NOW), '48h ago');
  assert.equal(formatCsfloatRelativeTime(new Date(NOW - 49 * 60 * 60_000), NOW), '2d ago');
});

test('CSFloat timestamp parsing rejects missing and malformed intercepted values', () => {
  assert.equal(parseCsfloatTimestamp(undefined), null);
  assert.equal(parseCsfloatTimestamp(''), null);
  assert.equal(parseCsfloatTimestamp('not-a-date'), null);
  assert.equal(parseCsfloatTimestamp('2026-08-08T11:00:00.000Z')?.toISOString(), '2026-08-08T11:00:00.000Z');
});

test('listed metadata differs for detail and grid while preserving the exact intercepted timestamp', () => {
  const grid = buildListingMetadataView({
    createdAt: '2026-08-08T11:00:00.000Z',
    state: 'listed',
    detail: false,
    nowMs: NOW,
  });
  const detail = buildListingMetadataView({
    createdAt: '2026-08-08T11:00:00.000Z',
    state: 'listed',
    detail: true,
    nowMs: NOW,
  });

  assert.equal(grid.listed?.label, '60min ago');
  assert.equal(detail.listed?.label, 'Listed 60min ago');
  assert.match(detail.listed?.title ?? '', /^Listed at /);
  assert.equal(detail.sold, null);
});

test('sold metadata is emitted only for sold listings with a valid sold_at timestamp', () => {
  const sold = buildListingMetadataView({
    createdAt: '2026-08-01T11:00:00.000Z',
    soldAt: '2026-08-08T10:00:00.000Z',
    state: 'sold',
    detail: true,
    nowMs: NOW,
  });
  const merelyListed = buildListingMetadataView({
    createdAt: '2026-08-01T11:00:00.000Z',
    soldAt: '2026-08-08T10:00:00.000Z',
    state: 'listed',
    detail: true,
    nowMs: NOW,
  });

  assert.match(sold.sold?.label ?? '', /^Sold 2h ago \(.+\)$/);
  assert.match(sold.sold?.title ?? '', /^Sold at /);
  assert.equal(merelyListed.sold, null);
});
