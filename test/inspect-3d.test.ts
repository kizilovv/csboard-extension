import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { cs2InspectToken } from '../src/shared/inspect-actions.ts';
import { INSPECT_3D_PAGE, buildInspect3dHref } from '../src/shared/inspect-3d.ts';

const PAGE_URL = `chrome-extension://abc/${INSPECT_3D_PAGE}`;
const CERTIFICATE = 'D2C2076F5F1D15D3CAD5F248D0FAD7E2D6EA332F4D26D1922AD0B0DDDAD2C232';
const HEX_LINK = `steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20${CERTIFICATE}`;

test('The inspect token is taken from both the encoded and the spaced link form', () => {
  assert.equal(cs2InspectToken(HEX_LINK), CERTIFICATE);
  assert.equal(
    cs2InspectToken(`steam://rungame/730/76561202255233023/+csgo_econ_action_preview S76561199418447383A53604992376D1234567890123456`),
    'S76561199418447383A53604992376D1234567890123456',
  );
});

test('Anything that is not a Steam inspect link yields no token', () => {
  for (const candidate of [
    '',
    'https://evil.example/steal',
    'steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20javascript:alert(1)',
    'steam://openurl/https://evil.example',
  ]) {
    assert.equal(cs2InspectToken(candidate), null, candidate);
  }
});

test('The viewer href carries only the token, so no URL crosses into the page', () => {
  const href = buildInspect3dHref(HEX_LINK, PAGE_URL);
  assert.equal(href, `${PAGE_URL}?token=${CERTIFICATE}`);
  assert.ok(!href!.includes('steam://'));
});

test('A rejected inspect link opens nothing', () => {
  assert.equal(buildInspect3dHref('https://evil.example/', PAGE_URL), null);
});

test('The viewer page is web accessible to Steam, or the modal frames a 404', () => {
  const manifest = JSON.parse(readFileSync('src/manifest.json', 'utf8'));
  const steamEntry = manifest.web_accessible_resources.find(
    (entry: { matches: string[] }) => entry.matches.includes('*://steamcommunity.com/*'),
  );
  assert.ok(steamEntry, 'no web_accessible_resources entry covers steamcommunity.com');
  assert.ok(steamEntry.resources.includes(INSPECT_3D_PAGE));
});

test('The viewer page re-validates the token it is handed', () => {
  const pageScript = readFileSync('src/pages/inspect-3d.js', 'utf8');
  assert.match(pageScript, /TOKEN_RE\s*=/);
  assert.match(pageScript, /TOKEN_RE\.test\(token\)/);
});
