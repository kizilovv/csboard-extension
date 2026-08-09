// ============================================================
// CSBOARD — Steam Inventory Sell UI
// ============================================================
// Two surfaces, one engine:
//   1. native Steam Sell plus Quick / Instant buttons in the right detail panel
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
  DEFAULT_WALLET_FEES,
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
import {
  authorizeSellFromUserGesture,
  batchStopReasonForError,
  computeSellTarget,
  getCurrentSteamAccountId,
  getSellBlockReason,
  hasDownwardPriceDrift,
  hasIndividualPremiumRisk,
  INITIAL_BATCH_SELL_STATE,
  MAX_SELL_BATCH_SIZE,
  reduceBatchSellState,
  sellItem,
  summarizeSellTargets,
  type BatchSellState,
  type MarketWriteAuthorization,
  type OrderBookSellMode,
  type SellTarget,
} from '../../shared/market-actions';

const logger = createLogger('sell-ui');
const LAST_SINGLE_SELL_AUDIT_KEY = 'csboard_last_single_sell_audit';
const LAST_BATCH_SELL_RESULT_KEY = 'csboard_last_sell_batch_result';

/** Accessor into inventory.ts's item array — avoids a circular import. */
type ItemsAccessor = () => any[];

let getItems: ItemsAccessor = () => [];
let wallet: WalletFeeInfo = DEFAULT_WALLET_FEES;
let loggedInSteamId: string | null = null;

// ============================================================
// Toast + undo
// ============================================================

const UNDO_MS = 3000;

