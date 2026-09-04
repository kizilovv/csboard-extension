// ============================================================
// CSBOARD Content Script — Steam Market Page
// ============================================================
// Injected on: steamcommunity.com/market/listings/730/*
//
// Features:
// - Buff163/CSBOARD price comparison banner
// - Per-listing colored labels (overpriced/underpriced/fair)
// - Float values via inspect link
//
// Architecture:
// - Lifecycle class with cleanup
// - Single price fetch per page (not per listing)
// - Observer for paginated listings

import { sendTypedMessage } from '../../shared/message-bus';
import { createLogger } from '../../shared/logger';
import { getCsboardLink } from '../../shared/items';
import { MarketHashName, type PriceData } from '../../shared/types';
import { getWalletFeeInfo, formatWalletAmount, receivedForBuyerPays } from '../../shared/steam-fees';
import { getOrderBook, primeItemNameId, type OrderBook } from '../../shared/market-orders';
import { whenSiteEnabled } from '../../shared/enhancements';

const logger = createLogger('market');

// ============================================================
// Market Script Lifecycle
// ============================================================

class MarketScript {
  private observer: MutationObserver | null = null;
  private itemPrice: PriceData | null = null;
  private itemName: string | null = null;
  /** Real CSBOARD minAsk in USD cents (csgoskins feed), keyed "name|phase". */
  private csboardCents: number | null = null;

  private static readonly RETRY_INTERVAL_MS = 1000;
  private static readonly MAX_RETRIES = 10;

