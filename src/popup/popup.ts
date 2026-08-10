// ============================================================
// CSBOARD-PROD Popup
// ============================================================
// Local settings are available regardless of CSBOARD login state. Portfolio
// commands use the extension's internal router only; none of these messages may
// be forwarded by onMessageExternal.

import { SITE_BASE } from '../shared/config';
import { sendTypedMessage } from '../shared/message-bus';
import { normalizeAvatarUrl, type UserProfile } from '../shared/types';
import {
  DEFAULT_POPUP_SETTINGS,
  DEFAULT_PORTFOLIO_STATUS,
  P2P_LISTING_TERMS_VERSION,
  POPUP_P2P_PROTOCOL_VERSION,
  POPUP_PORTFOLIO_PROTOCOL_VERSION,
  POPUP_SETTINGS_SCHEMA_VERSION,
  isSupportedCurrency,
  isSupportedPriceSource,
  type PopupInternalMessageType,
  type PopupInternalRequest,
  type PopupResponseFor,
  type PopupSettingsV2,
  type P2PEligibleAsset,
  type P2PEligibilityReason,
  type P2PListingReview,
  type PortfolioSource,
  type PortfolioSourceRunState,
  type PortfolioSourceStatus,
  type PortfolioSyncStatus,
  type PricePreferenceSyncState,
  type PricePreferenceSyncStatus,
} from './contracts';
import {
  buildP2PAssetOption,
  p2pAssetOptionsMatch,
} from './p2p-view-model';
import { pairingFailureNotice } from './pairing-error-notice';

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
let p2pAssets: readonly P2PEligibleAsset[] = [];
let p2pAvailable = false;
let p2pBusy = false;
let p2pReview: P2PListingReview | null = null;
let selectedP2PAssetId: string | null = null;
let p2pSummaryText = 'Checking current P2P eligibility…';
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
    followCsboardSettings: typeof value.followCsboardSettings === 'boolean'
      ? value.followCsboardSettings
      : fallback.followCsboardSettings,
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

function normalizeP2PAsset(value: unknown): P2PEligibleAsset | null {
  if (!isRecord(value) ||
      typeof value.operationalAssetId !== 'string' ||
      !/^[A-Za-z0-9:._-]{1,256}$/.test(value.operationalAssetId) ||
      typeof value.assetRevision !== 'string' ||
      !/^[A-Za-z0-9:_-]{16,128}$/.test(value.assetRevision) ||
      typeof value.marketHashName !== 'string' ||
      value.marketHashName.length < 1 || value.marketHashName.length > 256 ||
      (value.contextId !== '2' && value.contextId !== '16') ||
      typeof value.eligibility !== 'boolean' ||
      !Array.isArray(value.reasons) ||
      value.reasons.length > 32 ||
      value.reasons.some((reason) => !isRecord(reason) ||
        typeof reason.code !== 'string' || !/^[A-Za-z0-9:_-]{1,96}$/.test(reason.code) ||
        typeof reason.message !== 'string' ||
        !/^[^\u0000-\u001f\u007f]{1,240}$/.test(reason.message)) ||
      value.currency !== 'USD' ||
      !(value.snapshotCompletedAt === null ||
        (typeof value.snapshotCompletedAt === 'string' &&
          Number.isFinite(Date.parse(value.snapshotCompletedAt))))) {
    return null;
  }
  const listingId = value.listingId === null
    ? null
    : typeof value.listingId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value.listingId)
      ? value.listingId
      : undefined;
  const listingState = value.listingState === null
    ? null
    : typeof value.listingState === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value.listingState)
      ? value.listingState
      : undefined;
  if (listingId === undefined || listingState === undefined ||
      ((listingId === null) !== (listingState === null)) ||
      (value.eligibility && (value.snapshotCompletedAt === null || value.reasons.length > 0)) ||
      (!value.eligibility && value.reasons.length === 0)) {
    return null;
  }
  return {
    operationalAssetId: value.operationalAssetId,
    assetRevision: value.assetRevision,
    marketHashName: value.marketHashName,
    contextId: value.contextId,
    eligibility: value.eligibility,
    reasons: value.reasons.map((reason) => ({
      code: (reason as Record<string, unknown>).code as string,
      message: (reason as Record<string, unknown>).message as string,
    })),
    listingId,
    listingState,
    currency: 'USD',
    snapshotCompletedAt: value.snapshotCompletedAt,
  };
}

