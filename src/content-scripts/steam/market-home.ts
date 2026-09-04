// ============================================================
// CSBOARD Content Script — Steam Market Home (/market/)
// ============================================================
// The page where the user's own money sits: active listings, buy orders,
// pending confirmations. Steam shows rows and no arithmetic.
//
// What we add:
//   - totals (what buyers pay vs what actually lands in the wallet)
//   - sorting of your own listings
//   - an explicit "scan prices" pass that marks listings sitting above the
//     current cheapest ask, plus one-click removal of those
//
// Two deliberate limits:
//
// - Nothing scans on page load. A user with 200 listings would fire 200 Steam
//   requests just by opening the page, which is exactly how this account gets
//   rate-limited. The scan is a button, it is sequential, and it is per unique
//   item name.
// - There is no "relist" button. Removing a listing returns the asset to the
//   inventory with a NEW assetid, so a remove+relist pair cannot be done
//   atomically from here. Pretending otherwise would silently drop items.
//   Removed items get relisted from the inventory page instead.

import { createLogger } from '../../shared/logger';
import {
  getWalletFeeInfo,
  formatWalletAmount,
  parseWalletAmount,
  receivedForBuyerPays,
  type WalletFeeInfo,
} from '../../shared/steam-fees';
import { getOrderBook, rateLimitSecondsLeft } from '../../shared/market-orders';
import { whenSiteEnabled } from '../../shared/enhancements';
import {
  authorizeListingRemovalFromUserGesture,
  batchStopReasonForError,
  getCurrentSteamAccountId,
  removeListing,
  type ListingRemovalAuthorization,
} from '../../shared/market-actions';

const logger = createLogger('market-home');

/** How far above the cheapest ask a listing must sit to be flagged. */
const OVERPRICED_THRESHOLD_PCT = 5;

interface ListingRow {
  readonly el: HTMLElement;
  readonly listingId: string;
  readonly marketHashName: string;
  /** Buyer-pays price in wallet minor units. */
  readonly buyerPays: number;
  /** Seller-receives, from Steam's own second figure when present. */
  readonly received: number;
}

let wallet: WalletFeeInfo = getWalletFeeInfo();
const flagged = new Set<string>();

// ============================================================
// Row scraping
// ============================================================

function listingContainer(): HTMLElement | null {
  return (
    document.getElementById('tabContentsMyActiveMarketListingsRows') ??
    document.getElementById('tabContentsMyListings')
  );
}

/**
 * Read one listing row.
 *
 * Steam renders both the buyer price and the seller net inside the price cell,
 * in markup that has changed shape more than once. Rather than depend on the
 * current class names, we take every currency-looking figure in the cell: the
 * largest is what the buyer pays, the smallest is the net. When only one
 * number is there, the net comes from our own fee math.
 */
function readListingRow(el: HTMLElement): ListingRow | null {
  const listingId = el.id.startsWith('mylisting_') ? el.id.slice('mylisting_'.length) : '';
  if (!listingId) return null;

  const nameEl = el.querySelector('.market_listing_item_name');
  const marketHashName = nameEl?.textContent?.trim() ?? '';
  if (!marketHashName) return null;

  const priceCell =
    el.querySelector('.market_listing_price') ??
    el.querySelector('.market_listing_my_price') ??
    el.querySelector('.market_table_value');
  if (!priceCell) return null;

  const figures: number[] = [];
  for (const raw of (priceCell.textContent ?? '').split(/\s{2,}|\n/)) {
    const parsed = parseWalletAmount(raw);
    if (parsed !== null && parsed > 0) figures.push(parsed);
  }
  if (figures.length === 0) {
    const whole = parseWalletAmount(priceCell.textContent ?? '');
    if (whole === null) return null;
    figures.push(whole);
  }

  const buyerPays = Math.max(...figures);
  const received =
    figures.length > 1
      ? Math.min(...figures)
      : receivedForBuyerPays(buyerPays, wallet).received;

  return { el, listingId, marketHashName, buyerPays, received };
}

function readListings(): ListingRow[] {
  const container = listingContainer();
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>('[id^="mylisting_"]'))
    .map(readListingRow)
    .filter((r): r is ListingRow => r !== null);
}

function readBuyOrders(): { count: number; total: number } {
  let count = 0;
  let total = 0;
  document.querySelectorAll<HTMLElement>('[id^="mybuyorder_"]').forEach((el) => {
    const priceEl = el.querySelector('.market_listing_price');
    const price = parseWalletAmount(priceEl?.textContent ?? '');
    // Buy orders carry a quantity ("3 @ $1.20") — Steam puts it in its own cell.
    const qtyText = el.querySelector('.market_listing_buyorder_qty, .market_listing_num_listings_qty')?.textContent ?? '1';
    const qty = parseInt(qtyText.replace(/[^0-9]/g, ''), 10) || 1;
    if (price !== null) {
      count += qty;
      total += price * qty;
    }
  });
  return { count, total };
}

// ============================================================
// Summary panel
// ============================================================

