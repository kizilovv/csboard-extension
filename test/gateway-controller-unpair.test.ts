import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { GatewayController } from '../src/background/gateway-controller.ts';
import type { IndexedDbDeviceKeyStore } from '../src/background/device-key-store.ts';
import type { ProtectedGatewayClient } from '../src/background/gateway-client.ts';
import type { SteamReadSessionProvider } from '../src/background/steam-read-session-provider.ts';

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('successful syncs retain the same memory-only Steam session for the next run', async (t) => {
  const originalChrome = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = originalChrome;
  });

  const local: Record<string, unknown> = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: local[key] };
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, values);
        },
      },
    },
  } as typeof chrome;

  let usable = true;
  let forgotSession = 0;
  let inventoryReads = 0;
  const provider: SteamReadSessionProvider = {
    async readInventoryContext(contextId) {
      assert.equal(usable, true, 'the previous run discarded the in-memory session');
      inventoryReads += 1;
      return { contextId, complete: true, items: [] };
    },
    async readRecentTrades() {
      return { complete: true, trades: [], icons: {}, nameColors: {} };
    },
    async readTradeOffers() {
      return { complete: true, offers: [] };
    },
    async readTradeOffersForDisplay() {
      return { complete: true, offers: [] };
    },
    offerAccessToken() {},
    hasUsableAccessToken() {
      return usable;
    },
    forgetSession() {
      forgotSession += 1;
      usable = false;
    },
  };

  const rawFixture = JSON.parse(await readFile(
    new URL('../tests/fixtures/gateway-portfolio-sync-v1.json', import.meta.url),
    'utf8',
  )) as { envelope: Record<string, unknown> & { protected: Record<string, unknown> } };
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const envelope = structuredClone(rawFixture.envelope);
  envelope.protected.issuedAt = nowSeconds;
  envelope.protected.expiresAt = nowSeconds + 120;

  const registration = {
    id: 'registration' as const,
    deviceId: 'device_1234567890',
    steamId: '76561198000000000',
    gatewayOrigin: 'https://csboard.com',
    recipientKeyId: 'gateway-key-v1',
    pairedAt: 1,
  };
  const controller = new GatewayController({
    client: {
      origin: 'https://csboard.com',
      async seal() {
        return structuredClone(envelope);
      },
      async sendEnvelope() {
        return { accepted: true, retryable: false };
      },
    } as unknown as ProtectedGatewayClient,
    deviceKeys: {
      async getRegistration() {
        return registration;
      },
    } as unknown as IndexedDbDeviceKeyStore,
    extensionVersion: '1.1.0',
    createSteamProvider: () => provider,
    getEnabledSources: async () => ({
      inventory: true,
      tradeHistory: false,
      tradeOffers: false,
    }),
  });

  await controller.syncNow();
  await controller.syncNow();

  assert.equal(inventoryReads, 4);
  assert.equal(forgotSession, 0);
  assert.equal(usable, true);
});

