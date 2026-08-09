// ============================================================
// CSBOARD — Steam Market Fee Math + Wallet Info
// ============================================================
// Steam's sell dialog does NOT take the price a buyer pays — the
// `price` param of /market/sellitem/ is what the SELLER RECEIVES,
// in minor units (cents) of the seller's wallet currency.
//
// Every button we render has to show both sides of that split, so
// this module ports Steam's own two functions verbatim:
//   CalculateAmountToSendForDesiredReceivedAmount()  received → buyer pays
//   CalculateFeeAmount()                             buyer pays → received
// Off-by-one here means a listing at the wrong price, so the port is
// literal (integer math, Math.floor, the same undershoot loop).
//
// Fee parameters live in the page's g_rgWalletInfo. They are NOT
// constant: wallet_fee_percent/base/minimum vary by currency, and the
// publisher cut is per-app. Hardcoding 5%+10% mispricing every
// non-USD wallet, so we read the real values off the page and only
// fall back to the CS2/USD defaults when the page has none.

import { injectScript } from './inject';
import { createLogger } from './logger';

const logger = createLogger('steam-fees');

export interface WalletFeeInfo {
  /** Steam wallet currency id (1 = USD, 5 = RUB, 3 = EUR, …) */
  readonly currencyId: number;
  /** ISO country of the wallet — required by itemordershistogram */
  readonly country: string;
  /** Steam's cut, e.g. 0.05 */
  readonly feePercent: number;
  /** Flat component added to the Steam fee (0 in most currencies) */
  readonly feeBase: number;
  /** Minimum Steam fee in minor units (usually 1) */
  readonly feeMinimum: number;
  /** Publisher (Valve/CS2) cut, e.g. 0.10 */
  readonly publisherFeePercent: number;
  /** Wallet balance in minor units, when the page exposed it */
  readonly balance: number | null;
  /** false when the page had no g_rgWalletInfo and defaults were used */
  readonly fromPage: boolean;
}

export const DEFAULT_WALLET_FEES: WalletFeeInfo = {
  currencyId: 1,
  country: 'US',
  feePercent: 0.05,
  feeBase: 0,
  feeMinimum: 1,
  publisherFeePercent: 0.1,
  balance: null,
  fromPage: false,
};

export interface FeeSplit {
  /** What the seller receives, minor units */
  readonly received: number;
  /** Steam's cut, minor units */
  readonly steamFee: number;
  /** Publisher's cut, minor units */
  readonly publisherFee: number;
  /** steamFee + publisherFee */
  readonly fees: number;
  /** What the buyer pays, minor units */
  readonly buyerPays: number;
}

// --- Wallet info (page context) ---

const WALLET_ATTR = 'csboardWalletInfo';

let cachedWallet: WalletFeeInfo | null = null;

/** Reject malformed page globals before they can influence a Steam write. */
export function normalizeWalletFeeInfo(raw: unknown): WalletFeeInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<WalletFeeInfo>;
  const validInteger = (input: unknown, max: number): input is number =>
    typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 && input <= max;
  const validRate = (input: unknown): input is number =>
    typeof input === 'number' && Number.isFinite(input) && input >= 0 && input <= 0.5;

  if (!validInteger(value.currencyId, 100) || value.currencyId < 1) return null;
  if (typeof value.country !== 'string' || !/^[A-Z]{2}$/.test(value.country)) return null;
  if (!validRate(value.feePercent) || !validRate(value.publisherFeePercent)) return null;
  if (!validInteger(value.feeBase, 1_000_000)) return null;
  if (!validInteger(value.feeMinimum, 1_000_000)) return null;
  if (value.balance !== null && !validInteger(value.balance, Number.MAX_SAFE_INTEGER)) return null;

  return {
    currencyId: value.currencyId,
    country: value.country,
    feePercent: value.feePercent,
    feeBase: value.feeBase,
    feeMinimum: value.feeMinimum,
    publisherFeePercent: value.publisherFeePercent,
    balance: value.balance,
    fromPage: value.fromPage === true,
  };
}

/**
 * Read g_rgWalletInfo out of the page. Content scripts live in an isolated
 * world and cannot touch page globals, so this goes through the synchronous
 * onreset injection trick already used for the inventory reader.
 *
 * Cached for the lifetime of the content script — wallet currency does not
 * change mid-session, and re-injecting on every button render is wasteful.
 */
export function getWalletFeeInfo(): WalletFeeInfo {
  if (cachedWallet) return cachedWallet;

  document.body?.removeAttribute(WALLET_ATTR);

  const script = `
    try {
      var w = (typeof g_rgWalletInfo !== 'undefined' && g_rgWalletInfo) ? g_rgWalletInfo : null;
      var out = null;
      if (w) {
        out = {
          currencyId: parseInt(w.wallet_currency, 10),
          country: (typeof g_strCountryCode !== 'undefined' && g_strCountryCode) ? String(g_strCountryCode).toUpperCase() : String(w.wallet_country || '').toUpperCase(),
          feePercent: parseFloat(w.wallet_fee_percent),
          feeBase: parseInt(w.wallet_fee_base, 10),
          feeMinimum: parseInt(w.wallet_fee_minimum, 10),
          publisherFeePercent: parseFloat(w.wallet_publisher_fee_percent_default),
          balance: (w.wallet_balance !== undefined && w.wallet_balance !== null) ? parseInt(w.wallet_balance, 10) : null
        };
      }
      document.querySelector('body').setAttribute('${WALLET_ATTR}', JSON.stringify(out));
    } catch (e) {
      document.querySelector('body').setAttribute('${WALLET_ATTR}', 'null');
    }
  `;

  const raw = injectScript(script, true, 'csboardWalletInfo', WALLET_ATTR);

  try {
    const parsed = raw ? JSON.parse(raw) : null;
    const normalized = normalizeWalletFeeInfo({ ...parsed, fromPage: true });
    if (normalized) {
      cachedWallet = normalized;
      logger.debug('Wallet info read from page', {
        currencyId: cachedWallet.currencyId,
        country: cachedWallet.country,
        publisherFeePercent: cachedWallet.publisherFeePercent,
      });
      return cachedWallet;
    }
  } catch {
    // fall through to defaults
  }

  logger.warn('g_rgWalletInfo unavailable — using USD/CS2 fee defaults');
  cachedWallet = DEFAULT_WALLET_FEES;
  return cachedWallet;
}