function ensurePanel(): HTMLElement | null {
  let panel = document.getElementById('csboard-market-home') as HTMLElement | null;
  if (panel?.isConnected) return panel;

  panel = document.createElement('div');
  panel.id = 'csboard-market-home';
  panel.className = 'csboard-market-home';

  // #myMarketTabs is a fixed-height rail (30px) whose own children — the tab
  // strip and the "Sell an item" button — are absolutely positioned. A block
  // placed inside it is drawn over by the tabs and spills onto the listing
  // table below, so the panel goes after the rail, in normal flow.
  const tabWell = document.getElementById('myMarketTabs');
  if (tabWell) {
    tabWell.insertAdjacentElement('afterend', panel);
    return panel;
  }

  const anchor =
    document.querySelector('.market_header_text') ??
    document.querySelector('#mainContents');
  if (!anchor) return null;

  anchor.insertAdjacentElement('afterbegin', panel);
  return panel;
}

function renderPanel(): void {
  const panel = ensurePanel();
  if (!panel) return;

  const listings = readListings();
  const buyOrders = readBuyOrders();

  const buyerTotal = listings.reduce((sum, l) => sum + l.buyerPays, 0);
  const netTotal = listings.reduce((sum, l) => sum + l.received, 0);

  panel.innerHTML = `
    <div class="csboard-mh-row">
      <span class="csboard-logo">CSBOARD</span>
      <span class="csboard-mh-stat">Listings <strong>${listings.length}</strong></span>
      <span class="csboard-mh-stat">Buyers pay <strong>${formatWalletAmount(buyerTotal, wallet)}</strong></span>
      <span class="csboard-mh-stat">You receive <strong class="csboard-mh-net">${formatWalletAmount(netTotal, wallet)}</strong></span>
      <span class="csboard-mh-stat">Fees <strong>${formatWalletAmount(buyerTotal - netTotal, wallet)}</strong></span>
      <span class="csboard-mh-stat">Buy orders <strong>${buyOrders.count}</strong> · ${formatWalletAmount(buyOrders.total, wallet)}</span>
    </div>
    <div class="csboard-mh-row">
      <label class="csboard-mh-label">Sort
        <select id="csboard-mh-sort">
          <option value="default">Steam order</option>
          <option value="price_desc">Price (high → low)</option>
          <option value="price_asc">Price (low → high)</option>
          <option value="name_asc">Name (A → Z)</option>
        </select>
      </label>
      <button id="csboard-mh-scan" class="csboard-mass-btn">Scan Steam prices</button>
      <button id="csboard-mh-remove" class="csboard-sell-btn instant" disabled>Remove flagged</button>
      <span id="csboard-mh-status" class="csboard-mh-status"></span>
    </div>
  `;

  (panel.querySelector('#csboard-mh-sort') as HTMLSelectElement).addEventListener('change', (e) => {
    sortListings((e.target as HTMLSelectElement).value);
  });
  panel.querySelector('#csboard-mh-scan')!.addEventListener('click', () => {
    void scanPrices();
  });
  panel.querySelector('#csboard-mh-remove')!.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    if (!wallet.fromPage) {
      setStatus('Steam wallet currency is unavailable — listing removal is disabled.', 'err');
      return;
    }
    const ids = [...flagged];
    const steamId = getCurrentSteamAccountId();
    if (!steamId) {
      setStatus('Cannot verify the active Steam account — reload before removing listings.', 'err');
      return;
    }
    const authorization = authorizeListingRemovalFromUserGesture(event, ids, steamId);
    if (!authorization.ok) {
      setStatus(authorization.error.message, 'err');
      return;
    }
    if (!window.confirm(`Remove ${ids.length} reviewed Steam listing(s)? Already removed listings cannot be restored automatically.`)) {
      return;
    }
    void removeFlagged(ids, authorization.value);
  });

  updateRemoveButton();
}

function setStatus(text: string, kind: 'info' | 'err' | 'ok' = 'info'): void {
  const el = document.getElementById('csboard-mh-status');
  if (!el) return;
  el.textContent = text;
  el.className = `csboard-mh-status ${kind}`;
}

function updateRemoveButton(): void {
  const btn = document.getElementById('csboard-mh-remove') as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = flagged.size === 0;
  btn.textContent = flagged.size === 0 ? 'Remove flagged' : `Remove flagged (${flagged.size})`;
}

// ============================================================
// Sorting
// ============================================================

function sortListings(mode: string): void {
  const container = listingContainer();
  if (!container) return;

  const rows = readListings();
  if (rows.length === 0) return;

  const sorted = [...rows].sort((a, b) => {
    if (mode === 'price_desc') return b.buyerPays - a.buyerPays;
    if (mode === 'price_asc') return a.buyerPays - b.buyerPays;
    if (mode === 'name_asc') return a.marketHashName.localeCompare(b.marketHashName);
    return 0;
  });

  if (mode === 'default') return;
  for (const row of sorted) container.appendChild(row.el);
}

// ============================================================
// Price scan
// ============================================================

