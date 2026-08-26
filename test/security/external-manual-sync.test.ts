import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dispatchExternalMessage,
  type ExternalManualSyncResult,
  type ExternalPairAndEnableHandlers,
  type ExternalSyncHandlers,
  type ExternalSyncStatusSnapshot,
} from '../../src/background/external-router.ts';

const STATUS_ORIGINS = new Set(['https://csboard.com', 'https://csboard.trade']);
const PAIRING_ORIGINS = new Set(['https://csfolder.com']);
const SYNC_ORIGINS = new Set(['https://csboard.com', 'https://csboard.trade']);

/** Pairing must stay untouched by everything in this file: a sync command that
 *  could pair, unpair or enable a source would be the widening we did not make. */
function pairingHandlers(calls: { pair: number; enable: number; sync: number; disable: number }) {
  const handlers: ExternalPairAndEnableHandlers = {
    async isPaired() { return true; },
    async pair() { calls.pair += 1; },
    async enablePortfolioSync() { calls.enable += 1; },
    async syncNow() { calls.sync += 1; },
    async disablePortfolioSync() { calls.disable += 1; },
  };
  return handlers;
}

function harness(sync: Partial<ExternalSyncHandlers> = {}) {
  const calls = { pair: 0, enable: 0, sync: 0, disable: 0, manual: 0, status: 0 };
  const syncHandlers: ExternalSyncHandlers = {
    async requestManualSync() {
      calls.manual += 1;
      return { started: true };
    },
    async readSyncStatus() {
      calls.status += 1;
      return { paired: true, syncState: 'syncing' };
    },
    ...sync,
  };
  const dispatch = (message: unknown, origin = 'https://csboard.com') =>
    dispatchExternalMessage(message, origin, {
      statusAllowedOrigins: STATUS_ORIGINS,
      pairingAllowedOrigins: PAIRING_ORIGINS,
      syncAllowedOrigins: SYNC_ORIGINS,
      extensionVersion: '1.1.7',
      handlers: pairingHandlers(calls),
      syncHandlers,
    });
  return { calls, dispatch };
}

function syncRequest(overrides: Record<string, unknown> = {}) {
  return { version: 1, type: 'RUN_MANUAL_SYNC', requestId: 'sync_request_01', ...overrides };
}

function statusRequest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    type: 'GET_PORTFOLIO_SYNC_STATUS',
    requestId: 'sync_status_01',
    ...overrides,
  };
}

test('CSBOARD may start one refresh and read whether it is running', async () => {
  const { calls, dispatch } = harness();

  assert.deepEqual(await dispatch(syncRequest()), {
    version: 1,
    requestId: 'sync_request_01',
    ok: true,
    data: { syncTriggered: true },
  });
  assert.deepEqual(await dispatch(statusRequest()), {
    version: 1,
    requestId: 'sync_status_01',
    ok: true,
    data: { paired: true, syncState: 'syncing' },
  });
  assert.deepEqual(await dispatch(syncRequest(), 'https://csboard.trade'), {
    version: 1,
    requestId: 'sync_request_01',
    ok: true,
    data: { syncTriggered: true },
  });

  // The widening is a sync trigger and nothing else: no pairing handler ran.
  assert.equal(calls.pair + calls.enable + calls.sync + calls.disable, 0);
});

test('sync commands are pinned to CSBOARD and pairing stays pinned to CSFolder', async () => {
  const { calls, dispatch } = harness();
  for (const message of [syncRequest(), statusRequest()]) {
    const refused = await dispatch(message, 'https://csfolder.com');
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, 'UNAUTHORIZED_ORIGIN');
  }
  for (const origin of ['https://evil.example', 'http://csboard.com', null]) {
    const refused = await dispatch(syncRequest(), origin as string);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, 'UNAUTHORIZED_ORIGIN');
  }
  assert.equal(calls.manual, 0);
  assert.equal(calls.status, 0);
});

test('a sync command carrying any extra field is rejected before the handler', async () => {
  const { calls, dispatch } = harness();
  const invalid = [
    syncRequest({ payload: {} }),
    syncRequest({ sources: ['inventory'] }),
    syncRequest({ steamId: '76561198000000000' }),
    syncRequest({ requestId: 'x'.repeat(65) }),
    syncRequest({ requestId: 42 }),
    syncRequest({ version: 2 }),
    statusRequest({ payload: {} }),
    statusRequest({ version: 2 }),
  ];
  for (const candidate of invalid) {
    const response = await dispatch(candidate);
    assert.equal(response.ok, false);
    if (!response.ok) assert.match(response.error.code, /INVALID_MESSAGE|UNSUPPORTED_VERSION/);
  }
  assert.equal(calls.manual, 0);
  assert.equal(calls.status, 0);
});

