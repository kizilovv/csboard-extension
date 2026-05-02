// ============================================================
// CSBOARD Background Service Worker — Senior Architecture
// ============================================================
// Single responsibility: message routing + periodic tasks.
// All business logic lives in api.ts / storage.ts.
// Uses typed message router — zero `any`, zero `switch`.

import { getApiBase, SITE_BASE } from '../shared/config';
import { priceEngine, type CompactPrice } from '../shared/price-engine';
import { getAuthStatus, logout } from '../shared/api';
import { getTradeHoldItems } from '../shared/steam-api';
import { createSteamTradeOffer, fetchSteamSession } from '../shared/steam-trade';
import { createMessageRouter } from '../shared/message-bus';
import {
  runMigrations,
  setEncryptedAccessToken,
  hasEncryptedAccessToken,
  clearEncryptedAccessToken,
} from '../shared/storage';
import { createLogger } from '../shared/logger';
import { clearSessionKey } from '../shared/crypto';
import type { MarketHashName, PriceData } from '../shared/types';

const logger = createLogger('background');

// ============================================================
// Message Router (replaces monolithic switch statement)
// ============================================================

const router = createMessageRouter();

// --- Auth (cookie-based — no tokens, just check /auth/me with cookies) ---
router.on('GET_AUTH_STATUS', async () => {
  return getAuthStatus();
});

router.on('LOGOUT', async () => {
  await logout();
  return { success: true as const };
});

// --- Pricing — read from local price-engine cache (full dump from /api/extension/prices) ---
router.on('GET_PRICES', async (msg) => {
  await priceEngine.init();
  const items = msg.data.items as MarketHashName[];
  const out: Record<string, PriceData> = {};
  for (const name of items) {
    const compact = (priceEngine as unknown as { prices: Record<string, CompactPrice> }).prices[name];
    if (!compact) continue;
    out[name] = {
      marketHashName: name,
      ...(compact.s != null ? { steam: compact.s } : {}),
      ...(compact.b != null ? { buff163: compact.b } : {}),
      ...(compact.bo != null ? { buff163_buy: compact.bo } : {}),
      ...(compact.cf != null ? { csfloat: compact.cf } : {}),
      ...(compact.sp != null ? { skinport: compact.sp } : {}),
      ...(compact.dm != null ? { dmarket: compact.dm } : {}),
      ...(compact.yp != null ? { youpin: compact.yp } : {}),
      ...(compact.ls != null ? { lisskins: compact.ls } : {}),
    } as PriceData;
  }
  return out;
});

router.on('REFRESH_PRICES', async () => {
  return refreshAllPrices();
});

// --- Trade History (Steam-side only, no server sync) ---
import { fetchTradeHistory } from '../shared/trade-history';

// Force Steam to mint a fresh loyalty_webapi_token bound to the current browser IP.
// Steam embeds it as `data-loyalty_webapi_token="&quot;<JWT>&quot;"` in page HTML.
// Requires cookies; service worker has host_permissions for steamcommunity.com.
async function refreshSteamAccessToken(): Promise<string | null> {
  try {
    const resp = await fetch('https://steamcommunity.com/my/tradehistory?l=english', {
      credentials: 'include',
      headers: { Accept: 'text/html' },
    });
    if (!resp.ok) {
      logger.warn('Token refresh: Steam page fetch failed', { status: resp.status });
      return null;
    }
    const html = await resp.text();
    const match = /data-loyalty_webapi_token\s*=\s*"([^"]+)"/.exec(html);
    const raw = match?.[1];
    if (!raw) {
      logger.warn('Token refresh: loyalty_webapi_token not found in HTML');
      return null;
    }
    const token = raw.replace(/&quot;/g, '').replace(/"/g, '');
    if (!token) return null;
    await chrome.storage.local.set({ csboard_steam_access_token: token });
    logger.info('Steam access token refreshed', { length: token.length });
    return token;
  } catch (err: any) {
    logger.warn('Token refresh failed', { error: err?.message });
    return null;
  }
}