test('unpair fences a portfolio sync paused in Steam collection', async (t) => {
  const originalChrome = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = originalChrome;
  });

  const outboxKey = 'csboard_gateway_encrypted_outbox_v1';
  const local: Record<string, unknown> = {};
  const outboxWrites: unknown[] = [];
  globalThis.chrome = {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: local[key] };
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, values);
          if (outboxKey in values) outboxWrites.push(structuredClone(values[outboxKey]));
        },
      },
    },
  } as typeof chrome;

  let registration = {
    id: 'registration' as const,
    deviceId: 'device_1234567890',
    steamId: '76561198000000000',
    gatewayOrigin: 'https://csboard.com',
    recipientKeyId: 'gateway-key-v1',
    pairedAt: 1,
  };
  let identityDeleted = false;
  const deviceKeys = {
    async getRegistration() {
      return identityDeleted ? null : registration;
    },
    async deleteIdentity() {
      identityDeleted = true;
    },
  } as unknown as IndexedDbDeviceKeyStore;

  const collectionStarted = deferred();
  const releaseCollection = deferred();
  let inventoryReads = 0;
  let forgotSession = 0;
  const provider: SteamReadSessionProvider = {
    async readInventoryContext(contextId) {
      inventoryReads += 1;
      if (inventoryReads === 2) collectionStarted.resolve();
      await releaseCollection.promise;
      return { contextId, complete: true, items: [] };
    },
    async readRecentTrades() {
      return { complete: true, trades: [], icons: {}, nameColors: {} };
    },
    async readTradeOffers() {
      return { complete: true, offers: [] };
    },
    async readTradeOffersForDisplay() {
      return { complete: true as const, offers: [] };
    },
    offerAccessToken() {},
    forgetSession() {
      forgotSession += 1;
    },
  };

  const sealedOperations: string[] = [];
  const sentOperations: string[] = [];
  const client = {
    origin: 'https://csboard.com',
    async seal(_payload: unknown, operation: string) {
      sealedOperations.push(operation);
      return { operation };
    },
    async sendEnvelope(envelope: { operation?: string }) {
      sentOperations.push(envelope.operation ?? 'unknown');
      return { accepted: true, retryable: false };
    },
  } as unknown as ProtectedGatewayClient;

  const controller = new GatewayController({
    client,
    deviceKeys,
    extensionVersion: '1.1.0',
    createSteamProvider: () => provider,
    getEnabledSources: async () => ({
      inventory: true,
      tradeHistory: false,
      tradeOffers: false,
    }),
  });

  const sync = controller.syncNow();
  const cancelled = assert.rejects(sync, /portfolio-sync-cancelled-by-unpair/);
  await collectionStarted.promise;

  // `unpair()` must synchronously raise the fence before this paused collector
  // is released. Awaiting unpair first would deadlock a correct implementation,
  // because unpair deliberately waits for the fenced run to settle before it
  // clears the outbox and sends the revoke envelope.
  const unpair = controller.unpair();
  await assert.rejects(
    controller.pair('CSF-2345-6789-ABCD-EFGH'),
    /unpair-in-progress/,
  );
  releaseCollection.resolve();

  await cancelled;
  await unpair;

  assert.deepEqual(sealedOperations, ['device.unpair']);
  assert.deepEqual(sentOperations, ['device.unpair']);
  assert.equal(identityDeleted, true);
  assert.equal(forgotSession, 1);
  assert.deepEqual(local[outboxKey], []);
  assert.equal(outboxWrites.some((records) => Array.isArray(records) && records.length > 0), false);
});

test('unpair waits for an in-flight pair and revokes the resulting device', async (t) => {
  const originalChrome = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = originalChrome;
  });

  const local: Record<string, unknown> = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: local[key] };
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, values);
        },
      },
    },
  } as typeof chrome;

  let registration: {
    id: 'registration';
    deviceId: string;
    steamId: string;
    gatewayOrigin: string;
    recipientKeyId: string;
    pairedAt: number;
  } | null = null;
  const deviceKeys = {
    async getRegistration() {
      return registration;
    },
    async getOrCreateIdentity() {
      return {
        deviceKeyId: 'device_key_12345678901234567890',
        publicJwk: {
          kty: 'EC',
          crv: 'P-256',
          x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        },
      };
    },
    async saveRegistration(next: Omit<NonNullable<typeof registration>, 'id'>) {
      registration = { id: 'registration', ...next };
    },
    async deleteIdentity() {
      registration = null;
    },
  } as unknown as IndexedDbDeviceKeyStore;

  const confirmStarted = deferred();
  const releaseConfirm = deferred();
  const operations: string[] = [];
  const client = {
    origin: 'https://csboard.com',
    async confirmPair() {
      confirmStarted.resolve();
      await releaseConfirm.promise;
      return {
        deviceId: 'device_1234567890',
        steamId: '76561198000000000',
        gatewayOrigin: 'https://csboard.com',
        recipientKeyId: 'gateway-key-v1',
        pairedAt: 1,
      };
    },
    async seal(_payload: unknown, operation: string) {
      operations.push(`seal:${operation}`);
      return { operation };
    },
    async sendEnvelope(envelope: { operation?: string }) {
      operations.push(`send:${envelope.operation ?? 'unknown'}`);
      return { accepted: true, retryable: false };
    },
  } as unknown as ProtectedGatewayClient;

  const controller = new GatewayController({
    client,
    deviceKeys,
    extensionVersion: '1.1.0',
    createSteamProvider: () => {
      throw new Error('sync provider must not be used');
    },
    getEnabledSources: async () => ({
      inventory: false,
      tradeHistory: false,
      tradeOffers: false,
    }),
  });

  const pair = controller.pair('CSF-2345-6789-ABCD-EFGH');
  await confirmStarted.promise;
  const unpair = controller.unpair();
  releaseConfirm.resolve();

  await pair;
  await unpair;

  assert.equal(registration, null);
  assert.deepEqual(operations, [
    'seal:device.unpair',
    'send:device.unpair',
  ]);
});

