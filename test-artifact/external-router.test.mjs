import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function createChromeMock(manifest) {
  const listeners = { external: null, internal: null };
  const effects = { fetches: 0, localReads: 0, sessionReads: 0 };
  const noopEvent = { addListener() {} };
  const storageArea = (kind) => ({
    async get() {
      if (kind === 'local') effects.localReads += 1;
      else effects.sessionReads += 1;
      return {};
    },
    async set() {},
    async remove() {},
    async clear() {},
  });

  const chrome = {
    runtime: {
      id: 'artifact-test',
      getManifest: () => manifest,
      getURL: (path) => `chrome-extension://artifact-test/${path}`,
      onMessage: { addListener(listener) { listeners.internal = listener; } },
      onMessageExternal: { addListener(listener) { listeners.external = listener; } },
      onInstalled: noopEvent,
      onStartup: noopEvent,
      lastError: undefined,
    },
    storage: { local: storageArea('local'), session: storageArea('session'), onChanged: noopEvent },
    alarms: { create() {}, onAlarm: noopEvent },
    tabs: { create() {}, query: async () => [], sendMessage: async () => undefined },
  };

  return { chrome, listeners, effects };
}

function dispatch(listener, message, url, id) {
  return new Promise((resolveResponse, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error('external listener did not answer'));
    }, 1_000);
    const sendResponse = (response) => {
      settled = true;
      clearTimeout(timer);
      resolveResponse(response);
    };
    listener(message, { url, ...(id ? { id } : {}) }, sendResponse);
  });
}

test('real bundled service worker exposes only bounded status externally', async () => {
  const root = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(await readFile(resolve(root, 'build/manifest.json'), 'utf8'));
  const { chrome, listeners, effects } = createChromeMock(manifest);
  globalThis.chrome = chrome;
  globalThis.fetch = async (...args) => {
    effects.fetches += 1;
    throw new Error(`unexpected external fetch: ${String(args[0])}`);
  };

  await import(`${pathToFileURL(resolve(root, 'build/service-worker.js')).href}?artifact=${Date.now()}`);
  assert.equal(typeof listeners.external, 'function', 'onMessageExternal listener missing');

  const valid = await dispatch(listeners.external, {
    version: 1,
    type: 'GET_EXTENSION_STATUS',
    requestId: 'artifact_test_1',
    payload: {},
  }, 'https://csboard.com/extension');
  assert.deepEqual(valid, {
    version: 1,
    requestId: 'artifact_test_1',
    ok: true,
    data: {
      installed: true,
      extensionVersion: manifest.version,
      capabilityVersion: 1,
    },
  });

  const denied = [
    { type: 'GET_AUTH_STATUS' },
    { type: 'REFRESH_STEAM_READ_SESSION' },
    { type: 'FETCH_TRADE_HISTORY', data: { maxTrades: 1 } },
    { type: 'FETCH_STEAM_TRADE_OFFERS' },
    { type: 'FETCH_INVENTORY_WITH_PROPERTIES', data: { steamId: '76561198000000000' } },
    { type: 'CREATE_STEAM_TRADE', data: {} },
    { type: 'P2P_CREATE_AND_ANNOTATE', data: {} },
    { type: 'GET_P2P_ELIGIBLE_ASSETS', version: 1 },
    { type: 'PREPARE_P2P_LISTING', version: 1, data: {} },
    { type: 'CONFIRM_P2P_LISTING', version: 1, data: { reviewId: 'external-review' } },
    { type: 'CANCEL_P2P_LISTING_REVIEW', version: 1, data: { reviewId: 'external-review' } },
    { version: 1, type: 'GET_EXTENSION_STATUS', requestId: 'x', payload: {}, extra: true },
    { version: 1, type: 'GET_EXTENSION_STATUS', requestId: 'x'.repeat(65), payload: {} },
    { version: 1, type: 'GET_EXTENSION_STATUS', requestId: 'x', payload: { nested: true } },
    { version: 1, type: 'GET_EXTENSION_STATUS', requestId: 'x', payload: {}, pad: 'x'.repeat(2_048) },
  ];

  for (const request of denied) {
    const response = await dispatch(listeners.external, request, 'https://csboard.com/extension');
    assert.equal(response?.ok, false, `sensitive message was not rejected: ${request.type}`);
    assert.match(response?.error?.code || '', /INVALID_MESSAGE|UNSUPPORTED_VERSION/);
  }

  const wrongOrigin = await dispatch(listeners.external, {
    version: 1,
    type: 'GET_EXTENSION_STATUS',
    requestId: 'wrong_origin',
    payload: {},
  }, 'https://steamcommunity.com/id/example');
  assert.equal(wrongOrigin?.ok, false);
  assert.equal(wrongOrigin?.error?.code, 'UNAUTHORIZED_ORIGIN');

  assert.equal(typeof listeners.internal, 'function', 'onMessage listener missing');
  const internalNonPopup = await dispatch(listeners.internal, {
    type: 'GET_P2P_ELIGIBLE_ASSETS',
    version: 1,
  }, 'chrome-extension://artifact-test/pages/trade-history.html', 'artifact-test');
  assert.deepEqual(internalNonPopup, { error: 'POPUP_ONLY_OPERATION' });

  assert.equal(effects.fetches, 0, 'external status router performed network I/O');
  assert.equal(effects.localReads, 0, 'external status router read local storage');
  assert.equal(effects.sessionReads, 0, 'external status router read session/credential storage');
});
