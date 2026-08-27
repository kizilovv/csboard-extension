import {
  CSBOARD_BUFF_EVENT_NAME,
  computeBuffListingDifference,
  formatBuffRelativeAge,
  normalizeBuffInterceptEvent,
  type BuffApiKind,
} from '../../shared/buff-enhancer';
import {
  buildBuffActionLinks,
  createStaticBuffModel,
  extractBuffApiModels,
  formatCnyWithSelected,
  formatCurrencyAmount,
  resolveLocalReferencePrice,
  type BuffApiModels,
  type BuffItemModel,
  type BuffLocalPriceState,
  type BuffPriceHistorySummary,
} from './model';

const CONTROL_EVENT = 'CSBOARD_BUFF_CONTROL_V1';
const NAVIGATION_EVENT = 'CSBOARD_BUFF_NAVIGATION_V1';
const EVENT_VERSION = 1;
const SETTINGS_KEY = 'csboard_settings';
const RATES_KEY = 'csboard_exchange_rates';
const PRICES_KEY = 'csboard_all_prices';
const CSBOARD_PRICES_KEY = 'csboard_prices';
const OWNED_SELECTOR = '[data-csboard-buff-owned="true"]';
const STATIC_DATASET_LIMIT = 100_000;

type UnknownRecord = Record<string, unknown>;

interface CachedBatch {
  readonly sequence: number;
  readonly models: BuffApiModels;
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const recordMap = (value: unknown): Record<string, UnknownRecord> => {
  if (!isRecord(value)) return {};
  const result: Record<string, UnknownRecord> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isRecord(entry)) result[key] = entry;
  }
  return result;
};

const numberMap = (value: unknown): Record<string, number> => {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) result[key] = entry;
  }
  return result;
};

const defaultPriceState = (): BuffLocalPriceState => ({
  currency: 'USD',
  priceSource: 'buff163',
  exchangeRates: {},
  allPrices: {},
  csboardPrices: {},
});

let enabled = false;
let bridgeLoaded = false;
let observer: MutationObserver | null = null;
let renderTimer: number | null = null;
let renderSequence = 0;
let stateGeneration = 0;
let localPriceState: BuffLocalPriceState = defaultPriceState();
let latestHistory: BuffPriceHistorySummary | null = null;
const batches = new Map<BuffApiKind, CachedBatch>();
const knownByGoodsId = new Map<string, BuffItemModel>();
const knownByOrderId = new Map<string, BuffItemModel>();

const isBuffUrl = (rawUrl: string): boolean => {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' &&
      (url.hostname === 'buff.163.com' || url.hostname.endsWith('.buff.163.com'));
  } catch {
    return false;
  }
};

function emitControlState(): void {
  if (!bridgeLoaded) return;
  document.dispatchEvent(new CustomEvent(CONTROL_EVENT, {
    detail: { version: EVENT_VERSION, enabled },
  }));
}

function injectPageBridge(): void {
  const inject = () => {
    const root = document.documentElement;
    if (!root) return false;

    const script = document.createElement('script');
    script.id = 'csboard-buff-interceptor-loader';
    script.src = chrome.runtime.getURL('injectToPage/buffInterceptor.js');
    script.addEventListener('load', () => {
      bridgeLoaded = true;
      script.remove();
      emitControlState();
    }, { once: true });
    script.addEventListener('error', () => script.remove(), { once: true });
    root.appendChild(script);
    return true;
  };

  if (inject()) return;
  const earlyObserver = new MutationObserver(() => {
    if (!inject()) return;
    earlyObserver.disconnect();
  });
  earlyObserver.observe(document, { childList: true, subtree: true });
}

function clearRuntimeData(): void {
  batches.clear();
  knownByGoodsId.clear();
  knownByOrderId.clear();
  latestHistory = null;
}

function removeOwnedNodes(): void {
  document.querySelectorAll(OWNED_SELECTOR).forEach((node) => node.remove());
}

