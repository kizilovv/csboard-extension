// ============================================================
// CSBOARD — Steam Inventory Sell UI
// ============================================================
// Two surfaces, one engine:
//   1. per-item Quick / Instant sell buttons in the right detail panel
//   2. a select-many toolbar in the inventory header for mass listing
//
// Deliberate choices, because this spends the user's items:
//
// - Every listing goes through a 3s undo window. A misclick on a knife is
//   otherwise unrecoverable without cancelling the listing on the market page.
// - Prices are never guessed. If the order book has no bid (instant) or no
//   listing to undercut (quick), the button stays disabled with the reason.
// - Mass sell is strictly sequential and stops dead on the first 429. Racing
//   Steam here gets the account rate-limited, and the trading stack shares
//   that bucket.
// - The panel says "needs Steam Guard confirmation" when Steam says so. The
//   extension cannot and does not skip mobile confirmation.

import { createLogger } from '../../shared/logger';
import {
  getWalletFeeInfo,
  formatWalletAmount,
  type WalletFeeInfo,
} from '../../shared/steam-fees';
import {
  getOrderBook,
  getCachedOrderBook,
  isRateLimited,
  rateLimitSecondsLeft,
  type OrderBook,
} from '../../shared/market-orders';
import { computeSellTarget, sellItem, type SellMode, type SellTarget } from '../../shared/market-actions';

const logger = createLogger('sell-ui');

/** Accessor into inventory.ts's item array — avoids a circular import. */
type ItemsAccessor = () => any[];

let getItems: ItemsAccessor = () => [];
let wallet: WalletFeeInfo = getWalletFeeInfo();

// ============================================================
// Toast + undo
// ============================================================

const UNDO_MS = 3000;

interface PendingSell {
  timer: number;
  cancelled: boolean;
}

const pending = new Map<string, PendingSell>();

function ensureToastHost(): HTMLElement {
  let host = document.getElementById('csboard-sell-toasts');
  if (host?.isConnected) return host;
  host = document.createElement('div');
  host.id = 'csboard-sell-toasts';
  host.className = 'csboard-sell-toasts';
  document.body.appendChild(host);
  return host;
}

function showToast(text: string, kind: 'info' | 'ok' | 'err' = 'info', ttlMs = 6000): HTMLElement {
  const toast = document.createElement('div');
  toast.className = `csboard-sell-toast ${kind}`;
  toast.textContent = text;
  ensureToastHost().appendChild(toast);
  if (ttlMs > 0) setTimeout(() => toast.remove(), ttlMs);
  return toast;
}

/**
 * Queue a listing behind a visible undo countdown. Resolves to true when the
 * listing actually went out, false when the user pulled it back.
 */
function queueSellWithUndo(
  item: any,
  target: SellTarget,
  label: string,
): Promise<boolean> {
  const key = `${item.assetid}`;

  // A second click on the same asset replaces the first pending listing.
  const existing = pending.get(key);
  if (existing) {
    existing.cancelled = true;
    clearTimeout(existing.timer);
    pending.delete(key);
  }

  return new Promise<boolean>((resolve) => {
    const toast = document.createElement('div');
    toast.className = 'csboard-sell-toast info';

    const receivedText = formatWalletAmount(target.split.received, wallet);
    const buyerText = formatWalletAmount(target.split.buyerPays, wallet);

    let secondsLeft = Math.ceil(UNDO_MS / 1000);
    const textEl = document.createElement('span');
    const render = () => {
      textEl.textContent = `${label}: ${item.name || item.market_hash_name} — you get ${receivedText} (buyer pays ${buyerText}) · ${secondsLeft}s`;
    };
    render();

    const undoBtn = document.createElement('button');
    undoBtn.className = 'csboard-sell-undo';
    undoBtn.textContent = 'Undo';

    toast.append(textEl, undoBtn);
    ensureToastHost().appendChild(toast);

    const tick = window.setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft >= 0) render();
    }, 1000);

    const state: PendingSell = { timer: 0, cancelled: false };

    const finish = (didList: boolean) => {
      clearInterval(tick);
      pending.delete(key);
      toast.remove();
      resolve(didList);
    };

    undoBtn.addEventListener('click', () => {
      state.cancelled = true;
      clearTimeout(state.timer);
      showToast('Listing cancelled', 'info', 2500);
      finish(false);
    });

    state.timer = window.setTimeout(async () => {
      if (state.cancelled) return;
      const result = await sellItem({
        appId: item.appid || '730',
        contextId: item.contextid || '2',
        assetId: item.assetid,
        amount: 1,
        received: target.split.received,
      });

      if (!result.ok) {
        showToast(`Steam refused: ${result.error.message}`, 'err', 9000);
        finish(false);
        return;
      }

      const suffix = result.value.requiresConfirmation
        ? ' — confirm it in Steam Guard'
        : '';
      showToast(`Listed at ${buyerText}${suffix}`, 'ok', 7000);
      finish(true);
    }, UNDO_MS);

    pending.set(key, state);
  });
}