/** Drop the cached wallet info (e.g. after a Steam SPA navigation). */
export function resetWalletFeeInfo(): void {
  cachedWallet = null;
}

// --- Fee math (ports of Steam's market JS) ---

/**
 * Steam's CalculateAmountToSendForDesiredReceivedAmount.
 * Given what the seller wants to receive, compute what the buyer pays.
 * All values in minor units.
 */
export function buyerPaysForReceived(received: number, wallet: WalletFeeInfo): FeeSplit {
  const safeReceived = Math.max(0, Math.floor(received));

  const steamFee = Math.floor(
    Math.max(safeReceived * wallet.feePercent, wallet.feeMinimum) + wallet.feeBase,
  );
  const publisherFee =
    wallet.publisherFeePercent > 0
      ? Math.floor(Math.max(safeReceived * wallet.publisherFeePercent, 1))
      : 0;

  return {
    received: safeReceived,
    steamFee,
    publisherFee,
    fees: steamFee + publisherFee,
    buyerPays: safeReceived + steamFee + publisherFee,
  };
}

/**
 * Steam's CalculateFeeAmount — the inverse direction.
 * Given the price a buyer pays, compute what the seller receives.
 *
 * Steam does this by estimating, then walking the estimate up until the
 * round-trip matches (integer flooring makes the mapping non-invertible in
 * closed form). The undershoot guard is Steam's, kept as-is: without it the
 * loop can oscillate on currencies with a flat fee base.
 */
export function receivedForBuyerPays(buyerPays: number, wallet: WalletFeeInfo): FeeSplit {
  const target = Math.max(0, Math.floor(buyerPays));

  const estimate = Math.floor(
    (target - wallet.feeBase) / (wallet.feePercent + wallet.publisherFeePercent + 1),
  );

  let received = Math.max(0, estimate);
  let split = buyerPaysForReceived(received, wallet);
  let undershot = false;

  // Bounded walk — 1000 iterations is far past what any real price needs, and
  // guarantees we never spin if Steam's fee params are nonsense.
  for (let i = 0; i < 1000 && split.buyerPays !== target; i += 1) {
    if (split.buyerPays > target) {
      if (undershot) {
        // We already stepped below target once — the exact price is not
        // representable, so keep the last value that stays under it.
        received -= 1;
        split = buyerPaysForReceived(received, wallet);
        break;
      }
      received -= 1;
      undershot = true;
    } else {
      received += 1;
    }
    split = buyerPaysForReceived(received, wallet);
  }

  return split;
}

// --- Formatting ---

const CURRENCY_SIGNS: Record<number, string> = {
  1: '$',
  2: '£',
  3: '€',
  4: 'CHF ',
  5: '₽',
  6: 'zł',
  7: 'R$',
  8: '¥',
  9: 'kr ',
  10: 'Rp ',
  11: 'RM ',
  12: '₱',
  13: 'S$',
  14: '฿',
  15: '₫',
  16: '₩',
  17: '₺',
  18: '₴',
  19: 'MX$',
  20: 'C$',
  21: 'A$',
  22: 'NZ$',
  23: '¥',
  24: '₹',
  25: 'CLP$',
  26: 'S/',
  27: 'COL$',
  28: 'R ',
  29: 'HK$',
  30: 'NT$',
  31: 'SR ',
  32: 'AED ',
  34: 'ARS$',
  35: '₪',
  37: '₸',
  38: 'KD ',
  39: 'QR ',
  40: '₡',
  41: 'UYU$',
  42: 'BYN ',
};

/** Format minor units in the wallet's currency, e.g. 1234 → "$12.34". */
export function formatWalletAmount(minorUnits: number, wallet: WalletFeeInfo): string {
  const sign = CURRENCY_SIGNS[wallet.currencyId] ?? '';
  const value = minorUnits / 100;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${sign}${formatted}`;
}

/**
 * Parse a Steam-rendered price ("$12.34", "12,34€", "1 234,56 ₽") into minor
 * units. Steam's own markup is the only input here, so we normalise on the
 * LAST separator being decimal when it leaves 2 digits behind — that is the
 * one rule that holds across every locale Steam renders.
 */
export function parseWalletAmount(text: string): number | null {
  const cleaned = (text || '').replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  const lastSep = Math.max(lastDot, lastComma);

  let normalized: string;
  if (lastSep !== -1 && cleaned.length - lastSep - 1 <= 2 && cleaned.length - lastSep - 1 > 0) {
    // Trailing group of 1–2 digits → decimal separator.
    normalized = `${cleaned.slice(0, lastSep).replace(/[.,]/g, '')}.${cleaned.slice(lastSep + 1)}`;
  } else {
    // No decimals at all (e.g. "₽6 206" or "1,234") — every separator groups.
    normalized = cleaned.replace(/[.,]/g, '');
  }

  const value = parseFloat(normalized);
  if (!isFinite(value)) return null;
  return Math.round(value * 100);
}
