import assert from 'node:assert/strict';
import test, { before } from 'node:test';

/*
  The bridge, run against a Steam tab that has been open longer than its token
  lives. 2026-10-02: such a tab answered every ask with the token it loaded
  with, a day dead, and the seller's reads failed with 403 until he reloaded it.
*/

const STEAM_ID = '76561198000000042';
const NOW = Date.now();

function steamJwt(expiresAtMs: number, tag: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ typ: 'JWT', alg: 'EdDSA' })}.` +
    `${part({ sub: STEAM_ID, exp: Math.floor(expiresAtMs / 1_000) })}.${tag.repeat(40)}`;
}

function fakeDocument(token: string | null, steamId = STEAM_ID) {
  return {
    scripts: [{ src: '', textContent: `var g_steamID = "${steamId}";` }],
    querySelector: (selector: string) => (
      selector === '#application_config' && token ? { getAttribute: () => token } : null
    ),
  };
}

const LIVE_ON_PAGE = steamJwt(NOW + 5 * 60 * 60_000, 'p');
const DEAD_ON_PAGE = steamJwt(NOW - 3 * 60 * 60_000, 'd');
const FRESH_FROM_STEAM = steamJwt(NOW + 20 * 60 * 60_000, 'f');

const globals = globalThis as Record<string, unknown>;
const fetched: string[] = [];
const offered: unknown[] = [];
type Listener = (message: unknown, sender: { id: string }, respond: (value: unknown) => void) => boolean;
let listener: Listener | undefined;

globals['window'] = {
  location: { origin: 'https://steamcommunity.com' },
  // The bridge's own timers are not what is under test; nothing here fires them.
  setTimeout: () => 0,
  setInterval: () => 0,
  addEventListener() {},
};
globals['document'] = fakeDocument(LIVE_ON_PAGE);
globals['DOMParser'] = class {
  // The page Steam sends back, reduced to the one thing the bridge reads.
  parseFromString(html: string) {
    return fakeDocument(/token="([^"]+)"/.exec(html)?.[1] ?? null);
  }
};
globals['chrome'] = {
  runtime: {
    id: 'bridge-test',
    lastError: undefined,
    sendMessage: (message: unknown) => { offered.push(message); },
    onMessage: { addListener: (fn: Listener) => { listener = fn; } },
  },
};
globalThis.fetch = (async (input: string | URL) => {
  const url = String(input);
  fetched.push(url);
  const response = new Response(`<div token="${FRESH_FROM_STEAM}"></div>`, { status: 200 });
  Object.defineProperty(response, 'url', { value: 'https://steamcommunity.com/id/someone/tradehistory' });
  return response;
}) as typeof fetch;

before(async () => {
  await import('../src/content-scripts/steam/page-credential-bridge.ts');
});

const ASK = { type: 'REQUEST_STEAM_PAGE_CREDENTIAL', version: 1 };

function ask(): { answeredNow: boolean; answer: Promise<{ credential: { pageAccessToken: string } | null }> } {
  let resolve!: (value: { credential: { pageAccessToken: string } | null }) => void;
  const answer = new Promise<{ credential: { pageAccessToken: string } | null }>((done) => { resolve = done; });
  const keptOpen = listener!(ASK, { id: 'bridge-test' }, (value) => resolve(value as never));
  return { answeredNow: !keptOpen, answer };
}

test('a page whose token is alive answers at once and asks Steam nothing', async () => {
  // On load it offered what the page had.
  assert.equal(offered.length, 1);

  const { answeredNow, answer } = ask();
  assert.equal(answeredNow, true);
  assert.equal((await answer).credential?.pageAccessToken, LIVE_ON_PAGE);
  assert.deepEqual(fetched, []);
});

test('a signed-out page has nothing to hand over and nothing to refresh', async () => {
  globals['document'] = fakeDocument(null);

  const { answeredNow, answer } = ask();
  assert.equal(answeredNow, true);
  assert.equal((await answer).credential, null);
  assert.deepEqual(fetched, []);
});

test('a page whose token has died fetches a live one from Steam instead of handing the dead one over', async () => {
  globals['document'] = fakeDocument(DEAD_ON_PAGE);

  const first = ask();
  assert.equal(first.answeredNow, false);
  assert.equal((await first.answer).credential?.pageAccessToken, FRESH_FROM_STEAM);
  assert.deepEqual(fetched, ['https://steamcommunity.com/my/tradehistory?l=english']);

  // And keeps it: the next pass is answered at once, with no second request.
  const second = ask();
  assert.equal(second.answeredNow, true);
  assert.equal((await second.answer).credential?.pageAccessToken, FRESH_FROM_STEAM);
  assert.equal(fetched.length, 1);
});