function isAuthError(err: unknown): boolean {
  return /\b(401|403)\b/.test(String((err as any)?.message || err));
}

router.on('FETCH_TRADE_HISTORY', async (msg) => {
  const { accessToken, maxTrades, startAfterTime, startAfterTradeId } = msg.data;
  try {
    return await fetchTradeHistory(accessToken, maxTrades, startAfterTime, startAfterTradeId);
  } catch (err) {
    if (!isAuthError(err)) throw err;
    logger.info('Trade history 401/403 — refreshing Steam access token and retrying');
    const fresh = await refreshSteamAccessToken();
    if (!fresh) throw new Error('Steam access token expired. Open steamcommunity.com in this browser and make sure you are logged in.');
    return await fetchTradeHistory(fresh, maxTrades, startAfterTime, startAfterTradeId);
  }
});

router.on('REFRESH_STEAM_ACCESS_TOKEN', async () => {
  const token = await refreshSteamAccessToken();
  if (!token) throw new Error('Could not refresh Steam access token. Log in at steamcommunity.com first.');
  return { accessToken: token };
});

router.on('OPEN_TRADE_HISTORY', async () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/trade-history.html') });
  return { ok: true };
});

router.on('GET_TRADE_HISTORY_SYNC_STATE', async () => {
  const data = await chrome.storage.local.get([
    'csboard_trade_history_cursor',
    'csboard_trade_history_last_sync',
  ]);
  return {
    cursor: data['csboard_trade_history_cursor'] || null,
    lastSync: data['csboard_trade_history_last_sync'] || null,
  };
});

router.on('GET_PRICE_ENGINE_STATUS', async () => {
  await priceEngine.init();
  const settings = priceEngine.getSettings();
  return {
    loaded: priceEngine.isLoaded,
    count: priceEngine.itemCount,
    lastFetched: await priceEngine.getLastFetched(),
    currency: settings.currency,
    priceSource: settings.priceSource,
  };
});

// --- Fetch inventory with asset_properties (float, stickers, certificate) ---
router.on('FETCH_INVENTORY_WITH_PROPERTIES', async (msg) => {
  const { accessToken, steamId, contextId = '2' } = msg.data as any;
  if (!accessToken || !steamId) throw new Error('Missing accessToken or steamId');

  const params = new URLSearchParams({
    access_token: accessToken,
    steamid: steamId,
    appid: '730',
    contextid: contextId,
    get_descriptions: 'true',
    get_asset_properties: 'true',
    for_trade_offer_verification: 'true',
    language: 'english',
    count: '2000',
  });

  const resp = await fetch(
    `https://api.steampowered.com/IEconService/GetInventoryItemsWithDescriptions/v1/?${params.toString()}`
  );

  if (!resp.ok) throw new Error(`Steam API error: ${resp.status}`);
  const data = (await resp.json()).response;
  if (!data) throw new Error('Empty response');

  // Build description lookup
  const descLookup: Record<string, any> = {};
  for (const desc of (data.descriptions || [])) {
    descLookup[`${desc.classid}_${desc.instanceid || '0'}`] = desc;
  }

  // Build asset_properties lookup
  const propLookup: Record<string, any> = {};
  for (const ap of (data.asset_properties || [])) {
    propLookup[ap.assetid] = ap;
  }

  // Merge assets + descriptions + properties
  const items: any[] = [];
  for (const asset of (data.assets || [])) {
    const desc = descLookup[`${asset.classid}_${asset.instanceid || '0'}`] || {};
    const assetProp = propLookup[asset.assetid];

    let floatValue: number | null = null;
    let paintSeed: number | null = null;
    let certificate: string | null = null;

    if (assetProp?.asset_properties) {
      for (const prop of assetProp.asset_properties) {
        if (prop.propertyid === 1 && prop.int_value) paintSeed = parseInt(prop.int_value, 10);
        if (prop.propertyid === 2 && prop.float_value) floatValue = parseFloat(prop.float_value);
        if (prop.propertyid === 6 && prop.string_value) certificate = prop.string_value;
      }
    }

    items.push({
      assetid: asset.assetid,
      classid: asset.classid,
      instanceid: asset.instanceid || '0',
      appid: '730',
      contextid: asset.contextid,
      amount: asset.amount,
      // Description fields
      name: desc.name || '',
      market_hash_name: desc.market_hash_name || '',
      name_color: desc.name_color || '',
      icon_url: desc.icon_url || '',
      tradable: desc.tradable ?? 0,
      marketable: desc.marketable ?? 0,
      type: desc.type || '',
      tags: desc.tags || [],
      descriptions: desc.descriptions || [],
      owner_descriptions: desc.owner_descriptions || [],
      actions: desc.actions || [],
      // Properties (float, stickers)
      floatValue,
      paintSeed,
      certificate,
    });
  }

  logger.info('Inventory fetched with properties', {
    assets: data.assets?.length || 0,
    items: items.length,
    withFloat: items.filter((i: any) => i.floatValue).length,
  });

  return { items, totalCount: data.total_inventory_count || items.length };
});

