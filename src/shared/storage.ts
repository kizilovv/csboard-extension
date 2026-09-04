// ============================================================
// CSBOARD — Typed Storage Wrapper
// ============================================================
// Type-safe wrapper around chrome.storage.local with:
// - Schema-validated get/set (no `any`)
// - Migration support (version-based)
// - TTL-based cache invalidation
// - Atomic batch operations

import type { StorageSchema, StorageKey, ExtensionSettings } from './types';
import { STORAGE_KEYS, DEFAULT_SETTINGS } from './types';
import { createLogger } from './logger';

const logger = createLogger('storage');

// Current storage schema version
const CURRENT_VERSION = 3;

// --- Typed Get/Set ---

/**
 * Get a single value from storage with type safety.
 * Returns undefined if key doesn't exist.
 */
export async function storageGet<K extends StorageKey>(
  key: K,
): Promise<StorageSchema[K] | undefined> {
  try {
    const result = await chrome.storage.local.get(key);
    return result[key] as StorageSchema[K] | undefined;
  } catch (err) {
    logger.error('Storage get failed', { key, error: String(err) });
    return undefined;
  }
}

/**
 * Set a single value in storage with type safety.
 */
export async function storageSet<K extends StorageKey>(
  key: K,
  value: StorageSchema[K],
): Promise<void> {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch (err) {
    logger.error('Storage set failed', { key, error: String(err) });
    throw err;
  }
}

/**
 * Remove a key from storage.
 */
export async function storageRemove(key: StorageKey | StorageKey[]): Promise<void> {
  try {
    await chrome.storage.local.remove(Array.isArray(key) ? key : [key]);
  } catch (err) {
    logger.error('Storage remove failed', { key: String(key), error: String(err) });
    throw err;
  }
}

/**
 * Get multiple values at once (batch read).
 */
export async function storageGetMany<K extends StorageKey>(
  keys: K[],
): Promise<Partial<Pick<StorageSchema, K>>> {
  try {
    const result = await chrome.storage.local.get(keys);
    return result as Partial<Pick<StorageSchema, K>>;
  } catch (err) {
    logger.error('Storage getMany failed', { keys, error: String(err) });
    return {};
  }
}

// --- Settings (with defaults) ---

export async function getSettings(): Promise<ExtensionSettings> {
  const settings = await storageGet(STORAGE_KEYS.SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    portfolioSources: {
      ...DEFAULT_SETTINGS.portfolioSources,
      ...(settings?.portfolioSources ?? {}),
    },
  };
}

export async function updateSettings(
  partial: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const current = await getSettings();
  const updated = { ...current, ...partial };
  await storageSet(STORAGE_KEYS.SETTINGS, updated);
  return updated;
}

// --- Cache Helpers (TTL-based) ---

const PRICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get a cached price. Returns undefined if expired or missing.
 */
export async function getCachedPrice(
  marketHashName: string,
): Promise<StorageSchema[typeof STORAGE_KEYS.PRICE_CACHE][string] | undefined> {
  const cache = await storageGet(STORAGE_KEYS.PRICE_CACHE);
  if (!cache) return undefined;

  const entry = cache[marketHashName];
  if (!entry) return undefined;

  // Check TTL
  if (Date.now() - entry.cachedAt > PRICE_CACHE_TTL_MS) {
    return undefined; // Expired
  }

  return entry;
}

/**
 * Set cached prices (batch).
 */
export async function setCachedPrices(
  prices: Record<string, StorageSchema[typeof STORAGE_KEYS.PRICE_CACHE][string]>,
): Promise<void> {
  const existing = (await storageGet(STORAGE_KEYS.PRICE_CACHE)) ?? {};

  // Merge and prune expired entries
  const now = Date.now();
  const merged: typeof existing = {};

  for (const [key, entry] of Object.entries(existing)) {
    if (now - entry.cachedAt < PRICE_CACHE_TTL_MS) {
      merged[key] = entry;
    }
  }

  for (const [key, entry] of Object.entries(prices)) {
    merged[key] = entry;
  }

  await storageSet(STORAGE_KEYS.PRICE_CACHE, merged);
}

