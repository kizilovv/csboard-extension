import {
  GatewayPayloadError,
  type GatewayEncryptedEnvelope,
} from '../shared/gateway-dto';
import { assertGatewayEncryptedEnvelope } from './gateway-crypto';

const OUTBOX_STORAGE_KEY = 'csboard_gateway_encrypted_outbox_v1';
const MAX_OUTBOX_ENTRIES = 100;
const MAX_ATTEMPTS = 8;
const BASE_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 30 * 60 * 1_000;

export type GatewayDeliveryFailureCode =
  | 'network-unavailable'
  | 'gateway-rate-limited'
  | 'gateway-temporary-error'
  | 'gateway-rejected'
  | 'device-revoked'
  | 'retry-limit';

export interface GatewayOutboxRecord {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly envelope: GatewayEncryptedEnvelope;
  readonly createdAt: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastFailureCode?: GatewayDeliveryFailureCode;
}

export interface GatewayOutboxStorage {
  read(): Promise<unknown>;
  write(records: readonly GatewayOutboxRecord[]): Promise<void>;
}

export interface GatewayEnvelopeSenderResult {
  readonly accepted: boolean;
  readonly retryable: boolean;
  readonly failureCode?: GatewayDeliveryFailureCode;
  readonly retryAfterMs?: number;
}

export interface GatewayOutboxDrainResult {
  readonly delivered: number;
  readonly deferred: number;
  readonly failed: number;
  readonly remaining: number;
  readonly terminalFailureCodes: readonly GatewayDeliveryFailureCode[];
}

function defaultStorage(): GatewayOutboxStorage {
  return {
    async read() {
      const result = await chrome.storage.local.get(OUTBOX_STORAGE_KEY);
      return result[OUTBOX_STORAGE_KEY];
    },
    async write(records) {
      await chrome.storage.local.set({ [OUTBOX_STORAGE_KEY]: records });
    },
  };
}

function parseRecord(value: unknown): GatewayOutboxRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-outbox-record' });
  }
  const record = value as Partial<GatewayOutboxRecord>;
  if (typeof record.requestId !== 'string' || typeof record.idempotencyKey !== 'string' ||
      typeof record.createdAt !== 'number' || typeof record.attempts !== 'number' ||
      typeof record.nextAttemptAt !== 'number' || !record.envelope) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-outbox-record' });
  }
  assertGatewayEncryptedEnvelope(record.envelope);
  if (record.requestId !== record.envelope.protected.requestId ||
      record.idempotencyKey !== record.envelope.protected.idempotencyKey ||
      !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.attempts) ||
      record.attempts < 0 || record.attempts > MAX_ATTEMPTS ||
      !Number.isSafeInteger(record.nextAttemptAt)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-outbox-record' });
  }
  return record as GatewayOutboxRecord;
}

async function readRecords(storage: GatewayOutboxStorage): Promise<GatewayOutboxRecord[]> {
  const raw = await storage.read();
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_OUTBOX_ENTRIES) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-outbox' });
  }
  return raw.map(parseRecord);
}

export async function enqueueGatewayEnvelope(
  envelope: GatewayEncryptedEnvelope,
  options: {
    readonly storage?: GatewayOutboxStorage;
    readonly now?: () => number;
  } = {},
): Promise<{ readonly queued: boolean; readonly size: number }> {
  // The sealer already performed the pre-encryption denylist scan. This second
  // boundary validates that only a structurally valid encrypted envelope is persisted.
  assertGatewayEncryptedEnvelope(envelope);
  const storage = options.storage ?? defaultStorage();
  const records = await readRecords(storage);
  const duplicate = records.find((record) =>
    record.requestId === envelope.protected.requestId ||
    record.idempotencyKey === envelope.protected.idempotencyKey);
  if (duplicate) return { queued: false, size: records.length };
  if (records.length >= MAX_OUTBOX_ENTRIES) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'outbox-full' });
  }
  const now = options.now?.() ?? Date.now();
  records.push({
    requestId: envelope.protected.requestId,
    idempotencyKey: envelope.protected.idempotencyKey,
    envelope,
    createdAt: now,
    attempts: 0,
    nextAttemptAt: now,
  });
  await storage.write(records);
  return { queued: true, size: records.length };
}

export async function getGatewayOutboxStatus(
  storage: GatewayOutboxStorage = defaultStorage(),
): Promise<{ readonly pending: number; readonly retrying: number }> {
  const records = await readRecords(storage);
  return {
    pending: records.length,
    retrying: records.filter((record) => record.attempts > 0).length,
  };
}

function retryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** Math.max(0, attempts - 1)));
}

export async function drainGatewayOutbox(
  send: (envelope: GatewayEncryptedEnvelope) => Promise<GatewayEnvelopeSenderResult>,
  options: {
    readonly storage?: GatewayOutboxStorage;
    readonly now?: () => number;
  } = {},
): Promise<GatewayOutboxDrainResult> {
  const storage = options.storage ?? defaultStorage();
  const now = options.now?.() ?? Date.now();
  const records = await readRecords(storage);
  const remaining: GatewayOutboxRecord[] = [];
  let delivered = 0;
  let deferred = 0;
  let failed = 0;
  const terminalFailureCodes: GatewayDeliveryFailureCode[] = [];

  for (const record of records) {
    const expiresAtMs = record.envelope.protected.expiresAt * 1_000;
    if (expiresAtMs <= now) {
      failed += 1;
      terminalFailureCodes.push(record.lastFailureCode ?? 'retry-limit');
      continue;
    }
    if (record.nextAttemptAt > now) {
      remaining.push(record);
      deferred += 1;
      continue;
    }

    let result: GatewayEnvelopeSenderResult;
    try {
      result = await send(record.envelope);
    } catch {
      result = {
        accepted: false,
        retryable: true,
        failureCode: 'network-unavailable',
      };
    }

    if (result.accepted) {
      delivered += 1;
      continue;
    }

    const attempts = record.attempts + 1;
    if (!result.retryable || attempts >= MAX_ATTEMPTS) {
      failed += 1;
      terminalFailureCodes.push(result.failureCode ?? 'retry-limit');
      continue;
    }
    const requestedDelay = result.retryAfterMs ?? retryDelay(attempts);
    const safeDelay = Math.max(BASE_RETRY_DELAY_MS, Math.min(MAX_RETRY_DELAY_MS, requestedDelay));
    if (now + safeDelay >= expiresAtMs) {
      failed += 1;
      terminalFailureCodes.push(result.failureCode ?? 'retry-limit');
      continue;
    }
    remaining.push({
      ...record,
      attempts,
      nextAttemptAt: now + safeDelay,
      lastFailureCode: result.failureCode ?? 'gateway-temporary-error',
    });
    deferred += 1;
  }

  await storage.write(remaining);
  return {
    delivered,
    deferred,
    failed,
    remaining: remaining.length,
    terminalFailureCodes,
  };
}

export async function clearGatewayOutbox(
  storage: GatewayOutboxStorage = defaultStorage(),
): Promise<void> {
  await storage.write([]);
}
