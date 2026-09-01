import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCsfolderInspectUrl,
  canonicalAccessoryMarketName,
} from '../src/shared/inspect-actions.ts';

const inspectLink =
  'steam://run/730//+csgo_econ_action_preview%207C6CF88390E2D17D64655C1C547D4C7844BE8B98897F3C8578145B0C64904061B1';

test('builds one shareable RU CSFolder path and preserves the complete inspect action', () => {
  const result = buildCsfolderInspectUrl(inspectLink);
  assert.ok(result);

  const url = new URL(result);
  assert.equal(url.origin, 'https://csfolder.com');
  assert.equal(url.pathname.startsWith('/ru/inspect/'), true);
  assert.equal(decodeURIComponent(url.pathname.slice('/ru/inspect/'.length)), inspectLink);
});

test('refuses non-CS2 actions instead of creating a paid screenshot link', () => {
  assert.equal(buildCsfolderInspectUrl('https://example.com/skin'), null);
  assert.equal(buildCsfolderInspectUrl('steam://run/440//+inspect%20something'), null);
});

test('extracts the exact accessory market name without swallowing its scrape level', () => {
  assert.equal(
    canonicalAccessoryMarketName(
      'Sticker | Astralis (Gold) | Katowice 2019\nSticker Scrape Level: 0.143011615',
    ),
    'Sticker | Astralis (Gold) | Katowice 2019',
  );
  assert.equal(
    canonicalAccessoryMarketName(
      'Sticker | IEM (Gold) | Katowice 2019Sticker Scrape Level: 0.119022653',
    ),
    'Sticker | IEM (Gold) | Katowice 2019',
  );
  assert.equal(canonicalAccessoryMarketName('The Overpass Collection'), null);
});
