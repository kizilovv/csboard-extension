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
const PORTFOLIO_UI_STATUS_KEY = 'csboard_portfolio_ui_status_v1';

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
            'export {',
            '  portfolioAutoSyncFailureState as __testPortfolioAutoSyncFailureState,',
            '  sourceStatus as __testPortfolioSourceStatus,',
            '  portfolioSyncSuccessStatus as __testPortfolioSyncSuccessStatus,',
            '  beginPortfolioUnpairFence as __testBeginPortfolioUnpairFence,',
            '  finishPortfolioUnpairAttempt as __testFinishPortfolioUnpairAttempt,',
            '  allowPortfolioUploadsAfterExplicitConsent as __testAllowPortfolioUploads,',
            '  preparePortfolioPairing as __testPreparePortfolioPairing',
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
        query: async () => [],
        sendMessage: async () => undefined,
      },
    },
    fetch: async () => {
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
    __testPortfolioSyncSuccessStatus: (
      previous: Bag,
      settings: Bag,
      result: Bag,
      attemptedAt: number,
      successfulAt: number,
    ) => Bag;
    __testBeginPortfolioUnpairFence: () => number;
    __testFinishPortfolioUnpairAttempt: () => void;
    __testAllowPortfolioUploads: () => void;
    __testPreparePortfolioPairing: () => Promise<void>;
  };

  return {
    alarms,
    local,
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
  };
}

test('portfolio automatic sync remains opt-in by default', () => {
  assert.equal(DEFAULT_POPUP_SETTINGS.portfolioSyncEnabled, false);
  assert.equal(Object.values(DEFAULT_POPUP_SETTINGS.portfolioSources).some(Boolean), false);
});

test('retired trade offers stay unavailable and never receive synthetic sync records', async () => {
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
      errorCode: 'NOT_AVAILABLE_IN_1_1',
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
        tradeOffers: true,
      },
    },
    {
      queued: 0,
      inventoryItems: 7,
      trades: 0,
      offers: 99,
      failedSources: [],
      warningCodes: ['TRADE_OFFERS_TRUNCATED'],
    },
    10,
    20,
  );
  assert.deepEqual(success.sourceRecords, { inventory: 7 });
  assert.deepEqual(success.sourceErrors, {});
  assert.deepEqual(success.sourceWarnings, {});
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
