// ============================================================
// CSBOARD-PROD Popup
// ============================================================
// Local settings are available regardless of CSBOARD login state. Portfolio
// commands use the extension's internal router only; none of these messages may
// be forwarded by onMessageExternal.

import { SITE_BASE } from '../shared/config';
import {
  applyTranslations,
  initI18n,
  isMessageKey,
  normalizeLocalePreference,
  resolveLocale,
  activateLocale,
  loadLocalePreference,
  saveLocalePreference,
  t,
  type LocalePreference,
} from '../shared/i18n';
import { sendTypedMessage } from '../shared/message-bus';
import { normalizeAvatarUrl, type UserProfile } from '../shared/types';
import {
  DEFAULT_POPUP_SETTINGS,
  DEFAULT_PORTFOLIO_STATUS,
  POPUP_PORTFOLIO_PROTOCOL_VERSION,
  POPUP_SETTINGS_SCHEMA_VERSION,
  isSupportedCurrency,
  isSupportedPriceSource,
  type PopupInternalMessageType,
  type PopupInternalRequest,
  type PopupResponseFor,
  type PopupSettingsV2,
  type PortfolioSource,
  type PortfolioSourceRunState,
  type PortfolioSourceStatus,
  type PortfolioSyncStatus,
  type PricePreferenceSyncState,
  type PricePreferenceSyncStatus,
} from './contracts';

type NoticeKind = 'info' | 'success' | 'warning' | 'error';

/**
 * Only the two sources a portfolio actually needs have a control.
 *
 * Accepted trade offers describe exactly the same events as trade history, so
 * a second switch for them asked the user to make a distinction that does not
 * exist. Steam Market facts are not implemented in 1.1 and a permanently
 * disabled row is just noise.
 */
const SOURCE_ELEMENT_IDS: Readonly<Partial<Record<PortfolioSource, string>>> = {
  inventory: 'source-inventory',
  tradeHistory: 'source-trade-history',
};

const PRICE_SYNC_STATES = new Set<PricePreferenceSyncState>([
  'idle',
  'syncing',
  'success',
  'warning',
  'error',
  'signed_out',
]);

const PORTFOLIO_RUN_STATES = new Set<PortfolioSourceRunState>([
  'idle',
  'queued',
  'running',
  'success',
  'error',
  'disabled',
]);

type AuthState =
  | { kind: 'checking' }
  | { kind: 'signed-in'; user: UserProfile }
  | { kind: 'signed-out' }
  | { kind: 'offline' };

