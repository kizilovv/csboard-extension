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

import { SITE_BASE } from '../../shared/config';
import { sendTypedMessage } from '../../shared/message-bus';
import { createLogger } from '../../shared/logger';
import { MarketHashName, type PriceData } from '../../shared/types';

const logger = createLogger('market');

// ============================================================
// Market Script Lifecycle
// ============================================================

class MarketScript {
  private observer: MutationObserver | null = null;
  private itemPrice: PriceData | null = null;
  private itemName: string | null = null;

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
    await this.fetchPrice();

    // Process listings
    this.waitForListings(0);
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

  private injectPriceBanner() {
    if (document.getElementById('csboard-market-banner') || !this.itemPrice || !this.itemName) return;

    const price = this.itemPrice;
    const parts: string[] = ['<span class="csboard-logo">CSBOARD</span>'];

    if (price.buff163) {
      parts.push(`<span class="csboard-price-item">Buff163: <strong>$${price.buff163.toFixed(2)}</strong></span>`);
    }
    if (price.steam) {
      parts.push(`<span class="csboard-price-item">Steam: <strong>$${price.steam.toFixed(2)}</strong></span>`);
    }
    if (price.csboard) {
      parts.push(`<span class="csboard-price-item">CSBOARD: <strong>$${price.csboard.toFixed(2)}</strong></span>`);
    }

    if (price.buff163 && price.steam && price.steam > price.buff163) {
      const savings = Math.round(((price.steam - price.buff163) / price.steam) * 100);
      parts.push(`<span class="csboard-savings">Save ${savings}% on Buff</span>`);
    }

    parts.push(`
      <a href="${SITE_BASE}/item/${encodeURIComponent(this.itemName)}" target="_blank" class="csboard-view-btn">
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
