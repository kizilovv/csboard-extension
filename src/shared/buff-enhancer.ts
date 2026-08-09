// ============================================================
// CSBOARD — Buff163 enhancement boundary and pure helpers
// ============================================================
// This is an independent, behavior-compatible implementation informed by the
// public BetterBuff feature set. Keep it DOM/chrome-free so URL and payload
// validation can be exercised without trusting page-context data.

export const CSBOARD_BUFF_EVENT_NAME = 'CSBOARD_BUFF_API_RESPONSE_V1';
export const CSBOARD_BUFF_EVENT_VERSION = 1 as const;
export const MAX_BUFF_EVENT_JSON_BYTES = 1_500_000;

export type BuffApiKind =
  | 'sell_order'
  | 'buy_order'
  | 'bundle_inventory'
  | 'bundle_overview'
  | 'market_goods'
  | 'market_buying'
  | 'top_bookmarked'
  | 'shop_sell_order'
  | 'shop_bill_order'
  | 'shop_featured'
  | 'item_detail'
  | 'price_history';

export interface NormalizedBuffInterceptEvent {
  readonly version: typeof CSBOARD_BUFF_EVENT_VERSION;
  readonly status: number;
  readonly url: string;
  readonly kind: BuffApiKind;
  readonly data: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isBuffHostname = (hostname: string): boolean =>
  hostname === 'buff.163.com' || hostname.endsWith('.buff.163.com');

export function classifyBuffApiUrl(rawUrl: string): BuffApiKind | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || !isBuffHostname(url.hostname)) return null;
  const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '');

  if (path === '/api/market/goods/sell_order') return 'sell_order';
  if (path === '/api/market/goods/buy_order') return 'buy_order';
  if (path === '/api/market/goods/bundle_inventory') return 'bundle_inventory';
  if (path.startsWith('/api/market/bundle_overview/')) return 'bundle_overview';
  if (path === '/api/market/goods/buying') return 'market_buying';
  if (path === '/api/market/goods') return 'market_goods';
  if (path === '/api/market/sell_order/top_bookmarked') return 'top_bookmarked';
  if (/^\/api\/market\/shop\/[^/]+\/sell_order$/.test(path)) return 'shop_sell_order';
  if (/^\/api\/market\/shop\/[^/]+\/bill_order$/.test(path)) return 'shop_bill_order';
  if (/^\/api\/market\/shop\/[^/]+\/featured$/.test(path)) return 'shop_featured';
  if (path === '/api/market/item_desc_detail') return 'item_detail';
  if (path === '/api/market/goods/price_history') return 'price_history';
  return null;
}

function serializedSizeWithinLimit(value: unknown): boolean {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' &&
      new TextEncoder().encode(json).byteLength <= MAX_BUFF_EVENT_JSON_BYTES;
  } catch {
    return false;
  }
}

/**
 * Validate data crossing from Buff's page world into the extension world.
 * Failed/non-JSON responses, unknown endpoints, and oversized payloads fail
 * closed before any DOM adapter sees them.
 */
export function normalizeBuffInterceptEvent(
  value: unknown,
): NormalizedBuffInterceptEvent | null {
  if (!isRecord(value) ||
      value.version !== CSBOARD_BUFF_EVENT_VERSION ||
      typeof value.url !== 'string' || value.url.length > 2_048 ||
      typeof value.status !== 'number' || !Number.isInteger(value.status) ||
      value.status < 200 || value.status > 299 ||
      !isRecord(value.data)) {
    return null;
  }

  const kind = classifyBuffApiUrl(value.url);
  if (!kind || !serializedSizeWithinLimit(value.data)) return null;

  return {
    version: CSBOARD_BUFF_EVENT_VERSION,
    status: value.status,
    url: value.url,
    kind,
    data: value.data,
  };
}

export function formatBuffRelativeAge(createdAtSeconds: number, nowMs = Date.now()): string {
  if (!Number.isFinite(createdAtSeconds) || createdAtSeconds <= 0) return 'unknown';
  const elapsedMs = Math.max(0, nowMs - createdAtSeconds * 1_000);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 120) return `${minutes}m ago`;
  const hours = Math.floor(elapsedMs / 3_600_000);
  if (hours <= 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface BuffListingDifference {
  readonly differenceCny: number;
  readonly percentage: number;
  readonly direction: 'cheaper' | 'equal' | 'more_expensive';
}

const roundTwo = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export function computeBuffListingDifference(
  listingPriceCny: number,
  referencePriceCny: number,
): BuffListingDifference | null {
  if (!Number.isFinite(listingPriceCny) || listingPriceCny < 0 ||
      !Number.isFinite(referencePriceCny) || referencePriceCny <= 0) {
    return null;
  }
  const differenceCny = roundTwo(listingPriceCny - referencePriceCny);
  const percentage = roundTwo((differenceCny / referencePriceCny) * 100);
  return {
    differenceCny,
    percentage,
    direction: differenceCny < 0
      ? 'cheaper'
      : differenceCny > 0
        ? 'more_expensive'
        : 'equal',
  };
}

export interface BuffShareIdentity {
  readonly goodsId: string | number;
  readonly classId: string | number;
  readonly instanceId: string | number;
  readonly assetId: string | number;
  readonly sellOrderId: string | number;
}

const numericId = (value: string | number): string | null => {
  const text = String(value);
  return /^\d{1,32}$/.test(text) ? text : null;
};

export function buildBuffShareUrl(identity: BuffShareIdentity): string | null {
  const goodsId = numericId(identity.goodsId);
  const classId = numericId(identity.classId);
  const instanceId = numericId(identity.instanceId);
  const assetId = numericId(identity.assetId);
  const sellOrderId = String(identity.sellOrderId);
  if (!goodsId || !classId || !instanceId || !assetId ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(sellOrderId)) {
    return null;
  }

  const url = new URL(`https://buff.163.com/goods/${goodsId}`);
  url.searchParams.set('appid', '730');
  url.searchParams.set('classid', classId);
  url.searchParams.set('instanceid', instanceId);
  url.searchParams.set('assetid', assetId);
  url.searchParams.set('contextid', '2');
  url.searchParams.set('sell_order_id', sellOrderId);
  return url.toString();
}
