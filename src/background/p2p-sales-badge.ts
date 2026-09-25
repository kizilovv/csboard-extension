/*
  The number on the toolbar icon: sales waiting for this seller.

  ── WHY IT HAS ITS OWN CLOCK ──────────────────────────────────────────────

  The obvious home for this was the trade tracker's pass, and it is the wrong
  one. That pass paces itself by what it is WATCHING — an offer already sent —
  and drops to hourly when there is nothing in flight. But "nothing in flight"
  is exactly the state a seller sits in between sales, so a badge on that clock
  would announce a new sale up to an hour after it happened, which is the one
  moment it needed to be quick.

  So it ticks on its own, and backs off on its own: five minutes while the
  browser is signed in to csboard, half an hour once a request comes back
  unauthorised. A signed-out browser polling every five minutes forever is
  traffic nobody asked for.

  ── WHAT IT COUNTS ────────────────────────────────────────────────────────

  The delivery queue — the sales that need the seller to DO something, accept
  or send. Not sales in Steam's hold: those are waiting on time, and a number
  that never goes down is a number people stop reading.

  It is deliberately NOT gated on the enhancements master switch. That switch is
  about what this extension draws on other people's pages; this is its own icon
  telling its owner that money is waiting on him, and it is the same reason
  delivery keeps running when the decorations are off.

  ── ONE ICON, TWO THINGS TO SAY ───────────────────────────────────────────

  Since 1.1.26 the icon also warns when this browser has no Steam login: a "!"
  on the same amber. The two never share the badge. A sale wins whenever there
  is one, because it is money waiting on the seller right now and its number is
  the only place he sees it; the missing login is still in the tooltip and at
  the top of the popup. The "!" shows only while the count is zero, and when
  the login comes back the count this module last painted is put back without
  asking csboard again. Both paths go through `render`, so there is one place
  that decides what the icon says.
*/

import { getApiBase, SITE_BASE } from '../shared/config';
import { initI18n, t } from '../shared/i18n';
import { createLogger } from '../shared/logger';
import { getSettings } from '../shared/storage';
import { readSteamSessionState, type SteamSessionState } from '../shared/steam-session-state';

const logger = createLogger('p2p-badge');

export const P2P_SALES_BADGE_ALARM = 'csboard-p2p-sales-badge' as const;

/** Signed in and looking: fast enough that a new sale is news, not history. */
const BADGE_PERIOD_ACTIVE_MINUTES = 5;
/** Signed out, or the API is unreachable. Stop asking so often. */
const BADGE_PERIOD_IDLE_MINUTES = 30;

/** Amber, the same warning colour the site uses for a running deadline. */
const BADGE_COLOR = '#f5a623';

type Outcome = 'signed_in' | 'signed_out';

interface ActionableSale {
  orderId: string;
  itemName: string;
}

/*
  Which sales this browser has already announced.

  Kept per order id rather than as a count, because a count cannot tell a second
  sale from the first one still sitting there: a seller with one unhandled sale
  would never hear about the next. Pruned to the live queue on every pass, so a
  handled order stops costing a row and — deliberately — can announce itself
  again if it ever comes back.
*/
const NOTIFIED_KEY = 'csboard_p2p_notified_sales';
const NOTIFICATION_PREFIX = 'csboard-sale:';

async function readNotified(): Promise<string[]> {
  try {
    const stored = await chrome.storage.local.get(NOTIFIED_KEY);
    const value = stored?.[NOTIFIED_KEY];
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    /*
      Unreadable storage means we cannot tell what has been announced. Return
      "everything is new" would buzz the seller for every open sale on every
      pass, so this fails SILENT instead: a missed notification is a nuisance,
      a repeated one every five minutes is a reason to uninstall.
    */
    return [];
  }
}

