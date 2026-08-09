import type { BuffApiKind } from '../../shared/buff-enhancer';
import { buildBuffShareUrl } from '../../shared/buff-enhancer';
import { buildCsfloatSearchUrl, type CsfloatSteamTag } from '../../shared/csfloat-lookup';

type UnknownRecord = Record<string, unknown>;

export interface BuffPriceHistorySummary {
  readonly days: number | null;
  readonly latest: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly currency: string;
  readonly currencySymbol: string;
}

export interface BuffItemModel {
  readonly key: string;
  readonly kind: BuffApiKind | 'static';
  readonly goodsId: string | null;
  readonly orderId: string | null;
  readonly name: string | null;
  readonly listingPriceCny: number | null;
  readonly unitPriceCny: number | null;
  readonly liveSellPriceCny: number | null;
  readonly liveBuyPriceCny: number | null;
  readonly buffReferencePriceCny: number | null;
  readonly steamPriceCny: number | null;
  readonly createdAtSeconds: number | null;
  readonly allowBargain: boolean;
  readonly lowestBargainPriceCny: number | null;
  readonly assetId: string | null;
  readonly classId: string | null;
  readonly instanceId: string | null;
  readonly floatValue: number | null;
  readonly paintIndex: number | null;
  readonly paintSeed: number | null;
  readonly defIndex: number | null;
  readonly dopplerPhase: string | null;
  readonly tags: readonly CsfloatSteamTag[];
}

export interface BuffApiModels {
  readonly items: BuffItemModel[];
  readonly priceHistory: BuffPriceHistorySummary | null;
}

export interface BuffLocalPriceState {
  readonly currency: string;
  readonly priceSource: string;
  readonly exchangeRates: Readonly<Record<string, number>>;
  readonly allPrices: Readonly<Record<string, UnknownRecord>>;
  readonly csboardPrices: Readonly<Record<string, number>>;
}

export interface BuffReferencePrice {
  readonly cny: number;
  readonly source: string;
  readonly usdCents: number;
}

export interface BuffActionLinks {
  readonly csfloat: string | null;
  readonly steamMarket: string | null;
  readonly findSimilar: string | null;
  readonly goods: string | null;
  readonly share: string | null;
}

const PRICE_SOURCE_KEYS: Readonly<Record<string, string>> = {
  buff163: 'b',
  buff163_buy: 'bo',
  steam: 's',
  skinport: 'sp',
  dmarket: 'dm',
  csfloat: 'cf',
  youpin: 'yp',
  lisskins: 'ls',
};

const SELL_KINDS = new Set<BuffApiKind>([
  'sell_order',
  'bundle_inventory',
  'bundle_overview',
  'top_bookmarked',
  'shop_sell_order',
  'shop_featured',
]);

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const firstRecord = (...values: unknown[]): UnknownRecord => {
  for (const value of values) {
    if (isRecord(value)) return value;
  }
  return {};
};

const finiteNumber = (value: unknown): number | null => {
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const money = (value: unknown): number | null => {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
};

const boundedFloat = (value: unknown): number | null => {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && number <= 1 ? number : null;
};

const integer = (value: unknown): number | null => {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
};

const safeId = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(text) ? text : null;
};

const safeNumericId = (value: unknown): string | null => {
  const text = safeId(value);
  return text && /^\d{1,32}$/.test(text) ? text : null;
};

const nonEmptyText = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text && text.length <= 512) return text;
  }
  return null;
};

const timestampSeconds = (value: unknown): number | null => {
  const numeric = finiteNumber(value);
  if (numeric !== null && numeric > 0) {
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1_000) : Math.floor(numeric);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed / 1_000);
  }
  return null;
};

const responseData = (payload: UnknownRecord): UnknownRecord =>
  isRecord(payload.data) ? payload.data : payload;

const responseItems = (root: UnknownRecord, kind: BuffApiKind): UnknownRecord[] => {
  if (kind === 'bundle_overview' || kind === 'item_detail') return [root];
  if (!Array.isArray(root.items)) return [];
  return root.items.filter(isRecord);
};

const goodsInfoMap = (root: UnknownRecord): UnknownRecord =>
  isRecord(root.goods_infos) ? root.goods_infos : {};