router.on('UPDATE_PRICE_SETTINGS', async (msg) => {
  await priceEngine.init();
  await priceEngine.updateSettings(msg.data as any);
  return { success: true };
});

// --- Trade Hold Token Management ---

router.on('SET_ACCESS_TOKEN', async (msg) => {
  const success = await setEncryptedAccessToken(msg.data.accessToken);
  if (success) {
    logger.info('Access token set and encrypted');
    return { success: true as const };
  }
  throw new Error('Failed to encrypt and store access token');
});

router.on('GET_ACCESS_TOKEN_STATUS', async () => {
  const isSet = await hasEncryptedAccessToken();
  return { isSet };
});

router.on('GET_TRADE_HOLD_ITEMS', async (msg) => {
  // For now, directly fetch from Steam without requiring stored token
  // The Steam community inventory endpoint uses browser cookies
  const result = await getTradeHoldItems(msg.data.steamId);

  if (result.ok) {
    return result.value;
  }

  // Return empty result on error (caller can decide to retry)
  logger.error('Failed to fetch trade hold items', {
    steamId: msg.data.steamId,
    error: result.error.message,
  });

  return {
    items: [],
    totalOnHold: 0,
    fetchedAt: Date.now(),
  };
});

router.on('CLEAR_ACCESS_TOKEN', async () => {
  await clearEncryptedAccessToken();
  await clearSessionKey();
  logger.info('Access token and session key cleared');
  return { success: true as const };
});

// --- Steam Trade Offer Creation ---

router.on('CREATE_STEAM_TRADE', async (msg) => {
  const result = await createSteamTradeOffer({
    partnerSteamId64: msg.data.partnerSteamId64,
    tradeToken: msg.data.tradeToken,
    assetIdsToGive: [...msg.data.assetIdsToGive],
    assetIdsToReceive: [...msg.data.assetIdsToReceive],
    message: msg.data.message,
  });

  if (result.ok) {
    return result.value;
  }

  logger.error('Steam trade creation failed', { error: result.error.message });
  return {
    success: false,
    error: result.error.message,
  };
});

router.on('GET_STEAM_SESSION', async () => {
  const result = await fetchSteamSession();
  if (result.ok) {
    return {
      isLoggedIn: result.value.isLoggedIn,
      steamId: result.value.steamId,
      hasSessionId: !!result.value.sessionId,
    };
  }
  return { isLoggedIn: false, hasSessionId: false };
});

// --- Steam Trade Offers (IEconService — cs2trader approach) ---

