// ============================================================
// CSBOARD Content Script — CSFloat Market
// ============================================================
// Injected on: csfloat.com/*
//
// Architecture (from BetterFloat):
// 1. Inject fetch/XHR interceptor into page context
// 2. CSFloat API responses dispatched as CustomEvent
// 3. Content script caches items with market_hash_name
// 4. MutationObserver detects item-card → dequeue matching item
// 5. Inject buff bid/ask from priceEngine cache
//
// All prices from local cache — zero external API calls.

import { priceEngine, CURRENCIES } from '../../shared/price-engine';
import { getBuffLink } from '../../shared/items';
import { createLogger } from '../../shared/logger';

const logger = createLogger('csfloat');

// ============================================================
// Queue — BetterFloat pattern: reset per API response, dequeue per card
// ============================================================

interface CSFItem {
  market_hash_name?: string;  // inventory format
  item_name?: string;         // inventory format alt
  float_value?: number;
  phase?: string;
  asset_id?: string;
  d?: string;
  stickers?: any[];
}

interface CSFAuctionDetails {
  expires_at?: string;
  min_next_bid?: number;
  reserve_price?: number;
  top_bid?: {
    price: number; // cents
    state?: string;
  };
}

interface CSFListing {
  id: string;
  item: {
    market_hash_name: string;
    float_value?: number;
    phase?: string;
  };
  price: number; // cents — for auctions, equals reserve_price
  type?: 'buy_now' | 'auction';
  auction_details?: CSFAuctionDetails;
}

class ItemQueue {
  private items: CSFListing[] = [];
  reset(items: CSFListing[]) { this.items = items; }
  dequeue(): CSFListing | undefined { return this.items.shift(); }
  get length() { return this.items.length; }
}

// Main listings queue — populated from listings/watchlist/stall/recommended/etc.
const listingsQueue = new ItemQueue();
// Separate queue for similar items (item-detail page lower section).
// Must be separate from listingsQueue so the popup similar-items fetch doesn't
// clobber whichever grid we navigated from.
const similarQueue = new ItemQueue();
// Single-item cache populated by /v1/listings/<id> (item-detail GET).
let popupItem: CSFListing | null = null;

// Inventory cache for /sell page — BetterFloat pattern: cache once, look up by name+float.
// NEVER use queue-order matching here: CSFloat sorts/filters the /sell grid independently
// of the inventory array returned by /api/v1/me/inventory, so dequeue desyncs prices.
let inventoryItems: CSFItem[] = [];

// ============================================================
// CSFloat site currency — intercepted from /v1/me + /v1/meta/exchange-rates.
// Display all prices in this currency so our overlay matches whatever the
// site is showing (user setting in extension popup is ignored on CSFloat).
// ============================================================
let csfCurrency = 'USD';
let csfRates: Record<string, number> = {}; // lowercase code → rate from USD

// Try to seed from a localStorage entry that the site (or BetterFloat) may have left.
try {
  const cached = localStorage.getItem('currency_rates');
  if (cached) {
    const parsed = JSON.parse(cached);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) csfRates = parsed;
  }
} catch {}

function formatCsfPrice(usdCents: number): { raw: number; display: string } {
  const code = csfCurrency.toUpperCase();
  const rateKey = code.toLowerCase();
  const rate = csfRates[rateKey];
  // Non-USD currency selected but no rate yet → fall back to USD display so we
  // don't show a wrong number with the new symbol (e.g. "€18.97" while still in USD).
  if (code !== 'USD' && (rate === undefined || rate === null)) {
    const nf0 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return { raw: usdCents / 100, display: `$${nf0.format(usdCents / 100)}` };
  }
  const r = rate ?? 1;
  const converted = (usdCents / 100) * r;
  const info = CURRENCIES[code] || CURRENCIES['USD']!;
  const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return { raw: converted, display: `${info.sign}${nf.format(converted)}` };
}

// ============================================================
// Live refresh — repaint every overlay span/badge from its USD-cents data
// attribute when csfCurrency or csfRates change. No re-render, no DOM rebuild.
// Spans get `data-csboard-cents` (positive USD cents); diff badges get
// `data-csboard-diff-cents` (signed USD cents).
// ============================================================
let refreshScheduled = false;
function scheduleRefresh(): void {
  if (refreshScheduled) return;
  refreshScheduled = true;
  // Coalesce — currency change typically arrives with rates / followup fetches
  // back-to-back; one repaint at the end of the microtask is enough.
  Promise.resolve().then(() => {
    refreshScheduled = false;
    refreshOverlayCurrencies();
  });
}

function refreshOverlayCurrencies(): void {
  document.querySelectorAll<HTMLElement>('[data-csboard-cents]').forEach((el) => {
    const cents = parseInt(el.dataset['csboardCents'] || '0', 10);
    if (!Number.isFinite(cents) || cents <= 0) return;
    el.textContent = formatCsfPrice(cents).display;
  });
  document.querySelectorAll<HTMLElement>('[data-csboard-diff-cents]').forEach((el) => {
    const diffCents = parseInt(el.dataset['csboardDiffCents'] || '0', 10);
    if (!Number.isFinite(diffCents)) return;
    const sign = diffCents >= 0 ? '+' : '-';
    el.textContent = `${sign}${formatCsfPrice(Math.abs(diffCents)).display}`;
  });
}

