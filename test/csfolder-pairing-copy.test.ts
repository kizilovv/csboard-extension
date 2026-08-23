import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertPairingCode } from '../src/shared/gateway-dto.js';

const popupHtml = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
const popupSource = readFileSync(new URL('../src/popup/popup.ts', import.meta.url), 'utf8');

test('portfolio pairing UI names CSFolder as the one-time-code authority', () => {
  assert.match(popupHtml, /Secure CSFolder portfolio sync/);
  assert.match(popupHtml, /Enter code from CSFolder/);
  assert.doesNotMatch(popupHtml, /Enter code from CSBOARD/);

  assert.match(popupSource, /one-time code from CSFolder/);
  assert.match(popupSource, /Unpair this browser from CSFolder\?/);
  assert.match(popupSource, /\^CSF-\[2-9A-HJ-NP-Z\]/);
  assert.doesNotMatch(popupSource, /one-time code from CSBOARD/);
});

test('unpaired help CTA opens the CSFolder extension import tab directly', () => {
  const href = /<a class="text-button" href="([^"]+)"[^>]*>CSFolder portfolio<\/a>/
    .exec(popupHtml)?.[1];

  assert.equal(
    href,
    'https://csfolder.com/portfolio/import?tab=csboard-extension&amp;utm_source=csboard_extension&amp;utm_medium=pairing',
  );
});

test('gateway accepts only the exact CSFolder human-safe pairing-code contract', () => {
  assert.doesNotThrow(() => assertPairingCode('CSF-2345-6789-ABCD-EFGH'));

  for (const invalid of [
    'ABCDE',
    'CSB-2345-6789-ABCD-EFGH',
    'CSF-2345-6789-ABCD-EFGI',
    'CSF-2345-6789-ABCD-EFGO',
    'csf-2345-6789-abcd-efgh',
    'CSF-2345-6789-ABCD-EFGH-extra',
  ]) {
    assert.throws(() => assertPairingCode(invalid), /INVALID_PAYLOAD/);
  }
});