// ============================================================
// Per-item sell panel (right-hand detail panel)
// ============================================================

const PANEL_CLASS = 'csboard-sell-panel';

function itemBlockedReason(item: any): string | null {
  if (!item) return 'Item data not loaded yet';
  if (!item.market_hash_name) return 'No market name for this item';
  if (!item.marketable) return 'Steam marks this item as not marketable';
  if (item.contextid === '16') return 'Trade-protected — cannot be listed yet';
  if (item.tradabilityShort) return `On trade hold (${item.tradabilityShort})`;
  return null;
}

function renderButtonRow(
  panel: HTMLElement,
  item: any,
  book: OrderBook | null,
  loading: boolean,
): void {
  panel.querySelectorAll('.csboard-sell-row, .csboard-sell-note').forEach((el) => el.remove());

  const row = document.createElement('div');
  row.className = 'csboard-sell-row';

  const modes: Array<{ mode: SellMode; label: string }> = [
    { mode: 'quick', label: 'Quick sell' },
    { mode: 'instant', label: 'Instant sell' },
  ];

  for (const { mode, label } of modes) {
    const btn = document.createElement('button');
    btn.className = `csboard-sell-btn ${mode}`;

    if (loading) {
      btn.textContent = `${label} …`;
      btn.disabled = true;
      row.appendChild(btn);
      continue;
    }

    const target = book ? computeSellTarget(mode, book, wallet) : null;

    if (!target) {
      btn.textContent = label;
      btn.disabled = true;
      btn.title =
        mode === 'instant'
          ? 'No standing buy order to meet'
          : 'Nothing listed to undercut';
      row.appendChild(btn);
      continue;
    }

    btn.innerHTML = `${label} <strong>${formatWalletAmount(target.split.received, wallet)}</strong>`;
    btn.title = `${target.basis} · buyer pays ${formatWalletAmount(target.buyerPays, wallet)} · Steam + game fees ${formatWalletAmount(target.split.fees, wallet)}`;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void queueSellWithUndo(item, target, label);
    });
    row.appendChild(btn);
  }

  panel.appendChild(row);

  if (book && !loading) {
    const note = document.createElement('div');
    note.className = 'csboard-sell-note';
    const bid = book.highestBuyOrder !== null ? formatWalletAmount(book.highestBuyOrder, wallet) : '—';
    const ask = book.lowestSellOrder !== null ? formatWalletAmount(book.lowestSellOrder, wallet) : '—';
    note.textContent = `Steam book: bid ${bid} · ask ${ask}`;
    panel.appendChild(note);
  }
}

/**
 * Build (or refresh) the sell panel for the item currently open in Steam's
 * right-hand panel. `anchor` is the element we insert after.
 */
export async function injectSellPanel(anchor: Element, item: any): Promise<void> {
  // One panel at a time — Steam re-renders this area constantly.
  document.querySelectorAll(`.${PANEL_CLASS}`).forEach((el) => el.remove());

  const panel = document.createElement('div');
  panel.className = PANEL_CLASS;

  const header = document.createElement('div');
  header.className = 'csboard-sell-header';
  header.textContent = 'Sell on Steam market';
  panel.appendChild(header);

  const blocked = itemBlockedReason(item);
  if (blocked) {
    const note = document.createElement('div');
    note.className = 'csboard-sell-note';
    note.textContent = blocked;
    panel.appendChild(note);
    anchor.insertAdjacentElement('afterend', panel);
    return;
  }

  anchor.insertAdjacentElement('afterend', panel);

  const name = item.market_hash_name as string;
  const cached = getCachedOrderBook(name);
  if (cached) {
    renderButtonRow(panel, item, cached, false);
    return;
  }

  if (isRateLimited()) {
    renderButtonRow(panel, item, null, false);
    const note = document.createElement('div');
    note.className = 'csboard-sell-note';
    note.textContent = `Steam rate limit — prices in ${rateLimitSecondsLeft()}s`;
    panel.appendChild(note);
    return;
  }

  renderButtonRow(panel, item, null, true);

  const result = await getOrderBook(name, wallet);

  // The user may have clicked another item while we waited.
  if (!panel.isConnected) return;

  if (!result.ok) {
    renderButtonRow(panel, item, null, false);
    const note = document.createElement('div');
    note.className = 'csboard-sell-note';
    note.textContent = `No prices: ${result.error.message}`;
    panel.appendChild(note);
    return;
  }

  renderButtonRow(panel, item, result.value, false);
}

