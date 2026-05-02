// ============================================================
// CSBOARD Content Script — Steam Trade History Page
// ============================================================
// Injected on: steamcommunity.com/*/tradehistory
//
// Features:
// - Show prices next to items in trade history
// - Total value of each trade
// - Profit/loss indicator (items given vs received)
// - Historical arbitrage analysis
//
// Architecture:
// - Lifecycle class with cleanup
// - MutationObserver for pagination
// - Instant lookups via priceEngine

import { priceEngine } from '../../shared/price-engine';
import { createLogger } from '../../shared/logger';

const logger = createLogger('trade-history');

// ============================================================
// Trade History Script
// ============================================================

class TradeHistoryScript {
  private observer: MutationObserver | null = null;
  private initialized = false;

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    logger.info('Initializing trade history page');

    await priceEngine.init();
    this.saveAccessToken();
    this.setupObserver();
    this.processExistingTrades();
  }

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
    logger.debug('Trade history script destroyed');
  }

  // --- Save access token (needed by extension trade history page) ---

  private saveAccessToken() {
    const token = document.getElementById('application_config')
      ?.getAttribute('data-loyalty_webapi_token')
      ?.replace(/"/g, '');
    if (token) {
      chrome.storage.local.set({ csboard_steam_access_token: token });
    }
  }

  // --- MutationObserver ---

  private setupObserver() {
    const container = document.querySelector('.tradehistory_container')
      || document.querySelector('[id^="tab_contents_"]')
      || document.body;

    if (!container) return;

    this.observer = new MutationObserver(() => {
      this.processExistingTrades();
    });

    this.observer.observe(container, { childList: true, subtree: true });
    logger.debug('Trade history observer started');
  }

  private processExistingTrades() {
    const trades = document.querySelectorAll('.tradehistory_event, [class*="trade"][class*="row"]');
    trades.forEach((trade) => this.processTrade(trade));
  }

  // --- Per-Trade Processing ---

  private processTrade(tradeEl: Element) {
    // Skip if already processed
    if (tradeEl.querySelector('.csboard-trade-value')) return;

    const myItems = this.extractItemsFromSide(tradeEl, 'your');
    const theirItems = this.extractItemsFromSide(tradeEl, 'their');

    if (myItems.length === 0 || theirItems.length === 0) return;

    const myValue = priceEngine.getTotalValue(myItems);
    const theirValue = priceEngine.getTotalValue(theirItems);
    const diff = myValue.raw - theirValue.raw;

    const diffClass = diff < -0.5 ? 'loss' : diff > 0.5 ? 'gain' : 'balanced';
    const diffText = diff > 0 ? `+${diff.toFixed(2)}` : `${diff.toFixed(2)}`;

    const valueBox = document.createElement('div');
    valueBox.className = `csboard-trade-value csboard-${diffClass}`;
    valueBox.innerHTML = `
      <div class="csboard-trade-summary">
        <span>You gave: <strong>${myValue.display}</strong></span>
        <span class="csboard-sep">|</span>
        <span>You got: <strong>${theirValue.display}</strong></span>
      </div>
      <div class="csboard-trade-diff">
        <strong>${diffClass === 'gain' ? 'Profit' : diffClass === 'loss' ? 'Loss' : 'Fair'}: ${diffText}</strong>
      </div>
    `;

    // Find a good insertion point (typically after the items section)
    const itemsContainer = tradeEl.querySelector('.tradehistory_items, [class*="items"]');
    if (itemsContainer) {
      itemsContainer.insertAdjacentElement('afterend', valueBox);
    } else {
      tradeEl.insertAdjacentElement('afterbegin', valueBox);
    }
  }

  // --- Extract Items from Trade Side ---

  private extractItemsFromSide(tradeEl: Element, side: 'your' | 'their'): string[] {
    const items: string[] = [];

    // Try to find items on specific side
    let sideContainer: Element | null = null;

    if (side === 'your') {
      sideContainer = tradeEl.querySelector('[class*="gave"], [class*="my"], .secondary');
    } else {
      sideContainer = tradeEl.querySelector('[class*="received"], [class*="their"], .primary');
    }

    if (!sideContainer) {
      sideContainer = tradeEl;
    }

    // Find all item elements
    const itemEls = sideContainer.querySelectorAll('[data-economy-item], .trade_item, [class*="item"]');

    for (const itemEl of itemEls) {
      const name = this.getItemName(itemEl);
      if (name) items.push(name);
    }

    return items;
  }

  private getItemName(itemEl: Element): string | null {
    // Try title attribute (most reliable)
    const title = itemEl.getAttribute('title');
    if (title) return title;

    // Try data attribute
    const dataAttr = itemEl.getAttribute('data-economy-item');
    if (dataAttr && dataAttr.includes('/')) {
      // Can't extract full name from just classid/instanceid
      // but might be in title
    }

    // Try finding in alt text or aria-label
    const alt = itemEl.getAttribute('alt') || itemEl.getAttribute('aria-label');
    if (alt) return alt;

    // Try text content from name element
    const nameEl = itemEl.querySelector('.item_desc_name, [class*="name"]');
    if (nameEl?.textContent) return nameEl.textContent.trim();

    return null;
  }
}

// ============================================================
// Init
// ============================================================

const script = new TradeHistoryScript();

function init() {
  script.init().catch((err) => {
    logger.error('Failed to initialize trade history', { error: String(err) });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