function normalizeP2PReview(value: unknown): P2PListingReview | null {
  if (!isRecord(value) ||
      typeof value.reviewId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.reviewId) ||
      (value.action !== 'create' && value.action !== 'unpublish') ||
      typeof value.operationalAssetId !== 'string' ||
      typeof value.assetRevision !== 'string' ||
      typeof value.marketHashName !== 'string' ||
      value.marketHashName.length < 1 || value.marketHashName.length > 256 ||
      !(value.listingId === null || typeof value.listingId === 'string') ||
      typeof value.priceMinor !== 'number' || !Number.isSafeInteger(value.priceMinor) ||
      value.priceMinor < 10 || value.priceMinor > 10_000_000 ||
      value.currency !== 'USD' || value.termsVersion !== P2P_LISTING_TERMS_VERSION ||
      typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 2 * 60_000 + 5_000) {
    return null;
  }
  return value as unknown as P2PListingReview;
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

function humanizeCode(code: string): string {
  return code
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

function timeAgo(timestamp: number | null): string {
  if (!timestamp) return 'Never';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 15) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
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

function renderAuthenticatedUser(user: UserProfile): void {
  setHidden('#auth-user', false);
  renderUserAvatar(user);
  setText('#user-name', user.name);
  setHidden('#user-badge', !user.isPremium);
  setText('#auth-detail', 'Connected. CSBOARD preferences can be followed automatically.');
  setConnection('online', 'Connected');
}

async function checkAuth(): Promise<void> {
  const result = await sendTypedMessage({ type: 'GET_AUTH_STATUS' });
  if (!result.ok) {
    setHidden('#auth-user', true);
    setText('#auth-detail', 'CSBOARD is unreachable. Your last valid local settings are unchanged.');
    setConnection('offline', 'Offline');
    return;
  }

  if (result.value.isLoggedIn) {
    renderAuthenticatedUser(result.value.user);
    return;
  }

  setHidden('#auth-user', true);
  setText('#auth-detail', 'Signed out. Local price and overlay settings remain available.');
  setConnection('signed-out', 'Signed out');
}

function preferenceSyncDescription(): string {
  if (!settingsContractAvailable) return 'Settings controller unavailable in this build.';
  if (!settings.followCsboardSettings) return 'Off — local currency and source will not be overwritten.';

  const lastSync = preferenceSync.lastSyncedAt
    ? ` Last synced ${timeAgo(preferenceSync.lastSyncedAt)}.`
    : '';

  switch (preferenceSync.state) {
    case 'syncing':
      return 'Syncing from CSBOARD…';
    case 'success':
      return `Following CSBOARD.${lastSync}`;
    case 'warning':
      return `Following CSBOARD with warning${preferenceSync.warningCode ? `: ${humanizeCode(preferenceSync.warningCode)}` : '.'}${lastSync}`;
    case 'error':
      return `Sync failed; last valid values were kept.${lastSync}`;
    case 'signed_out':
      return 'Sign in to CSBOARD to import preferences. Last valid values are kept.';
    case 'idle':
      return `Following CSBOARD.${lastSync}`;
  }
}

function renderSettings(): void {
  const currency = element<HTMLSelectElement>('#currency-select');
  const priceSource = element<HTMLSelectElement>('#price-source-select');
  const follow = element<HTMLInputElement>('#sync-preferences-toggle');
  const showCsfloat = element<HTMLInputElement>('#csfloat-overlay-toggle');
  const showBetterBuff = element<HTMLInputElement>('#betterbuff-toggle');
  const syncButton = element<HTMLButtonElement>('#sync-preferences-btn');

  currency.value = settings.currency;
  priceSource.value = settings.priceSource;
  follow.checked = settings.followCsboardSettings;
  showCsfloat.checked = settings.showCsboardPricesOnCsfloat;
  showBetterBuff.checked = settings.showBetterBuffOnBuff;

  const unavailableOrBusy = !settingsContractAvailable || settingsBusy;
  currency.disabled = unavailableOrBusy || settings.followCsboardSettings;
  priceSource.disabled = unavailableOrBusy || settings.followCsboardSettings;
  follow.disabled = unavailableOrBusy;
  showCsfloat.disabled = unavailableOrBusy;
  showBetterBuff.disabled = unavailableOrBusy;
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
    showNotice('Could not save this setting. Your previous value was restored.', 'error');
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
    successMessage: 'CSBOARD price preferences synced.',
  });
  if (!saved) preferenceSync = { ...previousSync, state: 'error' };
  renderSettings();
}

