import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { DEFAULT_POPUP_SETTINGS } from '../src/popup/contracts.ts';

type Bag = Record<string, unknown>;
type Listener<T> = (value: T) => unknown;

const AUTO_SYNC_ALARM = 'portfolio-auto-sync';
const AUTO_SYNC_STATE_KEY = 'csboard_portfolio_auto_sync_v1';
const CREDENTIAL_SYNC_STATE_KEY = 'csboard_portfolio_page_sync_throttle_v1';
const PORTFOLIO_UI_STATUS_KEY = 'csboard_portfolio_ui_status_v1';
const PAGE_TOKEN = 'a'.repeat(48);

let bundleSequence = 0;
let workerBundle: Promise<string> | undefined;

function event<T>() {
  const listeners: Listener<T>[] = [];
  return {
    listeners,
    addListener(listener: Listener<T>) {
      listeners.push(listener);
    },
  };
}

function createIndexedDb(registration: Bag | null) {
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    close() {},
    transaction() {
      const transaction: Bag & {
        objectStore(name: string): Bag;
        oncomplete?: () => void;
      } = {
        objectStore(name: string) {
          return {
            get(key: string) {
              const request: Bag = {};
              queueMicrotask(() => {
                request.result = name === 'device-state' && key === 'registration'
                  ? registration ?? undefined
                  : undefined;
                (request.onsuccess as (() => void) | undefined)?.();
                setTimeout(() => transaction.oncomplete?.(), 0);
              });
              return request;
            },
            put() {},
            delete() {},
          };
        },
      };
      return transaction;
    },
  };

  return {
    open() {
      const request: Bag = { result: database };
      queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.());
      return request;
    },
  };
}

