/*
  One toolbar icon, two things that want it: the sales count and the
  "no Steam login in this browser" warning (support case 2026-09-25).

  The rule under test: a sale wins the badge whenever there is one, the "!"
  shows only while the count is zero, and when the login comes back the count
  is put back without asking csboard again. `unknown` (never checked) is not a
  warning.
*/

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import {
  STEAM_SESSION_STATE_KEY,
  readSteamSessionState,
  writeSteamSessionState,
} from '../src/shared/steam-session-state.ts';

const local: Record<string, unknown> = {};
const session: Record<string, unknown> = {};
const painted = { text: '', color: '', title: '' };
let salesResponse: { status: number; body: unknown } = { status: 200, body: [] };

function area(store: Record<string, unknown>) {
  return {
    get: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (key in store) out[key] = store[key];
      return out;
    },
    set: async (values: Record<string, unknown>) => { Object.assign(store, values); },
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
  };
}

(globalThis as Record<string, unknown>)['chrome'] = {
  storage: { local: area(local), session: area(session) },
  runtime: {
    id: 'badge-test',
    getURL: (path: string) => `chrome-extension://badge-test/${path}`,
    getManifest: () => ({ version: '0.0.0-test' }),
  },
  i18n: { getUILanguage: () => 'en-US' },
  notifications: {
    create: async () => '',
    clear: async () => true,
    onClicked: { addListener() {} },
  },
  alarms: { create() {} },
  tabs: { create: async () => ({}) },
  action: {
    setBadgeText: async ({ text }: { text: string }) => { painted.text = text; },
    setBadgeBackgroundColor: async ({ color }: { color: string }) => { painted.color = color; },
    setBadgeTextColor: async () => {},
    setTitle: async ({ title }: { title: string }) => { painted.title = title; },
  },
};

globalThis.fetch = (async (input: string | URL) => {
  const url = String(input);
  if (url.includes('/p2p/my/sales')) {
    return new Response(JSON.stringify(salesResponse.body), {
      status: salesResponse.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // The csboard origin probe in shared/config.
  return new Response('', { status: 200 });
}) as typeof fetch;

// Imported after the mock: the module registers a notification listener on load.
let refreshSalesBadge: typeof import('../src/background/p2p-sales-badge.ts').refreshSalesBadge;
let repaintActionBadge: typeof import('../src/background/p2p-sales-badge.ts').repaintActionBadge;
before(async () => {
  ({ refreshSalesBadge, repaintActionBadge } = await import('../src/background/p2p-sales-badge.ts'));
});

function sales(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    orderId: `order-${index}`,
    itemName: `Item ${index}`,
  }));
}

test('an install that has never checked Steam shows no warning', async () => {
  assert.deepEqual(await readSteamSessionState(), { state: 'unknown', checkedAt: null });
  salesResponse = { status: 200, body: [] };
  await refreshSalesBadge();
  assert.equal(painted.text, '');
  assert.equal(painted.title, 'CSBOARD settings');
});

test('no Steam login and no sales: amber "!" with the login hint as the tooltip', async () => {
  await writeSteamSessionState('missing');
  await repaintActionBadge();
  assert.equal(painted.text, '!');
  assert.equal(painted.color, '#f5a623');
  assert.equal(painted.title, 'Log into Steam in this browser');
});

test('a sale wins the badge while the login is missing, and the tooltip keeps both', async () => {
  salesResponse = { status: 200, body: sales(2) };
  await refreshSalesBadge();
  assert.equal(painted.text, '2');
  assert.match(painted.title, /2 sales need you/);
  assert.match(painted.title, /Log into Steam in this browser/);
});

test('the login coming back restores the sales count without asking csboard', async () => {
  // csboard is unreachable now: the count must come from what was painted.
  salesResponse = { status: 401, body: {} };
  await writeSteamSessionState('ok');
  await repaintActionBadge();
  assert.equal(painted.text, '2');
  assert.doesNotMatch(painted.title, /Steam/);
});

test('a failed csboard read does not hide the warning or invent a count', async () => {
  salesResponse = { status: 200, body: [] };
  await refreshSalesBadge();
  assert.equal(painted.text, '');

  await writeSteamSessionState('missing');
  salesResponse = { status: 401, body: {} };
  assert.equal(await refreshSalesBadge(), 'signed_out');
  await repaintActionBadge();
  assert.equal(painted.text, '!');

  await writeSteamSessionState('ok');
  await repaintActionBadge();
  assert.equal(painted.text, '');
  assert.equal(painted.title, 'CSBOARD settings');
});

test('the tooltip follows the language chosen in the popup', async () => {
  local['csboard_ui_language'] = 'ru';
  await writeSteamSessionState('missing');
  await repaintActionBadge();
  assert.equal(painted.title, 'Войдите в Steam в этом браузере');
  delete local['csboard_ui_language'];
});

test('stored state that is not a verdict reads as unknown', async () => {
  local[STEAM_SESSION_STATE_KEY] = { state: 'maybe', checkedAt: 1 };
  assert.equal((await readSteamSessionState()).state, 'unknown');
  local[STEAM_SESSION_STATE_KEY] = 'missing';
  assert.equal((await readSteamSessionState()).state, 'unknown');
  await repaintActionBadge();
  assert.notEqual(painted.text, '!');
});

/*
  Where the state comes from, and who may read it.

  The tracking pass is the writer: it used to return on a missing login with a
  log line and nothing else, which is the whole incident. Only a real "signed
  out" is a warning — Steam not answering must leave the last verdict alone,
  or an offline laptop tells a signed-in seller to sign in.
*/
test('the tracking pass records the Steam login, and only a real sign-out warns', async () => {
  const { readFileSync } = await import('node:fs');
  const worker = readFileSync(new URL('../src/background/service-worker.ts', import.meta.url), 'utf8');
  assert.match(worker, /throw session\.ok \? new SteamSignedOutError\(\) : new Error\('STEAM_SESSION_REQUIRED'\);/);
  assert.match(worker, /if \(error instanceof SteamSignedOutError\) await noteSteamSession\('missing'\);\n    return;\n  \}\n  await noteSteamSession\('ok'\);/);
  // Same message either way, so every refusal-code mapping keeps working.
  assert.match(worker, /super\('STEAM_SESSION_REQUIRED'\);/);
  // The popup's recheck is popup-only.
  assert.match(worker, /router\.on\('CHECK_STEAM_SESSION', async \(msg, sender\) => \{\n  requirePopupSender\(sender\);/);

  const popupHtml = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
  const popup = readFileSync(new URL('../src/popup/popup.ts', import.meta.url), 'utf8');
  assert.match(popupHtml, /id="steam-session-alert" class="card steam-alert hidden"/);
  assert.match(popupHtml, /href="https:\/\/steamcommunity\.com\/login\/home\/" target="_blank"/);
  assert.match(popup, /setHidden\('#steam-session-alert', steamSession\.state !== 'missing'\);/);
});

test('the Steam-login copy exists in every locale and carries no em dash', async () => {
  const { en } = await import('../src/shared/locales/en.ts');
  const { ru } = await import('../src/shared/locales/ru.ts');
  for (const key of ['steamSession.title', 'steamSession.body', 'steamSession.action'] as const) {
    for (const [locale, dictionary] of [['en', en], ['ru', ru]] as const) {
      const message = dictionary[key];
      assert.ok(message && message.length > 0, `${locale} is missing ${key}`);
      assert.doesNotMatch(message, /—/, `${locale} ${key} has an em dash`);
    }
  }
  assert.equal(ru['steamSession.title'], 'Войдите в Steam в этом браузере');
});