let authState: AuthState = { kind: 'checking' };
let localePreference: LocalePreference = 'auto';
let settings: PopupSettingsV2 = DEFAULT_POPUP_SETTINGS;
let preferenceSync: PricePreferenceSyncStatus = {
  state: 'idle',
  lastSyncedAt: null,
};
let portfolioStatus: PortfolioSyncStatus = DEFAULT_PORTFOLIO_STATUS;
let settingsContractAvailable = false;
let portfolioContractAvailable = false;
let settingsBusy = false;
let portfolioBusy = false;
let noticeTimer: number | null = null;

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Popup element not found: ${selector}`);
  return found;
}

function setText(selector: string, value: string): void {
  element<HTMLElement>(selector).textContent = value;
}

function setHidden(selector: string, hidden: boolean): void {
  element<HTMLElement>(selector).classList.toggle('hidden', hidden);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function boundedString(value: unknown, maxLength = 96): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, maxLength)
    : undefined;
}

async function sendPopupMessage<T extends PopupInternalMessageType>(
  message: Extract<PopupInternalRequest, { type: T }>,
  timeoutMs = 10_000,
): Promise<PopupResponseFor<T>> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${message.type} timed out`));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response: unknown) => {
        window.clearTimeout(timer);

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message ?? 'Extension runtime unavailable'));
          return;
        }

        if (isRecord(response) && 'error' in response) {
          const rawError = response.error;
          const messageText = typeof rawError === 'string'
            ? rawError
            : isRecord(rawError) && typeof rawError.message === 'string'
              ? rawError.message
              : 'Background request failed';
          reject(new Error(messageText));
          return;
        }

        resolve(response as PopupResponseFor<T>);
      });
    } catch (error) {
      window.clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function normalizeSettings(value: unknown, fallback: PopupSettingsV2): PopupSettingsV2 {
  if (!isRecord(value)) return fallback;
  const rawSources = isRecord(value.portfolioSources) ? value.portfolioSources : {};

  return {
    schemaVersion: POPUP_SETTINGS_SCHEMA_VERSION,
    currency: isSupportedCurrency(value.currency) ? value.currency : fallback.currency,
    priceSource: isSupportedPriceSource(value.priceSource)
      ? value.priceSource
      : fallback.priceSource,
    enhancementsEnabled: typeof value.enhancementsEnabled === 'boolean'
      ? value.enhancementsEnabled
      : fallback.enhancementsEnabled,
    salesNotifications: typeof value.salesNotifications === 'boolean'
      ? value.salesNotifications
      : fallback.salesNotifications,
    followCsboardSettings: typeof value.followCsboardSettings === 'boolean'
      ? value.followCsboardSettings
      : fallback.followCsboardSettings,
    showOnSteam: typeof value.showOnSteam === 'boolean'
      ? value.showOnSteam
      : fallback.showOnSteam,
    showCsboardPricesOnCsfloat: typeof value.showCsboardPricesOnCsfloat === 'boolean'
      ? value.showCsboardPricesOnCsfloat
      : fallback.showCsboardPricesOnCsfloat,
    showBetterBuffOnBuff: typeof value.showBetterBuffOnBuff === 'boolean'
      ? value.showBetterBuffOnBuff
      : fallback.showBetterBuffOnBuff,
    portfolioSyncEnabled: typeof value.portfolioSyncEnabled === 'boolean'
      ? value.portfolioSyncEnabled
      : fallback.portfolioSyncEnabled,
    portfolioSources: {
      inventory: typeof rawSources.inventory === 'boolean'
        ? rawSources.inventory
        : fallback.portfolioSources.inventory,
      tradeOffers: typeof rawSources.tradeOffers === 'boolean'
        ? rawSources.tradeOffers
        : fallback.portfolioSources.tradeOffers,
      tradeHistory: typeof rawSources.tradeHistory === 'boolean'
        ? rawSources.tradeHistory
        : fallback.portfolioSources.tradeHistory,
      marketHistory: typeof rawSources.marketHistory === 'boolean'
        ? rawSources.marketHistory
        : fallback.portfolioSources.marketHistory,
    },
  };
}

function normalizePreferenceSync(
  value: unknown,
  fallback: PricePreferenceSyncStatus,
): PricePreferenceSyncStatus {
  if (!isRecord(value)) return fallback;
  const syncState = typeof value.state === 'string'
    && PRICE_SYNC_STATES.has(value.state as PricePreferenceSyncState)
    ? value.state as PricePreferenceSyncState
    : fallback.state;
  const warningCode = boundedString(value.warningCode);

  return {
    state: syncState,
    lastSyncedAt: finiteTimestamp(value.lastSyncedAt),
    ...(warningCode ? { warningCode } : {}),
  };
}

function normalizeSourceStatus(
  value: unknown,
  fallback: PortfolioSourceStatus,
): PortfolioSourceStatus {
  if (!isRecord(value)) return fallback;
  const runState = typeof value.state === 'string'
    && PORTFOLIO_RUN_STATES.has(value.state as PortfolioSourceRunState)
    ? value.state as PortfolioSourceRunState
    : fallback.state;
  const records = typeof value.records === 'number'
    && Number.isInteger(value.records)
    && value.records >= 0
    ? value.records
    : undefined;
  const errorCode = boundedString(value.errorCode);
  const warningCode = boundedString(value.warningCode);

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
    state: runState,
    ...(records !== undefined ? { records } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(warningCode ? { warningCode } : {}),
  };
}

function normalizePortfolioStatus(
  value: unknown,
  fallback: PortfolioSyncStatus,
): PortfolioSyncStatus {
  if (!isRecord(value)) return fallback;
  const rawSources = isRecord(value.sources) ? value.sources : {};
  const connectionStates = new Set(['unpaired', 'paired', 'revoked', 'mismatch', 'error']);
  const connectionState = typeof value.connectionState === 'string'
    && connectionStates.has(value.connectionState)
    ? value.connectionState as PortfolioSyncStatus['connectionState']
    : fallback.connectionState;
  const errorCode = boundedString(value.errorCode);

  return {
    connectionState,
    steamId: typeof value.steamId === 'string' && /^\d{17}$/.test(value.steamId)
      ? value.steamId
      : null,
    paused: typeof value.paused === 'boolean' ? value.paused : fallback.paused,
    sources: {
      inventory: normalizeSourceStatus(rawSources.inventory, fallback.sources.inventory),
      tradeOffers: normalizeSourceStatus(rawSources.tradeOffers, fallback.sources.tradeOffers),
      tradeHistory: normalizeSourceStatus(rawSources.tradeHistory, fallback.sources.tradeHistory),
      marketHistory: normalizeSourceStatus(rawSources.marketHistory, fallback.sources.marketHistory),
    },
    lastAttemptedAt: finiteTimestamp(value.lastAttemptedAt),
    lastSuccessfulAt: finiteTimestamp(value.lastSuccessfulAt),
    queuedRecords: typeof value.queuedRecords === 'number'
      && Number.isInteger(value.queuedRecords)
      && value.queuedRecords >= 0
      ? value.queuedRecords
      : 0,
    retryAt: finiteTimestamp(value.retryAt),
    ...(errorCode ? { errorCode } : {}),
  };
}

function clearNotice(): void {
  if (noticeTimer !== null) {
    window.clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  const notice = element<HTMLElement>('#popup-notice');
  notice.classList.add('hidden');
  notice.classList.remove('success', 'warning', 'error');
  notice.textContent = '';
  notice.setAttribute('role', 'status');
}

function showNotice(message: string, kind: NoticeKind = 'info'): void {
  clearNotice();
  const notice = element<HTMLElement>('#popup-notice');
  notice.textContent = message;
  notice.classList.remove('hidden');
  if (kind !== 'info') notice.classList.add(kind);
  notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');

  if (kind !== 'error') {
    noticeTimer = window.setTimeout(clearNotice, 4_000);
  }
}

/*
  Codes arrive from the background already sanitized, and are shown, not parsed.

  A code with a translation gets the sentence; anything else is de-cased into
  something readable rather than dropped, because an untranslated cause still
  tells a user more than silence does.
*/
function humanizeCode(code: string): string {
  const safeCode = code.replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
  const key = `code.${safeCode}`;
  if (isMessageKey(key)) return t(key);
  return safeCode.replace(/[_-]+/g, ' ').toLowerCase();
}

function timeAgo(timestamp: number | null): string {
  if (!timestamp) return t('time.never');
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 15) return t('time.now');
  if (seconds < 60) return t('time.seconds', { n: seconds });
  if (seconds < 3_600) return t('time.minutes', { n: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t('time.hours', { n: Math.floor(seconds / 3_600) });
  return t('time.days', { n: Math.floor(seconds / 86_400) });
}

function setConnection(state: 'online' | 'signed-out' | 'offline', label: string): void {
  const dot = element<HTMLElement>('#status-dot');
  dot.classList.remove('online', 'signed-out', 'offline');
  dot.classList.add(state);
  setText('#connection-label', label);
}

function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const characters = parts.length > 1
    ? [Array.from(parts[0] ?? '')[0], Array.from(parts[parts.length - 1] ?? '')[0]]
    : Array.from(parts[0] ?? '').slice(0, 2);
  const initials = characters.filter((value): value is string => Boolean(value)).join('').toUpperCase();
  return Array.from(initials).slice(0, 2).join('') || '?';
}

export function renderUserAvatar(user: Pick<UserProfile, 'name' | 'avatar'>): void {
  const avatar = element<HTMLImageElement>('#user-avatar');
  const fallback = element<HTMLElement>('#user-avatar-fallback');
  const safeUrl = normalizeAvatarUrl(user.avatar);

  fallback.textContent = avatarInitials(user.name);
  setHidden('#user-avatar-fallback', false);
  setHidden('#user-avatar', true);
  avatar.alt = '';
  avatar.onload = null;
  avatar.onerror = null;
  avatar.removeAttribute('src');

  if (!safeUrl) return;

  avatar.onload = () => {
    if (avatar.getAttribute('src') !== safeUrl) return;
    avatar.alt = `${user.name} avatar`;
    setHidden('#user-avatar', false);
    setHidden('#user-avatar-fallback', true);
  };
  avatar.onerror = () => {
    if (avatar.getAttribute('src') !== safeUrl) return;
    avatar.onload = null;
    avatar.onerror = null;
    avatar.removeAttribute('src');
    avatar.alt = '';
    setHidden('#user-avatar', true);
    setHidden('#user-avatar-fallback', false);
  };
  avatar.src = safeUrl;
}

/*
  The account row is one line: avatar, name, badge, button.

  The paragraph that used to sit under it restated the connection pill in a
  sentence ("Connected. CSBOARD preferences can be followed automatically."),
  and the two never disagreed. The pill says the state; the name says whose.
*/
function renderAuthenticatedUser(user: UserProfile): void {
  authState = { kind: 'signed-in', user };
  renderAuth();
}

function renderAuth(): void {
  const loginButton = element<HTMLAnchorElement>('#login-btn');
  const avatarFallback = element<HTMLElement>('#user-avatar-fallback');

  if (authState.kind === 'signed-in') {
    renderUserAvatar(authState.user);
    setText('#user-name', authState.user.name);
    setHidden('#user-badge', !authState.user.isPremium);
    loginButton.textContent = t('account.open');
    setConnection('online', t('status.connected'));
    return;
  }

  setHidden('#user-avatar', true);
  setHidden('#user-avatar-fallback', false);
  avatarFallback.textContent = '?';
  setHidden('#user-badge', true);
  loginButton.textContent = authState.kind === 'signed-out'
    ? t('account.signIn')
    : t('account.open');

  if (authState.kind === 'offline') {
    setText('#user-name', t('account.offline'));
    setConnection('offline', t('status.offline'));
    return;
  }

  setText('#user-name', t('account.signedOut'));
  setConnection('signed-out', t('status.signedOut'));
}

async function checkAuth(): Promise<void> {
  const result = await sendTypedMessage({ type: 'GET_AUTH_STATUS' });
  if (!result.ok) {
    authState = { kind: 'offline' };
    renderAuth();
    return;
  }

  if (result.value.isLoggedIn) {
    renderAuthenticatedUser(result.value.user);
    return;
  }

  authState = { kind: 'signed-out' };
  renderAuth();
}

function preferenceSyncDescription(): string {
  if (!settingsContractAvailable) return t('sync.unavailable');
  if (!settings.followCsboardSettings) return t('sync.off');

  switch (preferenceSync.state) {
    case 'syncing':
      return t('sync.syncing');
    case 'warning':
      return t('sync.warning', {
        code: preferenceSync.warningCode ? humanizeCode(preferenceSync.warningCode) : '—',
      });
    case 'error':
      return t('sync.error');
    case 'signed_out':
      return t('sync.signedOut');
    case 'success':
    case 'idle':
      return preferenceSync.lastSyncedAt
        ? t('sync.followingAgo', { ago: timeAgo(preferenceSync.lastSyncedAt) })
        : t('sync.following');
  }
}

const SITE_TOGGLES = [
  { selector: '#steam-overlay-toggle', key: 'showOnSteam' },
  { selector: '#csfloat-overlay-toggle', key: 'showCsboardPricesOnCsfloat' },
  { selector: '#betterbuff-toggle', key: 'showBetterBuffOnBuff' },
] as const satisfies ReadonlyArray<{
  selector: string;
  key: 'showOnSteam' | 'showCsboardPricesOnCsfloat' | 'showBetterBuffOnBuff';
}>;

function renderSettings(): void {
  const currency = element<HTMLSelectElement>('#currency-select');
  const priceSource = element<HTMLSelectElement>('#price-source-select');
  const salesNotifications = element<HTMLInputElement>('#sales-notifications-toggle');
  const follow = element<HTMLInputElement>('#sync-preferences-toggle');
  const syncButton = element<HTMLButtonElement>('#sync-preferences-btn');
  const unavailableOrBusy = !settingsContractAvailable || settingsBusy;

  currency.value = settings.currency;
  priceSource.value = settings.priceSource;
  salesNotifications.checked = settings.salesNotifications;
  follow.checked = settings.followCsboardSettings;

  for (const { selector, key } of SITE_TOGGLES) {
    const toggle = element<HTMLInputElement>(selector);
    toggle.checked = settings[key];
    toggle.disabled = unavailableOrBusy;
  }

  currency.disabled = unavailableOrBusy || settings.followCsboardSettings;
  priceSource.disabled = unavailableOrBusy || settings.followCsboardSettings;
  salesNotifications.disabled = unavailableOrBusy;
  follow.disabled = unavailableOrBusy;
  syncButton.disabled = unavailableOrBusy || !settings.followCsboardSettings;
  setText('#preference-sync-status', preferenceSyncDescription());
}

async function loadSettings(): Promise<void> {
  try {
    const response = await sendPopupMessage({
      type: 'GET_EXTENSION_SETTINGS',
      version: POPUP_SETTINGS_SCHEMA_VERSION,
    });
    if (!isRecord(response) || !isRecord(response.settings) || !isRecord(response.sync)) {
      throw new Error('Invalid settings response');
    }
    settings = normalizeSettings(response.settings, settings);
    preferenceSync = normalizePreferenceSync(response.sync, preferenceSync);
    settingsContractAvailable = true;
  } catch {
    // Compatibility fallback is read-only. It preserves current currency/source
    // while making it obvious that the v2 controller still needs wiring.
    const legacy = await sendTypedMessage({ type: 'GET_PRICE_ENGINE_STATUS' });
    if (legacy.ok) {
      settings = normalizeSettings({
        ...settings,
        currency: legacy.value.currency,
        priceSource: legacy.value.priceSource,
      }, settings);
    }
    settingsContractAvailable = false;
  }
  renderSettings();
}

async function updateSettings(
  patch: Partial<Omit<PopupSettingsV2, 'schemaVersion'>>,
  options: { syncFromCsboardNow?: boolean; successMessage?: string } = {},
): Promise<boolean> {
  const previous = settings;
  const optimistic = normalizeSettings({ ...settings, ...patch }, settings);
  settings = optimistic;
  settingsBusy = true;
  clearNotice();
  renderSettings();
  renderPortfolio();

  try {
    const response = await sendPopupMessage({
      type: 'UPDATE_EXTENSION_SETTINGS',
      version: POPUP_SETTINGS_SCHEMA_VERSION,
      data: {
        patch,
        ...(options.syncFromCsboardNow ? { syncFromCsboardNow: true } : {}),
      },
    });
    if (!isRecord(response) || response.success !== true || !isRecord(response.settings)) {
      throw new Error('Invalid settings update response');
    }
    settings = normalizeSettings(response.settings, optimistic);
    if (response.sync !== undefined) {
      preferenceSync = normalizePreferenceSync(response.sync, preferenceSync);
    }
    if (options.successMessage) showNotice(options.successMessage, 'success');
    return true;
  } catch {
    settings = previous;
    showNotice(t('notice.saveFailed'), 'error');
    return false;
  } finally {
    settingsBusy = false;
    renderSettings();
    renderPortfolio();
  }
}

async function syncPreferencesNow(): Promise<void> {
  const previousSync = preferenceSync;
  preferenceSync = { ...preferenceSync, state: 'syncing' };
  renderSettings();
  const saved = await updateSettings({}, {
    syncFromCsboardNow: true,
    successMessage: t('notice.prefsSynced'),
  });
  if (!saved) preferenceSync = { ...previousSync, state: 'error' };
  renderSettings();
}

function sourceStatusText(source: PortfolioSource): string {
  if (source === 'marketHistory') return t('portfolio.src.unavailable');
  if (!settings.portfolioSources[source]) return t('portfolio.src.off');
  const status = portfolioStatus.sources[source];
  const count = status.records !== undefined ? ` · ${status.records.toLocaleString()}` : '';

  switch (status.state) {
    case 'queued': return `${t('portfolio.src.queued')}${count}`;
    case 'running': return `${t('portfolio.src.running')}${count}`;
    case 'success': return `${t('portfolio.src.synced')}${count}${status.warningCode
      ? ` · ${humanizeCode(status.warningCode)}`
      : ''}`;
    case 'error': return `${t('portfolio.src.error')}${status.errorCode ? ` · ${humanizeCode(status.errorCode)}` : ''}`;
    // The source is switched on but the scheduler has not reached it yet: it
    // will go with the next manual or hourly run.
    case 'disabled': return t('portfolio.src.on');
    case 'idle': return `${t('portfolio.src.ready')}${count}`;
  }
}

function portfolioSummary(): string {
  if (!portfolioContractAvailable) return t('portfolio.state.unavailable');
  switch (portfolioStatus.connectionState) {
    case 'unpaired':
      return t('portfolio.state.unpaired');
    case 'paired':
      if (!settings.portfolioSyncEnabled) return t('portfolio.state.pairedOff');
      if (portfolioStatus.paused) return t('portfolio.state.paused');
      return t('portfolio.state.pairedOn');
    case 'revoked':
      return t('portfolio.state.revoked');
    case 'mismatch':
      return t('portfolio.state.mismatch');
    case 'error':
      return t('portfolio.state.error', {
        code: portfolioStatus.errorCode ? humanizeCode(portfolioStatus.errorCode) : '—',
      });
  }
}

function renderPortfolio(): void {
  const badge = element<HTMLElement>('#portfolio-state-badge');
  const paired = portfolioStatus.connectionState === 'paired';
  const hasPairing = portfolioStatus.connectionState !== 'unpaired';
  const sourceFieldset = element<HTMLFieldSetElement>('#portfolio-sources');
  const portfolioToggle = element<HTMLInputElement>('#portfolio-sync-toggle');
  const syncButton = element<HTMLButtonElement>('#sync-portfolio-btn');
  const unpairButton = element<HTMLButtonElement>('#unpair-device-btn');

  badge.classList.remove('neutral', 'good', 'warn', 'bad');
  if (!portfolioContractAvailable) {
    badge.textContent = t('portfolio.badge.unavailable');
    badge.classList.add('neutral');
  } else {
    const badgeConfig = {
      unpaired: ['portfolio.badge.unpaired', 'neutral'],
      paired: [
        settings.portfolioSyncEnabled ? 'portfolio.badge.enabled' : 'portfolio.badge.paired',
        settings.portfolioSyncEnabled ? 'good' : 'neutral',
      ],
      revoked: ['portfolio.badge.revoked', 'bad'],
      mismatch: ['portfolio.badge.mismatch', 'bad'],
      error: ['portfolio.badge.error', 'bad'],
    } as const;
    const [labelKey, className] = badgeConfig[portfolioStatus.connectionState];
    badge.textContent = t(labelKey);
    badge.classList.add(className);
  }

  setText('#portfolio-summary', portfolioSummary());
  setHidden('#pair-prompt', !portfolioContractAvailable || portfolioStatus.connectionState !== 'unpaired');
  setHidden('#portfolio-enable-row', !portfolioContractAvailable || !paired);
  setHidden('#portfolio-account', !portfolioStatus.steamId);
  if (portfolioStatus.steamId) {
    setText('#portfolio-account', t('portfolio.steamId', { id: portfolioStatus.steamId }));
  }

  portfolioToggle.checked = settings.portfolioSyncEnabled;
  portfolioToggle.disabled = !portfolioContractAvailable || !paired || portfolioBusy || settingsBusy;
  sourceFieldset.disabled = !portfolioContractAvailable || !paired || portfolioBusy || settingsBusy;

  for (const [source, id] of Object.entries(SOURCE_ELEMENT_IDS) as [PortfolioSource, string][]) {
    const checkbox = element<HTMLInputElement>(`#${id}`);
    checkbox.checked = settings.portfolioSources[source];
    setText(`#${id}-status`, sourceStatusText(source));
  }

  const showMetrics = portfolioContractAvailable && hasPairing;
  setHidden('#portfolio-metrics', !showMetrics);
  setText('#portfolio-last-success', timeAgo(portfolioStatus.lastSuccessfulAt));
  setText('#portfolio-last-attempt', timeAgo(portfolioStatus.lastAttemptedAt));
  setText('#portfolio-queued', portfolioStatus.queuedRecords.toLocaleString());

  setHidden('#portfolio-actions', !portfolioContractAvailable || !hasPairing);
  setHidden('#sync-portfolio-btn', !paired);
  syncButton.disabled = portfolioBusy
    || !settings.portfolioSyncEnabled
    || !Object.values(settings.portfolioSources).some(Boolean);
  syncButton.textContent = portfolioBusy ? t('portfolio.syncing') : t('portfolio.syncNow');
  unpairButton.textContent = t('portfolio.unpair');
  unpairButton.disabled = portfolioBusy;
}

async function loadPortfolioStatus(): Promise<void> {
  try {
    const response = await sendPopupMessage({
      type: 'GET_PORTFOLIO_SYNC_STATUS',
      version: POPUP_PORTFOLIO_PROTOCOL_VERSION,
    });
    if (!isRecord(response) || !isRecord(response.status)) {
      throw new Error('Invalid portfolio status response');
    }
    portfolioStatus = normalizePortfolioStatus(response.status, portfolioStatus);
    portfolioContractAvailable = true;
  } catch {
    portfolioContractAvailable = false;
  }
  renderPortfolio();
}

/*
  `pairDevice` lived here and is gone with the code field it served.

  Pairing is a one-click handshake on the website now — the background still
  answers PAIR_DEVICE for that path, and the popup no longer offers a second,
  harder way to reach the same state. Unpairing stays: it is the one direction
  a user may want without leaving the browser.
*/

async function unpairDevice(): Promise<void> {
  const confirmed = window.confirm(t('portfolio.unpairConfirm'));
  if (!confirmed) return;

  portfolioBusy = true;
  clearNotice();
  renderPortfolio();
  try {
    const response = await sendPopupMessage({
      type: 'UNPAIR_DEVICE',
      version: POPUP_PORTFOLIO_PROTOCOL_VERSION,
    });
    if (!isRecord(response) || !isRecord(response.status)) {
      throw new Error('Invalid unpair response');
    }
    portfolioStatus = normalizePortfolioStatus(response.status, DEFAULT_PORTFOLIO_STATUS);
    settings = {
      ...settings,
      portfolioSyncEnabled: false,
      portfolioSources: { ...DEFAULT_POPUP_SETTINGS.portfolioSources },
    };
    showNotice(t('notice.unpaired'), 'success');
  } catch {
    showNotice(t('notice.unpairFailed'), 'error');
  } finally {
    portfolioBusy = false;
    renderSettings();
    renderPortfolio();
  }
}

async function runManualSync(): Promise<void> {
  portfolioBusy = true;
  clearNotice();
  renderPortfolio();
  try {
    const response = await sendPopupMessage({
      type: 'RUN_MANUAL_SYNC',
      version: POPUP_PORTFOLIO_PROTOCOL_VERSION,
    }, 60_000);
    if (!isRecord(response) || !isRecord(response.status)) {
      throw new Error('Invalid sync response');
    }
    portfolioStatus = normalizePortfolioStatus(response.status, portfolioStatus);
    const skippedSources = Object.values(portfolioStatus.sources)
      .filter((source) => source.enabled && source.state === 'error');
    const warnedSources = Object.values(portfolioStatus.sources)
      .filter((source) => source.enabled && source.warningCode);
    const warningCodes = new Set(warnedSources.map((source) => source.warningCode));
    const warningMessage = warningCodes.has('TRADE_HISTORY_TRUNCATED')
      ? t('notice.syncTruncated')
      : warningCodes.has('OVERSIZED_RECORDS_DROPPED')
        ? t('notice.syncOversized')
        : t('notice.syncWarning');
    showNotice(
      skippedSources.length > 0
        ? t('notice.syncPartial')
        : warnedSources.length > 0
          ? warningMessage
          : t('notice.syncDone'),
      skippedSources.length > 0 || warnedSources.length > 0 ? 'warning' : 'success',
    );
  } catch (error) {
    // The worker already stored WHY it failed. Showing a generic sentence
    // instead sent the last debugging round chasing a stale banner, so re-read
    // the status and name the cause.
    let cause = '';
    try {
      await loadPortfolioStatus();
      if (portfolioStatus?.errorCode) cause = ` (${humanizeCode(portfolioStatus.errorCode)})`;
    } catch {
      cause = error instanceof Error && error.message ? ` (${error.message})` : '';
    }
    showNotice(t('notice.syncFailed', { cause }), 'error');
  } finally {
    portfolioBusy = false;
    renderPortfolio();
  }
}

async function refreshPrices(): Promise<void> {
  const button = element<HTMLButtonElement>('#refresh-prices-btn');
  clearNotice();
  button.disabled = true;
  button.textContent = t('prices.refreshing');

  const result = await sendTypedMessage({ type: 'REFRESH_PRICES' }, 30_000);
  if (result.ok && result.value.success) {
    showNotice(t('notice.pricesLoaded', { count: result.value.count.toLocaleString() }), 'success');
    await loadPriceStatus();
  } else {
    showNotice(t('notice.pricesFailed'), 'error');
  }
  button.disabled = false;
  button.textContent = t('prices.refresh');
}

let priceStatus: { count: number; lastFetched: number | null } | null = null;

function renderPriceStatus(): void {
  if (!priceStatus) {
    setText('#prices-count', t('prices.cacheUnknown'));
    setText('#prices-updated', '');
    return;
  }
  setText('#prices-count', priceStatus.count > 0
    ? t('prices.cache', { count: priceStatus.count.toLocaleString() })
    : t('prices.cacheEmpty'));
  setText('#prices-updated', priceStatus.lastFetched
    ? t('prices.updated', { ago: timeAgo(priceStatus.lastFetched) })
    : t('prices.updatedNever'));
}

async function loadPriceStatus(): Promise<void> {
  const result = await sendTypedMessage({ type: 'GET_PRICE_ENGINE_STATUS' });
  priceStatus = result.ok
    ? { count: result.value.count, lastFetched: result.value.lastFetched }
    : null;
  renderPriceStatus();
}

function bindEvents(): void {
  element<HTMLSelectElement>('#currency-select').addEventListener('change', (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (isSupportedCurrency(value)) void updateSettings({ currency: value });
  });

  element<HTMLSelectElement>('#price-source-select').addEventListener('change', (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (isSupportedPriceSource(value)) void updateSettings({ priceSource: value });
  });

  element<HTMLInputElement>('#sales-notifications-toggle').addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    void updateSettings(
      { salesNotifications: enabled },
      { successMessage: enabled ? t('notice.notifyOn') : t('notice.notifyOff') },
    );
  });

  /*
    One message for all three sites, in both directions.

    The four separate sentences this replaced ("CSFloat overlay enabled.",
    "BetterBuff tools disabled on Buff163.", …) told the user what he had just
    clicked. What he cannot see is that the tab already open does not change
    until it reloads, so that is the only thing worth a notice.
  */
  for (const { selector, key } of SITE_TOGGLES) {
    element<HTMLInputElement>(selector).addEventListener('change', (event) => {
      const enabled = (event.currentTarget as HTMLInputElement).checked;
      void updateSettings(
        { [key]: enabled },
        { successMessage: t('notice.reloadTab') },
      );
    });
  }

  /*
    Language is a popup preference, not an extension setting.

    It never leaves this browser and nothing in the background reads it, so it
    lives under its own storage key rather than in the settings contract the
    service worker validates and csboard can sync.
  */
  element<HTMLSelectElement>('#language-select').addEventListener('change', (event) => {
    const preference = normalizeLocalePreference((event.currentTarget as HTMLSelectElement).value);
    localePreference = preference;
    activateLocale(resolveLocale(preference));
    applyTranslations();
    renderAll();
    void saveLocalePreference(preference);
  });

  element<HTMLInputElement>('#sync-preferences-toggle').addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    void (async () => {
      const saved = await updateSettings({ followCsboardSettings: enabled });
      if (saved && enabled) await syncPreferencesNow();
    })();
  });

  element<HTMLButtonElement>('#sync-preferences-btn').addEventListener('click', () => {
    void syncPreferencesNow();
  });


  element<HTMLInputElement>('#portfolio-sync-toggle').addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    void updateSettings(
      { portfolioSyncEnabled: enabled },
      { successMessage: enabled ? t('notice.uploadsOn') : t('notice.uploadsOff') },
    );
  });

  for (const [source, id] of Object.entries(SOURCE_ELEMENT_IDS) as [PortfolioSource, string][]) {
    element<HTMLInputElement>(`#${id}`).addEventListener('change', (event) => {
      const enabled = (event.currentTarget as HTMLInputElement).checked;
      void updateSettings({
        portfolioSources: {
          ...settings.portfolioSources,
          [source]: enabled,
        },
      });
    });
  }

  element<HTMLButtonElement>('#sync-portfolio-btn').addEventListener('click', () => {
    void runManualSync();
  });
  element<HTMLButtonElement>('#unpair-device-btn').addEventListener('click', () => {
    void unpairDevice();
  });
  element<HTMLButtonElement>('#refresh-prices-btn').addEventListener('click', () => {
    void refreshPrices();
  });
}

/** Every panel that holds translated text, re-run when the locale changes. */
function renderAll(): void {
  renderAuth();
  renderSettings();
  renderPortfolio();
  renderPriceStatus();
}

async function init(): Promise<void> {
  const loginButton = element<HTMLAnchorElement>('#login-btn');
  loginButton.href = SITE_BASE;

  /*
    Translate before the first paint, then again after each load resolves.

    `initI18n` is awaited here rather than raced with the data loads: it reads
    one local storage key, and a popup that renders English for 30ms and then
    swaps to Russian in front of the user looks broken in a way the saved
    round-trip does not pay for.
  */
  localePreference = await loadLocalePreference();
  await initI18n();
  element<HTMLSelectElement>('#language-select').value = localePreference;
  applyTranslations();

  bindEvents();
  renderAll();

  await Promise.allSettled([
    checkAuth(),
    loadSettings(),
    loadPortfolioStatus(),
    loadPriceStatus(),
  ]);
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