async function bundledWorker(): Promise<string> {
  workerBundle ??= (async () => {
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const stagingRoot = await mkdtemp(resolve(tmpdir(), 'csboard-auto-sync-test-'));
    try {
      await cp(resolve(projectRoot, 'src'), resolve(stagingRoot, 'src'), { recursive: true });
      await writeFile(resolve(stagingRoot, 'package.json'), '{"type":"module"}\n');
      await symlink(resolve(projectRoot, 'node_modules'), resolve(stagingRoot, 'node_modules'), 'dir');
      const result = await build({
        absWorkingDir: stagingRoot,
        entryPoints: ['./src/background/service-worker.ts'],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'chrome110',
        write: false,
        preserveSymlinks: true,
        define: {
          'process.env.NODE_ENV': '"test"',
          __CSBOARD_GATEWAY_HOSTS__: JSON.stringify([
            'https://csboard.com',
            'https://csboard.trade',
          ]),
          __CSBOARD_GATEWAY_ROOT_JWK__: 'null',
        },
        // Production keeps this helper private. The test-only bundle exposes
        // the exact state transition used by the alarm failure path.
        footer: {
          js: [
            'function __testSetPortfolioSyncInFlight(promise) {',
            '  const tracked = Promise.resolve(promise).finally(() => {',
            '    if (portfolioSyncInFlight === tracked) portfolioSyncInFlight = null;',
            '  });',
            '  portfolioSyncInFlight = tracked;',
            '}',
            'export {',
            '  portfolioAutoSyncFailureState as __testPortfolioAutoSyncFailureState,',
            '  sourceStatus as __testPortfolioSourceStatus,',
            '  portfolioCollectorSources as __testPortfolioCollectorSources,',
            '  portfolioSyncSuccessStatus as __testPortfolioSyncSuccessStatus,',
            '  safePortfolioErrorCode as __testSafePortfolioErrorCode,',
            '  getSteamReadProvider as __testGetSteamReadProvider,',
            '  beginPortfolioUnpairFence as __testBeginPortfolioUnpairFence,',
            '  finishPortfolioUnpairAttempt as __testFinishPortfolioUnpairAttempt,',
            '  allowPortfolioUploadsAfterExplicitConsent as __testAllowPortfolioUploads,',
            '  preparePortfolioPairing as __testPreparePortfolioPairing,',
            '  runCredentialAssistedPortfolioSync as __testRunCredentialAssistedPortfolioSync,',
            '  __testSetPortfolioSyncInFlight',
            '};',
          ].join('\n'),
        },
      });
      return result.outputFiles[0]!.text;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  })();
  return workerBundle;
}

interface WorkerHarnessOptions {
  readonly settings?: Bag;
  readonly paired?: boolean;
  readonly failAutoStateRead?: boolean;
  readonly autoSyncState?: Bag;
  readonly steamPageCredential?: {
    readonly pageAccessToken: string;
    readonly pageSteamId: string;
  };
  readonly steamTabUrl?: string;
  readonly steamSessionSteamId?: string;
}

async function loadWorker(options: WorkerHarnessOptions = {}) {
  const local: Bag = {
    csboard_storage_version: 3,
    csboard_settings: {
      ...DEFAULT_POPUP_SETTINGS,
      ...(options.settings ?? {}),
      portfolioSources: {
        ...DEFAULT_POPUP_SETTINGS.portfolioSources,
        ...((options.settings?.portfolioSources as Bag | undefined) ?? {}),
      },
    },
    ...(options.autoSyncState
      ? { [AUTO_SYNC_STATE_KEY]: structuredClone(options.autoSyncState) }
      : {}),
  };
  const writes: Bag[] = [];
  const alarms: Array<{ name: string; info: Bag }> = [];
  const tabMessages: Array<{ tabId: number; message: Bag }> = [];
  const fetchUrls: string[] = [];
  const onAlarm = event<{ name: string }>();
  const onInstalled = event<{ reason: string }>();
  const onStartup = event<void>();
  const onMessage = event<unknown>();
  const onMessageExternal = event<unknown>();
  const noopEvent = event<unknown>();

  const storageArea = {
    async get(keys?: string | string[] | null) {
      const list = keys === null || keys === undefined
        ? Object.keys(local)
        : Array.isArray(keys) ? keys : [keys];
      if (options.failAutoStateRead && list.includes(AUTO_SYNC_STATE_KEY)) {
        throw new Error('storage unavailable');
      }
      return Object.fromEntries(
        list.filter((key) => key in local).map((key) => [key, local[key]]),
      );
    },
    async set(values: Bag) {
      writes.push(structuredClone(values));
      Object.assign(local, values);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete local[key];
    },
    async clear() {
      for (const key of Object.keys(local)) delete local[key];
    },
  };

  const registration = options.paired
    ? {
        id: 'registration',
        deviceId: 'device_1234567890',
        steamId: '76561198000000000',
        gatewayOrigin: 'https://csboard.com',
        recipientKeyId: 'gateway-key-v1',
        pairedAt: 1,
      }
    : null;

  const silentConsole = Object.assign(Object.create(globalThis.console), {
    debug() {},
    log() {},
    warn() {},
    error() {},
  });

  Object.assign(globalThis, {
    console: silentConsole,
    indexedDB: createIndexedDb(registration),
    chrome: {
      runtime: {
        id: 'auto-sync-test',
        getManifest: () => ({ version: '1.1.0' }),
        getURL: (path: string) => `chrome-extension://auto-sync-test/${path}`,
        onMessage,
        onMessageExternal,
        onInstalled,
        onStartup,
        lastError: undefined,
      },
      storage: {
        local: storageArea,
        session: storageArea,
        onChanged: noopEvent,
      },
      alarms: {
        create(name: string, info: Bag) {
          alarms.push({ name, info });
        },
        onAlarm,
      },
      tabs: {
        create() {},
        query: async () => options.steamPageCredential
          ? [{
              id: 71,
              url: options.steamTabUrl ?? 'https://steamcommunity.com/id/trader/inventory',
            }]
          : [],
        sendMessage: async (tabId: number, message: Bag) => {
          tabMessages.push({ tabId, message: structuredClone(message) });
          return { credential: options.steamPageCredential ?? null };
        },
      },
    },
    fetch: async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : input.url;
      fetchUrls.push(url);
      if (url === 'https://steamcommunity.com' && options.steamSessionSteamId) {
        return new Response(
          `<script>var g_steamID = "${options.steamSessionSteamId}";</script>`,
          { status: 200 },
        );
      }
      throw new Error('network disabled in scheduler test');
    },
  });

  const source = await bundledWorker();
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${bundleSequence++}`;
  const workerModule = await import(url) as {
    __testPortfolioAutoSyncFailureState: (
      previous: Bag,
      error: unknown,
      now: number,
    ) => Bag;
    __testPortfolioSourceStatus: (
      source: string,
      enabled: boolean,
      runtimeState: string,
      stored: Bag,
    ) => Bag;
    __testPortfolioCollectorSources: (settings: Bag) => Bag;
    __testPortfolioSyncSuccessStatus: (
      previous: Bag,
      settings: Bag,
      result: Bag,
      attemptedAt: number,
      successfulAt: number,
    ) => Bag;
    __testSafePortfolioErrorCode: (error: unknown) => string;
    __testGetSteamReadProvider: (steamId: string) => Promise<{
      hasUsableAccessToken?: () => boolean;
    }>;
    __testBeginPortfolioUnpairFence: () => number;
    __testFinishPortfolioUnpairAttempt: () => void;
    __testAllowPortfolioUploads: () => void;
    __testPreparePortfolioPairing: () => Promise<void>;
    __testRunCredentialAssistedPortfolioSync: (
      pairedAt: number,
      expectedSteamId: string,
      credential: { pageAccessToken: string; pageSteamId: string },
    ) => Promise<boolean>;
    __testSetPortfolioSyncInFlight: (promise: Promise<unknown>) => void;
  };

  return {
    alarms,
    fetchUrls,
    local,
    tabMessages,
    writes,
    workerModule,
    async fireAlarm(name = AUTO_SYNC_ALARM) {
      assert.equal(onAlarm.listeners.length, 1);
      await onAlarm.listeners[0]!({ name });
    },
    async start() {
      assert.equal(onStartup.listeners.length, 1);
      await onStartup.listeners[0]!(undefined);
    },
    async fireInternalMessage(message: Bag, sender: Bag): Promise<Bag> {
      assert.equal(onMessage.listeners.length, 1);
      const listener = onMessage.listeners[0] as unknown as (
        value: Bag,
        sender: Bag,
        sendResponse: (response: Bag) => void,
      ) => unknown;
      return new Promise((resolveResponse, rejectResponse) => {
        const timeout = setTimeout(
          () => rejectResponse(new Error('internal message timed out')),
          5_000,
        );
        listener(message, sender, (response) => {
          clearTimeout(timeout);
          resolveResponse(response);
        });
      });
    },
  };
}

test('portfolio automatic sync remains opt-in by default', () => {
  assert.equal(DEFAULT_POPUP_SETTINGS.portfolioSyncEnabled, false);
  assert.equal(Object.values(DEFAULT_POPUP_SETTINGS.portfolioSources).some(Boolean), false);
});

test('missing Steam cookies have a stable safe status code', async () => {
  const { workerModule } = await loadWorker();
  assert.equal(
    workerModule.__testSafePortfolioErrorCode(new Error('STEAM_SESSION_REQUIRED')),
    'STEAM_SESSION_REQUIRED',
  );
  assert.equal(
    workerModule.__testSafePortfolioErrorCode(new Error('a secret-looking arbitrary failure')),
    'SYNC_FAILED',
  );
});

test('trade history consent enables privacy-safe offer enrichment without exposing a source row', async () => {
  const { workerModule } = await loadWorker();
  const previous = {
    lastAttemptedAt: 1,
    lastSuccessfulAt: 2,
    sourceRecords: { inventory: 4, tradeOffers: 99 },
    sourceErrors: { tradeOffers: 'OLD_ERROR' },
    sourceWarnings: { tradeOffers: 'TRADE_OFFERS_TRUNCATED' },
  };

  assert.deepEqual(
    workerModule.__testPortfolioSourceStatus('tradeOffers', true, 'idle', previous),
    {
      enabled: false,
      state: 'disabled',
    },
  );

  assert.deepEqual(
    workerModule.__testPortfolioCollectorSources({
      ...DEFAULT_POPUP_SETTINGS,
      portfolioSyncEnabled: true,
      portfolioSources: {
        ...DEFAULT_POPUP_SETTINGS.portfolioSources,
        tradeHistory: true,
      },
    }),
    {
      inventory: false,
      tradeHistory: true,
      tradeOffers: true,
    },
  );
  assert.deepEqual(
    workerModule.__testPortfolioCollectorSources({
      ...DEFAULT_POPUP_SETTINGS,
      portfolioSyncEnabled: false,
      portfolioSources: {
        ...DEFAULT_POPUP_SETTINGS.portfolioSources,
        tradeHistory: true,
      },
    }),
    {
      inventory: false,
      tradeHistory: false,
      tradeOffers: false,
    },
  );
  assert.deepEqual(
    workerModule.__testPortfolioCollectorSources({
      ...DEFAULT_POPUP_SETTINGS,
      portfolioSyncEnabled: true,
      portfolioSources: {
        ...DEFAULT_POPUP_SETTINGS.portfolioSources,
        inventory: true,
      },
    }),
    {
      inventory: true,
      tradeHistory: false,
      tradeOffers: false,
    },
  );

  const success = workerModule.__testPortfolioSyncSuccessStatus(
    previous,
    {
      ...DEFAULT_POPUP_SETTINGS,
      portfolioSyncEnabled: true,
      portfolioSources: {
        ...DEFAULT_POPUP_SETTINGS.portfolioSources,
        inventory: true,
        tradeHistory: true,
      },
    },
    {
      queued: 0,
      inventoryItems: 7,
      trades: 0,
      offers: 99,
      failedSources: [],
      sourceFailureCodes: {},
      warningCodes: ['TRADE_OFFERS_TRUNCATED', 'TRADE_HISTORY_TRUNCATED'],
    },
    10,
    20,
  );
  assert.deepEqual(success.sourceRecords, { inventory: 7, tradeHistory: 0 });
  assert.deepEqual(success.sourceErrors, {});
  assert.deepEqual(success.sourceWarnings, { tradeHistory: 'TRADE_HISTORY_TRUNCATED' });

  const oversized = workerModule.__testPortfolioSyncSuccessStatus(
    previous,
    {
      ...DEFAULT_POPUP_SETTINGS,
      portfolioSyncEnabled: true,
      portfolioSources: {
        ...DEFAULT_POPUP_SETTINGS.portfolioSources,
        tradeHistory: true,
      },
    },
    {
      queued: 0,
      inventoryItems: 0,
      trades: 1,
      offers: 0,
      failedSources: [],
      sourceFailureCodes: {},
      warningCodes: ['OVERSIZED_RECORDS_DROPPED'],
    },
    21,
    22,
  );
  assert.deepEqual(oversized.sourceWarnings, {
    tradeHistory: 'OVERSIZED_RECORDS_DROPPED',
  });

  const sessionFailure = workerModule.__testPortfolioSyncSuccessStatus(
    previous,
    {
      ...DEFAULT_POPUP_SETTINGS,
      portfolioSyncEnabled: true,
      portfolioSources: {
        ...DEFAULT_POPUP_SETTINGS.portfolioSources,
        inventory: true,
        tradeHistory: true,
      },
    },
    {
      queued: 0,
      inventoryItems: 7,
      trades: 0,
      offers: 0,
      failedSources: ['tradeHistory'],
      sourceFailureCodes: { tradeHistory: 'STEAM_SESSION_REQUIRED' },
      warningCodes: [],
    },
    30,
    40,
  );
  assert.deepEqual(sessionFailure.sourceErrors, {
    tradeHistory: 'STEAM_SESSION_REQUIRED',
  });
});

test('a failed remote unpair keeps local uploads blocked until fresh explicit consent', async () => {
  const harness = await loadWorker({
    paired: true,
    settings: {
      portfolioSyncEnabled: true,
      portfolioSources: { inventory: true },
    },
  });

  harness.workerModule.__testBeginPortfolioUnpairFence();
  // Models the handler's finally path after the remote revoke rejects: the
  // transient operation ends, but the durable-in-process upload block stays.
  harness.workerModule.__testFinishPortfolioUnpairAttempt();
  await harness.fireAlarm();
  assert.equal(PORTFOLIO_UI_STATUS_KEY in harness.local, false);
  assert.equal(AUTO_SYNC_STATE_KEY in harness.local, false);

  // A later explicit opt-in is a new consent decision and may lift the block.
  harness.workerModule.__testAllowPortfolioUploads();
  await harness.fireAlarm();
  assert.equal(PORTFOLIO_UI_STATUS_KEY in harness.local, true);
});

test('pairing resets stale portfolio consent instead of reviving it', async () => {
  const harness = await loadWorker({
    settings: {
      portfolioSyncEnabled: true,
      portfolioSources: {
        inventory: true,
        tradeHistory: true,
      },
    },
    autoSyncState: {
      consecutiveFailures: 2,
      nextAttemptAt: Date.now() + 60_000,
      suspended: false,
    },
  });

  await harness.workerModule.__testPreparePortfolioPairing();

  const settings = harness.local.csboard_settings as Bag;
  assert.equal(settings.portfolioSyncEnabled, false);
  assert.deepEqual(settings.portfolioSources, DEFAULT_POPUP_SETTINGS.portfolioSources);
  assert.equal(AUTO_SYNC_STATE_KEY in harness.local, false);
  assert.deepEqual(harness.local.csboard_gateway_encrypted_outbox_v1, []);
});

test('registers one named portfolio alarm at a conservative cadence', async () => {
  const harness = await loadWorker();
  await harness.start();

  const alarm = harness.alarms.find((candidate) => candidate.name === AUTO_SYNC_ALARM);
  assert.ok(alarm, 'named portfolio alarm was not registered');
  assert.equal(typeof alarm.info.periodInMinutes, 'number');
  assert.ok(
    (alarm.info.periodInMinutes as number) >= 60,
    'authenticated Steam reads must not run more often than hourly',
  );
});

test('alarm requires pairing, the master opt-in, and a currently supported source', async () => {
  const scenarios: Array<{
    readonly name: string;
    readonly paired: boolean;
    readonly enabled: boolean;
    readonly sources: Bag;
    readonly shouldAttempt: boolean;
  }> = [
    {
      name: 'unpaired',
      paired: false,
      enabled: true,
      sources: { inventory: true },
      shouldAttempt: false,
    },
    {
      name: 'master switch off',
      paired: true,
      enabled: false,
      sources: { inventory: true },
      shouldAttempt: false,
    },
    {
      name: 'all sources off',
      paired: true,
      enabled: true,
      sources: {},
      shouldAttempt: false,
    },
    {
      name: 'retired trade-offer source only',
      paired: true,
      enabled: true,
      sources: { tradeOffers: true },
      shouldAttempt: false,
    },
    {
      name: 'unsupported market source only',
      paired: true,
      enabled: true,
      sources: { marketHistory: true },
      shouldAttempt: false,
    },
    {
      name: 'inventory enabled',
      paired: true,
      enabled: true,
      sources: { inventory: true },
      shouldAttempt: true,
    },
    {
      name: 'trade history enabled',
      paired: true,
      enabled: true,
      sources: { tradeHistory: true },
      shouldAttempt: true,
    },
  ];

  for (const scenario of scenarios) {
    const harness = await loadWorker({
      paired: scenario.paired,
      settings: {
        portfolioSyncEnabled: scenario.enabled,
        portfolioSources: scenario.sources,
      },
    });
    await harness.fireAlarm();
    assert.equal(
      PORTFOLIO_UI_STATUS_KEY in harness.local,
      scenario.shouldAttempt,
      scenario.name,
    );
  }
});

test('automatic failures are contained and persist only bounded scheduler metadata', async () => {
  const harness = await loadWorker({
    paired: true,
    settings: {
      portfolioSyncEnabled: true,
      portfolioSources: { inventory: true },
    },
  });

  await assert.doesNotReject(() => harness.fireAlarm());

  const state = harness.local[AUTO_SYNC_STATE_KEY] as Bag;
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(typeof state.nextAttemptAt, 'number');
  assert.ok((state.nextAttemptAt as number) > Date.now());

  const persistedKeys = harness.writes.flatMap((write) => Object.keys(write));
  assert.equal(
    persistedKeys.some((key) => /steam.*(?:token|credential|password|secret)|sessionid/i.test(key)),
    false,
  );
});

test('a cold worker requests a credential immediately from an existing trusted Steam tab', async () => {
  const harness = await loadWorker({
    paired: true,
    settings: {
      portfolioSyncEnabled: true,
      portfolioSources: { tradeHistory: true },
    },
    steamPageCredential: {
      pageAccessToken: PAGE_TOKEN,
      pageSteamId: '76561198000000000',
    },
  });

  const provider = await harness.workerModule.__testGetSteamReadProvider(
    '76561198000000000',
  );

  assert.deepEqual(harness.tabMessages, [{
    tabId: 71,
    message: { type: 'REQUEST_STEAM_PAGE_CREDENTIAL', version: 1 },
  }]);
  assert.equal(provider.hasUsableAccessToken?.(), true);
  assert.equal(JSON.stringify(harness.local).includes(PAGE_TOKEN), false);
  assert.equal(JSON.stringify(harness.writes).includes(PAGE_TOKEN), false);
});

test('cold credential refresh ignores non-Steam tab URLs before messaging', async () => {
  const harness = await loadWorker({
    paired: true,
    settings: {
      portfolioSyncEnabled: true,
      portfolioSources: { tradeHistory: true },
    },
    steamPageCredential: {
      pageAccessToken: PAGE_TOKEN,
      pageSteamId: '76561198000000000',
    },
    steamTabUrl: 'https://evil.steamcommunity.com/id/trader',
  });

  await assert.rejects(
    harness.workerModule.__testGetSteamReadProvider('76561198000000000'),
    /STEAM_SESSION_REQUIRED/,
  );
  assert.deepEqual(harness.tabMessages, []);
  assert.equal(JSON.stringify(harness.local).includes(PAGE_TOKEN), false);
});

test('cold credential probing ignores another account tab and accepts matching session proof', async () => {
  const harness = await loadWorker({
    paired: true,
    settings: {
      portfolioSyncEnabled: true,
      portfolioSources: { tradeHistory: true },
    },
    steamPageCredential: {
      pageAccessToken: PAGE_TOKEN,
      pageSteamId: '76561198000000001',
    },
    steamSessionSteamId: '76561198000000000',
  });

  const provider = await harness.workerModule.__testGetSteamReadProvider(
    '76561198000000000',
  );

  assert.equal(provider.hasUsableAccessToken?.(), false);
  assert.deepEqual(harness.fetchUrls, ['https://steamcommunity.com']);
  assert.equal(JSON.stringify(harness.local).includes(PAGE_TOKEN), false);
});

test('cold credential fallback still fails closed for a proven active account mismatch', async () => {
  const harness = await loadWorker({
    paired: true,
    settings: {
      portfolioSyncEnabled: true,
      portfolioSources: { tradeHistory: true },
    },
    steamPageCredential: {
      pageAccessToken: PAGE_TOKEN,
      pageSteamId: '76561198000000001',
    },
    steamSessionSteamId: '76561198000000001',
  });

  await assert.rejects(
    harness.workerModule.__testGetSteamReadProvider('76561198000000000'),
    /STEAM_ACCOUNT_MISMATCH/,
  );
  assert.deepEqual(harness.fetchUrls, ['https://steamcommunity.com']);
});

test('explicit portfolio opt-out destroys the memory-only provider and token', async () => {
  const scenarios: Array<{ readonly name: string; readonly patch: Bag }> = [
    {
      name: 'master switch off',
      patch: { portfolioSyncEnabled: false },
    },
    {
      name: 'all supported sources off',
      patch: {
        portfolioSources: {
          inventory: false,
          tradeOffers: false,
          tradeHistory: false,
          marketHistory: false,
        },
      },
    },
  ];

  for (const scenario of scenarios) {
    const harness = await loadWorker({
      paired: true,
      settings: {
        portfolioSyncEnabled: true,
        portfolioSources: { tradeHistory: true },
      },
      steamPageCredential: {
        pageAccessToken: PAGE_TOKEN,
        pageSteamId: '76561198000000000',
      },
    });
    const provider = await harness.workerModule.__testGetSteamReadProvider(
      '76561198000000000',
    );
    assert.equal(provider.hasUsableAccessToken?.(), true, scenario.name);

    const response = await harness.fireInternalMessage({
      type: 'UPDATE_EXTENSION_SETTINGS',
      version: 2,
      data: { patch: scenario.patch },
    }, {
      id: 'auto-sync-test',
      url: 'chrome-extension://auto-sync-test/popup/popup.html',
    });

    assert.equal(response.success, true, scenario.name);
    assert.equal(provider.hasUsableAccessToken?.(), false, scenario.name);
    assert.deepEqual(
      await harness.fireInternalMessage(
        { type: 'GET_STEAM_READ_SESSION_STATUS' },
        { id: 'auto-sync-test' },
      ),
      { ready: false },
      scenario.name,
    );
    assert.equal(
      await harness.workerModule.__testRunCredentialAssistedPortfolioSync(
        1,
        '76561198000000000',
        {
          pageAccessToken: PAGE_TOKEN,
          pageSteamId: '76561198000000000',
        },
      ),
      false,
      scenario.name,
    );
    assert.equal(CREDENTIAL_SYNC_STATE_KEY in harness.local, false, scenario.name);
  }
});

test('a scheduler-state storage failure never escapes the alarm listener', async () => {
  const harness = await loadWorker({
    paired: true,
    failAutoStateRead: true,
    settings: {
      portfolioSyncEnabled: true,
      portfolioSources: { tradeHistory: true },
    },
  });

  await assert.doesNotReject(() => harness.fireAlarm());
});

test('automatic retries use increasing bounded delays instead of creating an alarm retry storm', async () => {
  const originalNow = Date.now;
  let now = 2_000_000_000_000;
  Date.now = () => now;
  try {
    const harness = await loadWorker({
      paired: true,
      settings: {
        portfolioSyncEnabled: true,
        portfolioSources: { inventory: true },
      },
    });

    await harness.fireAlarm();
    const first = harness.local[AUTO_SYNC_STATE_KEY] as Bag;
    const firstDelay = (first.nextAttemptAt as number) - now;
    assert.equal(first.consecutiveFailures, 1);

    now = (first.nextAttemptAt as number) + 1;
    await harness.fireAlarm();
    const second = harness.local[AUTO_SYNC_STATE_KEY] as Bag;
    const secondDelay = (second.nextAttemptAt as number) - now;
    assert.equal(second.consecutiveFailures, 2);
    assert.ok(secondDelay > firstDelay, 'retry delay did not increase');
    assert.ok(secondDelay <= 6 * 60 * 60 * 1_000, 'retry delay exceeded the cap');
  } finally {
    Date.now = originalNow;
  }
});

test('a fresh exact-origin page credential bypasses an eight-failure backoff immediately', async () => {
  const originalNow = Date.now;
  const now = 2_000_000_000_000;
  Date.now = () => now;
  try {
    const harness = await loadWorker({
      paired: true,
      settings: {
        portfolioSyncEnabled: true,
        portfolioSources: { inventory: true, tradeHistory: true },
      },
      autoSyncState: {
        consecutiveFailures: 8,
        nextAttemptAt: now + 6 * 60 * 60 * 1_000,
        suspended: false,
      },
    });

    const response = await harness.fireInternalMessage({
      type: 'OFFER_STEAM_PAGE_CREDENTIAL',
      version: 1,
      data: {
        pageAccessToken: PAGE_TOKEN,
        pageSteamId: '76561198000000000',
      },
    }, {
      id: 'auto-sync-test',
      url: 'https://steamcommunity.com/id/trader/inventory',
      origin: 'https://steamcommunity.com',
    });

    assert.deepEqual(response, { accepted: true, syncTriggered: true });
    assert.deepEqual(harness.local[CREDENTIAL_SYNC_STATE_KEY], { lastAttemptedAt: now });
    assert.ok(PORTFOLIO_UI_STATUS_KEY in harness.local, 'credential did not start a sync');
    const autoState = harness.local[AUTO_SYNC_STATE_KEY] as Bag;
    assert.equal(autoState.consecutiveFailures, 8, 'bounded failure count changed shape');
    assert.ok((autoState.nextAttemptAt as number) > now);
    assert.equal(JSON.stringify(harness.local).includes(PAGE_TOKEN), false);
    assert.equal(JSON.stringify(harness.writes).includes(PAGE_TOKEN), false);
  } finally {
    Date.now = originalNow;
  }
});

test('a stale in-flight session failure cannot consume a fresh credential or its throttle', async () => {
  const originalNow = Date.now;
  const now = 2_000_000_000_000;
  Date.now = () => now;
  try {
    const harness = await loadWorker({
      paired: true,
      settings: {
        portfolioSyncEnabled: true,
        portfolioSources: { inventory: true, tradeHistory: true },
      },
      autoSyncState: {
        consecutiveFailures: 8,
        nextAttemptAt: now + 6 * 60 * 60 * 1_000,
        suspended: false,
      },
    });
    let rejectOldSync: ((reason: unknown) => void) | undefined;
    const oldSync = new Promise<void>((_resolve, reject) => {
      rejectOldSync = reject;
    });
    harness.workerModule.__testSetPortfolioSyncInFlight(oldSync);

    const recovery = harness.workerModule.__testRunCredentialAssistedPortfolioSync(
      1,
      '76561198000000000',
      {
        pageAccessToken: PAGE_TOKEN,
        pageSteamId: '76561198000000000',
      },
    );
    // The fresh credential waits for the stale verdict without occupying the
    // durable hourly slot. Otherwise the only useful retry is suppressed.
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    assert.equal(CREDENTIAL_SYNC_STATE_KEY in harness.local, false);

    rejectOldSync!(new Error('STEAM_SESSION_REQUIRED'));
    assert.equal(await recovery, true, 'the credential-backed one-shot was not started');
    assert.deepEqual(harness.local[CREDENTIAL_SYNC_STATE_KEY], { lastAttemptedAt: now });
    assert.ok(PORTFOLIO_UI_STATUS_KEY in harness.local, 'recovery did not start a fresh sync');
    assert.equal(JSON.stringify(harness.local).includes(PAGE_TOKEN), false);
    assert.equal(JSON.stringify(harness.writes).includes(PAGE_TOKEN), false);
  } finally {
    Date.now = originalNow;
  }
});

test('an unrelated in-flight failure keeps the hourly credential throttle intact', async () => {
  const originalNow = Date.now;
  const now = 2_000_000_000_000;
  Date.now = () => now;
  try {
    const harness = await loadWorker({
      paired: true,
      settings: {
        portfolioSyncEnabled: true,
        portfolioSources: { inventory: true },
      },
    });
    let rejectOldSync: ((reason: unknown) => void) | undefined;
    harness.workerModule.__testSetPortfolioSyncInFlight(new Promise<void>((_resolve, reject) => {
      rejectOldSync = reject;
    }));

    const firstOffer = harness.workerModule.__testRunCredentialAssistedPortfolioSync(
      1,
      '76561198000000000',
      {
        pageAccessToken: PAGE_TOKEN,
        pageSteamId: '76561198000000000',
      },
    );
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    assert.equal(CREDENTIAL_SYNC_STATE_KEY in harness.local, false);
    rejectOldSync!(new Error('gateway unavailable'));
    assert.equal(await firstOffer, false);
    assert.deepEqual(harness.local[CREDENTIAL_SYNC_STATE_KEY], { lastAttemptedAt: now });

    const secondOffer = await harness.workerModule.__testRunCredentialAssistedPortfolioSync(
      1,
      '76561198000000000',
      {
        pageAccessToken: PAGE_TOKEN,
        pageSteamId: '76561198000000000',
      },
    );
    assert.equal(secondOffer, false, 'the next page refresh bypassed the hourly throttle');
    assert.equal(PORTFOLIO_UI_STATUS_KEY in harness.local, false);
    assert.equal(JSON.stringify(harness.local).includes(PAGE_TOKEN), false);
    assert.equal(JSON.stringify(harness.writes).includes(PAGE_TOKEN), false);
  } finally {
    Date.now = originalNow;
  }
});

test('page credential messages from non-Steam senders are rejected before storage writes', async () => {
  const harness = await loadWorker({
    paired: true,
    settings: {
      portfolioSyncEnabled: true,
      portfolioSources: { inventory: true },
    },
  });
  const response = await harness.fireInternalMessage({
    type: 'OFFER_STEAM_PAGE_CREDENTIAL',
    version: 1,
    data: {
      pageAccessToken: PAGE_TOKEN,
      pageSteamId: '76561198000000000',
    },
  }, {
    id: 'auto-sync-test',
    url: 'https://evil.steamcommunity.com/',
    origin: 'https://evil.steamcommunity.com',
  });

  assert.deepEqual(response, { error: 'INVALID_STEAM_PAGE_SENDER' });
  assert.equal(CREDENTIAL_SYNC_STATE_KEY in harness.local, false);
});

test('device revocation suspends automatic retries until pairing state is reset', async () => {
  const now = 2_000_000_000_000;
  const harness = await loadWorker({
    paired: true,
    autoSyncState: {
      consecutiveFailures: 2,
      nextAttemptAt: null,
      suspended: true,
    },
    settings: {
      portfolioSyncEnabled: true,
      portfolioSources: { inventory: true },
    },
  });

  const transition = harness.workerModule.__testPortfolioAutoSyncFailureState(
    { consecutiveFailures: 2, nextAttemptAt: now, suspended: false },
    new Error('DEVICE_REVOKED'),
    now,
  );
  assert.deepEqual(transition, {
    consecutiveFailures: 3,
    nextAttemptAt: null,
    suspended: true,
  });

  await harness.fireAlarm();
  assert.equal(PORTFOLIO_UI_STATUS_KEY in harness.local, false);
  assert.equal(
    harness.writes.some((write) => PORTFOLIO_UI_STATUS_KEY in write),
    false,
  );

  const worker = await readFile(
    new URL('../src/background/service-worker.ts', import.meta.url),
    'utf8',
  );
  const pairingHandler = /router\.on\('PAIR_DEVICE',[\s\S]*?(?=router\.on\('UNPAIR_DEVICE')/
    .exec(worker)?.[0];
  assert.ok(pairingHandler, 'pairing handler not found');
  assert.match(pairingHandler, /await preparePortfolioPairing\(\)/);
  assert.doesNotMatch(pairingHandler, /\n\s+allowPortfolioUploadsAfterExplicitConsent\(\);/);
  assert.match(pairingHandler, /clearPortfolioAutoSyncState\(\)/);
});

test('the automatic path delegates to the same fenced sync function as the manual command', async () => {
  const worker = await readFile(
    new URL('../src/background/service-worker.ts', import.meta.url),
    'utf8',
  );
  const automaticBody = /async function performAutomaticPortfolioSync\(epoch: number\): Promise<void> \{([\s\S]*?)\n\}/
    .exec(worker)?.[1];
  assert.ok(automaticBody, 'automatic scheduler function not found');
  assert.match(automaticBody, /await runPortfolioSync\(epoch\)/);
  assert.doesNotMatch(automaticBody, /syncNow\(\)|collectPortfolioSync\(/);
  assert.match(
    worker,
    /const epoch = portfolioSyncEpoch;[\s\S]*?performAutomaticPortfolioSync\(epoch\)/,
  );
});
