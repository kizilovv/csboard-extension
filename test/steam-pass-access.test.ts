/*
  The tracking pass without a Steam login (support case 2026-09-25, Gemalert).

  Two things are pinned down here. How the pass decides the login is missing:
  the page bridge for the csboard account first, the worker's own read only
  after it, and a different Steam account falling back to what the pass always
  did. And that a pass which finds no login still calls csboard, with
  `steamSession: 'missing'` — the call is what pairs the device.
*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { before } from 'node:test';

import { resolvePassSteamAccess } from '../src/background/steam-pass-access.ts';
import type { CsboardSyncAccountRead } from '../src/shared/api.ts';

const ACCOUNT = '76561198000000001';
const OTHER = '76561198000000002';

class SignedOut extends Error {
  constructor() { super('STEAM_SESSION_REQUIRED'); }
}

function harness(account: CsboardSyncAccountRead | Error, reads: Array<(expected?: string) => string>) {
  const calls: Array<string | undefined> = [];
  const deps = {
    readCsboardAccount: async () => {
      if (account instanceof Error) throw account;
      return account;
    },
    openReader: async (expected?: string) => {
      calls.push(expected);
      const next = reads.shift();
      if (!next) throw new Error('unexpected read');
      return next(expected);
    },
    isSignedOut: (error: unknown) => error instanceof SignedOut,
  };
  return { deps, calls };
}

test('the pass names the csboard account, so an open Steam tab can lend its login', async () => {
  const { deps, calls } = harness({ state: 'signed-in', steamId: ACCOUNT }, [(expected) => `reader:${expected}`]);
  const access = await resolvePassSteamAccess(deps);
  assert.deepEqual(access, { state: 'ok', provider: `reader:${ACCOUNT}`, csboard: 'signed-in' });
  assert.deepEqual(calls, [ACCOUNT]);
});

test('signed out through the bridge and the worker read is missing, asked once', async () => {
  const { deps, calls } = harness({ state: 'signed-in', steamId: ACCOUNT }, [() => { throw new SignedOut(); }]);
  const access = await resolvePassSteamAccess(deps);
  assert.deepEqual(access, { state: 'missing', csboard: 'signed-in' });
  assert.deepEqual(calls, [ACCOUNT]);
});

test('a different Steam account falls back to the unnamed read the pass always made', async () => {
  const { deps, calls } = harness({ state: 'signed-in', steamId: ACCOUNT }, [
    () => { throw new Error('STEAM_ACCOUNT_MISMATCH'); },
    () => `reader:${OTHER}`,
  ]);
  const access = await resolvePassSteamAccess(deps);
  assert.deepEqual(access, { state: 'ok', provider: `reader:${OTHER}`, csboard: 'signed-in' });
  assert.deepEqual(calls, [ACCOUNT, undefined]);
});

test('Steam not answering is unreachable, never missing', async () => {
  const offline = new Error('STEAM_SESSION_REQUIRED');
  const { deps } = harness({ state: 'signed-in', steamId: ACCOUNT }, [() => { throw offline; }]);
  const access = await resolvePassSteamAccess(deps);
  assert.equal(access.state, 'unreachable');
});

test('no csboard account to name: the unnamed read, and the caller learns csboard said signed-out', async () => {
  const { deps, calls } = harness({ state: 'signed-out' }, [() => { throw new SignedOut(); }]);
  const access = await resolvePassSteamAccess(deps);
  assert.deepEqual(access, { state: 'missing', csboard: 'signed-out' });
  assert.deepEqual(calls, [undefined]);
});

test('csboard unreachable does not stop the pass from reading Steam', async () => {
  const { deps, calls } = harness(new Error('offline'), [() => 'reader']);
  const access = await resolvePassSteamAccess(deps);
  assert.deepEqual(access, { state: 'ok', provider: 'reader', csboard: 'unreachable' });
  assert.deepEqual(calls, [undefined]);
});

/* ── the heartbeat carries the verdict ─────────────────────────────────── */

const posted: Array<{ url: string; body: Record<string, unknown> }> = [];

(globalThis as Record<string, unknown>)['chrome'] = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
    },
  },
  runtime: { id: 'pass-test', getManifest: () => ({ version: '0.0.0-test' }) },
  alarms: { create() {} },
};

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/p2p/ext/status')) {
    posted.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
  }
  // The csboard origin probe in shared/config.
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

let reportExtensionStatus: typeof import('../src/background/p2p-trade-tracker.ts').reportExtensionStatus;
before(async () => {
  ({ reportExtensionStatus } = await import('../src/background/p2p-trade-tracker.ts'));
});

test('the status report says whether Steam was there', async () => {
  posted.length = 0;
  await reportExtensionStatus({
    version: '1.1.26',
    steamId: null,
    tokenOk: null,
    permissions: { steamCommunity: true, steamApi: true },
    outcome: null,
    lastPassAt: Date.now(),
    nextPassAt: null,
    steamSession: 'missing',
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.body['steamSession'], 'missing');
  assert.equal(posted[0]?.body['steamId'], null);
});

test('a pass without Steam still reports in, and skips everything that reads Steam', () => {
  const worker = readFileSync(new URL('../src/background/service-worker.ts', import.meta.url), 'utf8');
  const start = worker.indexOf('async function runP2PTrackingPass(');
  const missing = worker.indexOf("if (access.state === 'missing')", start);
  const end = worker.indexOf('const provider = access.provider;', missing);
  assert.ok(start > 0 && missing > start && end > missing, 'pass structure moved; re-check this test');
  const branch = worker.slice(missing, end);
  assert.match(branch, /reportPassStatus\(\{\s*steamSession: 'missing'/);
  assert.match(branch, /return;/);
  assert.doesNotMatch(branch, /trackP2PTrades|runP2PCancellations|provider\./);
  // The popup / Steam-page recheck must reach Steam the same way as the pass.
  const recheck = worker.slice(worker.indexOf('async function performSteamSessionRecheck('));
  assert.match(recheck.slice(0, 600), /openSteamForPass\(\)/);
});
