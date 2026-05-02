// ============================================================
// CSBOARD Content Script — Steam Market Search Page
// ============================================================
// Injected on: steamcommunity.com/market/search*
//
// Features:
// - Add price from primary source next to each search result
// - Show Buff/Steam spread percentage
// - Highlight good deals (buff price much lower than steam listing)
// - Quick scan for arbitrage opportunities
//
// Architecture:
// - Lifecycle class with cleanup
// - MutationObserver for pagination
// - Instant lookups via priceEngine

import { priceEngine } from '../../shared/price-engine';
import { createLogger } from '../../shared/logger';

const logger = createLogger('market-search');

// ============================================================
// Market Search Script
// ============================================================

class MarketSearchScript {
  private observer: MutationObserver | null = null;
  private initialized = false;

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    logger.info('Initializing market search page');

    await priceEngine.init();
    logger.info('Price engine initialized', {
      loaded: priceEngine.isLoaded,
      itemCount: priceEngine.itemCount,
    });

    this.setupObserver();
    this.processExistingResults();
  }

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
    logger.debug('Market search script destroyed');
  }

  // --- MutationObserver ---

  private setupObserver() {
    const resultsContainer = document.getElementById('searchResultsRows')
      || document.querySelector('.market_listing_table');

    if (!resultsContainer) {
      logger.warn('Search results container not found');
      return;
    }

    this.observer = new MutationObserver(() => {
      this.processExistingResults();
    });

    this.observer.observe(resultsContainer, { childList: true, subtree: true });
    logger.debug('Market search observer started');
  }

  private processExistingResults() {
    const results = document.querySelectorAll('.market_listing_row');
    results.forEach((result) => this.processResult(result));
  }

  // --- Per-Result Processing ---

  private processResult(resultEl: Element) {
    // Skip if already processed
    if (resultEl.hasAttribute('data-csboard-processed')) return;

    const itemName = this.getItemName(resultEl);
    if (!itemName) {
      resultEl.setAttribute('data-csboard-processed', 'true');
      return;
    }

    const price = priceEngine.getPrice(itemName);
    if (!price) {
      logger.debug('No price data available for item', { itemName });
      resultEl.setAttribute('data-csboard-processed', 'true');
      return;
    }

    const steamPrice = this.getSteamPrice(resultEl);
    if (!steamPrice) {
      logger.debug('Could not extract Steam price from listing', { itemName });
      resultEl.setAttribute('data-csboard-processed', 'true');
      return;
    }

    // Calculate spread
    const spread = Math.round(((steamPrice - price.raw) / steamPrice) * 100);
    const spreadClass = spread > 20 ? 'good-deal' : spread > 10 ? 'fair' : 'pricey';

    const priceTag = document.createElement('span');
    priceTag.className = `csboard-search-price csboard-${spreadClass}`;
    priceTag.innerHTML = `
      <span class="csboard-source-price">${price.display}</span>
      <span class="csboard-spread" title="% savings from Steam price">${spread > 0 ? 'Save ' : ''}${Math.abs(spread)}%</span>
    `;

    // Insert after the steam price
    const steamPriceEl = resultEl.querySelector(
      '.market_listing_price, .market_table_value'
    );
    if (steamPriceEl) {
      steamPriceEl.insertAdjacentElement('afterend', priceTag);
    } else {
      resultEl.insertAdjacentElement('afterbegin', priceTag);
    }

    resultEl.setAttribute('data-csboard-processed', 'true');
  }

  // --- Helpers ---

  private getItemName(resultEl: Element): string | null {
    // Try data attribute first
    const link = resultEl.querySelector('a[href*="/market/listings/"]') as HTMLAnchorElement | null;
    if (link?.href) {
      const match = link.href.match(/\/listings\/730\/(.+)$/);
      if (match && match[1]) return decodeURIComponent(match[1]);
    }

    // Try name element
    const nameEl = resultEl.querySelector('.market_listing_item_name, .market_item_name');
    if (nameEl?.textContent) return nameEl.textContent.trim();

    return null;
  }

  private getSteamPrice(resultEl: Element): number | null {
    const priceEl = resultEl.querySelector(
      '.market_listing_price, .market_table_value .normal_price'
    );
    if (!priceEl) return null;

    const text = priceEl.textContent?.trim() ?? '';
    return this.parseSteamPrice(text);
  }

  private parseSteamPrice(text: string): number | null {
    const cleaned = text.replace(/[^0-9.,]/g, '');
    // Handle comma as decimal separator (European format)
    const normalized =
      cleaned.includes(',') && !cleaned.includes('.')
        ? cleaned.replace(',', '.')
        : cleaned.replace(',', '');
    const value = parseFloat(normalized);
    return isNaN(value) ? null : value;
  }
}

// ============================================================
// Init
// ============================================================

const script = new MarketSearchScript();

function init() {
  script.init().catch((err) => {
    logger.error('Failed to initialize market search', { error: String(err) });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
