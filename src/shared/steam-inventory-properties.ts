// ============================================================
// CSBOARD — CS2 asset properties from a public Steam inventory
// ============================================================
// Steam serves `asset_properties` (wear rating, pattern template, item
// certificate) from the PUBLIC community inventory endpoint, for any profile,
// with no access token and no trade session. That is the only source of an
// opponent's float outside a trade window:
//
//   * IEconService/GetTradeOffers returns asset ids and descriptions but never
//     properties, and ignores `get_asset_properties`.
//   * /tradeoffer/new/partnerinventory/ answers 401 "missing required
//     parameter" unless the caller sits on a trade page, which is why the
//     offers LIST could never reuse the single-offer page's partner path.
//
// The endpoint is rate limited, so callers must queue and cache; a private
// profile answers 403 and must not be retried in a loop.

import { parseSteamAssetProperties, type ParsedSteamAssetProperties } from './steam-asset-properties';
import { storageGet, storageSet } from './storage';
import { STORAGE_KEYS, type CachedAssetProperties } from './types';
import { createLogger } from './logger';

const logger = createLogger('steam-inventory-properties');

const INVENTORY_PAGE_SIZE = 2000;
/** A partner holding more than this is not worth six seconds of Steam quota. */
const MAX_PAGES = 3;
const CACHE_ENTRY_LIMIT = 4000;

export type InventoryPropertiesOutcome =
  | { readonly status: 'ok'; readonly properties: Map<string, ParsedSteamAssetProperties> }
  /** Private, delisted or logged-out inventory — retrying changes nothing. */
  | { readonly status: 'unavailable' }
  /** Steam is rate limiting this client; the same id can be tried again later. */
  | { readonly status: 'throttled' }
  | { readonly status: 'error' };

interface SteamInventoryPage {
  readonly assets?: readonly { readonly assetid?: unknown }[];
  readonly asset_properties?: unknown;
  readonly more_items?: number;
  readonly last_assetid?: string;
}

const isSteamId64 = (value: string): boolean => /^\d{17}$/.test(value);

const assetIdOf = (value: unknown): string | null => {
  const normalized = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return /^\d{1,32}$/.test(normalized) ? normalized : null;
};

export const hasAnyProperty = (properties: ParsedSteamAssetProperties): boolean =>
  properties.floatValue !== undefined || properties.paintSeed !== undefined ||
  properties.defIndex !== undefined || properties.paintIndex !== undefined;

function collectPage(
  page: SteamInventoryPage,
  into: Map<string, ParsedSteamAssetProperties>,
  seenAssetIds: Set<string>,
): void {
  for (const asset of page.assets ?? []) {
    const assetId = assetIdOf(asset?.assetid);
    if (assetId) seenAssetIds.add(assetId);
  }

  const wrappers = Array.isArray(page.asset_properties)
    ? page.asset_properties
    : Object.values((page.asset_properties ?? {}) as Record<string, unknown>);

  for (const wrapper of wrappers) {
    if (typeof wrapper !== 'object' || wrapper === null) continue;
    const assetId = assetIdOf((wrapper as Record<string, unknown>)['assetid']);
    if (!assetId) continue;
    const parsed = parseSteamAssetProperties(wrapper);
    if (hasAnyProperty(parsed)) into.set(assetId, parsed);
  }
}

/**
 * Read one profile's CS2 asset properties, keyed by asset id.
 *
 * `neededAssetIds` stops paging as soon as every wanted asset has been seen,
 * so a partner with a 5000-item inventory still costs one request when the
 * offer's items sit on the first page.
 */
export async function fetchInventoryAssetProperties(
  steamId: string,
  options: {
    readonly neededAssetIds?: ReadonlySet<string>;
    readonly signal?: AbortSignal;
  } = {},
): Promise<InventoryPropertiesOutcome> {
  if (!isSteamId64(steamId)) return { status: 'error' };

  const properties = new Map<string, ParsedSteamAssetProperties>();
  const seenAssetIds = new Set<string>();
  let startAssetId: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`https://steamcommunity.com/inventory/${steamId}/730/2`);
    url.searchParams.set('l', 'english');
    url.searchParams.set('count', String(INVENTORY_PAGE_SIZE));
    if (startAssetId) url.searchParams.set('start_assetid', startAssetId);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        credentials: 'include',
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      logger.warn('Inventory read failed', { steamId, error: String(error) });
      return properties.size > 0 ? { status: 'ok', properties } : { status: 'error' };
    }

    if (response.status === 429) {
      return properties.size > 0 ? { status: 'ok', properties } : { status: 'throttled' };
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return properties.size > 0 ? { status: 'ok', properties } : { status: 'unavailable' };
    }
    if (!response.ok) {
      return properties.size > 0 ? { status: 'ok', properties } : { status: 'error' };
    }

    let body: SteamInventoryPage | null = null;
    try {
      body = (await response.json()) as SteamInventoryPage;
    } catch {
      body = null;
    }
    if (!body) return properties.size > 0 ? { status: 'ok', properties } : { status: 'error' };

    collectPage(body, properties, seenAssetIds);

    const needed = options.neededAssetIds;
    if (needed && [...needed].every((id) => seenAssetIds.has(id))) break;
    if (!body.more_items || !body.last_assetid) break;
    startAssetId = body.last_assetid;
  }

  return { status: 'ok', properties };
}

// --- Persistent asset-id cache -------------------------------------------
// Only the assets a page actually asked about are stored, so this stays a few
// hundred entries instead of whole partner inventories. A float is immutable,
// so entries never expire on age alone — they are only trimmed for size.

export async function readCachedAssetProperties(): Promise<Map<string, ParsedSteamAssetProperties>> {
  const stored = await storageGet(STORAGE_KEYS.ASSET_PROPERTY_CACHE);
  const cache = new Map<string, ParsedSteamAssetProperties>();
  if (!stored) return cache;

  for (const [assetId, entry] of Object.entries(stored)) {
    if (!entry || typeof entry !== 'object') continue;
    cache.set(assetId, {
      floatValue: entry.f,
      paintSeed: entry.s,
      defIndex: entry.d,
      paintIndex: entry.p,
    });
  }
  return cache;
}

export async function rememberAssetProperties(
  entries: ReadonlyMap<string, ParsedSteamAssetProperties>,
): Promise<void> {
  if (entries.size === 0) return;

  const stored: Record<string, CachedAssetProperties> = (await storageGet(STORAGE_KEYS.ASSET_PROPERTY_CACHE)) ?? {};
  const now = Date.now();

  for (const [assetId, parsed] of entries) {
    if (!hasAnyProperty(parsed)) continue;
    stored[assetId] = {
      ...(parsed.floatValue !== undefined ? { f: parsed.floatValue } : {}),
      ...(parsed.paintSeed !== undefined ? { s: parsed.paintSeed } : {}),
      ...(parsed.defIndex !== undefined ? { d: parsed.defIndex } : {}),
      ...(parsed.paintIndex !== undefined ? { p: parsed.paintIndex } : {}),
      t: now,
    };
  }

  const assetIds = Object.keys(stored);
  if (assetIds.length > CACHE_ENTRY_LIMIT) {
    const oldestFirst = assetIds.sort((a, b) => (stored[a]?.t ?? 0) - (stored[b]?.t ?? 0));
    for (const assetId of oldestFirst.slice(0, assetIds.length - CACHE_ENTRY_LIMIT)) {
      delete stored[assetId];
    }
  }

  await storageSet(STORAGE_KEYS.ASSET_PROPERTY_CACHE, stored);
}
