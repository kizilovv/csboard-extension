import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dispatchExternalMessage,
  registerExternalStatusRouter,
  type ExternalPairAndEnableHandlers,
  type ExternalSyncHandlers,
} from '../../src/background/external-router.ts';

const STATUS_ORIGINS = new Set(['https://csboard.com', 'https://csboard.trade']);
const PAIRING_ORIGINS = new Set(['https://csfolder.com']);
const SYNC_ORIGINS = new Set(['https://csboard.com', 'https://csboard.trade']);
const VALID_CODE = 'CSF-2345-6789-ABCD-EFGH';

/** CSFolder must not gain the CSBOARD sync commands, and a sync handler must
 *  never be reached by a pairing message. Any call here is a routing bug. */
const forbiddenSyncHandlers: ExternalSyncHandlers = {
  async requestManualSync() {
    throw new Error('CSFolder activation must not reach the manual-sync handler');
  },
  async readSyncStatus() {
    throw new Error('CSFolder activation must not reach the sync-status handler');
  },
};

interface Calls {
  pair: string[];
  enable: number;
  sync: number;
  disable: number;
}

function harness(
  failAt?: 'pair' | 'paired-status' | 'enable' | 'sync' | 'disable',
  paired = true,
) {
  const calls: Calls = { pair: [], enable: 0, sync: 0, disable: 0 };
  const handlers: ExternalPairAndEnableHandlers = {
    async isPaired() {
      if (failAt === 'paired-status') throw new Error('private registration detail');
      return paired;
    },
    async pair(code) {
      calls.pair.push(code);
      if (failAt === 'pair') throw new Error('private pairing detail');
    },
    async enablePortfolioSync() {
      calls.enable += 1;
      if (failAt === 'enable') throw new Error('private storage detail');
    },
    async syncNow() {
      calls.sync += 1;
      if (failAt === 'sync') throw new Error('private Steam detail');
    },
    async disablePortfolioSync() {
      calls.disable += 1;
      if (failAt === 'disable') throw new Error('private rollback detail');
    },
  };
  const dispatch = (message: unknown, origin = 'https://csfolder.com') =>
    dispatchExternalMessage(message, origin, {
      statusAllowedOrigins: STATUS_ORIGINS,
      pairingAllowedOrigins: PAIRING_ORIGINS,
      syncAllowedOrigins: SYNC_ORIGINS,
      extensionVersion: '1.1.2',
      handlers,
      syncHandlers: forbiddenSyncHandlers,
    });
  return { calls, dispatch };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    type: 'PAIR_AND_ENABLE_PORTFOLIO_SYNC',
    requestId: 'pair_request_01',
    code: VALID_CODE,
    ...overrides,
  };
}

function reactivateRequest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    type: 'REACTIVATE_PORTFOLIO_SYNC',
    requestId: 'reactivate_request_01',
    ...overrides,
  };
}

test('CSFolder activation is origin-pinned and CSBOARD status remains read-only', async () => {
  const { calls, dispatch } = harness();
  const wrongOrigin = await dispatch(request(), 'https://csboard.com');
  assert.deepEqual(wrongOrigin, {
    version: 1,
    requestId: 'pair_request_01',
    ok: false,
    error: { code: 'UNAUTHORIZED_ORIGIN' },
  });
  assert.deepEqual(calls, { pair: [], enable: 0, sync: 0, disable: 0 });

  const status = await dispatch({
    version: 1,
    type: 'GET_EXTENSION_STATUS',
    requestId: 'status_request_01',
    payload: {},
  }, 'https://csboard.com');
  assert.deepEqual(status, {
    version: 1,
    requestId: 'status_request_01',
    ok: true,
    data: {
      installed: true,
      extensionVersion: '1.1.2',
      capabilityVersion: 1,
    },
  });

  const csfolderStatus = await dispatch({
    version: 1,
    type: 'GET_EXTENSION_STATUS',
    requestId: 'status_request_02',
    payload: {},
  });
  assert.equal(csfolderStatus.ok, false);
  if (!csfolderStatus.ok) assert.equal(csfolderStatus.error.code, 'UNAUTHORIZED_ORIGIN');
});

test('activation rejects unknown fields, malformed codes and oversized requests before handlers', async () => {
  const { calls, dispatch } = harness();
  const invalid = [
    request({ extra: true }),
    request({ code: 'CSF-1111-1111-1111-1111' }),
    request({ code: 'CSF-2345-6789-ABCD-EFGH'.toLowerCase() }),
    request({ requestId: 'x'.repeat(65) }),
    request({ code: `CSF-${'A'.repeat(2_100)}` }),
    request({ version: 2 }),
  ];

  for (const candidate of invalid) {
    const response = await dispatch(candidate);
    assert.equal(response.ok, false);
    if (!response.ok) {
      assert.match(response.error.code, /INVALID_MESSAGE|UNSUPPORTED_VERSION/);
    }
  }
  assert.deepEqual(calls, { pair: [], enable: 0, sync: 0, disable: 0 });
});

test('reactivation is exact, origin-pinned and exposes no source or identity input', async () => {
  const { calls, dispatch } = harness();
  for (const candidate of [
    reactivateRequest({ sources: ['inventory'] }),
    reactivateRequest({ steamId: '76561198000000000' }),
    reactivateRequest({ payload: {} }),
    reactivateRequest({ requestId: 'x'.repeat(65) }),
    reactivateRequest({ version: 2 }),
  ]) {
    const response = await dispatch(candidate);
    assert.equal(response.ok, false);
    if (!response.ok) assert.match(response.error.code, /INVALID_MESSAGE|UNSUPPORTED_VERSION/);
  }
  const wrongOrigin = await dispatch(reactivateRequest(), 'https://csboard.com');
  assert.equal(wrongOrigin.ok, false);
  if (!wrongOrigin.ok) assert.equal(wrongOrigin.error.code, 'UNAUTHORIZED_ORIGIN');
  assert.deepEqual(calls, { pair: [], enable: 0, sync: 0, disable: 0 });
});