test('remote revoke failure still destroys the local pairing identity', async (t) => {
  const originalChrome = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = originalChrome;
  });

  const local: Record<string, unknown> = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: local[key] };
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, values);
        },
      },
    },
  } as typeof chrome;

  let registration: Record<string, unknown> | null = {
    id: 'registration',
    deviceId: 'device_1234567890',
    steamId: '76561198000000000',
    gatewayOrigin: 'https://csboard.com',
    recipientKeyId: 'gateway-key-v1',
    pairedAt: 1,
  };
  const deviceKeys = {
    async getRegistration() {
      return registration;
    },
    async deleteIdentity() {
      registration = null;
    },
  } as unknown as IndexedDbDeviceKeyStore;
  const client = {
    origin: 'https://csboard.com',
    async seal(_payload: unknown, operation: string) {
      return { operation };
    },
    async sendEnvelope() {
      return {
        accepted: false,
        retryable: true,
        failureCode: 'network-error',
      };
    },
  } as unknown as ProtectedGatewayClient;
  const controller = new GatewayController({
    client,
    deviceKeys,
    extensionVersion: '1.1.0',
    createSteamProvider: () => {
      throw new Error('sync provider must not be used');
    },
    getEnabledSources: async () => ({
      inventory: false,
      tradeHistory: false,
      tradeOffers: false,
    }),
  });

  await assert.rejects(controller.unpair(), /unpair-not-confirmed/);
  assert.equal(registration, null);
  assert.deepEqual(local.csboard_gateway_encrypted_outbox_v1, []);
});

test('outbox cleanup failure cannot prevent local identity destruction', async (t) => {
  const originalChrome = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = originalChrome;
  });

  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          return {};
        },
        async set() {
          throw new Error('storage unavailable');
        },
      },
    },
  } as typeof chrome;

  let identityDeleted = false;
  const deviceKeys = {
    async getRegistration() {
      return {
        id: 'registration' as const,
        deviceId: 'device_1234567890',
        steamId: '76561198000000000',
        gatewayOrigin: 'https://csboard.com',
        recipientKeyId: 'gateway-key-v1',
        pairedAt: 1,
      };
    },
    async deleteIdentity() {
      identityDeleted = true;
    },
  } as unknown as IndexedDbDeviceKeyStore;
  const client = {
    origin: 'https://csboard.com',
    async seal(_payload: unknown, operation: string) {
      return { operation };
    },
    async sendEnvelope() {
      return { accepted: true, retryable: false };
    },
  } as unknown as ProtectedGatewayClient;
  const controller = new GatewayController({
    client,
    deviceKeys,
    extensionVersion: '1.1.0',
    createSteamProvider: () => {
      throw new Error('sync provider must not be used');
    },
    getEnabledSources: async () => ({
      inventory: false,
      tradeHistory: false,
      tradeOffers: false,
    }),
  });

  await assert.rejects(controller.unpair(), /local-unpair-cleanup-failed/);
  assert.equal(identityDeleted, true);
});