const goodsInfoFor = (
  root: UnknownRecord,
  record: UnknownRecord,
  goodsId: string | null,
): UnknownRecord => {
  const inline = firstRecord(record.goods_info, record.goodsInfo);
  if (Object.keys(inline).length > 0) return inline;
  const infos = goodsInfoMap(root);
  if (goodsId && isRecord(infos[goodsId])) return infos[goodsId];
  return {};
};

const tagsFrom = (value: unknown): CsfloatSteamTag[] => {
  const candidates = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.values(value)
      : [];
  const tags: CsfloatSteamTag[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const tag: CsfloatSteamTag = {};
    for (const key of [
      'category',
      'category_name',
      'internal_name',
      'localized_category_name',
      'localized_tag_name',
      'name',
    ] as const) {
      if (typeof candidate[key] === 'string') tag[key] = candidate[key];
    }
    if (Object.keys(tag).length > 0) tags.push(tag);
  }
  return tags;
};

const defIndexFromDescriptions = (value: unknown): number | null => {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.app_data)) continue;
    const value = integer(entry.app_data.def_index);
    if (value !== null) return value;
  }
  return null;
};

const urlParam = (rawUrl: string | undefined, key: string): string | null => {
  if (!rawUrl) return null;
  try {
    return safeId(new URL(rawUrl).searchParams.get(key));
  } catch {
    return null;
  }
};

const normalizeItem = (
  kind: BuffApiKind,
  root: UnknownRecord,
  record: UnknownRecord,
  index: number,
  rawUrl?: string,
): BuffItemModel => {
  const asset = firstRecord(record.asset_info, record.assetInfo, root.steam_asset_info);
  const assetInfo = firstRecord(asset.info, root.steam_asset_info);

  const marketGoodsId = kind === 'market_goods' || kind === 'market_buying'
    ? record.id
    : null;
  const goodsId = safeNumericId(
    record.goods_id ?? asset.goods_id ?? root.goods_id ?? marketGoodsId ?? urlParam(rawUrl, 'goods_id'),
  );
  const goodsInfo = goodsInfoFor(root, record, goodsId);

  const orderId = safeId(
    kind === 'market_goods' || kind === 'market_buying'
      ? urlParam(rawUrl, 'sell_order_id')
      : record.id ?? root.id ?? urlParam(rawUrl, 'sell_order_id'),
  );

  const name = nonEmptyText(
    record.market_hash_name,
    record.marketHashName,
    goodsInfo.market_hash_name,
    record.name,
    goodsInfo.name,
    firstRecord(root.asset_info).market_hash_name,
  );

  const rawOrderPrice = money(record.price ?? root.price);
  const sellMin = money(record.sell_min_price ?? root.sell_min_price);
  const buyMax = money(record.buy_max_price ?? root.buy_max_price);
  const buffReference = money(
    record.sell_reference_price ?? record.reference_price ?? root.sell_reference_price ?? root.reference_price,
  );
  const steamPrice = money(
    record.steam_price_cny ?? goodsInfo.steam_price_cny ?? root.steam_price_cny,
  );

  const listingPriceCny = kind === 'market_goods' || kind === 'market_buying'
    ? sellMin
    : rawOrderPrice;
  const liveSellPriceCny = SELL_KINDS.has(kind)
    ? rawOrderPrice
    : sellMin;
  const liveBuyPriceCny = kind === 'buy_order' ? rawOrderPrice : buyMax;

  const bargainFloor = money(record.lowest_bargain_price ?? root.lowest_bargain_price);
  const allowBargain = (record.allow_bargain ?? root.allow_bargain) === true && bargainFloor !== null;

  const assetId = safeNumericId(asset.assetid ?? asset.asset_id);
  const classId = safeNumericId(asset.classid ?? asset.class_id);
  const instanceId = safeNumericId(asset.instanceid ?? asset.instance_id);
  const floatValue = boundedFloat(asset.paintwear ?? assetInfo.paintwear ?? record.paintwear);
  const paintIndex = integer(assetInfo.paintindex ?? asset.paintindex);
  const paintSeed = integer(assetInfo.paintseed ?? asset.paintseed);
  const defIndex = integer(assetInfo.def_index) ?? defIndexFromDescriptions(root.descriptions);
  const dopplerPhase = nonEmptyText(record.phase_name, root.phase_name);
  const goodsInfoDetails = firstRecord(goodsInfo.info);

  return {
    key: [kind, orderId ?? '', goodsId ?? '', assetId ?? '', index].join(':'),
    kind,
    goodsId,
    orderId,
    name,
    listingPriceCny,
    unitPriceCny: money(record.unit_price ?? root.unit_price),
    liveSellPriceCny,
    liveBuyPriceCny,
    buffReferencePriceCny: buffReference,
    steamPriceCny: steamPrice,
    createdAtSeconds: timestampSeconds(record.created_at ?? root.created_at),
    allowBargain,
    lowestBargainPriceCny: allowBargain ? bargainFloor : null,
    assetId,
    classId,
    instanceId,
    floatValue,
    paintIndex,
    paintSeed,
    defIndex,
    dopplerPhase,
    tags: tagsFrom(goodsInfo.tags ?? goodsInfoDetails.tags),
  };
};