test('reactivation requires a real local gateway registration', async () => {
  const { calls, dispatch } = harness(undefined, false);
  const response = await dispatch(reactivateRequest());
  assert.deepEqual(response, {
    version: 1,
    requestId: 'reactivate_request_01',
    ok: false,
    error: { code: 'NOT_PAIRED' },
  });
  assert.deepEqual(calls, { pair: [], enable: 0, sync: 0, disable: 0 });
});

test('successful paired reactivation enables the reviewed sources and triggers one sync', async () => {
  const { calls, dispatch } = harness();
  const response = await dispatch(reactivateRequest());
  assert.deepEqual(response, {
    version: 1,
    requestId: 'reactivate_request_01',
    ok: true,
    data: {
      paired: true,
      portfolioSyncEnabled: true,
      enabledSources: ['inventory', 'tradeHistory'],
      syncTriggered: true,
    },
  });
  assert.deepEqual(calls, { pair: [], enable: 1, sync: 1, disable: 0 });
});

test('reactivation fails closed when source activation fails', async () => {
  const { calls, dispatch } = harness('enable');
  const response = await dispatch(reactivateRequest());
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, 'ACTIVATION_FAILED');
  assert.deepEqual(calls, { pair: [], enable: 1, sync: 0, disable: 1 });
});

test('reactivation also fails closed when sync handoff fails', async () => {
  const { calls, dispatch } = harness('sync');
  const response = await dispatch(reactivateRequest());
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, 'SYNC_TRIGGER_FAILED');
  assert.deepEqual(calls, { pair: [], enable: 1, sync: 1, disable: 1 });
});

test('pair failure is atomic: it never enables sources or triggers sync', async () => {
  const { calls, dispatch } = harness('pair');
  const response = await dispatch(request());
  assert.deepEqual(response, {
    version: 1,
    requestId: 'pair_request_01',
    ok: false,
    error: { code: 'PAIRING_FAILED' },
  });
  assert.deepEqual(calls, {
    pair: [VALID_CODE],
    enable: 0,
    sync: 0,
    disable: 0,
  });
});

test('partial activation fails closed before sync', async () => {
  const { calls, dispatch } = harness('enable');
  const response = await dispatch(request());
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, 'ACTIVATION_FAILED');
  assert.deepEqual(calls, {
    pair: [VALID_CODE],
    enable: 1,
    sync: 0,
    disable: 1,
  });
});

test('sync trigger setup failure also disables portfolio uploads', async () => {
  const { calls, dispatch } = harness('sync');
  const response = await dispatch(request());
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, 'SYNC_TRIGGER_FAILED');
  assert.deepEqual(calls, {
    pair: [VALID_CODE],
    enable: 1,
    sync: 1,
    disable: 1,
  });
});

test('successful activation enables only the reviewed sources and triggers one sync', async () => {
  const { calls, dispatch } = harness();
  const response = await dispatch(request());
  assert.deepEqual(response, {
    version: 1,
    requestId: 'pair_request_01',
    ok: true,
    data: {
      paired: true,
      portfolioSyncEnabled: true,
      enabledSources: ['inventory', 'tradeHistory'],
      syncTriggered: true,
    },
  });
  assert.deepEqual(calls, {
    pair: [VALID_CODE],
    enable: 1,
    sync: 1,
    disable: 0,
  });
});

test('fresh pairing and paired reactivation share one in-flight guard', async () => {
  let listener: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (value: unknown) => void) => boolean =
    () => false;
  const previousChrome = globalThis.chrome;
  let releasePair!: () => void;
  const blockedPair = new Promise<void>((resolve) => {
    releasePair = resolve;
  });
  globalThis.chrome = {
    runtime: {
      onMessageExternal: {
        addListener(next: typeof listener) {
          listener = next;
        },
        removeListener() {},
      },
    },
  } as typeof chrome;
  const unregister = registerExternalStatusRouter({
    statusAllowedOrigins: ['https://csboard.com', 'https://csboard.trade'],
    pairingAllowedOrigins: ['https://csfolder.com'],
    syncAllowedOrigins: ['https://csboard.com', 'https://csboard.trade'],
    extensionVersion: '1.1.2',
    syncHandlers: forbiddenSyncHandlers,
    handlers: {
      async isPaired() { return true; },
      async pair() { await blockedPair; },
      async enablePortfolioSync() {},
      async syncNow() {},
      async disablePortfolioSync() {},
    },
  });
  try {
    const first = new Promise<unknown>((resolve) => {
      assert.equal(listener(request(), { url: 'https://csfolder.com/portfolio' }, resolve), true);
    });
    await Promise.resolve();
    const second = await new Promise<unknown>((resolve) => {
      assert.equal(listener(reactivateRequest(), { url: 'https://csfolder.com/portfolio' }, resolve), false);
    });
    assert.deepEqual(second, {
      version: 1,
      requestId: 'reactivate_request_01',
      ok: false,
      error: { code: 'ACTION_IN_PROGRESS' },
    });
    releasePair();
    const firstResponse = await first;
    assert.equal((firstResponse as { ok?: unknown }).ok, true);
  } finally {
    unregister();
    globalThis.chrome = previousChrome;
  }
});