interface PendingSell {
  timer: number;
  cancelled: boolean;
  submitting: boolean;
  cancel(): boolean;
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

function persistSanitizedLocalRecord(key: string, value: Record<string, unknown>): Promise<void> {
  // Deliberately local-only: no cookies, session id, Steam token, inspect link,
  // or authorization capability is included in these diagnostics.
  return chrome.storage.local.set({ [key]: value }).catch(() => undefined);
}

function persistSingleSellAudit(
  item: any,
  preview: SellTarget,
  submit: SellTarget | null,
  status: string,
  errorCode?: string,
): void {
  void persistSanitizedLocalRecord(LAST_SINGLE_SELL_AUDIT_KEY, {
    version: 1,
    recordedAt: Date.now(),
    assetId: String(item.assetid),
    marketHashName: String(item.market_hash_name),
    mode: preview.mode,
    previewBookFetchedAt: preview.bookFetchedAt,
    submitBookFetchedAt: submit?.bookFetchedAt ?? null,
    previewReceived: preview.split.received,
    submitReceived: submit?.split.received ?? null,
    previewBuyerPays: preview.split.buyerPays,
    submitBuyerPays: submit?.split.buyerPays ?? null,
    status,
    ...(errorCode ? { errorCode } : {}),
  });
}

/**
 * Queue a listing behind a visible undo countdown. Resolves to true when the
 * listing actually went out, false when the user pulled it back.
 */
function queueSellWithUndo(
  item: any,
  target: SellTarget,
  label: string,
  authorization: MarketWriteAuthorization,
): Promise<boolean> {
  const key = `${item.assetid}`;

  if (activeBatchAssetIds.has(key)) {
    showToast('This asset is already reserved by the active batch', 'err', 6000);
    return Promise.resolve(false);
  }

  // A second click on the same asset replaces the first pending listing.
  const existing = pending.get(key);
  if (existing) {
    if (!existing.cancel()) {
      showToast('This asset is already being submitted to Steam', 'err', 6000);
      return Promise.resolve(false);
    }
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

    const state: PendingSell = {
      timer: 0,
      cancelled: false,
      submitting: false,
      cancel: () => false,
    };
    let settled = false;

    const finish = (didList: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      pending.delete(key);
      toast.remove();
      resolve(didList);
    };

    state.cancel = () => {
      if (state.submitting || settled) return false;
      state.cancelled = true;
      clearTimeout(state.timer);
      persistSingleSellAudit(item, target, null, 'cancelled_during_undo');
      showToast('Listing cancelled', 'info', 2500);
      finish(false);
      return true;
    };
    undoBtn.addEventListener('click', state.cancel);

    state.timer = window.setTimeout(async () => {
      if (state.cancelled) return;

      let liveTarget = target;
      if (target.mode !== 'sell') {
        const bookResult = await getOrderBook(item.market_hash_name, wallet, { force: true });
        if (state.cancelled) return;
        if (!bookResult.ok) {
          persistSingleSellAudit(item, target, null, 'rejected_before_submit', bookResult.error.code);
          showToast(`Stopped before listing: ${bookResult.error.message}`, 'err', 9000);
          finish(false);
          return;
        }
        const repriced = computeSellTarget(target.mode, bookResult.value, wallet);
        if (!repriced) {
          persistSingleSellAudit(item, target, null, 'price_unavailable');
          showToast('Price is no longer available — review again', 'err', 9000);
          finish(false);
          return;
        }
        if (hasDownwardPriceDrift(target, repriced)) {
          persistSingleSellAudit(item, target, repriced, 'reconfirmation_required');
          showToast('Steam price dropped — click again to review the lower price', 'err', 10000);
          finish(false);
          return;
        }
        liveTarget = repriced;
      }

      if (state.cancelled) return;
      state.submitting = true;
      undoBtn.disabled = true;
      undoBtn.textContent = 'Submitting…';

      const result = await sellItem({
        appId: String(item.appid),
        contextId: String(item.contextid),
        assetId: item.assetid,
        amount: 1,
        received: liveTarget.split.received,
        authorization,
      });

      if (!result.ok) {
        persistSingleSellAudit(item, target, liveTarget, 'rejected', result.error.code);
        showToast(`Steam refused: ${result.error.message}`, 'err', 9000);
        finish(false);
        return;
      }

      const liveBuyerText = formatWalletAmount(liveTarget.split.buyerPays, wallet);
      persistSingleSellAudit(
        item,
        target,
        liveTarget,
        result.value.confirmationStatus,
      );
      if (result.value.confirmationStatus === 'pending_mobile_confirmation') {
        showToast(`Submitted at ${liveBuyerText} — pending mobile Steam Guard confirmation`, 'info', 10000);
      } else if (result.value.confirmationStatus === 'pending_email_confirmation') {
        showToast(`Submitted at ${liveBuyerText} — pending Steam email confirmation`, 'info', 10000);
      } else if (result.value.confirmationStatus === 'pending_confirmation') {
        showToast(`Submitted at ${liveBuyerText} — pending Steam confirmation`, 'info', 10000);
      } else {
        showToast(`Listed live at ${liveBuyerText}`, 'ok', 7000);
      }
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
  return getSellBlockReason(item, loggedInSteamId, wallet.fromPage);
}

function singleSellReviewText(label: string, item: any, target: SellTarget): string {
  const lines = [
    `${label}: ${item.name || item.market_hash_name}`,
    '',
    `You receive: ${formatWalletAmount(target.split.received, wallet)}`,
    `Steam fee: ${formatWalletAmount(target.split.steamFee, wallet)}`,
    `Game fee: ${formatWalletAmount(target.split.publisherFee, wallet)}`,
    `Total fees: ${formatWalletAmount(target.split.fees, wallet)}`,
    `Buyer pays: ${formatWalletAmount(target.split.buyerPays, wallet)}`,
  ];
  if (hasIndividualPremiumRisk(item)) {
    lines.push(
      '',
      'PREMIUM WARNING: Steam prices only the market name; individual float, pattern, phase, and stickers are ignored.',
    );
  }
  lines.push('', `${target.basis}. Continue?`);
  return lines.join('\n');
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

  const modes: Array<{ mode: OrderBookSellMode; label: string }> = [
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
      if (!e.isTrusted) return;

      loggedInSteamId = getCurrentSteamAccountId();
      const blocked = itemBlockedReason(item);
      if (blocked || !loggedInSteamId) {
        showToast(blocked ?? 'Cannot verify the active Steam account', 'err', 8000);
        return;
      }

      const authorizationResult = authorizeSellFromUserGesture(
        e,
        [item.assetid],
        loggedInSteamId,
      );
      if (!authorizationResult.ok) {
        showToast(authorizationResult.error.message, 'err', 8000);
        return;
      }

      if (!window.confirm(singleSellReviewText(label, item, target))) return;
      void queueSellWithUndo(item, target, label, authorizationResult.value);
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

  loggedInSteamId = getCurrentSteamAccountId();
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
let batchRunning = false;
const selected = new Set<string>();
const activeBatchAssetIds = new Set<string>();

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

interface SelectionBreakdown {
  readonly eligible: any[];
  readonly blocked: ReadonlyMap<string, number>;
  readonly blockedItems: ReadonlyArray<{
    readonly assetId: string;
    readonly marketHashName: string;
    readonly reason: string;
  }>;
}

function selectionBreakdown(): SelectionBreakdown {
  const selectedItems = itemsByAssetIds(selected);
  const eligible: any[] = [];
  const blocked = new Map<string, number>();
  const blockedItems: Array<{ assetId: string; marketHashName: string; reason: string }> = [];

  for (const item of selectedItems) {
    const assetId = String(item.assetid ?? '');
    const reason = pending.has(assetId)
      ? 'Item already has a pending single sell'
      : itemBlockedReason(item);
    if (!reason) eligible.push(item);
    else {
      blocked.set(reason, (blocked.get(reason) ?? 0) + 1);
      blockedItems.push({
        assetId: String(item.assetid ?? ''),
        marketHashName: String(item.market_hash_name ?? item.name ?? 'Unknown item'),
        reason,
      });
    }
  }
  const missing = selected.size - selectedItems.length;
  if (missing > 0) {
    const loadedIds = new Set(selectedItems.map((item) => String(item.assetid)));
    for (const assetId of selected) {
      if (loadedIds.has(assetId)) continue;
      blockedItems.push({
        assetId,
        marketHashName: 'Item no longer loaded',
        reason: 'Item is no longer loaded',
      });
    }
    blocked.set('Item is no longer loaded', missing);
  }
  return { eligible, blocked, blockedItems };
}

function updateToolbarCounts(): void {
  const countEl = document.getElementById('csboard-mass-count');
  const breakdown = selectionBreakdown();
  if (countEl) {
    const sellable = breakdown.eligible.length;
    const blocked = selected.size - sellable;
    countEl.textContent =
      selected.size === 0
        ? 'nothing selected'
        : `${selected.size} selected · ${sellable} eligible · ${blocked} blocked`;
    countEl.title = [...breakdown.blocked.entries()]
      .map(([reason, count]) => `${count} × ${reason}`)
      .join('\n');
  }
  for (const id of ['csboard-mass-quick', 'csboard-mass-instant']) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = breakdown.eligible.length === 0;
  }
}

/**
 * Sequentially list every selected item at the given mode. One order book
 * fetch + one listing per item, both behind their own rate gates, so a 40-item
 * run paces itself instead of stampeding Steam.
 */
interface MassSellPlan {
  readonly item: any;
  readonly reviewedTarget: SellTarget;
}

interface SkippedReviewRow {
  readonly item: any;
  readonly reason: string;
}

interface BatchAuditRow {
  readonly assetId: string;
  readonly marketHashName: string;
  readonly mode: OrderBookSellMode;
  readonly previewBookFetchedAt: number | null;
  readonly previewReceived: number;
  readonly previewBuyerPays: number;
  submitBookFetchedAt: number | null;
  submitReceived: number | null;
  submitBuyerPays: number | null;
  status:
    | 'unattempted'
    | 'failed'
    | 'reconfirmation_required'
    | 'listed_live'
    | 'pending_mobile_confirmation'
    | 'pending_email_confirmation'
    | 'pending_confirmation';
  errorCode?: string;
}

function showPersistentBatchResult(text: string, kind: 'info' | 'ok' | 'err'): void {
  const toast = showToast(text, kind, 0);
  const dismiss = document.createElement('button');
  dismiss.className = 'csboard-sell-undo';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    void chrome.storage.local.remove(LAST_BATCH_SELL_RESULT_KEY).catch(() => undefined);
    toast.remove();
  });
  toast.appendChild(dismiss);
}

function batchReviewText(
  mode: OrderBookSellMode,
  plans: readonly MassSellPlan[],
  skippedRows: readonly SkippedReviewRow[],
  breakdown: SelectionBreakdown,
): string {
  const totals = summarizeSellTargets(plans.map((plan) => plan.reviewedTarget));
  const definition = mode === 'quick'
    ? 'Quick sell: one wallet minor unit below each lowest ask.'
    : 'Instant sell: meet each highest standing bid.';
  const rows = plans.map((plan, index) => {
    const { item, reviewedTarget } = plan;
    const floatOrPhase = item.dopplerPhase ||
      (typeof item.floatValue === 'number' ? `float ${item.floatValue.toFixed(6)}` : '—');
    const warning = hasIndividualPremiumRisk(item) ? ' | PREMIUM' : '';
    const asset = String(item.assetid ?? '');
    return [
      `${index + 1}. ${item.name || item.market_hash_name} [asset …${asset.slice(-6)}]`,
      `   ${floatOrPhase} | ${mode} | buyer ${formatWalletAmount(reviewedTarget.split.buyerPays, wallet)} | fees ${formatWalletAmount(reviewedTarget.split.fees, wallet)} | receive ${formatWalletAmount(reviewedTarget.split.received, wallet)} | READY${warning}`,
    ].join('\n');
  });
  const skippedLines = skippedRows.map(({ item, reason }) =>
    `- ${item.name || item.market_hash_name} [asset …${String(item.assetid).slice(-6)}] | buyer — | fees — | receive — | SKIPPED: ${reason}`,
  );
  const blockedLines = breakdown.blockedItems.map(({ assetId, marketHashName, reason }) =>
    `- ${marketHashName} [asset …${assetId.slice(-6)}] | buyer — | fees — | receive — | BLOCKED: ${reason}`,
  );
  const premiumCount = plans.filter((plan) => hasIndividualPremiumRisk(plan.item)).length;

  const lines = [
    `${definition}`,
    '',
    `Items to submit: ${totals.itemCount}${skippedRows.length > 0 ? ` (${skippedRows.length} skipped)` : ''}`,
    `You receive: ${formatWalletAmount(totals.received, wallet)}`,
    `Steam fees: ${formatWalletAmount(totals.steamFee, wallet)}`,
    `Game fees: ${formatWalletAmount(totals.publisherFee, wallet)}`,
    `Total fees: ${formatWalletAmount(totals.fees, wallet)}`,
    `Buyers pay: ${formatWalletAmount(totals.buyerPays, wallet)}`,
    '',
    'ITEM REVIEW',
    ...rows,
  ];
  if (skippedLines.length > 0) lines.push('', 'SKIPPED (never submitted)', ...skippedLines);
  if (blockedLines.length > 0) lines.push('', 'BLOCKED (never submitted)', ...blockedLines);
  if (premiumCount > 0) {
    lines.push(
      '',
      `PREMIUM WARNING (${premiumCount}): Steam ignores individual float, pattern, phase, and sticker value.`,
    );
  }
  lines.push(
    '',
    'Items are submitted sequentially. Price drops, account changes, auth expiry, and rate limits stop the batch.',
    'Stop affects only unstarted items; already submitted listings remain submitted and may need Steam Guard or manual cancellation.',
    '',
    'Continue?',
  );
  return lines.join('\n');
}

function batchOutcomeText(state: BatchSellState): string {
  const parts = [`${state.listedLive} live`];
  if (state.pendingMobile > 0) parts.push(`${state.pendingMobile} pending mobile Steam Guard`);
  if (state.pendingEmail > 0) parts.push(`${state.pendingEmail} pending email confirmation`);
  if (state.pendingOther > 0) parts.push(`${state.pendingOther} pending Steam confirmation`);
  if (state.failed > 0) parts.push(`${state.failed} failed`);
  const unattempted = Math.max(0, state.total - state.processed);
  if (unattempted > 0) parts.push(`${unattempted} unattempted`);
  if (state.stopReason) parts.push(`stopped: ${state.stopReason.replace(/_/g, ' ')}`);
  return parts.join(' · ');
}

async function runMassSell(mode: OrderBookSellMode, event: Event): Promise<void> {
  if (batchRunning || !event.isTrusted) return;

  loggedInSteamId = getCurrentSteamAccountId();
  const breakdown = selectionBreakdown();
  const queue = breakdown.eligible;
  if (queue.length === 0 || !loggedInSteamId) {
    showToast('Select marketable items in your own live CS2 inventory', 'err', 8000);
    return;
  }
  if (queue.length > MAX_SELL_BATCH_SIZE) {
    showToast(
      `Beta safety limit: select at most ${MAX_SELL_BATCH_SIZE} eligible items per batch`,
      'err',
      9000,
    );
    return;
  }

  // Mint immediately while browser user activation is still present. No write
  // occurs until the live-price review below is explicitly confirmed.
  const authorizationResult = authorizeSellFromUserGesture(
    event,
    queue.map((item) => item.assetid),
    loggedInSteamId,
  );
  if (!authorizationResult.ok) {
    showToast(authorizationResult.error.message, 'err', 8000);
    return;
  }

  batchRunning = true;
  for (const item of queue) activeBatchAssetIds.add(String(item.assetid));
  let preparing: HTMLElement | null = showToast(`Reviewing 0/${queue.length} live prices…`, 'info', 0);
  let progress: HTMLElement | null = null;

  try {
    const plans: MassSellPlan[] = [];
    const skippedRows: SkippedReviewRow[] = [];

    for (let i = 0; i < queue.length; i += 1) {
      const item = queue[i];
      if (!item) continue;
      preparing.textContent = `Reviewing ${i + 1}/${queue.length} — ${item.market_hash_name}`;

      const bookResult = await getOrderBook(item.market_hash_name, wallet, { force: true });
      if (!bookResult.ok) {
        const stopReason = batchStopReasonForError(bookResult.error);
        if (stopReason) {
          showToast(`Review stopped: ${bookResult.error.message}`, 'err', 10000);
          return;
        }
        skippedRows.push({ item, reason: bookResult.error.message });
        continue;
      }

      const reviewedTarget = computeSellTarget(mode, bookResult.value, wallet);
      if (!reviewedTarget) {
        skippedRows.push({
          item,
          reason: mode === 'quick' ? 'No valid lowest ask to undercut' : 'No valid highest bid to meet',
        });
        continue;
      }
      plans.push({ item, reviewedTarget });
    }

    preparing.remove();
    preparing = null;

    if (plans.length === 0) {
      showToast('No selected item has a valid live price for this action', 'err', 9000);
      return;
    }
    if (!window.confirm(batchReviewText(mode, plans, skippedRows, breakdown))) return;

    const batchStartedAt = Date.now();
    const auditRows: BatchAuditRow[] = plans.map(({ item, reviewedTarget }) => ({
      assetId: String(item.assetid),
      marketHashName: String(item.market_hash_name),
      mode,
      previewBookFetchedAt: reviewedTarget.bookFetchedAt,
      previewReceived: reviewedTarget.split.received,
      previewBuyerPays: reviewedTarget.split.buyerPays,
      submitBookFetchedAt: null,
      submitReceived: null,
      submitBuyerPays: null,
      status: 'unattempted',
    }));

    runAbort = false;
    let state = reduceBatchSellState(INITIAL_BATCH_SELL_STATE, {
      type: 'start',
      total: plans.length,
    });
    progress = showToast(`Submitting 0/${plans.length}…`, 'info', 0);

    const stopBtn = document.createElement('button');
    stopBtn.className = 'csboard-sell-undo';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', (stopEvent) => {
      if (!stopEvent.isTrusted) return;
      runAbort = true;
      stopBtn.disabled = true;
      stopBtn.textContent = 'Stopping…';
    });
    progress.appendChild(stopBtn);

    for (let i = 0; i < plans.length; i += 1) {
      if (runAbort) {
        state = reduceBatchSellState(state, { type: 'stop', reason: 'user_stopped' });
        break;
      }

      const plan = plans[i];
      if (!plan) continue;
      const { item, reviewedTarget } = plan;
      const auditRow = auditRows[i];
      const statusText = document.createTextNode(
        `Submitting ${i + 1}/${plans.length} — ${item.market_hash_name} · ${state.processed} processed `,
      );
      progress.replaceChildren(statusText, stopBtn);

      // A batch confirmation is a price ceiling, not permission to accept a
      // worse live market. Every item is repriced immediately before its write.
      const bookResult = await getOrderBook(item.market_hash_name, wallet, { force: true });
      if (!bookResult.ok) {
        const stopReason = batchStopReasonForError(bookResult.error);
        if (stopReason) {
          if (auditRow) auditRow.errorCode = bookResult.error.code;
          state = reduceBatchSellState(state, { type: 'stop', reason: stopReason });
          showToast(`Batch stopped: ${bookResult.error.message}`, 'err', 11000);
          break;
        }
        if (auditRow) {
          auditRow.status = 'failed';
          auditRow.errorCode = bookResult.error.code;
        }
        state = reduceBatchSellState(state, { type: 'failed' });
        continue;
      }

      const liveTarget = computeSellTarget(mode, bookResult.value, wallet);
      if (!liveTarget || hasDownwardPriceDrift(reviewedTarget, liveTarget)) {
        if (auditRow) {
          auditRow.status = 'reconfirmation_required';
          auditRow.submitBookFetchedAt = liveTarget?.bookFetchedAt ?? bookResult.value.fetchedAt;
          auditRow.submitReceived = liveTarget?.split.received ?? null;
          auditRow.submitBuyerPays = liveTarget?.split.buyerPays ?? null;
        }
        state = reduceBatchSellState(state, {
          type: 'stop',
          reason: 'downward_price_drift',
        });
        showToast(
          `Stopped before ${item.market_hash_name}: price dropped. Review and confirm the batch again.`,
          'err',
          12000,
        );
        break;
      }

      if (auditRow) {
        auditRow.submitBookFetchedAt = liveTarget.bookFetchedAt;
        auditRow.submitReceived = liveTarget.split.received;
        auditRow.submitBuyerPays = liveTarget.split.buyerPays;
      }

      const result = await sellItem({
        appId: String(item.appid),
        contextId: String(item.contextid),
        assetId: item.assetid,
        amount: 1,
        received: liveTarget.split.received,
        authorization: authorizationResult.value,
      });

      if (!result.ok) {
        if (auditRow) {
          auditRow.status = 'failed';
          auditRow.errorCode = result.error.code;
        }
        state = reduceBatchSellState(state, { type: 'failed' });
        const stopReason = batchStopReasonForError(result.error);
        if (stopReason) {
          state = reduceBatchSellState(state, { type: 'stop', reason: stopReason });
          showToast(`Batch stopped: ${result.error.message}`, 'err', 11000);
          break;
        }
        logger.warn('Mass sell item failed', {
          assetId: item.assetid,
          error: result.error.message,
        });
        continue;
      }

      state = reduceBatchSellState(state, {
        type: 'listed',
        status: result.value.confirmationStatus,
      });
      if (auditRow) auditRow.status = result.value.confirmationStatus;
      selected.delete(item.assetid);
    }

    if (state.phase === 'running') state = reduceBatchSellState(state, { type: 'finish' });

    progress.remove();
    progress = null;
    paintSelection();

    const hasPending = state.pendingMobile + state.pendingEmail + state.pendingOther > 0;
    const kind = state.failed > 0 || state.stopReason ? 'err' : hasPending ? 'info' : 'ok';
    await persistSanitizedLocalRecord(LAST_BATCH_SELL_RESULT_KEY, {
      version: 1,
      startedAt: batchStartedAt,
      completedAt: Date.now(),
      mode,
      stoppedReason: state.stopReason,
      skippedBeforeReview: skippedRows.length,
      blockedReasons: Object.fromEntries(breakdown.blocked),
      summary: {
        total: state.total,
        processed: state.processed,
        listedLive: state.listedLive,
        pendingMobile: state.pendingMobile,
        pendingEmail: state.pendingEmail,
        pendingOther: state.pendingOther,
        failed: state.failed,
        unattempted: Math.max(0, state.total - state.processed),
      },
      rows: auditRows,
    });
    showPersistentBatchResult(batchOutcomeText(state), kind);
  } finally {
    preparing?.remove();
    progress?.remove();
    activeBatchAssetIds.clear();
    batchRunning = false;
  }
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

  bar.querySelector('#csboard-mass-quick')!.addEventListener('click', (event) => {
    void runMassSell('quick', event);
  });
  bar.querySelector('#csboard-mass-instant')!.addEventListener('click', (event) => {
    void runMassSell('instant', event);
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
  loggedInSteamId = getCurrentSteamAccountId();

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