// ============================================================
// Mass sell
// ============================================================

const SELECTED_CLASS = 'csboard-mass-selected';

let selectMode = false;
let runAbort = false;
const selected = new Set<string>();

function selectableItemEl(target: HTMLElement): HTMLElement | null {
  const el = target.closest('.item.app730') as HTMLElement | null;
  return el?.id ? el : null;
}

function assetIdOf(el: HTMLElement): string {
  return el.id.split('_')[2] ?? '';
}

function paintSelection(): void {
  document.querySelectorAll<HTMLElement>('.item.app730').forEach((el) => {
    const id = assetIdOf(el);
    el.classList.toggle(SELECTED_CLASS, selectMode && selected.has(id));
  });
  updateToolbarCounts();
}

function itemsByAssetIds(ids: Iterable<string>): any[] {
  const all = getItems();
  const wanted = new Set(ids);
  return all.filter((i: any) => wanted.has(i.assetid));
}

function sellableSelection(): any[] {
  return itemsByAssetIds(selected).filter((i) => itemBlockedReason(i) === null);
}

function updateToolbarCounts(): void {
  const countEl = document.getElementById('csboard-mass-count');
  if (countEl) {
    const sellable = sellableSelection().length;
    countEl.textContent =
      selected.size === 0
        ? 'nothing selected'
        : `${selected.size} selected · ${sellable} sellable`;
  }
  for (const id of ['csboard-mass-quick', 'csboard-mass-instant']) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = sellableSelection().length === 0;
  }
}

/**
 * Sequentially list every selected item at the given mode. One order book
 * fetch + one listing per item, both behind their own rate gates, so a 40-item
 * run paces itself instead of stampeding Steam.
 */
