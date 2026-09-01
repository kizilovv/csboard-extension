import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getBuffLink } from '../src/shared/items.ts';
import {
  assetIdFromInventoryElementId,
  resolveInventoryLookupItem,
} from '../src/shared/inventory-lookup.ts';

const v2InspectHref =
  'steam://run/730//+csgo_econ_action_preview%2046568088BD8F81475E5E66924F6E4376427ECEFD90B34506D5422EC5C6C6C64A364E1CA986E6';

test('inventory resolves the active Steam asset when a v2 inspect URL has no A<assetid> token', () => {
  const selectedItem = {
    appid: '730',
    contextid: '16',
    assetid: '53573773126',
    name: 'AK-47 | Redline',
    market_hash_name: 'AK-47 | Redline (Field-Tested)',
  };

  assert.equal(assetIdFromInventoryElementId('730_16_53573773126'), '53573773126');
  assert.equal(assetIdFromInventoryElementId('570_2_53573773126'), undefined);

  const resolved = resolveInventoryLookupItem(
    [selectedItem],
    'AK-47 | Redline',
    v2InspectHref,
    '730_16_53573773126',
  );

  assert.equal(resolved, selectedItem);
  assert.equal(
    getBuffLink(resolved!.market_hash_name),
    'https://buff.163.com/goods/33960',
  );
});

test('inventory keeps the generic fallback when neither inspect nor active Steam item identifies an asset', () => {
  const sameName = [
    { assetid: '1', name: '★ Bayonet | Doppler', market_hash_name: '★ Bayonet | Doppler (Factory New)' },
    { assetid: '2', name: '★ Bayonet | Doppler', market_hash_name: '★ Bayonet | Doppler (Minimal Wear)' },
  ];

  assert.equal(
    resolveInventoryLookupItem(sameName, '★ Bayonet | Doppler', v2InspectHref, undefined),
    undefined,
  );
});

test('inventory wires the activeInfo asset fallback into marketplace actions', () => {
  const source = readFileSync(
    new URL('../src/content-scripts/steam/inventory.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /\.item\.app730\.activeInfo\[id\]/);
  assert.match(source, /resolveInventoryLookupItem\(/);
});
