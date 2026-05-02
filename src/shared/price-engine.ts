// ============================================================
// Price Engine — cs2trader-style preloaded prices
// ============================================================
// All 24k+ prices stored in chrome.storage.local
// Updated every 5 min from GET /api/extension/prices
// Zero API calls per page — instant local lookups

import { createLogger } from './logger';

const logger = createLogger('price-engine');

// Compact price format from server (short keys, cents)
export interface CompactPrice {
  b?: number;   // buff163 (cents)
  bo?: number;  // buff163_buy / buy order (cents)
  s?: number;   // steam (cents)
  sp?: number;  // skinport (cents)
  dm?: number;  // dmarket (cents)
  cf?: number;  // csfloat (cents)
  yp?: number;  // youpin (cents)
  ls?: number;  // lisskins (cents)
  l?: number;   // liquidity score
}

export type PriceSourceKey = 'buff163' | 'buff163_buy' | 'steam' | 'skinport' | 'dmarket' | 'csfloat' | 'youpin' | 'lisskins';

// Map source names to compact keys
const COMPACT_KEY_MAP: Record<PriceSourceKey, keyof CompactPrice> = {
  buff163: 'b',
  buff163_buy: 'bo',
  steam: 's',
  skinport: 'sp',
  dmarket: 'dm',
  csfloat: 'cf',
  youpin: 'yp',
  lisskins: 'ls',
};

// Currency data — same as cs2trader
export interface CurrencyInfo {
  short: string;
  sign: string;
}

export const CURRENCIES: Record<string, CurrencyInfo> = {
  USD: { short: 'USD', sign: '$' },
  EUR: { short: 'EUR', sign: '€' },
  GBP: { short: 'GBP', sign: '£' },
  CNY: { short: 'CNY', sign: '¥' },
  RUB: { short: 'RUB', sign: '₽' },
  UAH: { short: 'UAH', sign: '₴' },
  BRL: { short: 'BRL', sign: 'R$' },
  TRY: { short: 'TRY', sign: '₺' },
  PLN: { short: 'PLN', sign: 'zł' },
  KZT: { short: 'KZT', sign: '₸' },
  CAD: { short: 'CAD', sign: 'C$' },
  AUD: { short: 'AUD', sign: 'A$' },
  JPY: { short: 'JPY', sign: '¥' },
  KRW: { short: 'KRW', sign: '₩' },
  INR: { short: 'INR', sign: '₹' },
};

// Storage keys
const PRICES_STORAGE_KEY = 'csboard_all_prices';
const RATES_STORAGE_KEY = 'csboard_exchange_rates';
const PRICES_META_KEY = 'csboard_prices_meta'; // { etag, lastFetched, count }
const SETTINGS_KEY = 'csboard_settings';

export interface PriceEngineSettings {
  currency: string;        // user's chosen currency (default USD)
  priceSource: PriceSourceKey; // primary price source (default buff163)
}

const DEFAULT_SETTINGS: PriceEngineSettings = {
  currency: 'USD',
  priceSource: 'buff163',
};

export interface FormattedPrice {
  raw: number;        // price in user's currency (dollars, not cents)
  display: string;    // formatted: "$12.34" or "₽1,234.56"
  cents: number;      // original USD cents from cache
}

/**
 * Strip "StatTrak™ " or "Souvenir " prefix from a Steam market_hash_name.
 * Correctly handles knife/glove names that start with "★ " or "★ StatTrak™ ".
 * Returns the stripped name, or the input unchanged if no prefix matched.
 *
 * Examples:
 *   "StatTrak™ MP7 | Amberline (Minimal Wear)" → "MP7 | Amberline (Minimal Wear)"
 *   "★ StatTrak™ Karambit | Doppler (Factory New)" → "★ Karambit | Doppler (Factory New)"
 *   "Souvenir AWP | Dragon Lore (Factory New)" → "AWP | Dragon Lore (Factory New)"
 *   "MP7 | Amberline (Minimal Wear)" → "MP7 | Amberline (Minimal Wear)" (unchanged)
 */
