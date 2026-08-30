import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertPairingCode } from '../src/shared/gateway-dto.js';

const popupHtml = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
const popupSource = readFileSync(new URL('../src/popup/popup.ts', import.meta.url), 'utf8');

test('portfolio pairing UI sends the user to CSFolder, and never asks for a code', () => {
  assert.match(popupHtml, /Secure CSFolder portfolio sync/);
  assert.match(popupHtml, /https:\/\/csfolder\.com\/portfolio\?/);
  assert.match(popupSource, /Unpair this browser from CSFolder\?/);

  /*
    The code field is gone, and staying gone is the assertion now.

    It asked the user to fetch a 5-minute string from CSFolder and retype it
    into a browser popup, for a handshake the website performs in one click.
    This used to check the field named CSFolder rather than CSBOARD as the
    authority for that code; with no field there is no authority to name, and
    what matters is that nothing here invites a code again.
  */
  assert.doesNotMatch(popupHtml, /pairing-code-input/);
  assert.doesNotMatch(popupHtml, /Enter code from/);
  assert.doesNotMatch(popupSource, /pairing-code-input/);
  assert.doesNotMatch(popupHtml, /Enter code from CSBOARD/);
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
