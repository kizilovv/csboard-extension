import {
  GatewayPayloadError,
  base64UrlEncode,
  canonicalJson,
  sha256Base64Url,
  utf8Bytes,
  isSteamId64,
  type DevicePublicIdentity,
} from '../shared/gateway-dto';

const DATABASE_NAME = 'csboard-secure-gateway';
const DATABASE_VERSION = 1;
const KEY_STORE_NAME = 'device-keys';
const STATE_STORE_NAME = 'device-state';
const ACTIVE_KEY_RECORD_ID = 'active-es256';
const REGISTRATION_RECORD_ID = 'registration';

interface StoredDeviceKeyRecord {
  readonly id: typeof ACTIVE_KEY_RECORD_ID;
  readonly deviceKeyId: string;
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JsonWebKey;
  readonly createdAt: number;
}

export interface DeviceRegistration {
  readonly id: typeof REGISTRATION_RECORD_ID;
  readonly deviceId: string;
  readonly steamId: string;
  readonly gatewayOrigin: string;
  readonly recipientKeyId: string;
  readonly pairedAt: number;
}

export interface DeviceSigningIdentity extends DevicePublicIdentity {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  readonly createdAt: number;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new GatewayPayloadError('INVALID_KEY', {
      reason: 'indexeddb-request-failed',
    }));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new GatewayPayloadError('INVALID_KEY', {
      reason: 'indexeddb-transaction-failed',
    }));
    transaction.onabort = () => reject(new GatewayPayloadError('INVALID_KEY', {
      reason: 'indexeddb-transaction-aborted',
    }));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(KEY_STORE_NAME)) {
        database.createObjectStore(KEY_STORE_NAME, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STATE_STORE_NAME)) {
        database.createObjectStore(STATE_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new GatewayPayloadError('INVALID_KEY', {
      reason: 'indexeddb-open-failed',
    }));
    request.onblocked = () => reject(new GatewayPayloadError('INVALID_KEY', {
      reason: 'indexeddb-open-blocked',
    }));
  });
}

function isP256Key(key: unknown, usage: KeyUsage, mustBeExtractable: boolean): key is CryptoKey {
  if (typeof key !== 'object' || key === null) return false;
  const candidate = key as CryptoKey;
  const algorithm = candidate.algorithm as EcKeyAlgorithm | undefined;
  return candidate.type === (usage === 'sign' ? 'private' : 'public') &&
    candidate.extractable === mustBeExtractable &&
    candidate.usages.includes(usage) &&
    algorithm?.name === 'ECDSA' &&
    algorithm.namedCurve === 'P-256';
}

function isSafePublicJwk(jwk: JsonWebKey): boolean {
  return jwk.kty === 'EC' && jwk.crv === 'P-256' &&
    typeof jwk.x === 'string' && typeof jwk.y === 'string' &&
    jwk.d === undefined;
}

function toIdentity(record: StoredDeviceKeyRecord): DeviceSigningIdentity {
  if (!isP256Key(record.privateKey, 'sign', false) ||
      !isP256Key(record.publicKey, 'verify', true) ||
      !isSafePublicJwk(record.publicJwk) ||
      !/^[A-Za-z0-9_-]{22,86}$/.test(record.deviceKeyId)) {
    throw new GatewayPayloadError('INVALID_KEY', { reason: 'invalid-stored-device-key' });
  }
  return {
    deviceKeyId: record.deviceKeyId,
    publicJwk: record.publicJwk,
    publicKey: record.publicKey,
    privateKey: record.privateKey,
    createdAt: record.createdAt,
  };
}

async function generateDeviceKeyRecord(): Promise<StoredDeviceKeyRecord> {
  const generated = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const keyPair = generated as CryptoKeyPair;
  if (!isP256Key(keyPair.privateKey, 'sign', false) ||
      !isP256Key(keyPair.publicKey, 'verify', true)) {
    throw new GatewayPayloadError('INVALID_KEY', { reason: 'non-extractable-key-generation-failed' });
  }

  const exported = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  if (!isSafePublicJwk(exported)) {
    throw new GatewayPayloadError('INVALID_KEY', { reason: 'invalid-generated-public-key' });
  }
  const publicJwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: exported.x,
    y: exported.y,
    ext: true,
    key_ops: ['verify'],
    alg: 'ES256',
  };
  const deviceKeyId = await sha256Base64Url(utf8Bytes(canonicalJson(publicJwk)));
  return {
    id: ACTIVE_KEY_RECORD_ID,
    deviceKeyId,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicJwk,
    createdAt: Date.now(),
  };
}

