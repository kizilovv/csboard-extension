// ============================================================
// CSBOARD Content Script — Steam Profile Page
// ============================================================
// Injected on: steamcommunity.com/profiles/*/
//              steamcommunity.com/id/*/
//
// Features:
// - Show estimated inventory value (if inventory is public)
// - "View on CSBOARD" button
// - Reputation indicator placeholder (future)
// - Quick profile value scan
//
// Architecture:
// - Lifecycle class with cleanup
// - Async inventory loading
// - priceEngine integration

import { priceEngine } from '../../shared/price-engine';
import { SITE_BASE } from '../../shared/config';
import { createLogger } from '../../shared/logger';

const logger = createLogger('profile');

// ============================================================
// Profile Script
// ============================================================

class ProfileScript {
  private initialized = false;

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    logger.info('Initializing profile page');

    await priceEngine.init();
    this.addCSBoardButton();
    this.tryLoadInventoryValue();
  }

  destroy() {
    logger.debug('Profile script destroyed');
  }

  // --- Add CSBOARD Button ---

  private addCSBoardButton() {
    const profileHeader = document.querySelector('.profile_header, .profile_top_section');
    if (!profileHeader) return;

    const profileOwnerSteamId = this.getProfileSteamId();
    if (!profileOwnerSteamId) return;

    // Check if button already exists
    if (profileHeader.querySelector('.csboard-profile-btn')) return;

    const btnContainer = document.createElement('div');
    btnContainer.className = 'csboard-profile-btn-container';
    btnContainer.innerHTML = `
      <a href="${SITE_BASE}/trader/${profileOwnerSteamId}" target="_blank" class="csboard-profile-btn">
        View on CSBOARD
      </a>
    `;

    // Insert near profile actions
    const actions = profileHeader.querySelector('.profile_header_actions, [class*="action"]');
    if (actions) {
      actions.insertAdjacentElement('beforeend', btnContainer);
    } else {
      profileHeader.insertAdjacentElement('beforeend', btnContainer);
    }
  }

  // --- Load Inventory Value ---

  private async tryLoadInventoryValue() {
    const profileId = this.getProfileSteamId();
    if (!profileId) return;

    try {
      // Try to get inventory items via the page's own inventory viewer
      const items = await this.extractInventoryItems();
      if (items.length === 0) {
        logger.debug('No inventory items found or inventory is private');
        return;
      }

      const totalValue = priceEngine.getTotalValue(items);

      this.injectInventoryValueBanner(totalValue.display, items.length);
    } catch (err) {
      logger.warn('Failed to load inventory value', { error: String(err) });
    }
  }

  private async extractInventoryItems(): Promise<string[]> {
    // Check if inventory link is visible (means inventory is public)
    const inventoryLink = document.querySelector('a[href*="/inventory"]');
    if (!inventoryLink) {
      logger.debug('No visible inventory link - likely private');
      return [];
    }

    // For now, we can't reliably fetch from this page context
    // Return empty to avoid errors
    // Future: implement async inventory fetch from inventory page
    return [];
  }

  private injectInventoryValueBanner(valueDisplay: string, itemCount: number) {
    const profileHeader = document.querySelector('.profile_header, .profile_top_section');
    if (!profileHeader || profileHeader.querySelector('.csboard-inventory-value')) return;

    const banner = document.createElement('div');
    banner.className = 'csboard-inventory-value';
    banner.innerHTML = `
      <div class="csboard-value-banner">
        <span class="csboard-label">Est. Inventory Value:</span>
        <span class="csboard-amount"><strong>${valueDisplay}</strong></span>
        <span class="csboard-count">${itemCount} items</span>
      </div>
    `;

    profileHeader.insertAdjacentElement('afterbegin', banner);
  }

  // --- Helpers ---

  private getProfileSteamId(): string | null {
    // Method 1: from URL
    const match = window.location.pathname.match(/\/(?:profiles|id)\/([a-zA-Z0-9]+)\/?/);
    if (match && match[1]) {
      const idOrUrl = match[1];
      // If it's a numeric ID (Steam ID 64), use directly
      if (/^\d+$/.test(idOrUrl)) {
        return idOrUrl;
      }
      // Otherwise, it's a custom URL - we'd need to resolve it
      // For now, return null as we'd need additional API call
      logger.debug('Custom profile URL - would need resolution', { url: idOrUrl });
      return null;
    }

    // Method 2: from page meta/data
    const steamIdEl = document.querySelector('[data-steamid], [data-profile], [id*="steam"]');
    const steamIdAttr = steamIdEl?.getAttribute('data-steamid');
    if (steamIdAttr) {
      return steamIdAttr;
    }

    return null;
  }
}

// ============================================================
// Init
// ============================================================

const script = new ProfileScript();

function init() {
  script.init().catch((err) => {
    logger.error('Failed to initialize profile', { error: String(err) });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
