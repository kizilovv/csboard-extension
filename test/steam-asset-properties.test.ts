import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { generateHex } from '@csfloat/cs2-inspect-serializer';

import { parseSteamAssetProperties } from '../src/shared/steam-asset-properties.ts';

test('Steam asset properties preserve an exact direct float, including zero', () => {
  assert.deepEqual(parseSteamAssetProperties([
    { propertyid: 1, int_value: 0 },
    { propertyid: 2, float_value: 0 },
  ]), {
    floatValue: 0,
    paintSeed: 0,
    defIndex: undefined,
    paintIndex: undefined,
  });
});

test('Steam inspect certificate recovers owner-side float metadata', () => {
  const certificate = generateHex({
    itemid: 123456789n,
    defindex: 7,
    paintindex: 474,
    paintseed: 306,
    paintwear: 0.6336590647697449,
    stickers: [],
    keychains: [],
    variations: [],
  });

  const parsed = parseSteamAssetProperties({
    certificate: { propertyid: 6, string_value: certificate },
  });

  assert.ok(parsed.floatValue !== undefined);
  assert.ok(Math.abs(parsed.floatValue - 0.6336590647697449) < 1e-7);
  assert.equal(parsed.paintSeed, 306);
  assert.equal(parsed.defIndex, 7);
  assert.equal(parsed.paintIndex, 474);
});

test('Steam asset properties accept nested wrapper objects', () => {
  assert.deepEqual(parseSteamAssetProperties({
    assetid: '333',
    asset_properties: {
      seed: { propertyid: '1', int_value: '306' },
      float: { propertyid: '2', float_value: '0.53009' },
    },
  }), {
    floatValue: 0.53009,
    paintSeed: 306,
    defIndex: undefined,
    paintIndex: undefined,
  });
});

test('direct Steam float properties win over certificate fallbacks', () => {
  const certificate = generateHex({
    itemid: 123456789n,
    defindex: 7,
    paintindex: 474,
    paintseed: 306,
    paintwear: 0.63,
    stickers: [],
    keychains: [],
    variations: [],
  });

  const parsed = parseSteamAssetProperties([
    { propertyid: 1, int_value: 42 },
    { propertyid: 2, float_value: 0.123456789 },
    { propertyid: 6, string_value: certificate },
  ]);

  assert.equal(parsed.floatValue, 0.123456789);
  assert.equal(parsed.paintSeed, 42);
  assert.equal(parsed.defIndex, 7);
  assert.equal(parsed.paintIndex, 474);
});

test('malformed certificates and out-of-range floats are ignored safely', () => {
  assert.deepEqual(parseSteamAssetProperties([
    { propertyid: 2, float_value: 1.5 },
    { propertyid: 6, string_value: 'not-hex' },
  ]), {
    floatValue: undefined,
    paintSeed: undefined,
    defIndex: undefined,
    paintIndex: undefined,
  });
});

test('trade-offer owner inventory keeps both Steam property sources and certificate data', () => {
  const source = readFileSync(
    new URL('../src/content-scripts/steam/trade-offer.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /inventory\.rgInventory\[asset\.assetid\]/);
  assert.match(source, /var rawProp = asset\.asset_properties/);
  assert.match(source, /rawProp = inventoryAsset && inventoryAsset\.asset_properties/);
  assert.match(source, /rawProp = assetProps\[asset\.assetid\]/);
  assert.match(source, /string_value:p\.string_value\?\?null/);
  assert.match(source, /parseSteamAssetProperties\(item\.properties\)/);
  assert.match(source, /Number\.isFinite\(exactFloat\)/);
  assert.doesNotMatch(source, /if \(item\.floatInfo\?\.floatvalue\)/);
});
