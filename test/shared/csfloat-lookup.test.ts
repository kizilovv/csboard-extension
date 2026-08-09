import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCsfloatSearchUrl,
  type CsfloatLookupItem,
  type CsfloatLookupOptions,
} from '../../src/shared/csfloat-lookup.ts';

const query = (item: CsfloatLookupItem, options?: CsfloatLookupOptions) => {
  const url = new URL(buildCsfloatSearchUrl(item, options));
  assert.equal(url.origin, 'https://csfloat.com');
  assert.equal(url.pathname, '/search');
  return url.searchParams;
};

test('builds the required StatTrak comparable search with exact paint identity', () => {
  const params = query({
    marketHashName: 'StatTrak™ Kukri Knife | Printstream (Field-Tested)',
    defIndex: 515,
    paintIndex: 1115,
    isStatTrak: true,
  });

  assert.deepEqual(Object.fromEntries(params), {
    category: '2',
    sort_by: 'lowest_price',
    min_float: '0.15',
    max_float: '0.38',
    type: 'buy_now',
    def_index: '515',
    paint_index: '1115',
  });
});

test('maps normal, StatTrak and Souvenir painted items to categories 1, 2 and 3', () => {
  const base = 'M4A1-S | Master Piece (Field-Tested)';
  assert.equal(query({ marketHashName: base }).get('category'), '1');
  assert.equal(query({ marketHashName: `StatTrak™ ${base}` }).get('category'), '2');
  assert.equal(query({ marketHashName: `Souvenir ${base}`, isStatTrak: true }).get('category'), '3');
});

test('ceil-to-hundredth narrows only the selected Field-Tested glove asset', () => {
  const base = {
    marketHashName: '★ Sport Gloves | Slingshot (Field-Tested)',
    defIndex: 5030,
    paintIndex: 10073,
    isGlove: true,
  };

  const first = query({ ...base, assetId: '1', floatValue: 0.2112 });
  const second = query({ ...base, assetId: '2', floatValue: 0.2871 });
  assert.equal(first.get('min_float'), '0.15');
  assert.equal(first.get('max_float'), '0.22');
  assert.equal(second.get('max_float'), '0.29');
});

test('does not narrow an ordinary painted weapon even when its exact float is known', () => {
  const params = query({
    marketHashName: 'AK-47 | Redline (Field-Tested)',
    floatValue: 0.2112,
  });
  assert.equal(params.get('min_float'), '0.15');
  assert.equal(params.get('max_float'), '0.38');
});

test('caps knife/glove narrowing at wear boundaries and guards the lower boundary', () => {
  const minimalWear = query({
    marketHashName: '★ M9 Bayonet | Doppler (Minimal Wear)',
    isKnife: true,
    floatValue: 0.14999,
  });
  assert.equal(minimalWear.get('max_float'), '0.15');

  const factoryNewZero = query({
    marketHashName: '★ Karambit | Fade (Factory New)',
    isKnife: true,
    floatValue: 0,
  });
  assert.equal(factoryNewZero.get('min_float'), '0');
  assert.equal(factoryNewZero.get('max_float'), '0.01');
});

test('falls back to the full wear range for invalid or contradictory exact floats', () => {
  for (const floatValue of [Number.NaN, -0.1, 1.1, 0.7]) {
    const params = query({
      marketHashName: '★ Hand Wraps | Slaughter (Field-Tested)',
      floatValue,
    });
    assert.equal(params.get('min_float'), '0.15');
    assert.equal(params.get('max_float'), '0.38');
  }
});

test('does not invent painted category or float filters for commodities', () => {
  for (const marketHashName of ['CS:GO Weapon Case', 'Sticker | Crown (Foil)']) {
    const params = query({ marketHashName });
    assert.equal(params.has('category'), false);
    assert.equal(params.has('min_float'), false);
    assert.equal(params.has('max_float'), false);
    assert.equal(params.get('sort_by'), 'lowest_price');
    assert.equal(params.get('type'), 'buy_now');
    assert.equal(params.get('market_hash_name'), marketHashName);
  }
});

test('uses both identity indices or neither and keeps Doppler phase in name fallback', () => {
  const params = query({
    marketHashName: '★ Karambit | Doppler (Factory New)',
    defIndex: 507,
    paintIndex: null,
    dopplerPhase: 'Phase 2',
  });
  assert.equal(params.has('def_index'), false);
  assert.equal(params.has('paint_index'), false);
  assert.equal(
    params.get('market_hash_name'),
    '★ Karambit | Doppler (Factory New) [Phase 2]',
  );
});

test('classifies a glove from Steam type/tags before conservative name fallback', () => {
  const params = query({
    marketHashName: '★ Specialist Item | Crimson Web (Field-Tested)',
    itemType: 'Extraordinary Gloves',
    tags: [{ category: 'Type', localized_tag_name: 'Gloves' }],
    floatValue: 0.2112,
  });
  assert.equal(params.get('category'), '1');
  assert.equal(params.get('max_float'), '0.22');
});

test('generic mode is an explicit name-only fallback', () => {
  const params = query(
    {
      marketHashName: 'AK-47 | Redline (Field-Tested)',
      defIndex: 7,
      paintIndex: 282,
      floatValue: 0.2,
    },
    { mode: 'generic' },
  );
  assert.deepEqual(Object.fromEntries(params), {
    market_hash_name: 'AK-47 | Redline (Field-Tested)',
  });
});