function annotate(row: ListingRow, cheapestAsk: number | null): void {
  row.el.querySelectorAll('.csboard-mh-diff').forEach((el) => el.remove());
  row.el.classList.remove('csboard-mh-flagged');

  const tag = document.createElement('span');
  tag.className = 'csboard-mh-diff';

  if (cheapestAsk === null) {
    tag.textContent = 'no ask';
    tag.classList.add('neutral');
  } else {
    const diffPct = Math.round(((row.buyerPays - cheapestAsk) / cheapestAsk) * 100);
    tag.textContent = `${diffPct > 0 ? '+' : ''}${diffPct}% vs ${formatWalletAmount(cheapestAsk, wallet)}`;

    if (diffPct > OVERPRICED_THRESHOLD_PCT) {
      tag.classList.add('over');
      row.el.classList.add('csboard-mh-flagged');
      flagged.add(row.listingId);
    } else if (diffPct < 0) {
      tag.classList.add('under');
      flagged.delete(row.listingId);
    } else {
      tag.classList.add('neutral');
      flagged.delete(row.listingId);
    }
  }

  const host =
    row.el.querySelector('.market_listing_item_name_block') ??
    row.el.querySelector('.market_listing_item_name') ??
    row.el;
  host.appendChild(tag);
}

/**
 * Fetch the cheapest current ask per unique item and mark every listing
 * against it. One request per NAME, not per listing — a user with 12 copies of
 * the same case pays for one lookup.
 */
async function scanPrices(): Promise<void> {
  const rows = readListings();
  if (rows.length === 0) {
    setStatus('No active listings on this page', 'info');
    return;
  }

  const scanBtn = document.getElementById('csboard-mh-scan') as HTMLButtonElement | null;
  if (scanBtn) scanBtn.disabled = true;

  flagged.clear();
  const uniqueNames = [...new Set(rows.map((r) => r.marketHashName))];
  const asks = new Map<string, number | null>();

  for (let i = 0; i < uniqueNames.length; i += 1) {
    const name = uniqueNames[i]!;
    setStatus(`Scanning ${i + 1}/${uniqueNames.length}…`);

    const result = await getOrderBook(name, wallet);
    if (!result.ok) {
      if (result.error.code === 'RATE_LIMITED') {
        setStatus(`Stopped — Steam rate limit. Retry in ${rateLimitSecondsLeft()}s`, 'err');
        break;
      }
      asks.set(name, null);
      continue;
    }
    asks.set(name, result.value.lowestSellOrder);
  }

  for (const row of rows) {
    if (!asks.has(row.marketHashName)) continue;
    annotate(row, asks.get(row.marketHashName) ?? null);
  }

  if (scanBtn) scanBtn.disabled = false;
  updateRemoveButton();

  const scanned = asks.size;
  setStatus(
    `Scanned ${scanned}/${uniqueNames.length} items · ${flagged.size} listing(s) above the cheapest ask`,
    flagged.size > 0 ? 'err' : 'ok',
  );
}

// ============================================================
// Bulk remove
// ============================================================

async function removeFlagged(
  ids: readonly string[],
  authorization: ListingRemovalAuthorization,
): Promise<void> {
  if (ids.length === 0) return;

  const btn = document.getElementById('csboard-mh-remove') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  let removed = 0;
  let failed = 0;

  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]!;
    setStatus(`Removing ${i + 1}/${ids.length}…`);

    const result = await removeListing(id, authorization);
    if (!result.ok) {
      failed += 1;
      const stopReason = batchStopReasonForError(result.error);
      if (stopReason) {
        setStatus(`Stopped (${stopReason.replace(/_/g, ' ')}). ${removed} removed.`, 'err');
        break;
      }
      logger.warn('removeListing failed', { listingId: id, error: result.error.message });
      continue;
    }

    removed += 1;
    flagged.delete(id);
    const row = document.getElementById(`mylisting_${id}`);
    row?.classList.add('csboard-mh-removed');
  }

  updateRemoveButton();
  renderPanel();
  setStatus(
    `${removed} removed${failed > 0 ? `, ${failed} failed` : ''} — items are back in your inventory, relist them there`,
    failed > 0 ? 'err' : 'ok',
  );
}

// ============================================================
// Init
// ============================================================

function init(): void {
  wallet = getWalletFeeInfo();
  renderPanel();

  // Steam loads the listings table asynchronously and repaginates in place;
  // re-render the totals when the row set changes, but never rescan prices.
  const container = listingContainer();
  if (container) {
    let scheduled = false;
    const obs = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        renderPanel();
      }, 250);
    });
    obs.observe(container, { childList: true });
  } else {
    setTimeout(init, 1000);
    return;
  }

  logger.info('Market home ready', { walletFromPage: wallet.fromPage });
}

/* The master switch is checked here, once, before anything is drawn. */
const bootstrap = () => { init(); };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => whenSiteEnabled('steam', bootstrap));
} else {
  whenSiteEnabled('steam', bootstrap);
}