function disableEnhancements(): void {
  enabled = false;
  emitControlState();
  observer?.disconnect();
  observer = null;
  if (renderTimer !== null) window.clearTimeout(renderTimer);
  renderTimer = null;
  removeOwnedNodes();
  clearRuntimeData();
}

function nodeIsOwned(node: Node): boolean {
  return node instanceof Element &&
    (node.matches(OWNED_SELECTOR) || node.closest(OWNED_SELECTOR) !== null);
}

function ensureObserver(): void {
  if (!enabled || observer || !document.documentElement) return;
  observer = new MutationObserver((mutations) => {
    const hasBuffMutation = mutations.some((mutation) => {
      if (nodeIsOwned(mutation.target)) return false;
      const changed = [...mutation.addedNodes, ...mutation.removedNodes];
      return changed.length === 0 || changed.some((node) => !nodeIsOwned(node));
    });
    if (hasBuffMutation) scheduleRender();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function enableEnhancements(): void {
  if (enabled) {
    scheduleRender();
    return;
  }
  enabled = true;
  emitControlState();
  ensureObserver();
  scheduleRender();
}

async function reloadLocalState(): Promise<void> {
  const generation = ++stateGeneration;
  try {
    const values = await chrome.storage.local.get([
      SETTINGS_KEY,
      RATES_KEY,
      PRICES_KEY,
      CSBOARD_PRICES_KEY,
    ]);
    if (generation !== stateGeneration) return;

    const settings = isRecord(values[SETTINGS_KEY]) ? values[SETTINGS_KEY] : {};
    localPriceState = {
      currency: typeof settings.currency === 'string' ? settings.currency : 'USD',
      priceSource: typeof settings.priceSource === 'string' ? settings.priceSource : 'buff163',
      exchangeRates: numberMap(values[RATES_KEY]),
      allPrices: recordMap(values[PRICES_KEY]),
      csboardPrices: numberMap(values[CSBOARD_PRICES_KEY]),
    };

    /*
      The master switch outranks the per-site opt-in, and is re-read here rather
      than at boot: this function already re-runs on every settings change, so
      flipping the switch takes the overlay down (and puts it back) without a
      reload — which is what a user who just turned the extension off expects to
      see on the page he is looking at.
    */
    const enhancementsOn = settings.enhancementsEnabled !== false;
    if (enhancementsOn && settings.showBetterBuffOnBuff === true) enableEnhancements();
    else disableEnhancements();
  } catch {
    if (generation === stateGeneration) disableEnhancements();
  }
}

function scheduleRender(delayMs = 40): void {
  if (!enabled) return;
  if (renderTimer !== null) window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    renderAll();
  }, delayMs);
}

function cacheKnownModel(model: BuffItemModel): void {
  if (model.goodsId) knownByGoodsId.set(model.goodsId, model);
  if (model.orderId) knownByOrderId.set(model.orderId, model);
}

function enrichKnownModel(model: BuffItemModel, row?: Element): BuffItemModel {
  const known = (model.orderId ? knownByOrderId.get(model.orderId) : undefined) ??
    (model.goodsId ? knownByGoodsId.get(model.goodsId) : undefined);
  const domName = row ? findItemName(row) : findPageItemName();
  const name = model.name ?? known?.name ?? domName;
  if (name === model.name) return model;
  return { ...model, name };
}

function onApiEvent(event: Event): void {
  if (!enabled || !(event instanceof CustomEvent)) return;
  const normalized = normalizeBuffInterceptEvent(event.detail);
  if (!normalized) return;

  const models = extractBuffApiModels(normalized.kind, normalized.data, normalized.url);
  for (const model of models.items) cacheKnownModel(model);
  if (models.priceHistory) latestHistory = models.priceHistory;
  batches.set(normalized.kind, { sequence: ++renderSequence, models });
  scheduleRender();
}

function onNavigation(event: Event): void {
  if (!enabled || !(event instanceof CustomEvent) || !isRecord(event.detail)) return;
  if (event.detail.version !== EVENT_VERSION || typeof event.detail.url !== 'string' ||
      !isBuffUrl(event.detail.url)) return;
  removeOwnedNodes();
  clearRuntimeData();
  scheduleRender(80);
}

function uniqueElements(selectors: readonly string[]): Element[] {
  const seen = new Set<Element>();
  const result: Element[] = [];
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((element) => {
      if (seen.has(element)) return;
      seen.add(element);
      result.push(element);
    });
  }
  return result;
}