// ============================================================
// API Interception — inject into page context
// ============================================================

function injectInterceptor(): void {
  // Inject as external file to bypass CSFloat's strict CSP (no inline scripts)
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injectToPage/csfloatInterceptor.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

// ============================================================
// Process intercepted API responses
// ============================================================

function handleApiResponse(url: string, data: any): void {
  const path = url.split('?')[0] ?? url;

  // /v1/me/inventory — sell page inventory (array of Item, no id/price wrapper)
  if (path.includes('/v1/me/inventory') || path.endsWith('/me/inventory')) {
    const items = Array.isArray(data) ? data : data?.data;
    if (Array.isArray(items) && items.length > 0 && (items[0]?.market_hash_name || items[0]?.item_name)) {
      inventoryItems = items;
      logger.info('Inventory cached for sell page', { count: items.length });
    }
    return;
  }

  // /v1/meta/exchange-rates — currency conversion table (USD-based, lowercase keys)
  if (path.includes('/v1/meta/exchange-rates')) {
    const rates = data?.data ?? data;
    if (rates && typeof rates === 'object' && !Array.isArray(rates)) {
      csfRates = rates as Record<string, number>;
      try { localStorage.setItem('currency_rates', JSON.stringify(csfRates)); } catch {}
      logger.debug('CSF exchange rates cached', { count: Object.keys(csfRates).length });
      scheduleRefresh();
    }
    return;
  }

  // /v1/me family — user prefs (currency etc.). Catches GET /v1/me, PATCH /v1/me,
  // and any /v1/me/preferences endpoint that returns a `preferences.currency`.
  // Skip /v1/me/inventory and /v1/me/buy-orders which are handled above.
  if (/\/v1\/me(\b|\/)/.test(path) && !path.includes('/inventory') && !path.includes('/buy-orders')) {
    const candidates = [data, (data as any)?.user, (data as any)?.data, (data as any)?.preferences];
    for (const c of candidates) {
      const cur = c?.preferences?.currency ?? c?.currency;
      if (typeof cur === 'string' && cur.length >= 3) {
        if (cur !== csfCurrency) {
          logger.debug('CSF currency changed', { from: csfCurrency, to: cur });
          csfCurrency = cur;
          scheduleRefresh();
        }
        break;
      }
    }
    return;
  }

  // /v1/listings/<id>/similar — separate queue (don't clobber main listings)
  if (/\/v1\/listings\/[^/]+\/similar$/.test(path)) {
    const arr = Array.isArray(data) ? data : data?.data;
    if (Array.isArray(arr)) {
      const valid = arr.filter((l: any) => l?.id && l?.item?.market_hash_name) as CSFListing[];
      if (valid.length > 0) similarQueue.reset(valid);
    }
    return;
  }

  // /v1/listings/<id>/buy-orders — buy orders array, NOT listings; ignore for queue
  if (/\/v1\/listings\/[^/]+\/buy-orders/.test(path)) return;

  // /v1/history/... — sales graph / sales table; ignore for queue
  if (path.includes('/v1/history/')) return;

  // /v1/listings/<id> — single popup item (item-detail GET)
  if (/\/v1\/listings\/[^/]+$/.test(path) && data?.id && data?.item?.market_hash_name) {
    popupItem = data as CSFListing;
    return;
  }

  // Listing arrays — primary queue
  // Covers: /v1/listings?, /v1/listings/recommended, /v1/listings/unique-items,
  // /v1/me/listings, /v1/me/watchlist, /v1/users/:id/stall
  const listings = Array.isArray(data) ? data : data?.data;
  if (Array.isArray(listings)) {
    const valid = listings.filter((l: any) => l?.id && l?.item?.market_hash_name) as CSFListing[];
    if (valid.length > 0) {
      listingsQueue.reset(valid);
      logger.debug('Queue reset', { url: path, count: valid.length });
    }
  }
}

// ============================================================
// Detect sell page
// ============================================================

function isSellPage(): boolean {
  return location.pathname === '/sell';
}

// ============================================================
// Parse item name + float from card DOM (for sell page matching)
// ============================================================

function parseCardDOM(card: Element): { name: string; float?: number } | null {
  // BetterFloat pattern: app-item-name > .item-name
  const nameContainer = card.querySelector('app-item-name');
  let name = nameContainer?.querySelector('.item-name')?.textContent?.replace(/\n/g, '').trim();

  if (!name) name = card.querySelector('.item-name')?.textContent?.replace(/\n/g, '').trim();

  if (!name) {
    const img = card.querySelector('img.item-img, img[alt]') as HTMLImageElement;
    if (img?.alt) name = img.alt;
  }

  if (!name) return null;

  const wearEl = card.querySelector('item-float-bar .wear');
  const floatText = wearEl?.textContent?.trim();
  const float = floatText ? parseFloat(floatText) : undefined;

  return { name, float: float && !isNaN(float) ? float : undefined };
}

// ============================================================
// Match inventory item by name + float (sell page)
// ============================================================

// BetterFloat parity: match by name + float_value (inventory JSON uses `item_name`,
// which is the bare name without condition — same as DOM .item-name text).
// Float match uses 12-dp precision (BetterFloat uses Decimal.toDP(12)), which
// comfortably covers float_value full precision.
function findInventoryItem(name: string, float?: number): CSFItem | null {
  for (const item of inventoryItems) {
    const itemName = item.item_name || item.market_hash_name;
    if (itemName !== name) continue;
    if (float !== undefined && item.float_value !== undefined) {
      if (Math.abs(item.float_value - float) < 1e-12) return item;
    } else {
      // No float on either side — name match is sufficient (non-skin items etc.)
      return item;
    }
  }
  return null;
}

// ============================================================
// Card placement detection — what kind of context is this card in?
// ============================================================

enum CardKind { GRID, PAGE, SIMILAR, SELL }

function detectCardKind(card: Element): CardKind {
  if (isSellPage()) return CardKind.SELL;
  // Similar-items strip on item-detail page
  if (card.closest('app-similar-items')) return CardKind.SIMILAR;
  // Main item-detail card (popout). BetterFloat checks width="100%" attr; we
  // also accept any item-card under <item-detail> that's not in app-similar-items.
  if (card.closest('item-detail')) return CardKind.PAGE;
  if (card.getAttribute('width')?.includes('100%')) return CardKind.PAGE;
  return CardKind.GRID;
}

function urlListingId(): string | null {
  const m = location.pathname.match(/^\/item\/([^/?#]+)/);
  return m ? m[1]! : null;
}

// ============================================================
// Match card to listing — context-aware lookup (no FIFO clobbering)
// ============================================================

function getItemData(card: Element): CSFListing | null {
  // Already processed — read from element
  const stored = card.getAttribute('data-csboard');
  if (stored) {
    try { return JSON.parse(stored); } catch {}
  }

  const kind = detectCardKind(card);

  // --- Sell page: match by name/float from inventory cache ---
  if (kind === CardKind.SELL) {
    const parsed = parseCardDOM(card);
    if (parsed) {
      const invItem = findInventoryItem(parsed.name, parsed.float);
      if (invItem) {
        const fakeListing: CSFListing = {
          id: invItem.asset_id || '',
          item: {
            market_hash_name: invItem.market_hash_name || invItem.item_name || parsed.name,
            float_value: invItem.float_value,
            phase: invItem.phase,
          },
          price: 0, // no price on sell page — item is not listed yet
        };
        card.setAttribute('data-csboard', JSON.stringify(fakeListing));
        return fakeListing;
      }
    }
    return null;
  }

  // --- Item-detail (popout / /item/:id main card) ---
  if (kind === CardKind.PAGE) {
    const wantedId = urlListingId();
    let item: CSFListing | null = null;
    if (popupItem && (!wantedId || popupItem.id === wantedId)) {
      item = popupItem;
    } else if (popupItem) {
      // popupItem from a previous detail — accept anyway, better than nothing
      item = popupItem;
    }
    if (item) {
      card.classList.add('item-' + item.id);
      card.setAttribute('data-csboard', JSON.stringify(item));
      return item;
    }
    return null;
  }

  // --- Similar items strip ---
  if (kind === CardKind.SIMILAR) {
    const item = similarQueue.dequeue();
    if (item) {
      card.classList.add('item-' + item.id);
      card.setAttribute('data-csboard', JSON.stringify(item));
      return item;
    }
    return null;
  }

  // --- Grid (marketplace, watchlist, stall) ---
  const item = listingsQueue.dequeue();
  if (item) {
    card.classList.add('item-' + item.id);
    card.setAttribute('data-csboard', JSON.stringify(item));
    return item;
  }
  return null;
}

// ============================================================
// Price overlay injection (BetterFloat style)
// ============================================================

// Real Buff163 favicon, bundled with the extension. Listed in
// `web_accessible_resources` for csfloat.com so the page can load it.
const BUFF_ICON = chrome.runtime.getURL('icons/buff163.png');

// Throttled miss-logger — prints each unmatched name once per page so you can see
// in DevTools which items our price blob doesn't cover (new items / name mismatch).
const loggedMisses = new Set<string>();
function logPriceMiss(marketHashName: string, phase?: string) {
  const key = phase ? `${marketHashName} | ${phase}` : marketHashName;
  if (loggedMisses.has(key)) return;
  loggedMisses.add(key);
  logger.warn('No Buff price in cache', { name: key, cacheSize: priceEngine.itemCount });
}

function injectPriceOverlay(card: Element, listing: CSFListing): void {
  if (card.querySelector('.csboard-buff-a')) return;

  const marketHashName = listing.item.market_hash_name;
  const phase = listing.item.phase;

  const { bid, buyOrder } = priceEngine.getBuffPrices(marketHashName, phase);
  if (!bid && !buyOrder) {
    logPriceMiss(marketHashName, phase);
    return;
  }

  const buffLink = getBuffLink(marketHashName);
  const onSellPage = isSellPage();

  // Reference (Buff) price in USD cents — same currency unit as listing.price.
  // Note: `bid` here is item.b = Buff min-ask listing; `buyOrder` is item.bo = bid side.
  const refCents = bid?.cents ?? buyOrder?.cents ?? 0;

  // Auction-aware effective price:
  //   - buy_now: listing.price (cents)
  //   - auction with top_bid: auction_details.top_bid.price (current high bid)
  //   - auction without bids: listing.price (== reserve_price)
  const auction = listing.auction_details;
  const isAuction = listing.type === 'auction' || !!auction;
  const hasBid = !!auction?.top_bid?.price;
  const itemCents = isAuction
    ? (auction?.top_bid?.price ?? auction?.reserve_price ?? listing.price)
    : listing.price;

  // Reformat Buff line in CSFloat site currency so our overlay matches the
  // currency the user sees on the page (their extension setting is ignored here).
  const orderDisplay = buyOrder?.cents ? formatCsfPrice(buyOrder.cents).display : '';
  const listingDisplay = bid?.cents ? formatCsfPrice(bid.cents).display : '';

  // --- Difference badge ---
  // Skip on sell page (no listing price). For auctions with no bids, badge
  // compares reserve to Buff (what BetterFloat does); annotate as "Reserve".
  let saleTagHtml = '';
  if (!onSellPage && refCents > 0 && itemCents > 0) {
    const pct = (itemCents / refCents) * 100;
    const color = pct < 99.5 ? '#008000' : pct > 100.5 ? '#ce0000' : '#708090';
    const decimals = pct > 200 ? 0 : pct > 150 ? 1 : 2;
    const pctDisplay = pct.toFixed(decimals);

    const diffCents = itemCents - refCents;
    const diffAbs = formatCsfPrice(Math.abs(diffCents)).display;
    const diffSign = diffCents >= 0 ? '+' : '-';
    const auctionTag = isAuction
      ? `<span style="font-size:10px;opacity:0.85;">${hasBid ? 'Top bid' : 'Reserve'}</span>`
      : '';

    saleTagHtml = `
      <span class="csboard-sale-tag" style="background-color:${color};">
        ${auctionTag}
        <span data-csboard-diff-cents="${diffCents}">${diffSign}${diffAbs}</span>
        <span>(${pctDisplay}%)</span>
      </span>
    `;
  }

  // --- Buff buy order | listing line ---
  // data-csboard-cents stores the original USD-cent amount so live refresh
  // can repaint the display when the user switches CSFloat currency.
  const orderHtml = buyOrder?.cents
    ? `<span style="color:orange;" data-csboard-cents="${buyOrder.cents}">${orderDisplay}</span>`
    : '';
  const listingHtml = bid?.cents
    ? `<span style="color:greenyellow;" data-csboard-cents="${bid.cents}">${listingDisplay}</span>`
    : '';
  const sep = orderHtml && listingHtml
    ? '<span style="color:gray;margin:0 3px;">|</span>'
    : '';

  const buffLine = document.createElement('a');
  buffLine.className = 'csboard-buff-a';
  buffLine.href = buffLink;
  buffLine.target = '_blank';
  buffLine.rel = 'noopener';
  buffLine.title = `Buff163: ${marketHashName}`;
  // Store reference (Buff ASK) USD-cent and converted-currency value on element
  // for the sell dialog auto-pricing flow. Sell dialog uses USD by default for
  // the input, so we expose `data-csboard-ref` in dollars (USD).
  const refPriceUsd = refCents / 100;
  buffLine.setAttribute('data-csboard-ref', String(refPriceUsd));
  buffLine.setAttribute('data-csboard-ref-cents', String(refCents));
  buffLine.innerHTML = `
    <img src="${BUFF_ICON}" style="height:15px;margin-right:5px;border-radius:2px;" />
    <div class="csboard-buffprice">
      ${orderHtml}${sep}${listingHtml}
    </div>
  `;

  // --- Insert into card ---
  // Sell page uses .price, marketplace uses .price-row or .price
  const priceEl = card.querySelector(onSellPage ? '.price' : '.price') || card.querySelector('.price-row');
  if (!priceEl) {
    // Fallback: just append to the card
    card.appendChild(buffLine);
    return;
  }

  if (!onSellPage) {
    card.querySelector('app-reference-widget')?.remove();
  }

  if (saleTagHtml) {
    priceEl.insertAdjacentHTML('afterend', saleTagHtml);
  }

  const priceParent = priceEl.parentElement || priceEl;
  priceParent.insertAdjacentElement('afterend', buffLine);
}

// ============================================================
// APP-SELL-DIALOG — inject buff price into listing dialog
// ============================================================

function adjustSellDialog(dialog: Element): void {
  if (dialog.querySelector('.csboard-buff-a')) return;

  // Find the item-card inside the dialog to get the item name
  const itemCard = dialog.querySelector('item-card');
  if (!itemCard) return;

  // Try to read stored data or parse from DOM
  const stored = itemCard.getAttribute('data-csboard');
  let marketHashName = '';
  let phase: string | undefined;

  if (stored) {
    try {
      const data = JSON.parse(stored);
      marketHashName = data.item?.market_hash_name || '';
      phase = data.item?.phase;
    } catch {}
  }

  if (!marketHashName) {
    const parsed = parseCardDOM(itemCard);
    if (parsed) marketHashName = parsed.name;
  }

  if (!marketHashName) return;

  const { bid, buyOrder } = priceEngine.getBuffPrices(marketHashName, phase);
  if (!bid && !buyOrder) return;

  // Reference = Buff ASK (min listing). See comment in injectPriceOverlay.
  // The sell dialog price input is USD; auto-pricing logic uses USD dollars.
  const refCents = bid?.cents ?? buyOrder?.cents ?? 0;
  const refPrice = refCents / 100;
  const buffLink = getBuffLink(marketHashName);
  const orderDisplay = buyOrder?.cents ? formatCsfPrice(buyOrder.cents).display : '';
  const listingDisplay = bid?.cents ? formatCsfPrice(bid.cents).display : '';
  const orderHtml = buyOrder?.cents
    ? `<span style="color:orange;" data-csboard-cents="${buyOrder.cents}">${orderDisplay}</span>`
    : '';
  const listingHtml = bid?.cents
    ? `<span style="color:greenyellow;" data-csboard-cents="${bid.cents}">${listingDisplay}</span>`
    : '';
  const sep = orderHtml && listingHtml ? '<span style="color:gray;margin:0 3px;">|</span>' : '';

  const buffLine = document.createElement('a');
  buffLine.className = 'csboard-buff-a';
  buffLine.href = buffLink;
  buffLine.target = '_blank';
  buffLine.rel = 'noopener';
  buffLine.style.cssText = 'justify-content:center;width:100%;margin:8px 0;';
  buffLine.innerHTML = `
    <img src="${BUFF_ICON}" style="height:15px;margin-right:5px;border-radius:2px;" />
    <div class="csboard-buffprice">${orderHtml}${sep}${listingHtml}</div>
  `;

  // Insert before the price input / slider area
  const sliderWrapper = dialog.querySelector('div.slider-wrapper') || dialog.querySelector('mat-slider')?.parentElement;
  if (sliderWrapper) {
    sliderWrapper.before(buffLine);
  } else {
    // Fallback: insert at top of dialog content
    const dialogContent = dialog.querySelector('.mat-mdc-dialog-content') || dialog.querySelector('.content');
    dialogContent?.prepend(buffLine);
  }

  // --- Auto-price: show % of buff next to price input ---
  const priceInput = dialog.querySelector<HTMLInputElement>('input[formcontrolname="price"], input[type="number"]');
  const priceLabel = dialog.querySelector<HTMLElement>('.price .name, .price-label');

  if (priceInput && refPrice > 0) {
    const updatePct = () => {
      const val = parseFloat(priceInput.value);
      if (!val || val <= 0) return;
      const pct = ((val / refPrice) * 100).toFixed(1);
      if (priceLabel) {
        // Show "Price (95.5% of Buff)" inline
        if (!priceLabel.textContent?.includes('Buff')) {
          priceLabel.dataset.origText = priceLabel.textContent || '';
        }
        priceLabel.textContent = `${priceLabel.dataset.origText || 'Price'} (${pct}% Buff)`;
      }
    };
    priceInput.addEventListener('input', updatePct);
    // Run once in case value is already set
    setTimeout(updatePct, 300);
  }
}

// ============================================================
// Process cards
// ============================================================

function processCard(card: Element): void {
  if (card.querySelector('.csboard-buff-a')) return;

  // === Sell page: match by name + float (BetterFloat pattern) ===
  // The /sell grid is sorted/filtered independently from inventory array order,
  // so we MUST NOT use FIFO dequeue — look up each rendered card by its
  // parsed (name, float) against the cached inventory.
  if (isSellPage()) {
    let retries = 0;
    const trySellMatch = () => {
      if (card.querySelector('.csboard-buff-a')) return;
      const parsed = parseCardDOM(card);
      if (!parsed) {
        if (retries++ < 12) setTimeout(trySellMatch, 150);
        return;
      }
      const invItem = findInventoryItem(parsed.name, parsed.float);
      if (!invItem) {
        // Inventory may not be cached yet, or name/float differs due to quality tag —
        // retry a few times, then give up silently.
        if (retries++ < 12) setTimeout(trySellMatch, 250);
        return;
      }
      const listing: CSFListing = {
        id: invItem.asset_id || '',
        item: {
          market_hash_name: invItem.market_hash_name || invItem.item_name || parsed.name,
          float_value: invItem.float_value,
          phase: invItem.phase,
        },
        price: 0,
      };
      card.setAttribute('data-csboard', JSON.stringify(listing));
      injectPriceOverlay(card, listing);
      addSaleListListener(card);
    };
    trySellMatch();
    return;
  }

  // === Marketplace: dequeue from intercepted listings ===
  const listing = getItemData(card);
  if (!listing) {
    let retries = 0;
    const retry = () => {
      if (card.querySelector('.csboard-buff-a')) return;
      const listing = getItemData(card);
      if (listing) {
        injectPriceOverlay(card, listing);
      } else if (retries++ < 6) {
        setTimeout(retry, 500);
      }
    };
    setTimeout(retry, 500);
    return;
  }
  injectPriceOverlay(card, listing);
}

function processAllCards(): void {
  document.querySelectorAll('item-card').forEach(card => processCard(card));
}

// Fetch CSF exchange rates directly if the site hasn't requested them yet
// (page may have been loaded after the initial bootstrap fetch). Idempotent.
async function ensureExchangeRatesLoaded(): Promise<void> {
  if (Object.keys(csfRates).length > 0) return;
  try {
    const resp = await fetch('https://csfloat.com/api/v1/meta/exchange-rates', {
      credentials: 'include',
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const rates = data?.data ?? data;
    if (rates && typeof rates === 'object' && !Array.isArray(rates)) {
      csfRates = rates as Record<string, number>;
      try { localStorage.setItem('currency_rates', JSON.stringify(csfRates)); } catch {}
      scheduleRefresh();
    }
  } catch (err) {
    logger.debug('Failed to fetch CSF exchange rates', { error: String(err) });
  }
}

// On sell page, if inventory not cached yet — fetch it directly
async function ensureInventoryLoaded(): Promise<void> {
  if (!isSellPage() || inventoryItems.length > 0) return;
  try {
    const resp = await fetch('https://csfloat.com/api/v1/me/inventory', {
      credentials: 'include',
    });
    if (resp.ok) {
      const data = await resp.json();
      const items = Array.isArray(data) ? data : data?.data;
      if (Array.isArray(items)) {
        inventoryItems = items;
        logger.info('Inventory fetched for sell page', { count: items.length });
        // Re-process all cards now that we have data
        processAllCards();
      }
    }
  } catch (err) {
    logger.warn('Failed to fetch inventory for sell page', { error: String(err) });
  }
}

// ============================================================
// Observer — watch for new item-card elements
// ============================================================

function startObserver(): void {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        // Item cards (marketplace, stall, sell page)
        if (node.tagName === 'ITEM-CARD') {
          processCard(node);
        }
        // Sell dialog — inject buff price into listing form
        else if (node.tagName === 'APP-SELL-DIALOG') {
          adjustSellDialog(node);
        }
        // Item detail popout
        else if (node.tagName === 'ITEM-DETAIL') {
          const itemCard = node.querySelector('item-card');
          if (itemCard) processCard(itemCard);
        }
        // Stall view or any container with item-cards
        else if (node.querySelectorAll) {
          const cards = node.querySelectorAll('item-card');
          if (cards.length > 0) {
            cards.forEach(processCard);
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ============================================================
// Inject CSS
// ============================================================

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    /* Buff price line — separate row below price (BetterFloat style) */
    .csboard-buff-a {
      display: flex;
      align-items: center;
      font-size: 15px;
      width: fit-content;
      text-decoration: none !important;
      cursor: pointer;
      margin-top: 4px;
    }
    .csboard-buff-a:hover {
      opacity: 0.8;
    }
    .csboard-buffprice {
      margin-left: 2px;
      padding-top: 1px;
    }

    /* Difference badge — 2-row layout, inline next to CSFloat price */
    .csboard-sale-tag {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      font-size: 13px;
      line-height: 1.2;
      padding: 2px 6px;
      border-radius: 5px;
      color: white;
      font-weight: 500;
      margin-left: 8px;
      vertical-align: middle;
      white-space: nowrap;
    }

    /* --- Auto Sell Pricing panel (injected into app-sell-home .actions) --- */
    .csboard-sell-settings {
      position: relative;
      display: inline-block;
      font-family: Roboto, "Helvetica Neue", sans-serif;
      margin-right: 12px;
    }
    .csboard-sell-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      height: 36px;
      padding: 0 16px;
      border: 1px solid rgba(193, 206, 255, 0.18);
      border-radius: 6px;
      background: rgba(193, 206, 255, 0.04);
      color: var(--subtext-color, #c1ceff);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 120ms ease;
    }
    .csboard-sell-btn:hover { background: rgba(193, 206, 255, 0.12); }
    .csboard-sell-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 4px;
      background: #f5a623;
      color: #1a1a1a;
      font-weight: 700;
      font-size: 13px;
    }
    .csboard-sell-pop[hidden] { display: none; }
    .csboard-sell-pop {
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      z-index: 99;
      min-width: 280px;
      padding: 20px;
      background: var(--module-background-color, #181b24);
      border: 2px solid rgba(193, 206, 255, 0.12);
      border-radius: 12px;
      color: var(--subtext-color, #c1ceff);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      box-shadow: 0 16px 32px rgba(0, 0, 0, 0.4);
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .csboard-sell-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--primary-text-color, #fff);
      text-align: center;
    }
    .csboard-sell-row {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      cursor: pointer;
    }
    .csboard-sell-row.csboard-sell-col {
      flex-direction: column;
      align-items: stretch;
      cursor: default;
    }
    .csboard-sell-row input[type="checkbox"] {
      width: 16px;
      height: 16px;
      accent-color: #6b21a8;
      cursor: pointer;
    }
    .csboard-sell-row input[type="number"] {
      margin-top: 4px;
      padding: 6px 10px;
      background: transparent;
      border: 1px solid rgba(193, 206, 255, 0.18);
      border-radius: 6px;
      color: var(--subtext-color, #c1ceff);
      font-size: 13px;
      font-family: inherit;
    }
    .csboard-sell-row input[type="number"]:focus {
      outline: none;
      border-color: #6b21a8;
    }
    .csboard-sell-save {
      width: 100%;
      padding: 8px 14px;
      border: none;
      border-radius: 6px;
      background: #2563eb;
      color: #fff;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 200ms ease;
    }
    .csboard-sell-save:hover { background: #1d4ed8; }
    .csboard-sell-save.csboard-sell-saved { background: #16a34a; }
    .csboard-sell-hint {
      margin: 0;
      font-size: 11px;
      line-height: 1.4;
      color: rgba(193, 206, 255, 0.55);
      text-align: center;
    }
  `;
  document.head.appendChild(style);
}

// ============================================================
// Auto Sell Pricing (BetterFloat Pro parity)
// On /sell, user can enable "auto-price as X% of Buff". When they click
// "Sell Item" on a card, we wait for the new <app-sell-queue-item> and
// fill its price input with `refPrice * pct / 100`, then dispatch `input`
// so CSFloat's Angular form picks it up.
// Settings persist in localStorage key `csboard-sell-settings`.
// ============================================================

interface SellSettings {
  active: boolean;
  percentage: number;
}

const SELL_SETTINGS_KEY = 'csboard-sell-settings';
const DEFAULT_SELL_SETTINGS: SellSettings = { active: false, percentage: 100 };

function getSellSettings(): SellSettings {
  try {
    const raw = localStorage.getItem(SELL_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SELL_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<SellSettings>;
    return {
      active: !!parsed.active,
      percentage: typeof parsed.percentage === 'number' && parsed.percentage > 0 ? parsed.percentage : 100,
    };
  } catch {
    return { ...DEFAULT_SELL_SETTINGS };
  }
}

function saveSellSettings(s: SellSettings): void {
  localStorage.setItem(SELL_SETTINGS_KEY, JSON.stringify(s));
}

// Bind "Sell Item" click on each sell-page card. On click we schedule a poll
// for the newly-added app-sell-queue-item and fill its price.
function addSaleListListener(card: Element): void {
  const btn = card.querySelector('div.action button, .action > button, button[mat-flat-button]') as HTMLElement | null;
  if (!btn || btn.hasAttribute('data-csboard-sell-bound')) return;
  btn.setAttribute('data-csboard-sell-bound', 'true');
  btn.addEventListener('click', () => {
    const settings = getSellSettings();
    const buffA = card.querySelector('a.csboard-buff-a') as HTMLElement | null;
    const refPrice = parseFloat(buffA?.getAttribute('data-csboard-ref') ?? '0');
    if (!refPrice) return;
    adjustSaleQueueItem(refPrice, settings);
  });
}

// Poll for the most recently added sell-queue-item and attach our pricing logic.
function adjustSaleQueueItem(refPrice: number, settings: SellSettings): void {
  let tries = 25;
  const tick = () => {
    const items = Array.from(document.querySelectorAll('app-sell-queue-item'));
    const listItem = items[items.length - 1] as HTMLElement | undefined;
    if (!listItem || listItem.hasAttribute('data-csboard-priced')) {
      if (tries-- > 0) setTimeout(tick, 120);
      return;
    }
    const priceInput = listItem.querySelector<HTMLInputElement>('input[formcontrolname="price"], input[type="number"]');
    if (!priceInput) {
      if (tries-- > 0) setTimeout(tick, 120);
      return;
    }
    listItem.setAttribute('data-csboard-priced', 'true');

    const priceLabel = listItem.querySelector<HTMLElement>('.price .name, .price-label');
    const origLabel = priceLabel?.textContent || 'Price';
    const updateLabel = () => {
      if (!priceLabel) return;
      const val = parseFloat(priceInput.value);
      if (!val || val <= 0) { priceLabel.textContent = origLabel; return; }
      const pct = ((val / refPrice) * 100).toFixed(1);
      priceLabel.textContent = `${origLabel} (${pct}% Buff)`;
    };
    priceInput.addEventListener('input', updateLabel);

    if (settings.active && settings.percentage > 0) {
      const target = (refPrice * settings.percentage / 100).toFixed(2);
      priceInput.value = target;
      priceInput.dispatchEvent(new Event('input', { bubbles: true }));
      const wrapper = priceInput.closest('.mat-mdc-text-field-wrapper, .mat-form-field-wrapper') as HTMLElement | null;
      if (wrapper) wrapper.style.border = '1px solid rgb(107 33 168)';
    }
    updateLabel();
  };
  tick();
}

// Inject the "Sell Settings" toolbar button into app-sell-home .actions.
async function mountSellSettingsPanel(): Promise<void> {
  if (document.getElementById('csboard-sell-settings')) return;
  let parent: Element | null = null;
  let tries = 40;
  while (!parent && tries-- > 0) {
    parent = document.querySelector('app-sell-home .actions');
    if (!parent) await new Promise(r => setTimeout(r, 200));
  }
  if (!parent) return;

  const settings = getSellSettings();
  const host = document.createElement('div');
  host.id = 'csboard-sell-settings';
  host.className = 'csboard-sell-settings';
  host.innerHTML = `
    <button type="button" class="csboard-sell-btn">
      <span class="csboard-sell-badge">C</span>
      <span>Sell Settings</span>
    </button>
    <div class="csboard-sell-pop" hidden>
      <div class="csboard-sell-title">Auto Sell Pricing</div>
      <label class="csboard-sell-row">
        <input type="checkbox" id="csboard-sell-active" ${settings.active ? 'checked' : ''} />
        <span>Enable</span>
      </label>
      <label class="csboard-sell-row csboard-sell-col">
        <span>Target Market % (of Buff)</span>
        <input type="number" id="csboard-sell-pct" value="${settings.percentage}" min="1" max="999" />
      </label>
      <button type="button" class="csboard-sell-save">Save</button>
      <p class="csboard-sell-hint">Auto-fills the price when you click "Sell Item" on a card.</p>
    </div>
  `;
  parent.insertBefore(host, parent.firstChild);

  const btn = host.querySelector('.csboard-sell-btn') as HTMLButtonElement;
  const pop = host.querySelector('.csboard-sell-pop') as HTMLElement;
  const activeEl = host.querySelector<HTMLInputElement>('#csboard-sell-active')!;
  const pctEl = host.querySelector<HTMLInputElement>('#csboard-sell-pct')!;
  const saveBtn = host.querySelector('.csboard-sell-save') as HTMLButtonElement;

  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
  document.addEventListener('click', (e) => {
    if (!host.contains(e.target as Node)) pop.hidden = true;
  });
  saveBtn.addEventListener('click', () => {
    const pct = parseInt(pctEl.value, 10);
    saveSellSettings({
      active: activeEl.checked,
      percentage: !isNaN(pct) && pct > 0 ? pct : 100,
    });
    saveBtn.textContent = 'Saved!';
    saveBtn.classList.add('csboard-sell-saved');
    setTimeout(() => {
      saveBtn.textContent = 'Save';
      saveBtn.classList.remove('csboard-sell-saved');
    }, 900);
  });
}

// ============================================================
// Init — two phases: interceptor ASAP, UI after DOM ready
// ============================================================

// Phase 1: Inject API interceptor immediately (before CSFloat fetches data)
logger.info('CSFloat content script loaded');
injectInterceptor();

// Listen for intercepted API responses (works before DOM ready)
document.addEventListener('csboard_api', ((e: CustomEvent) => {
  handleApiResponse(e.detail.url, e.detail.data);
}) as EventListener);

// Phase 2: UI injection after DOM is ready
async function initUI() {
  await priceEngine.init();
  injectStyles();
  startObserver();

  // Kick off rates fetch in background — overlay can render in USD until they arrive
  ensureExchangeRatesLoaded();

  // On sell page, fetch inventory before processing + mount settings panel
  if (isSellPage()) {
    await ensureInventoryLoaded();
    mountSellSettingsPanel();
  }

  // Wait for cards to appear (Angular SPA — cards render async)
  let cards = document.querySelectorAll('item-card');
  let tries = 30;
  while (cards.length === 0 && tries-- > 0) {
    await new Promise(r => setTimeout(r, 200));
    cards = document.querySelectorAll('item-card');
  }

  logger.info('Processing cards', { count: cards.length, page: location.pathname, invItems: inventoryItems.length });
  processAllCards();

  // SPA navigation — re-process on URL changes + reload inventory on /sell
  let lastUrl = location.href;
  setInterval(async () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (isSellPage()) {
        inventoryItems = [];
        await ensureInventoryLoaded();
        mountSellSettingsPanel();
      }
      setTimeout(processAllCards, 1000);
    }
  }, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initUI());
} else {
  initUI();
}