function sourceStatusText(source: PortfolioSource): string {
  if (source === 'marketHistory') return 'Not available in 1.1';
  if (!settings.portfolioSources[source]) return 'Off';
  const status = portfolioStatus.sources[source];
  const count = status.records !== undefined ? ` · ${status.records.toLocaleString()} records` : '';

  switch (status.state) {
    case 'queued': return `Queued${count}`;
    case 'running': return `Syncing${count}`;
    case 'success': return `Synced${count}${status.warningCode
      ? ` · ${humanizeCode(status.warningCode)}`
      : ''}`;
    case 'error': return `Error${status.errorCode ? ` · ${humanizeCode(status.errorCode)}` : ''}`;
    case 'disabled': return 'Enabled for manual and hourly sync';
    case 'idle': return `Ready${count}`;
  }
}

function portfolioSummary(): string {
  if (!portfolioContractAvailable) return 'Portfolio sync is unavailable in this build. No data is uploaded.';
  switch (portfolioStatus.connectionState) {
    case 'unpaired':
      return 'Pair with a one-time code from CSFolder. Installing the extension never enables uploads.';
    case 'paired':
      if (!settings.portfolioSyncEnabled) return 'Paired. Portfolio uploads remain off until you enable them.';
      if (portfolioStatus.paused) return 'Sync is paused by the connector. Review the status and retry manually.';
      return 'Paired. Enabled sources sync automatically about once per hour; Sync now runs them immediately.';
    case 'revoked':
      return 'This device was revoked. Unpair it locally, then create a new one-time code.';
    case 'mismatch':
      return 'The active Steam account does not match the paired account. Sync is blocked.';
    case 'error':
      return `Portfolio connection error${portfolioStatus.errorCode ? `: ${humanizeCode(portfolioStatus.errorCode)}` : '.'}`;
  }
}