function rowsForKind(kind: BuffApiKind): Element[] {
  switch (kind) {
    case 'sell_order':
      return uniqueElements(['tr.selling']);
    case 'buy_order':
      return uniqueElements(['.list_tb_csgo > tr', '.list_tb_csgo > tbody > tr'])
        .filter((row) => row.querySelector('td') !== null &&
          !row.classList.contains('tr_gallery') &&
          !row.classList.contains('selling'));
    case 'bundle_inventory':
      return uniqueElements(['.list_tb_csgo > tr', '.list_tb_csgo > tbody > tr'])
        .filter((row) => row.querySelector('td') !== null && !row.classList.contains('tr_gallery'));
    case 'bundle_overview':
      return uniqueElements(['.list_tb_csgo > tr.tr_gallery', '.list_tb_csgo > tbody > tr.tr_gallery']);
    case 'market_goods':
    case 'market_buying':
    case 'top_bookmarked':
      return uniqueElements(['#j_list_card li']);
    case 'shop_sell_order':
      return uniqueElements(['li.my_shop_selling']);
    case 'shop_bill_order':
      return uniqueElements(['#recent-deal-container li']);
    case 'shop_featured':
      return uniqueElements(['#j_recommend li']);
    case 'item_detail':
      return uniqueElements(['.popup-inspect-cont']);
    case 'price_history':
      return [];
  }
}

function hrefsIn(element: Element): URL[] {
  const anchors = element.matches('a[href]')
    ? [element as HTMLAnchorElement]
    : Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href]'));
  const urls: URL[] = [];
  for (const anchor of anchors.slice(0, 30)) {
    try {
      urls.push(new URL(anchor.href, location.href));
    } catch {
      // Ignore malformed page-provided links.
    }
  }
  return urls;
}

function rowContainsOrderId(row: Element, orderId: string): boolean {
  const direct = [
    row.getAttribute('data-orderid'),
    row.getAttribute('data-order-id'),
    row.getAttribute('data-sell-order-id'),
    row.querySelector('[data-orderid]')?.getAttribute('data-orderid'),
    row.querySelector('[data-order-id]')?.getAttribute('data-order-id'),
    row.querySelector('[data-sell-order-id]')?.getAttribute('data-sell-order-id'),
  ];
  if (direct.some((value) => value === orderId)) return true;
  return hrefsIn(row).some((url) =>
    url.searchParams.get('sell_order_id') === orderId || url.searchParams.get('order_id') === orderId);
}

function rowContainsGoodsId(row: Element, goodsId: string): boolean {
  if (row.getAttribute('data-goods-id') === goodsId ||
      row.querySelector('[data-goods-id]')?.getAttribute('data-goods-id') === goodsId) {
    return true;
  }
  return hrefsIn(row).some((url) =>
    new RegExp(`^/goods/${goodsId}(?:/|$)`).test(url.pathname) || url.searchParams.get('goods_id') === goodsId);
}

function matchRows(models: readonly BuffItemModel[], rows: readonly Element[]): Array<[BuffItemModel, Element]> {
  const used = new Set<Element>();
  const pairs: Array<[BuffItemModel, Element]> = [];
  models.forEach((model) => {
    let row = model.orderId
      ? rows.find((candidate) => !used.has(candidate) && rowContainsOrderId(candidate, model.orderId!))
      : undefined;
    if (!row && model.goodsId) {
      row = rows.find((candidate) => !used.has(candidate) && rowContainsGoodsId(candidate, model.goodsId!));
    }
    // Events originating in the page world are observable and forgeable by
    // the visited marketplace. Never bind financial data by row position:
    // late, filtered, reordered, or synthetic responses must fail closed.
    if (!row) return;
    used.add(row);
    pairs.push([model, row]);
  });
  return pairs;
}