router.on('FETCH_STEAM_TRADE_OFFERS', async (msg) => {
  const { accessToken, activesOnly = 1, sent = 1, received = 1 } = msg.data;

  if (!accessToken) {
    throw new Error('No Steam access token provided');
  }

  const url = `https://api.steampowered.com/IEconService/GetTradeOffers/v1/?get_received_offers=${received}&get_sent_offers=${sent}&active_only=${activesOnly}&historical_only=0&get_descriptions=1&language=english&access_token=${accessToken}`;

  logger.info('Fetching trade offers from Steam API');

  const response = await fetch(url);
  if (!response.ok) {
    logger.error('Steam API error', { status: response.status });
    throw new Error(`Steam API error: ${response.status}`);
  }

  const body = await response.json();
  const offersResponse = body.response;

  if (!offersResponse) {
    throw new Error('Empty response from Steam API');
  }

  // Merge items with their descriptions (cs2trader pattern)
  const descriptions = offersResponse.descriptions || [];
  const allItems: Array<Record<string, unknown>> = [];

  // Process received offers
  if (offersResponse.trade_offers_received) {
    for (const offer of offersResponse.trade_offers_received) {
      if (offer.items_to_give) {
        for (let i = 0; i < offer.items_to_give.length; i++) {
          const item = offer.items_to_give[i];
          const desc = descriptions.find(
            (d: any) => d.classid === item.classid && d.instanceid === item.instanceid
          );
          allItems.push({
            ...item,
            ...(desc || {}),
            position: i,
            side: 'your',
            inOffer: offer.tradeofferid,
            accountid_other: offer.accountid_other,
            offerOrigin: 'received',
          });
        }
      }
      if (offer.items_to_receive) {
        for (let i = 0; i < offer.items_to_receive.length; i++) {
          const item = offer.items_to_receive[i];
          const desc = descriptions.find(
            (d: any) => d.classid === item.classid && d.instanceid === item.instanceid
          );
          allItems.push({
            ...item,
            ...(desc || {}),
            position: i,
            side: 'their',
            inOffer: offer.tradeofferid,
            accountid_other: offer.accountid_other,
            offerOrigin: 'received',
          });
        }
      }
    }
  }

  // Process sent offers
  if (offersResponse.trade_offers_sent) {
    for (const offer of offersResponse.trade_offers_sent) {
      if (offer.items_to_give) {
        for (let i = 0; i < offer.items_to_give.length; i++) {
          const item = offer.items_to_give[i];
          const desc = descriptions.find(
            (d: any) => d.classid === item.classid && d.instanceid === item.instanceid
          );
          allItems.push({
            ...item,
            ...(desc || {}),
            position: i,
            side: 'your',
            inOffer: offer.tradeofferid,
            accountid_other: offer.accountid_other,
            offerOrigin: 'sent',
          });
        }
      }
      if (offer.items_to_receive) {
        for (let i = 0; i < offer.items_to_receive.length; i++) {
          const item = offer.items_to_receive[i];
          const desc = descriptions.find(
            (d: any) => d.classid === item.classid && d.instanceid === item.instanceid
          );
          allItems.push({
            ...item,
            ...(desc || {}),
            position: i,
            side: 'their',
            inOffer: offer.tradeofferid,
            accountid_other: offer.accountid_other,
            offerOrigin: 'sent',
          });
        }
      }
    }
  }

  logger.info('Trade offers fetched', {
    received: offersResponse.trade_offers_received?.length || 0,
    sent: offersResponse.trade_offers_sent?.length || 0,
    totalItems: allItems.length,
    descriptions: descriptions.length,
  });

  return {
    offers: {
      trade_offers_received: offersResponse.trade_offers_received || [],
      trade_offers_sent: offersResponse.trade_offers_sent || [],
    },
    items: allItems,
  };
});

// --- Validate Steam Access Token ---

router.on('VALIDATE_STEAM_TOKEN', async (msg) => {
  const { accessToken } = msg.data;
  try {
    const resp = await fetch(
      `https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v1/?appid=730&class_count=1&classid0=3608123907&access_token=${accessToken}`
    );
    if (!resp.ok) return { valid: false };
    const body = await resp.json();
    return { valid: body.result?.success === true };
  } catch {
    return { valid: false };
  }
});

// Start listening
router.listen();