function renderPortfolio(): void {
  const badge = element<HTMLElement>('#portfolio-state-badge');
  const paired = portfolioStatus.connectionState === 'paired';
  const hasPairing = portfolioStatus.connectionState !== 'unpaired';
  const sourceFieldset = element<HTMLFieldSetElement>('#portfolio-sources');
  const portfolioToggle = element<HTMLInputElement>('#portfolio-sync-toggle');
  const pairingCode = element<HTMLInputElement>('#pairing-code-input');
  const pairButton = element<HTMLButtonElement>('#pair-device-btn');
  const syncButton = element<HTMLButtonElement>('#sync-portfolio-btn');
  const unpairButton = element<HTMLButtonElement>('#unpair-device-btn');

  badge.classList.remove('neutral', 'good', 'warn', 'bad');
  if (!portfolioContractAvailable) {
    badge.textContent = 'Unavailable';
    badge.classList.add('neutral');
  } else {
    const badgeConfig = {
      unpaired: ['Unpaired', 'neutral'],
      paired: [settings.portfolioSyncEnabled ? 'Enabled' : 'Paired', settings.portfolioSyncEnabled ? 'good' : 'neutral'],
      revoked: ['Revoked', 'bad'],
      mismatch: ['Mismatch', 'bad'],
      error: ['Error', 'bad'],
    } as const;
    const [label, className] = badgeConfig[portfolioStatus.connectionState];
    badge.textContent = label;
    badge.classList.add(className);
  }

  setText('#portfolio-summary', portfolioSummary());
  setHidden('#pair-form', !portfolioContractAvailable || portfolioStatus.connectionState !== 'unpaired');
  setHidden('#portfolio-enable-row', !portfolioContractAvailable || !paired);
  setHidden('#portfolio-account', !portfolioStatus.steamId);
  if (portfolioStatus.steamId) {
    setText('#portfolio-account', `Paired Steam ID: ${portfolioStatus.steamId}`);
  }

  portfolioToggle.checked = settings.portfolioSyncEnabled;
  portfolioToggle.disabled = !portfolioContractAvailable || !paired || portfolioBusy || settingsBusy;
  pairingCode.disabled = portfolioBusy;
  pairButton.disabled = portfolioBusy;
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
  setText('#portfolio-queued', `${portfolioStatus.queuedRecords.toLocaleString()} records`);

  setHidden('#portfolio-actions', !portfolioContractAvailable || !hasPairing);
  setHidden('#sync-portfolio-btn', !paired);
  syncButton.disabled = portfolioBusy
    || !settings.portfolioSyncEnabled
    || !Object.values(settings.portfolioSources).some(Boolean);
  syncButton.textContent = portfolioBusy ? 'Syncing…' : 'Sync now';
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

async function pairDevice(code: string): Promise<void> {
  portfolioBusy = true;
  clearNotice();
  renderPortfolio();
  try {
    const response = await sendPopupMessage({
      type: 'PAIR_DEVICE',
      version: POPUP_PORTFOLIO_PROTOCOL_VERSION,
      data: { code },
    });
    if (!isRecord(response) || !isRecord(response.status)) {
      throw new Error('Invalid pairing response');
    }
    portfolioStatus = normalizePortfolioStatus(response.status, portfolioStatus);
    element<HTMLInputElement>('#pairing-code-input').value = '';
    showNotice('Device paired with CSFolder. Portfolio uploads are still off until you enable them.', 'success');
  } catch (error) {
    showNotice(pairingFailureNotice(error), 'error');
  } finally {
    portfolioBusy = false;
    renderPortfolio();
  }
}

async function unpairDevice(): Promise<void> {
  const confirmed = window.confirm('Unpair this browser from CSFolder? Pending local sync data will no longer upload.');
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
    showNotice('Device unpaired and portfolio uploads disabled.', 'success');
  } catch {
    showNotice('Could not unpair this device. Nothing was deleted locally.', 'error');
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
    showNotice(
      skippedSources.length > 0
        ? 'Sync finished, but one or more Steam sources were unavailable. Successful sources were uploaded safely.'
        : warnedSources.length > 0
          ? 'Sync finished safely, but one or more oversized records were omitted.'
          : 'Manual portfolio sync finished.',
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
    showNotice(
      `Portfolio sync did not finish${cause}. Safe queued records will retry without duplication.`,
      'error',
    );
  } finally {
    portfolioBusy = false;
    renderPortfolio();
  }
}

function formatUsdMinor(value: number): string {
  return `$${(value / 100).toFixed(2)} USD`;
}

function parseUsdMinor(value: string): number | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  const parsed = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(parsed) && parsed >= 10 && parsed <= 10_000_000
    ? parsed
    : null;
}

function p2pReasonText(reason: P2PEligibilityReason): string {
  const reasons: Readonly<Record<string, string>> = {
    already_listed: 'This asset already has a listing.',
    steam_account_mismatch: 'The active Steam account does not match the CSBOARD account.',
    snapshot_missing: 'A complete inventory snapshot (contexts 2 and 16) is required.',
    snapshot_stale: 'The inventory snapshot is stale. Sync the portfolio again.',
    snapshot_superseded: 'A newer inventory snapshot exists. Refresh eligibility.',
    asset_missing: 'This asset is missing from the latest complete inventory snapshot.',
    asset_revision_unverified: 'CSBOARD cannot verify the current asset revision.',
    not_tradable: 'Steam currently marks this asset as not tradable.',
    on_hold: 'This asset is on trade hold.',
    hold_not_ended: 'The Steam trade hold has not ended yet.',
    reserved: 'This asset is reserved by another operation.',
    active_trade: 'This asset is already part of an active trade.',
    inventory_item_unavailable: 'The synchronized inventory item is unavailable.',
  };
  return reasons[reason.code] ?? reason.message;
}

