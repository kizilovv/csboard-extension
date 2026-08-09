import assert from 'node:assert/strict';
import test from 'node:test';

test('the wear badge survives an item that carries no Steam tags', async () => {
  // The normalized trade-offer read returns a clean DTO with no tag list, and
  // the badge quietly vanished from every offer when that path replaced the raw
  // Steam description. The wear is spelled out in the market hash name, so
  // there is no reason to lose it.
  const { getExteriorShort } = await import('../src/shared/items.ts');

  const cases: Array<[string, string | null]> = [
    ['AK-47 | Redline (Field-Tested)', 'FT'],
    ['★ Nomad Knife | Safari Mesh (Well-Worn)', 'WW'],
    ['StatTrak™ M4A1-S | Printstream (Factory New)', 'FN'],
    ['Souvenir AWP | Dragon Lore (Minimal Wear)', 'MW'],
    ['Glock-18 | Fade (Battle-Scarred)', 'BS'],
    ['Fracture Case', null],
    ['Sticker | Reason Gaming (Holo) | Katowice 2014', null],
  ];
  for (const [name, expected] of cases) {
    assert.equal(getExteriorShort(undefined, name), expected, name);
  }
});

test('a real Steam tag still wins over the name', async () => {
  const { getExteriorShort } = await import('../src/shared/items.ts');
  const tags = [{ category: 'Exterior', localized_tag_name: 'Battle-Scarred' }];
  assert.equal(getExteriorShort(tags, 'AK-47 | Redline (Field-Tested)'), 'BS');
});