function resolvePanelHost(row: Element): Element {
  if (row.tagName === 'TR') {
    return row.querySelector('td:last-child') ?? row.querySelector('td') ?? row;
  }
  return row;
}

function ownedElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.className = className;
  element.dataset.csboardBuffOwned = 'true';
  return element;
}

function makeExternalLink(label: string, href: string, className = 'csboard-buff-action'): HTMLAnchorElement {
  const link = ownedElement('a', className);
  link.textContent = label;
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function appendPriceLine(
  container: Element,
  label: string,
  priceCny: number,
  reference: { cny: number; label: string } | null = null,
): void {
  const line = ownedElement('div', 'csboard-buff-price-line');
  const name = ownedElement('span', 'csboard-buff-price-label');
  name.textContent = label;
  const value = ownedElement('strong', 'csboard-buff-price-value');
  value.textContent = formatCnyWithSelected(
    priceCny,
    localPriceState.currency,
    localPriceState.exchangeRates,
  );
  line.append(name, value);

  if (reference) {
    const difference = computeBuffListingDifference(priceCny, reference.cny);
    if (difference) {
      const delta = ownedElement('span', `csboard-buff-difference csboard-buff-${difference.direction}`);
      const sign = difference.differenceCny > 0 ? '+' : '';
      const percentSign = difference.percentage > 0 ? '+' : '';
      delta.textContent = `${sign}${formatCurrencyAmount(difference.differenceCny, 'CNY')} ` +
        `(${percentSign}${difference.percentage.toFixed(2)}%) vs ${reference.label}`;
      line.appendChild(delta);
    }
  }

  container.appendChild(line);
}

function appendMetadata(panel: Element, model: BuffItemModel): void {
  const values: string[] = [];
  if (model.floatValue !== null) values.push(`Float ${model.floatValue.toFixed(8)}`);
  if (model.paintSeed !== null) values.push(`Seed ${model.paintSeed}`);
  if (model.paintIndex !== null) values.push(`Paint ${model.paintIndex}`);
  if (values.length === 0) return;
  const metadata = ownedElement('div', 'csboard-buff-metadata');
  metadata.textContent = values.join(' · ');
  panel.appendChild(metadata);
}

function appendActions(panel: Element, model: BuffItemModel): void {
  const links = buildBuffActionLinks(model);
  const actions = ownedElement('div', 'csboard-buff-actions');

  if (links.csfloat) actions.appendChild(makeExternalLink('CSFloat', links.csfloat));
  if (links.steamMarket) actions.appendChild(makeExternalLink('Steam Market', links.steamMarket));
  if (links.findSimilar) actions.appendChild(makeExternalLink('Find similar', links.findSimilar));
  if (links.goods) actions.appendChild(makeExternalLink('BUFF item', links.goods));

  if (links.share) {
    const share = ownedElement('button', 'csboard-buff-action csboard-buff-share');
    share.type = 'button';
    share.textContent = 'Share';
    share.title = 'Copy the exact, credential-free BUFF listing URL';
    share.addEventListener('click', () => {
      void navigator.clipboard.writeText(links.share!).then(() => {
        share.textContent = 'Copied';
        window.setTimeout(() => { share.textContent = 'Share'; }, 1_500);
      }).catch(() => {
        share.textContent = 'Copy failed';
        window.setTimeout(() => { share.textContent = 'Share'; }, 1_500);
      });
    });
    actions.appendChild(share);
  }

  if (model.allowBargain && model.lowestBargainPriceCny !== null) {
    const bargainTarget = links.share ?? links.goods;
    if (bargainTarget) {
      const bargain = makeExternalLink(
        `Open · BUFF-reported floor ≥ ${formatCnyWithSelected(
          model.lowestBargainPriceCny,
          localPriceState.currency,
          localPriceState.exchangeRates,
        )}`,
        bargainTarget,
        'csboard-buff-action csboard-buff-bargain',
      );
      bargain.title = 'BUFF supplied this exact bargain floor. Opening the listing does not submit an offer.';
      actions.appendChild(bargain);
    }
  }

  if (actions.childElementCount > 0) panel.appendChild(actions);
}

function renderPanel(row: Element, rawModel: BuffItemModel, source: 'api' | 'static'): void {
  const host = resolvePanelHost(row);
  const model = enrichKnownModel(rawModel, row);
  const existing = Array.from(host.children).find((child) =>
    child instanceof HTMLElement && child.classList.contains('csboard-buff-panel'));
  if (existing instanceof HTMLElement) {
    if (source === 'static' && existing.dataset.csboardBuffSource === 'api') return;
    existing.remove();
  }

  const panel = ownedElement('section', 'csboard-buff-panel');
  panel.dataset.csboardBuffSource = source;
  panel.dataset.csboardBuffKey = model.key;

  const header = ownedElement('div', 'csboard-buff-header');
  const brand = ownedElement('strong', 'csboard-buff-brand');
  brand.textContent = source === 'api' ? 'CSBOARD · BUFF-reported' : 'CSBOARD · page-derived';
  brand.title = source === 'api'
    ? 'Marketplace data reported by the visited BUFF page; not independently authenticated by CSBOARD.'
    : 'Marketplace data read from the visible BUFF page.';
  header.appendChild(brand);
  if (model.createdAtSeconds !== null) {
    const age = ownedElement('span', 'csboard-buff-age');
    age.textContent = `Listed ${formatBuffRelativeAge(model.createdAtSeconds)}`;
    header.appendChild(age);
  }
  panel.appendChild(header);

  if (model.name) {
    const title = ownedElement('div', 'csboard-buff-name');
    title.textContent = model.name;
    panel.appendChild(title);
  }

  const prices = ownedElement('div', 'csboard-buff-prices');
  const localReference = model.name
    ? resolveLocalReferencePrice(model.name, localPriceState)
    : null;
  const comparisonReference = localReference
    ? { cny: localReference.cny, label: `CSBOARD ${localReference.source}` }
    : model.buffReferencePriceCny !== null
      ? { cny: model.buffReferencePriceCny, label: 'BUFF reference' }
      : null;

  const listingEqualsSell = model.listingPriceCny !== null &&
    model.liveSellPriceCny !== null &&
    Math.abs(model.listingPriceCny - model.liveSellPriceCny) < 0.0001;
  if (model.listingPriceCny !== null) {
    appendPriceLine(
      prices,
      listingEqualsSell ? 'Live sell / listing' : 'Listing',
      model.listingPriceCny,
      comparisonReference,
    );
  }
  if (model.liveSellPriceCny !== null && !listingEqualsSell) {
    appendPriceLine(prices, 'Live sell', model.liveSellPriceCny, comparisonReference);
  }
  if (model.liveBuyPriceCny !== null) {
    appendPriceLine(prices, 'Live buy', model.liveBuyPriceCny, comparisonReference);
  }
  if (model.unitPriceCny !== null && model.unitPriceCny !== model.listingPriceCny) {
    appendPriceLine(prices, 'Unit price', model.unitPriceCny, comparisonReference);
  }
  if (model.buffReferencePriceCny !== null) {
    appendPriceLine(prices, 'BUFF reference', model.buffReferencePriceCny);
  }
  if (localReference) {
    appendPriceLine(prices, `CSBOARD reference (${localReference.source})`, localReference.cny);
  }
  if (model.steamPriceCny !== null) {
    appendPriceLine(prices, 'Steam reference', model.steamPriceCny, comparisonReference);
  }
  if (prices.childElementCount > 0) panel.appendChild(prices);

  appendMetadata(panel, model);
  appendActions(panel, model);

  if (panel.childElementCount > 1) host.appendChild(panel);
}

function renderBatch(kind: BuffApiKind, models: BuffApiModels): void {
  if (models.items.length === 0) return;
  const rows = rowsForKind(kind);
  if (rows.length === 0) return;
  for (const [model, row] of matchRows(models.items, rows)) renderPanel(row, model, 'api');
}

function priceFromText(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(/,/g, '');
  const match = normalized.match(/(?:CN¥|¥|元)?\s*(\d+(?:\.\d+)?)/);
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseBoundedDatasetJson(raw: string | undefined): UnknownRecord {
  if (!raw || raw.length > STATIC_DATASET_LIMIT) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function findPageItemName(): string | null {
  for (const selector of ['h1', '.detail-header h1', '.name-cont h3']) {
    const text = document.querySelector(selector)?.textContent?.trim();
    if (text && text.length <= 512) return text;
  }
  return null;
}

function findItemName(row: Element): string | null {
  const explicit = row.getAttribute('data-market-hash-name');
  if (explicit?.trim()) return explicit.trim().slice(0, 512);
  for (const selector of ['.name-cont h3', 'h3', 'h5', '[title]']) {
    const element = row.querySelector(selector);
    const text = (element?.getAttribute('title') || element?.textContent)?.trim();
    if (text && text.length <= 512) return text;
  }
  return null;
}

function idsFromRow(row: HTMLElement): { goodsId: string | null; orderId: string | null } {
  let goodsId = row.dataset.goodsId ?? null;
  let orderId = row.dataset.orderid ?? row.dataset.orderId ?? row.dataset.sellOrderId ?? null;
  for (const url of hrefsIn(row)) {
    if (!goodsId) goodsId = url.pathname.match(/^\/goods\/(\d{1,32})(?:\/|$)/)?.[1] ??
      url.searchParams.get('goods_id');
    if (!orderId) orderId = url.searchParams.get('sell_order_id') ?? url.searchParams.get('order_id');
  }
  return { goodsId, orderId };
}

function staticModelFromRow(row: HTMLElement): BuffItemModel {
  const assetInfo = parseBoundedDatasetJson(row.dataset.assetInfo);
  const goodsInfo = parseBoundedDatasetJson(row.dataset.goodsInfo);
  const itemInfo = parseBoundedDatasetJson(row.dataset.itemInfo);
  const assetDetails = isRecord(assetInfo.info) ? assetInfo.info : {};
  const ids = idsFromRow(row);

  return createStaticBuffModel({
    goodsId: ids.goodsId ?? goodsInfo.goods_id,
    orderId: ids.orderId ?? itemInfo.sell_order_id,
    name: findItemName(row) ?? goodsInfo.market_hash_name ?? goodsInfo.name,
    price: row.dataset.price ?? itemInfo.price ??
      priceFromText(row.querySelector('strong.f_Strong, p.hide-cny, [data-price]')?.textContent),
    createdAt: row.dataset.createdAt ?? itemInfo.created_at,
    allowBargain: itemInfo.allow_bargain,
    lowestBargainPrice: itemInfo.lowest_bargain_price,
    assetId: assetInfo.assetid,
    classId: assetInfo.classid,
    instanceId: assetInfo.instanceid,
    floatValue: assetInfo.paintwear,
    paintIndex: assetDetails.paintindex,
    paintSeed: assetDetails.paintseed,
  });
}

function renderStaticPages(): void {
  const rows = uniqueElements([
    'tr.bookmark_order',
    '#j_list_card li.my_inventory',
    '#j_list_card li.my_selling',
  ]).filter((element): element is HTMLElement => element instanceof HTMLElement);

  for (const row of rows) renderPanel(row, staticModelFromRow(row), 'static');
}

function renderPriceHistory(): void {
  if (!latestHistory) return;
  const anchor = document.querySelector('#price-history-days');
  if (!anchor) return;
  anchor.parentElement?.querySelector('.csboard-buff-price-history')?.remove();

  const panel = ownedElement('section', 'csboard-buff-price-history');
  const title = ownedElement('strong', 'csboard-buff-history-title');
  title.textContent = `CSBOARD price history${latestHistory.days ? ` · ${latestHistory.days}d` : ''}`;
  panel.appendChild(title);

  const latest = ownedElement('span', 'csboard-buff-history-value');
  const isCny = latestHistory.currency.toUpperCase() === 'CNY' || latestHistory.currencySymbol.includes('¥');
  latest.textContent = isCny
    ? `Latest ${formatCnyWithSelected(
        latestHistory.latest,
        localPriceState.currency,
        localPriceState.exchangeRates,
      )} · range ${formatCurrencyAmount(latestHistory.minimum, 'CNY')} – ${formatCurrencyAmount(latestHistory.maximum, 'CNY')}`
    : `Latest ${latestHistory.currencySymbol}${latestHistory.latest.toFixed(2)} · ` +
      `range ${latestHistory.currencySymbol}${latestHistory.minimum.toFixed(2)} – ` +
      `${latestHistory.currencySymbol}${latestHistory.maximum.toFixed(2)}`;
  panel.appendChild(latest);
  anchor.insertAdjacentElement('afterend', panel);
}

function forceNewestListings(): void {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  params.set('page', '1');
  params.set('sort_by', 'created.desc');
  params.set('csboard_reload', String(Date.now()));
  location.hash = params.toString();
}

function renderPageToolbar(): void {
  document.querySelector('.csboard-buff-toolbar')?.remove();
  const host = document.querySelector('.criteria > .l_Left') ??
    document.querySelector('#j_list_card')?.parentElement ??
    document.querySelector('.detail-pic .icon-list');
  if (!host) return;

  const toolbar = ownedElement('div', 'csboard-buff-toolbar');
  const label = ownedElement('span', 'csboard-buff-toolbar-label');
  label.textContent = `CSBOARD · ${localPriceState.currency} · ${localPriceState.priceSource}`;
  toolbar.appendChild(label);

  const newest = ownedElement('button', 'csboard-buff-action csboard-buff-newest');
  newest.type = 'button';
  newest.textContent = 'Newest listings';
  newest.title = 'Reload page 1 sorted by Buff creation time';
  newest.addEventListener('click', forceNewestListings);
  toolbar.appendChild(newest);

  const pageName = findPageItemName();
  if (pageName) {
    const model = createStaticBuffModel({ name: pageName });
    const links = buildBuffActionLinks(model);
    if (links.csfloat) toolbar.appendChild(makeExternalLink('CSFloat', links.csfloat));
    if (links.steamMarket) toolbar.appendChild(makeExternalLink('Steam Market', links.steamMarket));
    if (links.findSimilar) toolbar.appendChild(makeExternalLink('Find similar', links.findSimilar));
  }

  host.appendChild(toolbar);
}

function renderAll(): void {
  if (!enabled) return;
  const ordered = [...batches.entries()].sort((a, b) => a[1].sequence - b[1].sequence);
  for (const [kind, batch] of ordered) renderBatch(kind, batch.models);
  renderStaticPages();
  renderPriceHistory();
  renderPageToolbar();
}

document.addEventListener(CSBOARD_BUFF_EVENT_NAME, onApiEvent);
document.addEventListener(NAVIGATION_EVENT, onNavigation);
document.addEventListener('DOMContentLoaded', () => {
  ensureObserver();
  scheduleRender();
}, { once: true });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[SETTINGS_KEY] || changes[RATES_KEY] || changes[PRICES_KEY] || changes[CSBOARD_PRICES_KEY]) {
    void reloadLocalState();
  }
});

injectPageBridge();
void reloadLocalState();