const priceHistorySummary = (root: UnknownRecord): BuffPriceHistorySummary | null => {
  if (!Array.isArray(root.lines)) return null;
  const points: Array<[number, number]> = [];
  for (const line of root.lines) {
    if (!isRecord(line) || line.chart_type !== 'price' || line.allow === false || !Array.isArray(line.points)) {
      continue;
    }
    for (const point of line.points) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const time = finiteNumber(point[0]);
      const price = money(point[1]);
      if (time !== null && price !== null) points.push([time, price]);
    }
  }
  if (points.length === 0) return null;
  points.sort((a, b) => a[0] - b[0]);
  const prices = points.map((point) => point[1]);
  return {
    days: integer(root.days),
    latest: prices[prices.length - 1]!,
    minimum: Math.min(...prices),
    maximum: Math.max(...prices),
    currency: nonEmptyText(root.currency) ?? 'CNY',
    currencySymbol: nonEmptyText(root.currency_symbol) ?? 'CN¥',
  };
};

export function extractBuffApiModels(
  kind: BuffApiKind,
  payload: UnknownRecord,
  rawUrl?: string,
): BuffApiModels {
  const root = responseData(payload);
  if (kind === 'price_history') {
    return { items: [], priceHistory: priceHistorySummary(root) };
  }

  return {
    items: responseItems(root, kind).map((record, index) =>
      normalizeItem(kind, root, record, index, rawUrl)),
    priceHistory: null,
  };
}

export function convertCnyToCurrency(
  amountCny: number,
  currency: string,
  exchangeRates: Readonly<Record<string, number>>,
): number | null {
  if (!Number.isFinite(amountCny) || amountCny < 0) return null;
  const target = currency.trim().toUpperCase();
  if (target === 'CNY') return amountCny;
  const cnyPerUsd = finiteNumber(exchangeRates.CNY);
  const targetPerUsd = finiteNumber(exchangeRates[target]);
  if (cnyPerUsd === null || cnyPerUsd <= 0 || targetPerUsd === null || targetPerUsd <= 0) {
    return null;
  }
  return (amountCny / cnyPerUsd) * targetPerUsd;
}

