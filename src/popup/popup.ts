// ============================================================
// CSBOARD-PROD Popup
// ============================================================
// Minimal UI: auth status, price-cache status, refresh button.

import { SITE_BASE } from '../shared/config';
import { sendTypedMessage } from '../shared/message-bus';
import { createLogger } from '../shared/logger';
import type { UserProfile } from '../shared/types';

const logger = createLogger('popup');

const $ = (sel: string) => document.querySelector(sel);

function show(sel: string) { $(sel)?.classList.remove('hidden'); }
function hide(sel: string) { $(sel)?.classList.add('hidden'); }
function setText(sel: string, text: string) {
  const el = $(sel);
  if (el) el.textContent = text;
}
function setStatus(status: 'online' | 'offline') {
  const dot = $('#status-dot');
  if (dot) {
    dot.classList.remove('online', 'offline');
    dot.classList.add(status);
  }
}

async function init() {
  const loginBtn = $('#login-btn') as HTMLAnchorElement | null;
  if (loginBtn) loginBtn.href = SITE_BASE;

  setupPricesFooter();
  await checkAuth();
  loadPricesStatus();
}

function setupPricesFooter() {
  const btn = $('#refresh-prices-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const origText = btn.textContent || 'Refresh';
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    const result = await sendTypedMessage({ type: 'REFRESH_PRICES' });
    btn.disabled = false;
    if (result.ok && result.value.success) {
      btn.textContent = `✓ ${result.value.count}`;
      btn.classList.add('refreshed');
      setTimeout(() => {
        btn.textContent = origText;
        btn.classList.remove('refreshed');
      }, 1400);
      await loadPricesStatus();
    } else {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = origText; }, 1400);
    }
  });
}

async function loadPricesStatus() {
  const result = await sendTypedMessage({ type: 'GET_PRICE_ENGINE_STATUS' });
  if (!result.ok) {
    setText('#prices-count', 'Prices: —');
    setText('#prices-updated', 'status unavailable');
    return;
  }
  const { count, lastFetched } = result.value;
  setText('#prices-count', `Prices: ${count.toLocaleString()}`);
  setText('#prices-updated', lastFetched ? `updated ${getTimeAgo(new Date(lastFetched).toISOString())}` : 'never fetched');
}

async function checkAuth() {
  const result = await sendTypedMessage({ type: 'GET_AUTH_STATUS' });

  if (!result.ok) {
    logger.warn('Auth check failed', { error: result.error.message });
    showLoginScreen();
    return;
  }

  const auth = result.value;
  if (auth.isLoggedIn) {
    showMainScreen();
    updateUserBar(auth.user);
  } else {
    showLoginScreen();
  }
}

function showLoginScreen() {
  hide('#screen-main');
  show('#screen-login');
  setStatus('offline');
}

function showMainScreen() {
  hide('#screen-login');
  show('#screen-main');
  setStatus('online');
}

function updateUserBar(user: UserProfile) {
  const avatar = $('#user-avatar') as HTMLImageElement | null;
  if (avatar && user.avatar) {
    avatar.src = user.avatar;
  }
  setText('#user-name', user.name);
  if (user.isPremium) show('#user-badge');
}

function getTimeAgo(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

document.addEventListener('DOMContentLoaded', init);