function p2pFailureText(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  switch (code) {
    case 'P2P_AUTH_REQUIRED':
      return 'Sign in to CSBOARD, then refresh. No listing action is available while signed out.';
    case 'P2P_ASSET_INELIGIBLE':
      return 'This asset is no longer eligible. Refresh to see the current reason.';
    case 'P2P_ASSET_REVISION_CHANGED':
      return 'The asset changed after selection. Refresh and review the latest revision.';
    case 'P2P_LISTING_UNAVAILABLE':
      return 'The listing state changed. Refresh before trying again.';
    case 'P2P_REVIEW_EXPIRED':
    case 'P2P_REVIEW_NOT_FOUND':
    case 'P2P_REVIEW_STALE':
      return 'The review expired or changed. Request a new review.';
    case 'P2P_RATE_LIMITED':
      return 'CSBOARD is rate limiting listing actions. Wait, then request a new review.';
    case 'P2P_REQUEST_REJECTED':
      return 'CSBOARD rejected this listing action. Refresh eligibility and request a new review.';
    default:
      return 'P2P listing service is unavailable. Publishing and unpublishing are blocked.';
  }
}

function isTerminalP2PConfirmError(error: unknown): boolean {
  const code = error instanceof Error ? error.message : '';
  return code === 'P2P_AUTH_REQUIRED' ||
    code === 'P2P_LISTING_UNAVAILABLE' ||
    code === 'P2P_REVIEW_EXPIRED' ||
    code === 'P2P_REVIEW_NOT_FOUND' ||
    code === 'P2P_REVIEW_STALE' ||
    code === 'P2P_RATE_LIMITED' ||
    code === 'P2P_REQUEST_REJECTED';
}

function selectedP2PAsset(): P2PEligibleAsset | null {
  return p2pAssets.find((asset) => asset.operationalAssetId === selectedP2PAssetId) ?? null;
}

function replaceP2POptions(): void {
  const select = element<HTMLSelectElement>('#p2p-asset-select');
  const desiredOptions = p2pAssets.map(buildP2PAssetOption);
  const currentOptions = Array.from(select.options, (option) => ({
    value: option.value,
    label: option.textContent ?? '',
  }));
  if (p2pAssetOptionsMatch(currentOptions, desiredOptions)) return;

  const options = desiredOptions.map((model) => {
    const option = document.createElement('option');
    option.value = model.value;
    option.textContent = model.label;
    return option;
  });
  select.replaceChildren(...options);
}

