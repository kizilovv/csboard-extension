// ============================================================
// CSBOARD — Steam Trade Hold API
// ============================================================
// Fetch items on trade hold using Steam's public inventory endpoint.
// This approach uses the Steam community inventory API which doesn't require
// an API key and works with the user's session (no token needed in extension).
//
// Alternative: Steam Web API requires API key (not stored in extension)
// For now, we rely on the Steam community inventory endpoint which includes
// trade hold status in the item descriptions.

import { createLogger } from './logger';
import { type Result, Ok, Fail } from './result';
import type { TradeHoldItem, TradeHoldStatus } from './types';
import { AssetId, ClassId, InstanceId, MarketHashName } from './types';

const logger = createLogger('steam-api');

export type { TradeHoldStatus };

// --- Constants ---

const STEAM_INVENTORY_ENDPOINT = 'https://steamcommunity.com/inventory';
const STEAM_APP_ID = '730'; // CS2
const STEAM_CONTEXT_ID = '2'; // Community items
const INVENTORY_BATCH_SIZE = 5000;

// --- Steam Inventory API ---

/**
 * Fetch inventory from Steam community endpoint.
 * This returns items with trade hold information included.
 *
 * Note: This endpoint doesn't require authentication from the extension itself
 * because Steam uses browser cookies. The user's browser has authenticated
 * with Steam, so Steam will return their inventory.
 *
 * Items on trade hold have a "tradableAfter" timestamp in the descriptions.
 */
async function fetchSteamInventory(
  steamId: string,
): Promise<Result<{
  success: boolean;
  assets: Array<{
    assetid: string;
    classid: string;
    instanceid: string;
    amount: string;
  }>;
  descriptions: Array<{
    classid: string;
    instanceid: string;
    icon_url: string;
    market_hash_name: string;
    tradable: 0 | 1;
    market_tradable_restriction?: number;
    commodity?: 0 | 1;
    descriptions?: Array<{
      type: string;
      value: string;
      color?: string;
    }>;
  }>;
}>> {
  const url = new URL(
    `${STEAM_INVENTORY_ENDPOINT}/${steamId}/${STEAM_APP_ID}/${STEAM_CONTEXT_ID}`,
  );
  url.searchParams.set('l', 'english');
  url.searchParams.set('count', String(INVENTORY_BATCH_SIZE));

  try {
    logger.debug('Fetching Steam inventory', { steamId, url: url.toString() });

    const response = await fetch(url.toString(), {
      credentials: 'include', // Send cookies to Steam
    });

    if (!response.ok) {
      return Fail(
        `Steam inventory fetch failed: HTTP ${response.status}`,
        'API_ERROR',
        response.status === 503 || response.status === 504, // Retryable
      );
    }

    const data = await response.json();

    if (!data.success) {
      return Fail('Steam inventory returned success=false', 'API_ERROR', true);
    }

    return Ok(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Steam inventory fetch error', { error: message, steamId });
    return Fail(message, 'NETWORK_ERROR', true);
  }
}

/**
 * Parse Steam's inventory response to extract trade hold items.
 * Items on hold have a "tradableAfter" timestamp in their description.
 */
function parseTradeHoldItems(
  response: {
    assets: Array<{
      assetid: string;
      classid: string;
      instanceid: string;
      amount: string;
    }>;
    descriptions: Array<{
      classid: string;
      instanceid: string;
      icon_url: string;
      market_hash_name: string;
      tradable: 0 | 1;
      market_tradable_restriction?: number;
      descriptions?: Array<{
        type: string;
        value: string;
        color?: string;
      }>;
    }>;
  },
): TradeHoldItem[] {
  const descMap = new Map<string, (typeof response.descriptions)[0]>();

  // Build lookup map: classid:instanceid -> description
  for (const desc of response.descriptions) {
    const key = `${desc.classid}:${desc.instanceid}`;
    descMap.set(key, desc);
  }

  const items: TradeHoldItem[] = [];

  for (const asset of response.assets) {
    const desc = descMap.get(`${asset.classid}:${asset.instanceid}`);
    if (!desc) continue;

    // Skip if tradable and no restrictions
    if (desc.tradable === 1 && !desc.market_tradable_restriction) {
      continue;
    }

    // Look for "tradableAfter" in descriptions
    let tradableAfterTimestamp: number | undefined;
    let tradeHoldDays: number | undefined;

    if (desc.descriptions) {
      for (const d of desc.descriptions) {
        // Steam includes trade hold info like: "Can be traded after Jul 29, 2024 @ 5:25pm (in 6 days)"
        const match = d.value.match(/Can be traded after .+ \(in (\d+) days?\)/);
        if (match && match[1]) {
          tradeHoldDays = parseInt(match[1], 10);
          // Estimate timestamp: now + days
          tradableAfterTimestamp = Math.floor(Date.now() / 1000) + tradeHoldDays * 86400;
        }

        // Alternative: "Not tradable" or "Tradable after X"
        if (d.value.includes('Not tradable') || d.value.includes('tradable after')) {
          // Marked as on hold
          if (!tradeHoldDays && d.value.includes('7 days')) {
            tradeHoldDays = 7; // Default Steam trade hold
            tradableAfterTimestamp = Math.floor(Date.now() / 1000) + 7 * 86400;
          }
        }
      }
    }

    // Only include if we detected a hold
    if (tradeHoldDays !== undefined) {
      items.push({
        assetId: AssetId(asset.assetid),
        classId: ClassId(asset.classid),
        instanceId: InstanceId(asset.instanceid),
        marketHashName: MarketHashName(desc.market_hash_name),
        iconUrl: `https://community.cloudflare.steamstatic.com/economy/image/${desc.icon_url}`,
        tradableAfter: tradableAfterTimestamp,
        tradeHoldDays,
      });
    }
  }

  return items;
}

/**
 * Public API: Get items currently on trade hold for a user.
 */
export async function getTradeHoldItems(steamId: string): Promise<Result<TradeHoldStatus>> {
  const inventoryResult = await fetchSteamInventory(steamId);

  if (!inventoryResult.ok) {
    return inventoryResult as Result<never>;
  }

  const items = parseTradeHoldItems(inventoryResult.value);

  logger.info('Trade hold items fetched', { steamId, count: items.length });

  return Ok({
    items,
    totalOnHold: items.length,
    fetchedAt: Date.now(),
  });
}

/**
 * Format remaining hold time for display.
 */
export function formatHoldTime(daysRemaining: number): string {
  if (daysRemaining <= 0) return 'Ready to trade';
  if (daysRemaining === 1) return '1 day remaining';
  return `${daysRemaining} days remaining`;
}

/**
 * Check if an item is currently on hold.
 */
export function isItemOnHold(tradableAfterTimestamp?: number): boolean {
  if (!tradableAfterTimestamp) return false;
  return Date.now() < tradableAfterTimestamp * 1000;
}
