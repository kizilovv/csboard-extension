import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const csfloatSource = readFileSync(
  new URL('../src/content-scripts/csfloat/csfloat.ts', import.meta.url),
  'utf8',
);
const inventorySource = readFileSync(
  new URL('../src/content-scripts/steam/inventory.ts', import.meta.url),
  'utf8',
);

test('CSFloat price panel is fail-closed and reacts to its persisted live toggle', () => {
  assert.match(csfloatSource, /let showCsboardPricesOnCsfloat = false;/);
  assert.match(csfloatSource, /changes\['csboard_settings'\]/);
  assert.match(
    csfloatSource,
    /if \(!csboardPanelSettingsReady \|\| !showCsboardPricesOnCsfloat\) return;/,
  );
  assert.match(
    csfloatSource,
    /document\.querySelectorAll\('\.csboard-panel'\)\.forEach\(\(panel\) => panel\.remove\(\)\);/,
  );
  assert.match(csfloatSource, /priceEngine\.reload\(\)/);
});

test('CSBOARD quote on CSFloat uses extension currency with explicit provenance', () => {
  const panelStart = csfloatSource.indexOf('function injectCsboardPanel');
  const panelEnd = csfloatSource.indexOf('// APP-SELL-DIALOG', panelStart);
  const panelSource = csfloatSource.slice(panelStart, panelEnd);

  assert.match(csfloatSource, /priceEngine\.getSettings\(\)\.currency\.toUpperCase\(\)/);
  assert.match(csfloatSource, /extensionExchangeRates\[currency\]/);
  assert.match(csfloatSource, /return null;\n  }\n\n  const converted/);
  assert.match(panelSource, /CSBOARD min ask · csgoskins\.gg ·/);
  assert.doesNotMatch(panelSource, /formatCsfPrice\(cbCents\)/);
});

test('CSFloat item detail lookup is canonical and asset/float keyed', () => {
  assert.match(csfloatSource, /buildCsfloatSearchUrl\(\{/);
  assert.match(csfloatSource, /dynamicFloatForGloves: true/);
  assert.match(csfloatSource, /Find comparable listings on CSFloat/);
  assert.match(csfloatSource, /listing\.item\.asset_id \?\? ''/);
  assert.match(csfloatSource, /Number\.isFinite\(listing\.item\.float_value\)/);
  assert.match(csfloatSource, /popupMatchesRoute/);
  assert.match(csfloatSource, /noopener noreferrer/);
});

test('CSFloat listing metadata uses intercepted created/sold timestamps only', () => {
  assert.match(csfloatSource, /created_at\?: string;/);
  assert.match(csfloatSource, /sold_at\?: string;/);
  assert.match(csfloatSource, /state\?: string;/);
  assert.match(csfloatSource, /function injectListingMetadata/);
  assert.match(csfloatSource, /buildListingMetadataView\(\{/);
  assert.match(csfloatSource, /createdAt: listing\.created_at/);
  assert.match(csfloatSource, /soldAt: listing\.sold_at/);
  assert.match(csfloatSource, /state: listing\.state/);
  assert.match(csfloatSource, /age\.textContent = metadata\.listed\.label/);
  assert.match(csfloatSource, /injectSoldStatus\(card, metadata\.sold\)/);
  assert.match(csfloatSource, /csboardOriginalLabel/);
  assert.match(csfloatSource, /csboardOriginalTitle/);
  assert.match(csfloatSource, /statusButton\.removeAttribute\('title'\)/);
  assert.match(csfloatSource, /resetListingMetadata\(card\)/);
  assert.doesNotMatch(csfloatSource, /fetch\([^)]*sold_at/);
});

test('inventory settings repaint keeps the merged context 2 + 16 asset view', () => {
  const settingsStart = inventorySource.indexOf('// 10. Listen for settings changes');
  const settingsEnd = inventorySource.indexOf('// 11. Add sorting function bar', settingsStart);
  const settingsSource = inventorySource.slice(settingsStart, settingsEnd);

  assert.match(settingsSource, /const rawItems = readAllContextItems\(\);/);
  assert.doesNotMatch(settingsSource, /getItemInfoFromPage\('730', '2'\)/);

  const mergeStart = inventorySource.indexOf('const readAllContextItems');
  const mergeEnd = inventorySource.indexOf('const onFullInventoryLoad', mergeStart);
  const mergeSource = inventorySource.slice(mergeStart, mergeEnd);
  assert.match(mergeSource, /getItemInfoFromPage\('730', '2'\)/);
  assert.match(mergeSource, /getItemInfoFromPage\('730', '16'\)/);
  assert.match(mergeSource, /const seen = new Set<string>\(\);/);
  assert.match(mergeSource, /const identity = `\$\{item\.appid \|\| '730'\}:\$\{item\.contextid\}:\$\{item\.assetid\}`;/);
  assert.match(mergeSource, /seen\.has\(identity\)/);
  assert.match(mergeSource, /seen\.add\(identity\)/);
});