// Listen for external messages from the production CSBoard sites.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const allowedOrigins = [
    'https://csboard.com',
    'https://csboard.trade',
  ];
  const senderOrigin = sender.url ? new URL(sender.url).origin : '';
  if (!allowedOrigins.includes(senderOrigin)) {
    sendResponse({ error: 'Unauthorized origin' });
    return true;
  }

  // Route through the same handler system
  router.dispatch(message, sender, sendResponse);
  return true; // async response
});

// ============================================================
// Price Refresh Functions
// ============================================================

async function refreshAllPrices(): Promise<{ success: boolean; count: number }> {
  try {
    const etag = await priceEngine.getStoredEtag();
    const headers: Record<string, string> = {
      'Accept-Encoding': 'gzip',
    };
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    const apiBase = await getApiBase();
    const response = await fetch(`${apiBase}/extension/prices`, {
      headers,
    });

    // 304 Not Modified — prices haven't changed
    if (response.status === 304) {
      logger.debug('Prices unchanged (304)');
      return { success: true, count: priceEngine.itemCount };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const newEtag = response.headers.get('ETag') || `${Date.now()}`;

    await priceEngine.storePrices(data as Record<string, CompactPrice>, newEtag);
    logger.info('Prices refreshed', { count: Object.keys(data).length });

    return { success: true, count: Object.keys(data).length };
  } catch (err) {
    logger.error('Failed to refresh prices', { error: String(err) });
    return { success: false, count: priceEngine.itemCount };
  }
}

async function refreshExchangeRates(): Promise<void> {
  try {
    const apiBase = await getApiBase();
    const response = await fetch(`${apiBase}/extension/exchange-rates`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rates = await response.json();
    await priceEngine.storeExchangeRates(rates);
    logger.info('Exchange rates refreshed');
  } catch (err) {
    logger.error('Failed to refresh exchange rates', { error: String(err) });
  }
}

// ============================================================
// (Trade Verification Handlers removed — TB feature stripped from prod build)
// Periodic Tasks (Alarms)
// ============================================================

// Register alarms on install AND startup (MV3 service worker restarts)
chrome.runtime.onInstalled.addListener(async (details) => {
  logger.info('Extension installed/updated', { reason: details.reason });

  // Run storage migrations
  await runMigrations();

  // Register alarms
  await registerAlarms();

  // Load prices immediately
  refreshAllPrices().catch(err => logger.error('Initial price load failed', { error: String(err) }));
  refreshExchangeRates().catch(err => logger.error('Initial rates load failed', { error: String(err) }));

  // Sync settings from CSBoard site (currency, priceSource)
  syncSettingsFromSite().catch(() => {});

  if (details.reason === 'install') {
    chrome.tabs.create({ url: `${SITE_BASE}/extension/welcome` });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  logger.info('Extension startup (service worker wake)');
  await registerAlarms();
  refreshAllPrices().catch(err => logger.error('Startup price load failed', { error: String(err) }));
  refreshExchangeRates().catch(err => logger.error('Startup rates load failed', { error: String(err) }));
  syncSettingsFromSite().catch(() => {});
});

// Sync user settings (currency, priceSource) from CSBoard /auth/me
async function syncSettingsFromSite(): Promise<void> {
  try {
    const apiBase = await getApiBase();
    const response = await fetch(`${apiBase}/auth/me`, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) return;
    const user = await response.json();

    const updates: Record<string, string> = {};
    if (user.priceSource) updates.priceSource = user.priceSource;
    if (user.currency) updates.currency = user.currency;

    if (Object.keys(updates).length > 0) {
      await priceEngine.init();
      await priceEngine.updateSettings(updates as any);
      logger.info('Settings synced from site', updates);
    }
  } catch {
    // User not logged in or API unavailable — skip silently
  }
}

async function registerAlarms() {
  chrome.alarms.create('refresh-prices', { periodInMinutes: 5 });
  chrome.alarms.create('refresh-exchange-rates', { periodInMinutes: 60 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  switch (alarm.name) {
    case 'refresh-prices':
      await refreshAllPrices();
      return;
    case 'refresh-exchange-rates':
      await refreshExchangeRates();
      return;
  }
});