function renderP2P(): void {
  const badge = element<HTMLElement>('#p2p-state-badge');
  const refreshButton = element<HTMLButtonElement>('#refresh-p2p-btn');
  const select = element<HTMLSelectElement>('#p2p-asset-select');
  const priceInput = element<HTMLInputElement>('#p2p-price-input');
  const reviewButton = element<HTMLButtonElement>('#review-p2p-btn');
  const confirmButton = element<HTMLButtonElement>('#confirm-p2p-btn');
  const cancelButton = element<HTMLButtonElement>('#cancel-p2p-review-btn');

  badge.classList.remove('neutral', 'good', 'warn', 'bad');
  badge.textContent = p2pBusy ? 'Working' : p2pReview ? 'Review' : p2pAvailable ? 'Ready' : 'Unavailable';
  badge.classList.add(p2pReview ? 'warn' : p2pAvailable ? 'good' : 'neutral');
  refreshButton.disabled = p2pBusy || p2pReview !== null;
  setText('#p2p-summary', p2pSummaryText);

  const showWorkspace = p2pAvailable && p2pAssets.length > 0 && p2pReview === null;
  setHidden('#p2p-workspace', !showWorkspace);
  setHidden('#p2p-review', p2pReview === null);

  if (p2pReview) {
    const seconds = Math.max(0, Math.ceil((p2pReview.expiresAt - Date.now()) / 1_000));
    setText('#p2p-review-action', p2pReview.action === 'create' ? 'Publish listing' : 'Unpublish listing');
    setText('#p2p-review-item', p2pReview.marketHashName);
    setText('#p2p-review-price', formatUsdMinor(p2pReview.priceMinor));
    setText('#p2p-review-terms', p2pReview.termsVersion);
    setText('#p2p-review-expiry', `One-time review expires in at most ${seconds} seconds.`);
    confirmButton.textContent = p2pBusy
      ? 'Confirming…'
      : p2pReview.action === 'create' ? 'Confirm publish' : 'Confirm unpublish';
    confirmButton.disabled = p2pBusy || seconds <= 0;
    cancelButton.disabled = p2pBusy;
    return;
  }

  replaceP2POptions();
  if (!selectedP2PAssetId || !p2pAssets.some((asset) =>
    asset.operationalAssetId === selectedP2PAssetId)) {
    selectedP2PAssetId = p2pAssets[0]?.operationalAssetId ?? null;
  }
  select.value = selectedP2PAssetId ?? '';
  select.disabled = p2pBusy;

  const asset = selectedP2PAsset();
  if (!asset) return;
  const activeListing = Boolean(asset.listingId && asset.listingState === 'active');
  const canPublish = asset.eligibility && !asset.listingId;
  const reasons = [...asset.reasons];
  if (asset.snapshotCompletedAt === null &&
      !reasons.some((reason) => reason.code === 'snapshot_missing')) {
    reasons.push({
      code: 'snapshot_missing',
      message: 'A complete inventory snapshot is required.',
    });
  }
  if (asset.listingId && !activeListing) {
    reasons.push({
      code: 'listing_state_unavailable',
      message: `Listing state ${asset.listingState ?? 'unknown'} cannot be unpublished here.`,
    });
  }

  setText('#p2p-asset-name', asset.marketHashName);
  setText('#p2p-snapshot-time', asset.snapshotCompletedAt
    ? `Inventory snapshot: ${new Date(asset.snapshotCompletedAt).toLocaleString()} · context ${asset.contextId}`
    : `No complete inventory snapshot · context ${asset.contextId}`);
  const reasonList = element<HTMLUListElement>('#p2p-reasons');
  reasonList.classList.toggle('good', reasons.length === 0 || activeListing);
  const messages = activeListing
    ? ['Active listing is eligible for unpublish.']
    : reasons.length > 0
      ? reasons.map(p2pReasonText)
      : ['Eligible for a new P2P listing.'];
  reasonList.replaceChildren(...messages.map((message) => {
    const item = document.createElement('li');
    item.textContent = message;
    return item;
  }));

  setHidden('#p2p-price-field', activeListing);
  priceInput.disabled = p2pBusy || !canPublish;
  reviewButton.disabled = p2pBusy || (!activeListing && !canPublish);
  reviewButton.textContent = p2pBusy
    ? 'Requesting review…'
    : activeListing ? 'Review unpublish' : 'Review publish';
}

async function loadP2PAssets(): Promise<void> {
  p2pBusy = true;
  p2pSummaryText = 'Checking current P2P eligibility…';
  renderP2P();
  try {
    const response = await sendPopupMessage({
      type: 'GET_P2P_ELIGIBLE_ASSETS',
      version: POPUP_P2P_PROTOCOL_VERSION,
    });
    if (!isRecord(response) || !Array.isArray(response.assets)) {
      throw new Error('P2P_INVALID_ELIGIBILITY_RESPONSE');
    }
    const normalized = response.assets.map(normalizeP2PAsset);
    if (normalized.some((asset) => asset === null)) {
      throw new Error('P2P_INVALID_ELIGIBILITY_RESPONSE');
    }
    const assets = normalized as P2PEligibleAsset[];
    if (new Set(assets.map((asset) => asset.operationalAssetId)).size !== assets.length) {
      throw new Error('P2P_INVALID_ELIGIBILITY_RESPONSE');
    }
    p2pAssets = assets;
    p2pAvailable = true;
    p2pSummaryText = assets.length > 0
      ? 'Select your asset, request a bound review, then confirm with a separate click.'
      : 'No synchronized assets are available. Run a complete portfolio inventory sync first.';
    if (!assets.some((asset) => asset.operationalAssetId === selectedP2PAssetId)) {
      selectedP2PAssetId = assets[0]?.operationalAssetId ?? null;
    }
  } catch (error) {
    p2pAssets = [];
    selectedP2PAssetId = null;
    p2pAvailable = false;
    p2pSummaryText = p2pFailureText(error);
  } finally {
    p2pBusy = false;
    renderP2P();
  }
}

