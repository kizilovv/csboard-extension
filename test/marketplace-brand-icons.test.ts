import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MARKETPLACE_BRAND_ICON_DATA_URLS } from '../src/shared/marketplace-brand-icons.ts';

const EXPECTED_ICONS = {
  buff: {
    sha256: '09d138e1e6ba00c4578c7a479b24d2965edb1a75581c21dc2df03da9680b8213',
    width: 32,
    height: 32,
  },
  csfloat: {
    sha256: '80045225ba283150380f459c8c8f4f2eec1102800670b7e43d13aee8ed14f1c2',
    width: 48,
    height: 48,
  },
  csboard: {
    sha256: '332457dcbb270f68a7d3d7acfe5d3357658f492d847b40d40f01733fe1879642',
    width: 48,
    height: 48,
  },
} as const;

test('marketplace actions embed the exact real BUFF, CSFloat, and CSBOARD PNG assets', () => {
  for (const [key, expected] of Object.entries(EXPECTED_ICONS)) {
    const dataUrl = MARKETPLACE_BRAND_ICON_DATA_URLS[
      key as keyof typeof MARKETPLACE_BRAND_ICON_DATA_URLS
    ];
    assert.match(dataUrl, /^data:image\/png;base64,/);
    const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(bytes.readUInt32BE(16), expected.width);
    assert.equal(bytes.readUInt32BE(20), expected.height);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
  }
});

test('inventory renders one real-logo row at the primary visible Steam anchor', () => {
  const source = readFileSync(
    new URL('../src/content-scripts/steam/inventory.ts', import.meta.url),
    'utf8',
  );
  const actionsStart = source.indexOf("const MARKETPLACE_ACTIONS_CLASS");
  const actionsEnd = source.indexOf('const setupItemClickListener');
  assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);
  const actionsSource = source.slice(actionsStart, actionsEnd);

  assert.match(source, /MARKETPLACE_BRAND_ICON_DATA_URLS/);
  assert.match(actionsSource, /document\.createElement\('img'\)/);
  assert.match(actionsSource, /logo\.src = MARKETPLACE_BRAND_ICON_DATA_URLS\[key\]/);
  assert.doesNotMatch(actionsSource, /<svg|MARKETPLACE_LOGOS/);
  assert.match(actionsSource, /const primaryAnchor = anchors\.find\(/);
  assert.doesNotMatch(actionsSource, /anchors\.forEach\(/);
  assert.match(
    actionsSource,
    /document\.querySelectorAll\(`\.\$\{MARKETPLACE_ACTIONS_CLASS\}`\)[\s\S]*?previousElementSibling !== primaryAnchor\.row[\s\S]*?\.remove\(\)/,
  );
});