async function announce(sales: readonly ActionableSale[]): Promise<void> {
  if (sales.length === 0) return;
  let enabled = true;
  try {
    enabled = (await getSettings()).salesNotifications !== false;
  } catch { /* default stays on */ }
  if (!enabled) return;

  for (const sale of sales) {
    try {
      await chrome.notifications.create(`${NOTIFICATION_PREFIX}${sale.orderId}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Your item sold',
        message: sale.itemName
          ? `${sale.itemName} — accept the sale on csboard`
          : 'A sale is waiting for you on csboard',
        // The seller is the only one who can move this along, so it stays until
        // he looks at it rather than fading while the accept clock runs.
        requireInteraction: true,
      });
    } catch (error) {
      logger.warn('Could not raise a sale notification', { orderId: sale.orderId, error: String(error) });
    }
  }
}

/** Clicking the notification lands on the order it is about. */
chrome.notifications?.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
  const orderId = notificationId.slice(NOTIFICATION_PREFIX.length);
  void chrome.tabs.create({ url: `${SITE_BASE}/p2p/order/${orderId}` });
  void chrome.notifications.clear(notificationId);
});

async function readActionableSales(): Promise<ActionableSale[] | null> {
  const base = await getApiBase();
  let response: Response;
  try {
    response = await fetch(`${base}/p2p/my/sales?scope=delivery`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return null;
  }
  // 401 is the ordinary signed-out case, not a fault worth logging on a timer.
  if (!response.ok) return null;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const rows = Array.isArray(body) ? body : (body as { sales?: unknown })?.sales;
  if (!Array.isArray(rows)) return null;
  const sales: ActionableSale[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const orderId = row['orderId'];
    if (typeof orderId !== 'string') continue;
    const name = row['itemName'] ?? row['marketHashName'];
    sales.push({ orderId, itemName: typeof name === 'string' ? name : '' });
  }
  return sales;
}

/*
  The count this module last painted, so the icon can be repainted when the
  Steam-login warning changes without asking csboard again.

  Session storage, not local: it should live exactly as long as the badge does,
  which Chrome clears on a browser restart, while a service-worker restart in
  between must not forget it. The module variable is only the fast path.
*/
const PAINTED_COUNT_KEY = 'csboard_p2p_sales_badge_count';
let paintedCount: number | null = null;

async function readPaintedCount(): Promise<number> {
  if (paintedCount !== null) return paintedCount;
  try {
    const stored = await chrome.storage.session.get(PAINTED_COUNT_KEY);
    const value = stored?.[PAINTED_COUNT_KEY];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  } catch {
    // Nothing remembered: repaint as "no sales", the same thing a fresh browser shows.
  }
  return 0;
}

async function paint(count: number): Promise<void> {
  paintedCount = count;
  try {
    await chrome.storage.session.set({ [PAINTED_COUNT_KEY]: count });
  } catch {
    // This worker still remembers it; only a restart before the next pass forgets.
  }
  await queueRender();
}

/**
 * Repaint from what is already known. Called when the Steam-login state
 * changes: the sales count does not need a network round trip to come back.
 */
export function repaintActionBadge(): Promise<void> {
  return queueRender();
}

/*
  One render at a time, each reading both inputs when its turn comes.

  The sales pass and the Steam check run on separate clocks and can land
  together; two renders interleaving their awaits could put a count read
  before the other's write on the icon last. Queued, the last render always
  sees the latest of both.
*/
let renderChain: Promise<void> = Promise.resolve();

function queueRender(): Promise<void> {
  const job = renderChain.then(async () => {
    const [count, steam] = await Promise.all([readPaintedCount(), readSteamSessionState()]);
    await render(count, steam.state);
  });
  renderChain = job.catch(() => undefined);
  return job;
}

async function steamSessionHint(): Promise<string> {
  // The worker has no popup to have set the language, so it resolves it the
  // same way the popup does: stored preference, then the browser's.
  try {
    await initI18n();
  } catch {
    // English is the fallback dictionary.
  }
  return t('steamSession.title');
}

async function render(count: number, steam: SteamSessionState): Promise<void> {
  /*
    An empty string is the only thing that CLEARS a badge — '0' would leave a
    zero sitting on the icon forever, which reads as broken rather than as
    nothing to do.
  */
  const text = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
  // `unknown` says nothing: an install that has not looked yet is not an alarm.
  const steamMissing = steam === 'missing';
  try {
    await chrome.action.setBadgeText({ text: text || (steamMissing ? '!' : '') });
    if (count > 0 || steamMissing) {
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
      // Chrome 110+. Older builds ignore it; other browsers do not have it at
      // all, and neither case is worth failing the refresh over.
      await chrome.action.setBadgeTextColor?.({ color: '#000000' });
    }
    const salesTitle = count > 0
      ? `CSBOARD — ${count} ${count === 1 ? 'sale needs' : 'sales need'} you`
      : '';
    const steamHint = steamMissing ? await steamSessionHint() : '';
    await chrome.action.setTitle({
      title: salesTitle && steamHint
        ? `${salesTitle}. ${steamHint}`
        : salesTitle || steamHint || 'CSBOARD settings',
    });
  } catch (error) {
    logger.warn('Could not paint the toolbar badge', { error: String(error) });
  }
}

/**
 * One refresh. Returns what it learned so the caller can pace itself.
 *
 * A failed read does NOT clear the badge: the last known count is a better
 * answer than "no sales" when the truth is "we could not ask". It only goes
 * quiet on an answer we actually got.
 */
export async function refreshSalesBadge(): Promise<Outcome> {
  const sales = await readActionableSales();
  if (sales === null) return 'signed_out';
  await paint(sales.length);

  const live = sales.map((sale) => sale.orderId);
  const alreadyTold = new Set(await readNotified());
  await announce(sales.filter((sale) => !alreadyTold.has(sale.orderId)));
  try {
    await chrome.storage.local.set({ [NOTIFIED_KEY]: live });
  } catch {
    // Worst case the seller hears about the same sale twice; better than a
    // failed write silencing the next one.
  }
  return 'signed_in';
}

/** Chrome replaces a same-named alarm, so this both creates and re-paces it. */
export function registerSalesBadgeAlarm(periodInMinutes: number): void {
  chrome.alarms.create(P2P_SALES_BADGE_ALARM, {
    periodInMinutes,
    delayInMinutes: periodInMinutes,
  });
}

/** The whole tick: refresh, then choose when to come back. */
export async function runSalesBadgePass(): Promise<void> {
  const outcome = await refreshSalesBadge();
  registerSalesBadgeAlarm(
    outcome === 'signed_in' ? BADGE_PERIOD_ACTIVE_MINUTES : BADGE_PERIOD_IDLE_MINUTES,
  );
}