test('every refusal the site can act on keeps its own name', async () => {
  for (const refused of [
    'NOT_PAIRED',
    'SYNC_NOT_ENABLED',
    'STEAM_SESSION_REQUIRED',
    'ACTION_IN_PROGRESS',
    // 1.1.7, the direct csboard road. Each is a different thing for the seller
    // to do, and the site words each one separately.
    'CSBOARD_SIGN_IN_REQUIRED',
    'STEAM_ACCOUNT_NOT_LINKED',
    'STEAM_ACCOUNT_MISMATCH',
    'INVENTORY_TOO_LARGE',
    'SYNC_TRIGGER_FAILED',
  ] as const) {
    const { dispatch } = harness({ async requestManualSync() { return { refused }; } });
    const response = await dispatch(syncRequest());
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, refused);
  }
});

test('a refusal outside the closed vocabulary never reaches the page', async () => {
  const leaky = [
    'indexeddb: csboard_device_keys is corrupt',
    'STEAM_ACCOUNT_MISMATCH:76561198000000000',
    '',
    undefined,
  ];
  for (const refused of leaky) {
    const { dispatch } = harness({
      async requestManualSync() {
        return { refused } as unknown as ExternalManualSyncResult;
      },
    });
    const response = await dispatch(syncRequest());
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'SYNC_TRIGGER_FAILED');
  }
});

test('a throwing sync handler answers one bounded verdict', async () => {
  const { dispatch } = harness({
    async requestManualSync() {
      throw new Error('steamcommunity.com returned 401 for 76561198000000000');
    },
  });
  const response = await dispatch(syncRequest());
  assert.deepEqual(response, {
    version: 1,
    requestId: 'sync_request_01',
    ok: false,
    error: { code: 'SYNC_TRIGGER_FAILED' },
  });
});

test('the status answer is rebuilt here, so it cannot grow a field', async () => {
  const { dispatch } = harness({
    async readSyncStatus() {
      return {
        paired: true,
        syncState: 'syncing',
        steamId: '76561198000000000',
        lastFailureCode: 'device-revoked',
        pendingEncryptedRequests: 7,
      } as unknown as ExternalSyncStatusSnapshot;
    },
  });
  const response = await dispatch(statusRequest());
  assert.equal(response.ok, true);
  if (response.ok) {
    assert.deepEqual(response.data, { paired: true, syncState: 'syncing' });
  }
});

test('an unknown run state degrades to idle and a broken status is unavailable', async () => {
  const unknownState = harness({
    async readSyncStatus() {
      return { paired: 'yes', syncState: 'exploding' } as unknown as ExternalSyncStatusSnapshot;
    },
  });
  const degraded = await unknownState.dispatch(statusRequest());
  assert.equal(degraded.ok, true);
  if (degraded.ok) assert.deepEqual(degraded.data, { paired: false, syncState: 'idle' });

  const broken = harness({
    async readSyncStatus() { throw new Error('indexeddb unavailable'); },
  });
  const response = await broken.dispatch(statusRequest());
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, 'SYNC_STATUS_UNAVAILABLE');
});

test('the external surface still refuses listing, buying and Steam-action commands', async () => {
  // Moved from the P2P listing suite when that panel was removed. The commands
  // are gone from the extension entirely; this asserts that opening a sync
  // trigger did not open a door for them to come back from a web page.
  const { calls, dispatch } = harness();
  for (const type of [
    'GET_P2P_ELIGIBLE_ASSETS',
    'PREPARE_P2P_LISTING',
    'CONFIRM_P2P_LISTING',
    'P2P_BUY',
    'CREATE_STEAM_TRADE',
    'GET_STEAM_SESSION',
    'UNPAIR_DEVICE',
    'FETCH_INVENTORY_WITH_PROPERTIES',
  ]) {
    const response = await dispatch({
      version: 1,
      type,
      requestId: `request_${type}`,
    });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'INVALID_MESSAGE');
  }
  assert.equal(calls.manual + calls.status + calls.pair + calls.enable + calls.sync, 0);
});