async function prepareP2PReview(): Promise<void> {
  const asset = selectedP2PAsset();
  if (!asset) return;
  const activeListing = Boolean(asset.listingId && asset.listingState === 'active');
  let priceMinor: number | null = null;
  if (!activeListing) {
    priceMinor = parseUsdMinor(element<HTMLInputElement>('#p2p-price-input').value);
    if (priceMinor === null) {
      showNotice('Enter a valid USD price between $0.10 and $100,000.00.', 'error');
      element<HTMLInputElement>('#p2p-price-input').focus();
      return;
    }
  }

  p2pBusy = true;
  clearNotice();
  renderP2P();
  try {
    const data = activeListing
      ? {
          action: 'unpublish' as const,
          operationalAssetId: asset.operationalAssetId,
          assetRevision: asset.assetRevision,
          listingId: asset.listingId!,
        }
      : {
          action: 'create' as const,
          operationalAssetId: asset.operationalAssetId,
          assetRevision: asset.assetRevision,
          priceMinor: priceMinor!,
        };
    const response = await sendPopupMessage({
      type: 'PREPARE_P2P_LISTING',
      version: POPUP_P2P_PROTOCOL_VERSION,
      data,
    });
    const review = isRecord(response) ? normalizeP2PReview(response.review) : null;
    const exactBinding = review && review.operationalAssetId === asset.operationalAssetId
      && review.assetRevision === asset.assetRevision
      && review.marketHashName === asset.marketHashName
      && (activeListing
        ? review.action === 'unpublish' && review.listingId === asset.listingId
        : review.action === 'create' && review.listingId === null && review.priceMinor === priceMinor);
    if (!review || !exactBinding) throw new Error('P2P_REVIEW_BINDING_MISMATCH');
    p2pReview = review;
    p2pSummaryText = 'Review the exact item, action, price, and terms before confirming.';
  } catch (error) {
    showNotice(p2pFailureText(error), 'error');
  } finally {
    p2pBusy = false;
    renderP2P();
  }
}

async function cancelP2PReview(): Promise<void> {
  const review = p2pReview;
  p2pReview = null;
  p2pSummaryText = 'Listing review cancelled. No listing action was committed.';
  renderP2P();
  if (!review) return;
  try {
    await sendPopupMessage({
      type: 'CANCEL_P2P_LISTING_REVIEW',
      version: POPUP_P2P_PROTOCOL_VERSION,
      data: { reviewId: review.reviewId },
    });
  } catch {
    // The backend intent remains harmless and expires independently. The local
    // opaque handle is already gone, so it cannot be confirmed from this popup.
  }
}

async function confirmP2PReview(): Promise<void> {
  const review = p2pReview;
  if (!review) return;
  let refreshAfter = false;
  p2pBusy = true;
  clearNotice();
  renderP2P();
  try {
    const response = await sendPopupMessage({
      type: 'CONFIRM_P2P_LISTING',
      version: POPUP_P2P_PROTOCOL_VERSION,
      data: { reviewId: review.reviewId },
    }, 15_000);
    if (!isRecord(response) || response.success !== true ||
        response.action !== review.action || typeof response.listingId !== 'string') {
      throw new Error('P2P_INVALID_BACKEND_RESPONSE');
    }
    p2pReview = null;
    refreshAfter = true;
    showNotice(
      review.action === 'create' ? 'P2P listing published.' : 'P2P listing unpublished.',
      'success',
    );
  } catch (error) {
    if (isTerminalP2PConfirmError(error)) {
      p2pReview = null;
      refreshAfter = true;
      showNotice(p2pFailureText(error), 'error');
    } else {
      // The result may have committed before the response was lost. Keep the
      // opaque review handle and retry the same intent/idempotency binding;
      // never create a fresh listing intent for an ambiguous result.
      p2pReview = review;
      p2pSummaryText = 'Commit result is unknown. Retry Confirm to reuse the same one-time intent and idempotency key.';
      showNotice('Could not verify the commit result. You can safely retry Confirm before this review expires.', 'warning');
    }
  } finally {
    p2pBusy = false;
    renderP2P();
  }
  if (refreshAfter) await loadP2PAssets();
}