  async init() {
    logger.info('Initializing market page');
    this.itemName = this.getItemNameFromPage();
    if (!this.itemName) {
      logger.warn('Could not determine item name from page');
      return;
    }

    // Fetch price once for the item
    await this.loadCsboardPrice();
    await this.fetchPrice();

    // Process listings
    this.waitForListings(0);

    // Steam's own order book, read from the id this page already carries.
    this.loadOrderBook().catch((err) =>
      logger.debug('Order book unavailable', { error: String(err) }),
    );
  }

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
  }

  // --- Price Fetch (one-time per page) ---

  private async fetchPrice() {
    if (!this.itemName) return;

    const result = await sendTypedMessage({
      type: 'GET_PRICES',
      data: { items: [MarketHashName(this.itemName)] },
    });

    const price = result.ok ? result.value[this.itemName] : undefined;
    if (price) {
      this.itemPrice = price;
      this.injectPriceBanner();
    } else if (!result.ok) {
      logger.warn('Failed to fetch price', { item: this.itemName, error: result.error.message });
    }
  }

  // --- CSBOARD price (real minAsk, not buff163) ---
  //
  // GET_PRICES never carries `csboard` — the background worker keeps the real
  // CSBOARD minAsk in its own `csboard_prices` map (csgoskins partner feed,
  // USD cents, keyed "name|phase"). Same source the CSFloat panel reads, so the
  // two surfaces can never disagree.

  private async loadCsboardPrice() {
    if (!this.itemName) return;
    try {
      const data = await chrome.storage.local.get('csboard_prices');
      const map = (data['csboard_prices'] as Record<string, number> | undefined) ?? {};
      const cents = map[`${this.itemName}|`];
      if (typeof cents === 'number' && cents > 0) this.csboardCents = cents;
    } catch {
      // no feed cached yet — banner just omits the CSBOARD line
    }
  }

  // --- Steam Order Book ---
  //
  // Adds the two numbers Steam hides on this page: the highest standing buy
  // order (what an instant sale actually fills at) and what the seller keeps
  // after the 15% cut. The item_nameid comes off this page's own inline script,
  // so this costs exactly one JSON request.

  private async loadOrderBook() {
    if (!this.itemName) return;

    const idMatch = /Market_LoadOrderSpread\(\s*(\d+)\s*\)/.exec(document.documentElement.innerHTML);
    if (idMatch?.[1]) primeItemNameId(this.itemName, idMatch[1]);

    const wallet = getWalletFeeInfo();
    const result = await getOrderBook(this.itemName, wallet);
    if (!result.ok) {
      logger.debug('Order book fetch failed', { error: result.error.message });
      return;
    }
    this.injectOrderBookRow(result.value, wallet);
  }

  private injectOrderBookRow(book: OrderBook, wallet: ReturnType<typeof getWalletFeeInfo>) {
    // The banner may not exist yet when the price feed missed this item.
    if (!document.getElementById('csboard-market-banner')) this.injectPriceBanner();
    const banner = document.getElementById('csboard-market-banner');
    if (!banner || banner.querySelector('.csboard-orderbook')) return;

    const row = document.createElement('div');
    row.className = 'csboard-orderbook';

    const bid = book.highestBuyOrder;
    const ask = book.lowestSellOrder;

    const parts = [
      `<span class="csboard-price-item">Steam bid: <strong>${bid !== null ? formatWalletAmount(bid, wallet) : '—'}</strong></span>`,
      `<span class="csboard-price-item">Steam ask: <strong>${ask !== null ? formatWalletAmount(ask, wallet) : '—'}</strong></span>`,
    ];

    if (bid !== null) {
      const net = receivedForBuyerPays(bid, wallet);
      parts.push(
        `<span class="csboard-price-item">Instant sell nets: <strong class="csboard-net">${formatWalletAmount(net.received, wallet)}</strong></span>`,
      );
    }

    if (bid !== null && ask !== null && ask > 0) {
      const spread = Math.round(((ask - bid) / ask) * 100);
      parts.push(`<span class="csboard-price-item">Spread: <strong>${spread}%</strong></span>`);
    }

    row.innerHTML = parts.join('');
    banner.appendChild(row);
  }

  // --- Listings Observer ---

  private waitForListings(attempt: number) {
    const table =
      document.getElementById('searchResultsTable') ??
      document.getElementById('searchResultsRows');

    if (!table) {
      if (attempt < MarketScript.MAX_RETRIES) {
        setTimeout(() => this.waitForListings(attempt + 1), MarketScript.RETRY_INTERVAL_MS);
      }
      return;
    }

    this.processListings();

    this.observer = new MutationObserver(() => this.processListings());
    this.observer.observe(table, { childList: true, subtree: true });
  }

  private processListings() {
    if (!this.itemPrice) return;

    const listings = document.querySelectorAll('.market_listing_row');
    listings.forEach((el) => this.processListing(el));
  }

  // --- Price Banner ---

  // Renders with whatever we have. It used to bail unless GET_PRICES returned a
  // row, which also hid the Steam order book (that row lives inside this
  // banner) for every item the price feed is missing.
  private injectPriceBanner() {
    if (document.getElementById('csboard-market-banner') || !this.itemName) return;

    const price = this.itemPrice ?? ({} as PriceData);
    const parts: string[] = ['<span class="csboard-logo">CSBOARD</span>'];

    if (price.buff163) {
      parts.push(`<span class="csboard-price-item">Buff163: <strong>$${price.buff163.toFixed(2)}</strong></span>`);
    }
    if (price.steam) {
      parts.push(`<span class="csboard-price-item">Steam: <strong>$${price.steam.toFixed(2)}</strong></span>`);
    }
    if (this.csboardCents) {
      parts.push(`<span class="csboard-price-item">CSBOARD: <strong>$${(this.csboardCents / 100).toFixed(2)}</strong></span>`);
    }

    if (price.buff163 && price.steam && price.steam > price.buff163) {
      const savings = Math.round(((price.steam - price.buff163) / price.steam) * 100);
      parts.push(`<span class="csboard-savings">Save ${savings}% on Buff</span>`);
    }

    // `/item/<name>` was never a real route — the item page is
    // `/<locale>/items/<slug>`. getCsboardLink() is the single source for it.
    parts.push(`
      <a href="${getCsboardLink(this.itemName)}" target="_blank" rel="noopener noreferrer" class="csboard-view-btn">
        View on CSBOARD
      </a>
    `);

    const banner = document.createElement('div');
    banner.id = 'csboard-market-banner';
    banner.innerHTML = `<div class="csboard-market-banner-inner">${parts.join('')}</div>`;

    const header = document.querySelector('.market_listing_nav, .market_page_fullwidth');
    header?.insertAdjacentElement('afterend', banner);
  }

  // --- Per-Listing Labels ---

  private processListing(listing: Element) {
    if (listing.querySelector('.csboard-listing-label') || !this.itemPrice) return;

    const priceEl = listing.querySelector(
      '.market_listing_price_with_fee, .market_table_value .normal_price',
    );
    if (!priceEl) return;

    const listingPrice = parseSteamPrice(priceEl.textContent?.trim() ?? '');
    if (listingPrice === null || !this.itemPrice.buff163) return;

    const diff = Math.round(((listingPrice - this.itemPrice.buff163) / this.itemPrice.buff163) * 100);

    const label = document.createElement('span');
    label.className = 'csboard-listing-label';
    label.classList.add(diff > 10 ? 'overpriced' : diff > 0 ? 'fair' : 'underpriced');
    label.textContent = `${diff > 0 ? '+' : ''}${diff}%`;

    priceEl.appendChild(label);

    // Float value from inspect link
    const inspectLink = listing.querySelector('a[href*="csgo_econ_action_preview"]');
    if (inspectLink) {
      this.fetchFloat(listing, inspectLink.getAttribute('href') ?? '');
    }
  }

  // --- Float ---

  private async fetchFloat(listing: Element, inspectLink: string) {
    if (!inspectLink || listing.querySelector('.csboard-float-value')) return;

    const result = await sendTypedMessage({
      type: 'GET_FLOAT',
      data: { inspectLink },
    });

    if (!result.ok || result.value.floatValue === 0) return;

    const el = document.createElement('span');
    el.className = 'csboard-float-value';
    el.textContent = `Float: ${result.value.floatValue.toFixed(10)}`;
    if (result.value.paintSeed) {
      el.textContent += ` | Seed: ${result.value.paintSeed}`;
    }

    const nameEl = listing.querySelector(
      '.market_listing_item_name_block, .market_listing_item_name',
    );
    nameEl?.appendChild(el);
  }

  // --- Helpers ---

  private getItemNameFromPage(): string | null {
    const el =
      document.querySelector('.market_listing_nav a:last-child') ??
      document.querySelector('.market_listing_item_name_block .market_listing_item_name');
    return el?.textContent?.trim() ?? null;
  }
}

// --- Steam Price Parser ---

function parseSteamPrice(text: string): number | null {
  const cleaned = text.replace(/[^0-9.,]/g, '');
  // Handle comma as decimal separator (European format)
  const normalized =
    cleaned.includes(',') && !cleaned.includes('.')
      ? cleaned.replace(',', '.')
      : cleaned.replace(',', '');
  const value = parseFloat(normalized);
  return isNaN(value) ? null : value;
}

// ============================================================
// Init
// ============================================================

const script = new MarketScript();

function init() {
  script.init().catch((err) => {
    logger.error('Failed to initialize market', { error: String(err) });
  });
}

/* The master switch is checked here, once, before anything is drawn. */
const bootstrap = () => { init(); };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => whenSiteEnabled('steam', bootstrap));
} else {
  whenSiteEnabled('steam', bootstrap);
}