// --- Migrations ---

interface Migration {
  version: number;
  up: () => Promise<void>;
}

const migrations: Migration[] = [
  // Version 1: Initial schema — just ensure defaults exist
  {
    version: 1,
    up: async () => {
      const settings = await storageGet(STORAGE_KEYS.SETTINGS);
      if (!settings) {
        await storageSet(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
      }
    },
  },
  {
    version: 2,
    up: async () => {
      // P0 migration: remove every legacy/persistent Steam credential path.
      await chrome.storage.local.remove([
        'csboard_steam_access_token',
        'csboard_encrypted_access_token',
        'csboard_access_token_iv',
      ]);
      await chrome.storage.session.remove([
        'csboard_steam_access_token',
        'csboard_session_crypto_key',
      ]);

      const current = await storageGet(STORAGE_KEYS.SETTINGS);
      await storageSet(STORAGE_KEYS.SETTINGS, {
        ...DEFAULT_SETTINGS,
        ...current,
        // Automatic site settings sync was the shipped behavior, so migration
        // preserves it. Portfolio upload remains separately opt-in and off.
        followCsboardSettings: current?.followCsboardSettings ?? true,
        showCsboardPricesOnCsfloat: current?.showCsboardPricesOnCsfloat ?? true,
        portfolioSyncEnabled: current?.portfolioSyncEnabled ?? false,
        portfolioSources: {
          ...DEFAULT_SETTINGS.portfolioSources,
          ...(current?.portfolioSources ?? {}),
        },
      });
    },
  },
  {
    version: 3,
    up: async () => {
      const current = await storageGet(STORAGE_KEYS.SETTINGS);
      await storageSet(STORAGE_KEYS.SETTINGS, {
        ...DEFAULT_SETTINGS,
        ...current,
        // Buff pages are a newly requested host surface. Existing installs
        // must opt in explicitly before we alter that marketplace UI.
        showBetterBuffOnBuff: current?.showBetterBuffOnBuff ?? false,
        portfolioSources: {
          ...DEFAULT_SETTINGS.portfolioSources,
          ...(current?.portfolioSources ?? {}),
        },
      });
    },
  },
  {
    version: 4,
    up: async () => {
      /*
        The master switch became three per-site switches.

        A profile that had the master OFF must stay dark: folding it into the
        three site flags here is the only chance to carry that intent over,
        because the popup no longer draws a control that could restore it. The
        master itself is left ON afterwards and stays a plain AND, so nothing
        that still reads it changes behaviour.
      */
      const current = await storageGet(STORAGE_KEYS.SETTINGS);
      const wasMuted = current?.enhancementsEnabled === false;

      await storageSet(STORAGE_KEYS.SETTINGS, {
        ...DEFAULT_SETTINGS,
        ...current,
        enhancementsEnabled: true,
        showOnSteam: wasMuted ? false : current?.showOnSteam ?? true,
        showCsboardPricesOnCsfloat: wasMuted
          ? false
          : current?.showCsboardPricesOnCsfloat ?? true,
        showBetterBuffOnBuff: wasMuted ? false : current?.showBetterBuffOnBuff ?? false,
        portfolioSources: {
          ...DEFAULT_SETTINGS.portfolioSources,
          ...(current?.portfolioSources ?? {}),
        },
      });
    },
  },
];

/**
 * Run pending migrations. Call on extension install/update.
 */
export async function runMigrations(): Promise<void> {
  const currentVersion =
    (await storageGet(STORAGE_KEYS.STORAGE_VERSION)) ?? 0;

  const pending = migrations
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    logger.debug('No pending migrations');
    return;
  }

  for (const migration of pending) {
    logger.info(`Running migration v${migration.version}`);
    try {
      await migration.up();
      await storageSet(STORAGE_KEYS.STORAGE_VERSION, migration.version);
    } catch (err) {
      logger.error(`Migration v${migration.version} failed`, {
        error: String(err),
      });
      throw err; // Stop migration chain on failure
    }
  }

  logger.info(`Migrations complete. Storage at v${CURRENT_VERSION}`);
}