function stripVariantPrefix(name: string): string {
  // Knife/glove prefix "★ " optionally followed by StatTrak™
  if (name.startsWith('★ StatTrak™ ')) return '★ ' + name.slice('★ StatTrak™ '.length);
  if (name.startsWith('StatTrak™ ')) return name.slice('StatTrak™ '.length);
  if (name.startsWith('Souvenir ')) return name.slice('Souvenir '.length);
  return name;
}

class PriceEngine {
  private prices: Record<string, CompactPrice> = {};
  private exchangeRates: Record<string, number> = {};
  private settings: PriceEngineSettings = DEFAULT_SETTINGS;
  private loaded = false;
  private loading: Promise<void> | null = null;

  /** Initialize — load from chrome.storage */
  async init(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;

    this.loading = this._doInit();
    await this.loading;
    this.loading = null;
  }

  private async _doInit(): Promise<void> {
    try {
      const data = await chrome.storage.local.get([
        PRICES_STORAGE_KEY,
        RATES_STORAGE_KEY,
        SETTINGS_KEY,
      ]);

      this.prices = data[PRICES_STORAGE_KEY] || {};
      this.exchangeRates = data[RATES_STORAGE_KEY] || {};
      this.settings = { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
      this.loaded = true;

      logger.info('Price engine loaded', {
        items: Object.keys(this.prices).length,
        currency: this.settings.currency,
        source: this.settings.priceSource,
      });
    } catch (err) {
      logger.error('Failed to load prices', { error: String(err) });
      this.loaded = true; // Mark as loaded even on error to not block
    }
  }

  /** Force reload settings from chrome.storage (e.g. after currency change) */
  async reload(): Promise<void> {
    this.loaded = false;
    this.loading = null;
    await this.init();
  }

  /** Check if prices are loaded */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Get number of cached items */
  get itemCount(): number {
    return Object.keys(this.prices).length;
  }

  /** Get current settings */
  getSettings(): PriceEngineSettings {
    return { ...this.settings };
  }

  /** Update settings */
  async updateSettings(partial: Partial<PriceEngineSettings>): Promise<void> {
    this.settings = { ...this.settings, ...partial };
    await chrome.storage.local.set({ [SETTINGS_KEY]: this.settings });
  }

  /**
   * Get price for an item using the user's primary source + currency.
   * For Doppler items, pass dopplerPhase (e.g. "Phase 2", "Sapphire") to get phase-specific price.
   * Keys in price cache: "★ Flip Knife | Doppler (FN) - Phase 2"
   *
   * Fallback: if exact name misses (common for new skins where PE is missing the
   * StatTrak™/Souvenir variant), strip the variant prefix and retry with the base
   * name. Pricing will be slightly off (ST items trade at a premium) but better than
   * a blank overlay. Use `getPriceWithFallback` suffix in meta if callers need to
   * know whether the hit was exact.
   */
  getPrice(marketHashName: string, dopplerPhase?: string): FormattedPrice | null {
    // Try phase-specific price first for Doppler items
    if (dopplerPhase) {
      const phaseKey = `${marketHashName} - ${dopplerPhase}`;
      const phaseItem = this.prices[phaseKey];
      if (phaseItem) {
        const key = COMPACT_KEY_MAP[this.settings.priceSource];
        const cents = phaseItem[key];
        if (cents && cents > 0) return this.formatPrice(cents);
      }
    }

    const key = COMPACT_KEY_MAP[this.settings.priceSource];

    const exact = this.prices[marketHashName];
    if (exact) {
      const cents = exact[key];
      if (cents && cents > 0) return this.formatPrice(cents);
    }

    // Fallback: strip StatTrak™ / Souvenir prefix (keeps ★ for knives/gloves).
    const base = stripVariantPrefix(marketHashName);
    if (base && base !== marketHashName) {
      const baseItem = this.prices[base];
      if (baseItem) {
        const cents = baseItem[key];
        if (cents && cents > 0) return this.formatPrice(cents);
      }
    }

    return null;
  }

  /**
   * Get price from a specific source.
   */
  getPriceFromSource(marketHashName: string, source: PriceSourceKey): FormattedPrice | null {
    const item = this.prices[marketHashName];
    if (!item) return null;

    const key = COMPACT_KEY_MAP[source];
    const cents = item[key];
    if (!cents || cents <= 0) return null;

    return this.formatPrice(cents);
  }

  /**
   * Get ALL prices for an item (all sources).
   */
  getAllPrices(marketHashName: string): Record<PriceSourceKey, FormattedPrice | null> | null {
    const item = this.prices[marketHashName];
    if (!item) return null;

    const result: Record<string, FormattedPrice | null> = {};
    for (const [source, key] of Object.entries(COMPACT_KEY_MAP)) {
      const cents = item[key as keyof CompactPrice] as number | undefined;
      result[source] = cents && cents > 0 ? this.formatPrice(cents) : null;
    }
    return result as Record<PriceSourceKey, FormattedPrice | null>;
  }

  /**
   * Get buff163 bid (sell order) and buy order prices for an item.
   * Used for the BuffBid + BuffBuyOrder display.
   */
  getBuffPrices(marketHashName: string, dopplerPhase?: string): { bid: FormattedPrice | null; buyOrder: FormattedPrice | null } {
    // Try phase-specific prices first
    let item = dopplerPhase ? this.prices[`${marketHashName} - ${dopplerPhase}`] : null;
    if (!item) item = this.prices[marketHashName];

    // Fallback: base (non-StatTrak™ / non-Souvenir) name when PE is missing the variant.
    if (!item) {
      const base = stripVariantPrefix(marketHashName);
      if (base && base !== marketHashName) item = this.prices[base];
    }

    if (!item) return { bid: null, buyOrder: null };

    return {
      bid: item.b && item.b > 0 ? this.formatPrice(item.b) : null,
      buyOrder: item.bo && item.bo > 0 ? this.formatPrice(item.bo) : null,
    };
  }

  /**
   * Get liquidity score for an item (0-100).
   */
  getLiquidity(marketHashName: string): number {
    return this.prices[marketHashName]?.l ?? 0;
  }

  /**
   * Calculate total value of a list of items.
   */
  getTotalValue(marketHashNames: string[]): FormattedPrice {
    let totalCents = 0;
    for (const name of marketHashNames) {
      const item = this.prices[name];
      if (!item) continue;
      const key = COMPACT_KEY_MAP[this.settings.priceSource];
      const cents = item[key];
      if (cents && cents > 0) totalCents += cents;
    }
    return this.formatPrice(totalCents);
  }

  /** Format cents to user's currency */
  private formatPrice(usdCents: number): FormattedPrice {
    const rate = this.exchangeRates[this.settings.currency] || 1;
    const converted = (usdCents / 100) * rate;
    const currencyInfo = CURRENCIES[this.settings.currency] || CURRENCIES['USD'];

    const nf = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    return {
      raw: converted,
      display: `${currencyInfo!.sign}${nf.format(converted)}`,
      cents: usdCents,
    };
  }

  // --- Data Loading (called from service worker) ---

  /** Store new prices blob from API */
  async storePrices(prices: Record<string, CompactPrice>, etag: string): Promise<void> {
    this.prices = prices;
    await chrome.storage.local.set({
      [PRICES_STORAGE_KEY]: prices,
      [PRICES_META_KEY]: { etag, lastFetched: Date.now(), count: Object.keys(prices).length },
    });
    logger.info('Prices stored', { count: Object.keys(prices).length, etag });
  }

  /** Store exchange rates */
  async storeExchangeRates(rates: Record<string, number>): Promise<void> {
    this.exchangeRates = rates;
    await chrome.storage.local.set({ [RATES_STORAGE_KEY]: rates });
  }

  /** Get stored ETag for conditional requests */
  async getStoredEtag(): Promise<string | null> {
    const meta = await chrome.storage.local.get(PRICES_META_KEY);
    return meta[PRICES_META_KEY]?.etag ?? null;
  }

  /** Get last fetch timestamp */
  async getLastFetched(): Promise<number> {
    const meta = await chrome.storage.local.get(PRICES_META_KEY);
    return meta[PRICES_META_KEY]?.lastFetched ?? 0;
  }
}

// Singleton
export const priceEngine = new PriceEngine();