async function refreshPrices(): Promise<void> {
  const button = element<HTMLButtonElement>('#refresh-prices-btn');
  clearNotice();
  button.disabled = true;
  button.textContent = 'Refreshing…';

  const result = await sendTypedMessage({ type: 'REFRESH_PRICES' }, 30_000);
  if (result.ok && result.value.success) {
    showNotice(`Loaded ${result.value.count.toLocaleString()} price rows.`, 'success');
    await loadPriceStatus();
  } else {
    showNotice('Price refresh failed. Existing cached prices were kept.', 'error');
  }
  button.disabled = false;
  button.textContent = 'Refresh';
}

async function loadPriceStatus(): Promise<void> {
  const result = await sendTypedMessage({ type: 'GET_PRICE_ENGINE_STATUS' });
  if (!result.ok) {
    setText('#prices-count', 'Price data: —');
    setText('#prices-updated', 'Cache status unavailable');
    return;
  }
  setText('#prices-count', `Price data: ${result.value.count.toLocaleString()}`);
  setText('#prices-updated', result.value.lastFetched
    ? `Updated ${timeAgo(result.value.lastFetched)}`
    : 'Never fetched');
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

  element<HTMLInputElement>('#sync-preferences-toggle').addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    void (async () => {
      const saved = await updateSettings({ followCsboardSettings: enabled });
      if (saved && enabled) await syncPreferencesNow();
    })();
  });

  element<HTMLInputElement>('#csfloat-overlay-toggle').addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    void updateSettings(
      { showCsboardPricesOnCsfloat: enabled },
      { successMessage: enabled ? 'CSFloat overlay enabled.' : 'CSFloat overlay disabled.' },
    );
  });

  element<HTMLInputElement>('#betterbuff-toggle').addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    void updateSettings(
      { showBetterBuffOnBuff: enabled },
      {
        successMessage: enabled
          ? 'BetterBuff tools enabled on Buff163.'
          : 'BetterBuff tools disabled on Buff163.',
      },
    );
  });

  element<HTMLButtonElement>('#sync-preferences-btn').addEventListener('click', () => {
    void syncPreferencesNow();
  });

  element<HTMLFormElement>('#pair-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = element<HTMLInputElement>('#pairing-code-input');
    const code = input.value.trim().toUpperCase();
    if (!/^CSF-[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){3}$/.test(code)) {
      showNotice('Enter the one-time code shown by CSFolder.', 'error');
      input.focus();
      return;
    }
    void pairDevice(code);
  });

  element<HTMLInputElement>('#portfolio-sync-toggle').addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    void updateSettings(
      { portfolioSyncEnabled: enabled },
      { successMessage: enabled ? 'Portfolio uploads enabled.' : 'Portfolio uploads paused.' },
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
  element<HTMLButtonElement>('#refresh-p2p-btn').addEventListener('click', () => {
    void loadP2PAssets();
  });
  element<HTMLSelectElement>('#p2p-asset-select').addEventListener('change', (event) => {
    selectedP2PAssetId = (event.currentTarget as HTMLSelectElement).value;
    element<HTMLInputElement>('#p2p-price-input').value = '';
    renderP2P();
  });
  element<HTMLButtonElement>('#review-p2p-btn').addEventListener('click', () => {
    void prepareP2PReview();
  });
  element<HTMLButtonElement>('#confirm-p2p-btn').addEventListener('click', () => {
    void confirmP2PReview();
  });
  element<HTMLButtonElement>('#cancel-p2p-review-btn').addEventListener('click', () => {
    void cancelP2PReview();
  });
  element<HTMLButtonElement>('#refresh-prices-btn').addEventListener('click', () => {
    void refreshPrices();
  });
}

async function init(): Promise<void> {
  const loginButton = element<HTMLAnchorElement>('#login-btn');
  loginButton.href = SITE_BASE;
  bindEvents();
  renderSettings();
  renderPortfolio();
  renderP2P();

  await Promise.allSettled([
    checkAuth(),
    loadSettings(),
    loadPortfolioStatus(),
    loadP2PAssets(),
    loadPriceStatus(),
  ]);
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
