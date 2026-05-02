// ============================================================
// Trade History — fetch from Steam, enrich with prices, sync to server
// ============================================================

import { priceEngine } from './price-engine';
import { getDopplerInfo } from './dopplerPhases';
import { createLogger } from './logger';

const logger = createLogger('trade-history');

// ============================================================
// Types
// ============================================================

export interface TradeHistoryItem {
  appid: string;
  contextid: string;
  assetid: string;
  classid: string;
  instanceid: string;
  marketHashName: string;
  name: string;
  iconUrl?: string;
  nameColor?: string;
  priceUsd?: number;
  priceSource?: string;
}

export interface EnrichedTrade {
  steamTradeId: string;
  partnerSteamId: string;
  partnerName?: string;
  partnerAvatar?: string;
  timeInit: number;
  itemsGiven: TradeHistoryItem[];
  itemsReceived: TradeHistoryItem[];
  totalGivenUsd: number;
  totalReceivedUsd: number;
  profitLossUsd: number;
  priceSource: string;
}

export interface TradeHistoryResult {
  trades: EnrichedTrade[];
  totalTrades: number;
  hasMore: boolean;
  lastTradeId?: string;
  lastTradeTime?: number;
}

// ============================================================
// Fetch trade history from Steam IEconService API
// ============================================================

export async function fetchTradeHistory(
  accessToken: string,
  maxTrades = 100,
  startAfterTime = 0,
  startAfterTradeId = '0',
): Promise<TradeHistoryResult> {
  await priceEngine.init();

  const url = `https://api.steampowered.com/IEconService/GetTradeHistory/v1/?` +
    `max_trades=${maxTrades}` +
    `&start_after_time=${startAfterTime}` +
    `&start_after_tradeid=${startAfterTradeId}` +
    `&get_descriptions=1` +
    `&include_total=1` +
    `&language=english` +
    `&access_token=${accessToken}`;

  logger.info('Fetching trade history from Steam', { maxTrades, startAfterTradeId });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Steam API error: ${response.status}`);
  }

  const body = await response.json();
  const resp = body.response;

  if (!resp || !resp.trades) {
    return { trades: [], totalTrades: resp?.total_trades || 0, hasMore: false };
  }

  // Build description lookup (classid_instanceid → description)
  const descMap: Record<string, any> = {};
  for (const desc of (resp.descriptions || [])) {
    descMap[`${desc.classid}_${desc.instanceid || '0'}`] = desc;
  }

  const settings = priceEngine.getSettings();
  const trades: EnrichedTrade[] = [];

  for (const trade of resp.trades) {
    let totalGiven = 0;
    let totalReceived = 0;

    const itemsGiven = enrichItems(trade.assets_given || [], descMap, settings);
    const itemsReceived = enrichItems(trade.assets_received || [], descMap, settings);

    for (const item of itemsGiven) totalGiven += item.priceUsd || 0;
    for (const item of itemsReceived) totalReceived += item.priceUsd || 0;

    trades.push({
      steamTradeId: trade.tradeid,
      partnerSteamId: trade.steamid_other,
      timeInit: trade.time_init,
      itemsGiven,
      itemsReceived,
      totalGivenUsd: Math.round(totalGiven * 100) / 100,
      totalReceivedUsd: Math.round(totalReceived * 100) / 100,
      profitLossUsd: Math.round((totalReceived - totalGiven) * 100) / 100,
      priceSource: settings.priceSource,
    });
  }

  const lastTrade = trades[trades.length - 1];

  logger.info('Trade history fetched', {
    trades: trades.length,
    total: resp.total_trades,
    hasMore: !!resp.more,
  });

  return {
    trades,
    totalTrades: resp.total_trades || 0,
    hasMore: !!resp.more,
    lastTradeId: lastTrade?.steamTradeId,
    lastTradeTime: lastTrade?.timeInit,
  };
}

// ============================================================
// Enrich items with descriptions + prices
// ============================================================

function enrichItems(
  assets: any[],
  descMap: Record<string, any>,
  settings: { priceSource: string },
): TradeHistoryItem[] {
  return assets.map((asset) => {
    const desc = descMap[`${asset.classid}_${asset.instanceid || '0'}`] || {};
    const marketHashName = desc.market_hash_name || '';

    // Doppler phase pricing
    const dopplerInfo = desc.icon_url ? getDopplerInfo(desc.icon_url) : null;
    const dopplerPhase = dopplerInfo?.name;
    const priceData = priceEngine.getPrice(marketHashName, dopplerPhase);
    return {
      appid: String(asset.appid || '730'),
      contextid: String(asset.contextid || '2'),
      assetid: String(asset.assetid || ''),
      classid: String(asset.classid || ''),
      instanceid: String(asset.instanceid || '0'),
      marketHashName,
      name: desc.name || '',
      iconUrl: desc.icon_url,
      nameColor: desc.name_color,
      priceUsd: priceData?.raw,
      priceSource: settings.priceSource,
    };
  });
}

// ============================================================
// Quick sync: fetch only recent trades (1 page = 50 trades)
// Server-side sync is disabled in csboard-extension-prod — backend has no
// /trade-history/sync route on production.
// ============================================================

export async function fullSync(accessToken: string): Promise<{
  synced: number;
  skipped: number;
  totalTrades: number;
}> {
  const result = await fetchTradeHistory(accessToken, 50);

  await chrome.storage.local.set({
    csboard_trade_history_last_sync: Date.now(),
  });

  logger.info('Quick sync complete (Steam-only, no server push)', {
    fetched: result.trades.length,
    totalTrades: result.totalTrades,
  });

  return { synced: 0, skipped: result.trades.length, totalTrades: result.totalTrades };
}