export function formatCurrencyAmount(amount: number, currency: string): string {
  const normalized = currency.trim().toUpperCase();
  if (!Number.isFinite(amount)) return '—';
  if (normalized === 'CNY') {
    const sign = amount < 0 ? '-' : '';
    return `${sign}CN¥${Math.abs(amount).toFixed(2)}`;
  }
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: normalized,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${normalized || 'USD'} ${amount.toFixed(2)}`;
  }
}

export function formatCnyWithSelected(
  amountCny: number,
  currency: string,
  exchangeRates: Readonly<Record<string, number>>,
): string {
  const cny = formatCurrencyAmount(amountCny, 'CNY');
  if (currency.trim().toUpperCase() === 'CNY') return cny;
  const converted = convertCnyToCurrency(amountCny, currency, exchangeRates);
  return converted === null ? cny : `${cny} · ${formatCurrencyAmount(converted, currency)}`;
}

export function resolveLocalReferencePrice(
  marketHashName: string,
  state: BuffLocalPriceState,
): BuffReferencePrice | null {
  const name = marketHashName.trim();
  if (!name) return null;

  let cents: number | null = null;
  const source = state.priceSource.trim().toLowerCase();
  if (source === 'csboard') {
    cents = money(state.csboardPrices[`${name}|`]);
  } else {
    const compactKey = PRICE_SOURCE_KEYS[source];
    const row = state.allPrices[name];
    if (compactKey && isRecord(row)) cents = money(row[compactKey]);
  }

  const cnyPerUsd = finiteNumber(state.exchangeRates.CNY);
  if (cents === null || cnyPerUsd === null || cnyPerUsd <= 0) return null;
  return {
    cny: (cents / 100) * cnyPerUsd,
    source,
    usdCents: cents,
  };
}

const canonicalGoodsUrl = (goodsId: string | null): string | null => {
  if (!goodsId || !/^\d{1,32}$/.test(goodsId)) return null;
  const url = new URL(`https://buff.163.com/goods/${goodsId}`);
  url.searchParams.set('from', 'market');
  return url.toString();
};

export function buildBuffActionLinks(model: BuffItemModel): BuffActionLinks {
  const name = model.name?.trim() ?? '';
  const goods = canonicalGoodsUrl(model.goodsId);
  let share: string | null = null;
  if (model.goodsId && model.classId && model.instanceId && model.assetId && model.orderId) {
    share = buildBuffShareUrl({
      goodsId: model.goodsId,
      classId: model.classId,
      instanceId: model.instanceId,
      assetId: model.assetId,
      sellOrderId: model.orderId,
    });
  }

  if (!name) {
    return { csfloat: null, steamMarket: null, findSimilar: null, goods, share };
  }

  const steamMarket = new URL(`https://steamcommunity.com/market/listings/730/${encodeURIComponent(name)}`);
  const similar = new URL('https://buff.163.com/market/csgo');
  const similarHash = new URLSearchParams({
    tab: 'selling',
    page_num: '1',
    search: name,
  });
  similar.hash = similarHash.toString();

  return {
    csfloat: buildCsfloatSearchUrl({
      marketHashName: name,
      defIndex: model.defIndex,
      paintIndex: model.paintIndex,
      paintSeed: model.paintSeed,
      floatValue: model.floatValue,
      dopplerPhase: model.dopplerPhase,
      tags: model.tags,
    }),
    steamMarket: steamMarket.toString(),
    findSimilar: similar.toString(),
    goods,
    share,
  };
}

export function createStaticBuffModel(input: {
  goodsId?: unknown;
  orderId?: unknown;
  name?: unknown;
  price?: unknown;
  createdAt?: unknown;
  allowBargain?: unknown;
  lowestBargainPrice?: unknown;
  assetId?: unknown;
  classId?: unknown;
  instanceId?: unknown;
  floatValue?: unknown;
  paintIndex?: unknown;
  paintSeed?: unknown;
}): BuffItemModel {
  const bargainFloor = money(input.lowestBargainPrice);
  const allowBargain = input.allowBargain === true && bargainFloor !== null;
  const goodsId = safeNumericId(input.goodsId);
  const orderId = safeId(input.orderId);
  const assetId = safeNumericId(input.assetId);
  const price = money(input.price);
  return {
    key: ['static', orderId ?? '', goodsId ?? '', assetId ?? ''].join(':'),
    kind: 'static',
    goodsId,
    orderId,
    name: nonEmptyText(input.name),
    listingPriceCny: price,
    unitPriceCny: null,
    liveSellPriceCny: price,
    liveBuyPriceCny: null,
    buffReferencePriceCny: null,
    steamPriceCny: null,
    createdAtSeconds: timestampSeconds(input.createdAt),
    allowBargain,
    lowestBargainPriceCny: allowBargain ? bargainFloor : null,
    assetId,
    classId: safeNumericId(input.classId),
    instanceId: safeNumericId(input.instanceId),
    floatValue: boundedFloat(input.floatValue),
    paintIndex: integer(input.paintIndex),
    paintSeed: integer(input.paintSeed),
    defIndex: null,
    dopplerPhase: null,
    tags: [],
  };
}