export class IndexedDbDeviceKeyStore {
  private pendingIdentity: Promise<DeviceSigningIdentity> | undefined;

  constructor(private readonly factory: IDBFactory = globalThis.indexedDB) {
    if (!factory) {
      throw new GatewayPayloadError('INVALID_KEY', { reason: 'indexeddb-unavailable' });
    }
  }

  async getExistingIdentity(): Promise<DeviceSigningIdentity | null> {
    const database = await openDatabase(this.factory);
    try {
      const transaction = database.transaction(KEY_STORE_NAME, 'readonly');
      const record = await requestResult(
        transaction.objectStore(KEY_STORE_NAME).get(ACTIVE_KEY_RECORD_ID),
      ) as StoredDeviceKeyRecord | undefined;
      await transactionDone(transaction);
      return record ? toIdentity(record) : null;
    } finally {
      database.close();
    }
  }

  async getOrCreateIdentity(): Promise<DeviceSigningIdentity> {
    if (!this.pendingIdentity) {
      this.pendingIdentity = this.loadOrCreateIdentity().finally(() => {
        this.pendingIdentity = undefined;
      });
    }
    return this.pendingIdentity;
  }

  private async loadOrCreateIdentity(): Promise<DeviceSigningIdentity> {
    try {
      const existing = await this.getExistingIdentity();
      if (existing) return existing;
    } catch (error) {
      if (!(error instanceof GatewayPayloadError) || error.code !== 'INVALID_KEY') throw error;
      await this.deleteIdentity();
    }

    const record = await generateDeviceKeyRecord();
    const database = await openDatabase(this.factory);
    try {
      const transaction = database.transaction(KEY_STORE_NAME, 'readwrite');
      transaction.objectStore(KEY_STORE_NAME).put(record);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
    return toIdentity(record);
  }

  async getRegistration(): Promise<DeviceRegistration | null> {
    const database = await openDatabase(this.factory);
    try {
      const transaction = database.transaction(STATE_STORE_NAME, 'readonly');
      const record = await requestResult(
        transaction.objectStore(STATE_STORE_NAME).get(REGISTRATION_RECORD_ID),
      ) as DeviceRegistration | undefined;
      await transactionDone(transaction);
      if (!record) return null;
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(record.deviceId) ||
          !isSteamId64(record.steamId) ||
          !record.gatewayOrigin.startsWith('https://') ||
          !/^[A-Za-z0-9._-]{1,128}$/.test(record.recipientKeyId)) {
        throw new GatewayPayloadError('INVALID_KEY', { reason: 'invalid-device-registration' });
      }
      return record;
    } finally {
      database.close();
    }
  }

  async saveRegistration(registration: Omit<DeviceRegistration, 'id'>): Promise<void> {
    const origin = new URL(registration.gatewayOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== registration.gatewayOrigin ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(registration.deviceId) ||
        !isSteamId64(registration.steamId) ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(registration.recipientKeyId)) {
      throw new GatewayPayloadError('INVALID_KEY', { reason: 'invalid-device-registration' });
    }
    const record: DeviceRegistration = { id: REGISTRATION_RECORD_ID, ...registration };
    const database = await openDatabase(this.factory);
    try {
      const transaction = database.transaction(STATE_STORE_NAME, 'readwrite');
      transaction.objectStore(STATE_STORE_NAME).put(record);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async deleteIdentity(): Promise<void> {
    const database = await openDatabase(this.factory);
    try {
      const transaction = database.transaction(
        [KEY_STORE_NAME, STATE_STORE_NAME],
        'readwrite',
      );
      transaction.objectStore(KEY_STORE_NAME).delete(ACTIVE_KEY_RECORD_ID);
      transaction.objectStore(STATE_STORE_NAME).delete(REGISTRATION_RECORD_ID);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async clearRegistration(): Promise<void> {
    const database = await openDatabase(this.factory);
    try {
      const transaction = database.transaction(STATE_STORE_NAME, 'readwrite');
      transaction.objectStore(STATE_STORE_NAME).delete(REGISTRATION_RECORD_ID);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async sign(data: Uint8Array): Promise<{ deviceKeyId: string; signature: string }> {
    const identity = await this.getOrCreateIdentity();
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      identity.privateKey,
      bytes.buffer,
    );
    return { deviceKeyId: identity.deviceKeyId, signature: base64UrlEncode(signature) };
  }
}