async function runMassSell(mode: SellMode): Promise<void> {
  const queue = sellableSelection();
  if (queue.length === 0) return;

  runAbort = false;
  const progress = showToast(`Listing 0/${queue.length}…`, 'info', 0);

  const stopBtn = document.createElement('button');
  stopBtn.className = 'csboard-sell-undo';
  stopBtn.textContent = 'Stop';
  stopBtn.addEventListener('click', () => {
    runAbort = true;
    stopBtn.disabled = true;
    stopBtn.textContent = 'Stopping…';
  });
  progress.appendChild(stopBtn);

  let listed = 0;
  let failed = 0;
  let confirmations = 0;

  for (let i = 0; i < queue.length; i += 1) {
    if (runAbort) break;

    const item = queue[i];
    progress.firstChild!.textContent = `Listing ${i + 1}/${queue.length} — ${item.market_hash_name} · ${listed} done, ${failed} failed `;

    const bookResult = await getOrderBook(item.market_hash_name, wallet);
    if (!bookResult.ok) {
      failed += 1;
      if (bookResult.error.code === 'RATE_LIMITED') {
        showToast(`Stopped — Steam rate limit. Retry in ${rateLimitSecondsLeft()}s`, 'err', 12000);
        break;
      }
      continue;
    }

    const target = computeSellTarget(mode, bookResult.value, wallet);
    if (!target) {
      failed += 1;
      continue;
    }

    const result = await sellItem({
      appId: item.appid || '730',
      contextId: item.contextid || '2',
      assetId: item.assetid,
      amount: 1,
      received: target.split.received,
    });

    if (!result.ok) {
      failed += 1;
      if (result.error.code === 'RATE_LIMITED') {
        showToast(`Stopped — Steam rate limit while listing. ${listed} went out.`, 'err', 12000);
        break;
      }
      logger.warn('Mass sell item failed', {
        assetId: item.assetid,
        error: result.error.message,
      });
      continue;
    }

    listed += 1;
    if (result.value.requiresConfirmation) confirmations += 1;
    selected.delete(item.assetid);
  }

  progress.remove();
  paintSelection();

  const parts = [`${listed} listed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (confirmations > 0) parts.push(`${confirmations} need Steam Guard confirmation`);
  showToast(parts.join(' · '), failed > 0 ? 'err' : 'ok', 10000);
}

// --- Toolbar ---

function buildToolbar(): HTMLElement {
  const bar = document.createElement('div');
  bar.id = 'csboard-mass-sell';
  bar.className = 'csboard-mass-bar';

  bar.innerHTML = `
    <button id="csboard-mass-toggle" class="csboard-mass-btn">Select to sell</button>
    <span id="csboard-mass-count" class="csboard-mass-count">nothing selected</span>
    <span class="csboard-mass-group" id="csboard-mass-actions" hidden>
      <button id="csboard-mass-page" class="csboard-mass-btn ghost">Page</button>
      <button id="csboard-mass-dupes" class="csboard-mass-btn ghost">Duplicates</button>
      <button id="csboard-mass-clear" class="csboard-mass-btn ghost">Clear</button>
      <button id="csboard-mass-quick" class="csboard-sell-btn quick" disabled>Quick sell</button>
      <button id="csboard-mass-instant" class="csboard-sell-btn instant" disabled>Instant sell</button>
    </span>
  `;

  const toggle = bar.querySelector('#csboard-mass-toggle') as HTMLButtonElement;
  const actions = bar.querySelector('#csboard-mass-actions') as HTMLElement;

  toggle.addEventListener('click', () => {
    selectMode = !selectMode;
    toggle.classList.toggle('active', selectMode);
    toggle.textContent = selectMode ? 'Done selecting' : 'Select to sell';
    actions.hidden = !selectMode;
    if (!selectMode) selected.clear();
    paintSelection();
  });

  bar.querySelector('#csboard-mass-page')!.addEventListener('click', () => {
    document.querySelectorAll<HTMLElement>('.inventory_page').forEach((page) => {
      if (page.style.display === 'none') return;
      page.querySelectorAll<HTMLElement>('.item.app730').forEach((el) => {
        const id = assetIdOf(el);
        if (id) selected.add(id);
      });
    });
    paintSelection();
  });

  bar.querySelector('#csboard-mass-dupes')!.addEventListener('click', () => {
    // Keep one of each name, select the rest — the classic "sell my spares" pass.
    const seen = new Set<string>();
    for (const item of getItems()) {
      if (itemBlockedReason(item) !== null) continue;
      const name = item.market_hash_name;
      if (seen.has(name)) selected.add(item.assetid);
      else seen.add(name);
    }
    paintSelection();
  });

  bar.querySelector('#csboard-mass-clear')!.addEventListener('click', () => {
    selected.clear();
    paintSelection();
  });

  bar.querySelector('#csboard-mass-quick')!.addEventListener('click', () => {
    void runMassSell('quick');
  });
  bar.querySelector('#csboard-mass-instant')!.addEventListener('click', () => {
    void runMassSell('instant');
  });

  return bar;
}

// ============================================================
// Wiring
// ============================================================

/**
 * Mount the mass-sell toolbar and the click-to-select behaviour.
 * `headerBar` is inventory.ts's persistent header row.
 */
export function setupSellUi(accessor: ItemsAccessor, headerBar: HTMLElement | null): void {
  getItems = accessor;
  wallet = getWalletFeeInfo();

  if (headerBar && !document.getElementById('csboard-mass-sell')) {
    headerBar.appendChild(buildToolbar());
  }

  // Capture phase: in select mode a click toggles selection instead of opening
  // Steam's detail panel. Outside select mode we do not interfere at all.
  document.addEventListener(
    'click',
    (e) => {
      if (!selectMode) return;
      const el = selectableItemEl(e.target as HTMLElement);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const id = assetIdOf(el);
      if (!id) return;
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      paintSelection();
    },
    true,
  );

  logger.info('Sell UI mounted', {
    walletCurrency: wallet.currencyId,
    walletFromPage: wallet.fromPage,
  });
}

/** Re-apply selection highlighting after Steam re-renders a page of items. */
export function repaintSellSelection(): void {
  if (selectMode) paintSelection();
}
