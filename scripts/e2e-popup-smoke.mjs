#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const playwrightImport = process.env.CSBOARD_PLAYWRIGHT_IMPORT || 'playwright';
const { chromium } = await import(playwrightImport);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const sourceRoot = join(projectRoot, 'src');
const popupBuildDir = join(projectRoot, 'build', 'popup');
const popupFiles = ['popup.html', 'popup.js', 'popup.css'];
const screenshotPath = join(projectRoot, 'artifacts', 'e2e', 'popup-p2p-smoke.png');
const unpairedScreenshotPath = join(projectRoot, 'artifacts', 'e2e', 'popup-repairing-smoke.png');
const failureScreenshotPath = join(projectRoot, 'artifacts', 'e2e', 'popup-p2p-smoke-failure.png');

const fixture = Object.freeze({
  assetId: 'asset:730:2:e2e_123456789',
  assetRevision: 'asset_rev_e2e_20260807',
  listingId: 'p2p_listing_e2e_001',
  marketHashName: '★ Karambit | Doppler (Factory New)',
  pairingCode: 'CSF-2345-6789-ABCD-EFGH',
  rePairingCode: 'CSF-3456-789A-BCDE-FGHJ',
  priceInput: '1234.56',
  priceMinor: 123_456,
  reviewId: 'review_e2e_00000001',
  steamId: '76561198000000000',
});

function walkLatestMtime(directory) {
  let latest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    latest = Math.max(
      latest,
      entry.isDirectory() ? walkLatestMtime(path) : statSync(path).mtimeMs,
    );
  }
  return latest;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function captureBuildHashes() {
  return Object.fromEntries(
    popupFiles.map((name) => [name, sha256File(join(popupBuildDir, name))]),
  );
}

function assertFreshPopupBuild() {
  for (const name of popupFiles) {
    const path = join(popupBuildDir, name);
    assert.ok(existsSync(path), `Missing ${path}; run npm run build first`);
    assert.ok(statSync(path).size > 0, `Built popup file is empty: ${path}`);
  }

  const oldestPopupOutput = Math.min(
    ...popupFiles.map((name) => statSync(join(popupBuildDir, name)).mtimeMs),
  );
  const newestSource = walkLatestMtime(sourceRoot);
  assert.ok(
    oldestPopupOutput >= newestSource,
    'The build is older than extension source; run npm run build after concurrent edits finish',
  );

  const html = readFileSync(join(popupBuildDir, 'popup.html'), 'utf8');
  assert.match(html, /<script[^>]+src=["']popup\.js["']/u);
  assert.doesNotMatch(html, /popup\.ts/u);
  assert.match(readFileSync(join(popupBuildDir, 'popup.js'), 'utf8'), /GET_P2P_ELIGIBLE_ASSETS/u);
}

function inlineBuiltPopup() {
  let html = readFileSync(join(popupBuildDir, 'popup.html'), 'utf8');
  const css = readFileSync(join(popupBuildDir, 'popup.css'), 'utf8')
    .replaceAll('</style', '<\\/style');
  const javascript = readFileSync(join(popupBuildDir, 'popup.js'), 'utf8')
    .replaceAll('</script', '<\\/script');

  const originalHtml = html;
  html = html.replace(
    /<link\s+rel=["']stylesheet["']\s+href=["']popup\.css["']\s*\/?>/u,
    () => `<style data-e2e-built-resource="popup.css">${css}</style>`,
  );
  html = html.replace(
    /<script\s+type=["']module["']\s+src=["']popup\.js["']\s*><\/script>/u,
    () => `<script type="module" data-e2e-built-resource="popup.js">${javascript}</script>`,
  );
  assert.notEqual(html, originalHtml, 'Built popup resources were not inlined');
  assert.doesNotMatch(html, /(?:href|src)=["']popup\.(?:css|js)["']/u);
  return html;
}

class PopupPage {
  constructor(page) {
    this.page = page;
    this.connectionLabel = page.locator('#connection-label');
    this.currency = page.locator('#currency-select');
    this.priceSource = page.locator('#price-source-select');
    this.betterBuff = page.locator('#betterbuff-toggle');
    this.priceCount = page.locator('#prices-count');
    this.pairForm = page.locator('#pair-form');
    this.pairCode = page.locator('#pairing-code-input');
    this.pairButton = page.locator('#pair-device-btn');
    this.pairingHelp = page.locator('#pair-form a.text-button');
    this.portfolioSummary = page.locator('#portfolio-summary');
    this.portfolioToggle = page.locator('#portfolio-sync-toggle');
    this.inventorySource = page.locator('#source-inventory');
    this.tradeHistorySource = page.locator('#source-trade-history');
    this.syncPortfolioButton = page.locator('#sync-portfolio-btn');
    this.unpairButton = page.locator('#unpair-device-btn');
    this.assetSelect = page.locator('#p2p-asset-select');
    this.price = page.locator('#p2p-price-input');
    this.reviewButton = page.locator('#review-p2p-btn');
    this.review = page.locator('#p2p-review');
    this.reviewAction = page.locator('#p2p-review-action');
    this.reviewItem = page.locator('#p2p-review-item');
    this.reviewPrice = page.locator('#p2p-review-price');
    this.reviewTerms = page.locator('#p2p-review-terms');
    this.confirmButton = page.locator('#confirm-p2p-btn');
    this.notice = page.locator('#popup-notice');
  }

  async waitForInitialState() {
    await this.page.waitForFunction(
      (assetId) => {
        const select = document.querySelector('#p2p-asset-select');
        const badge = document.querySelector('#p2p-state-badge');
        return select instanceof HTMLSelectElement &&
          select.value === assetId &&
          !select.disabled &&
          badge?.textContent === 'Ready';
      },
      fixture.assetId,
    );
    await this.connectionLabel.waitFor({ state: 'visible' });
    await this.pairForm.waitFor({ state: 'visible' });
  }

  async pair(code = fixture.pairingCode) {
    await this.pairCode.fill(code);
    await this.pairButton.click();
    await this.page.waitForFunction(
      () => document.querySelector('#portfolio-summary')?.textContent?.startsWith('Paired.'),
    );
  }

  async enablePortfolioSources() {
    await this.portfolioToggle.check();
    await this.page.waitForFunction(() => {
      const input = document.querySelector('#source-inventory');
      return input instanceof HTMLInputElement && !input.disabled;
    });
    await this.inventorySource.check();
    await this.page.waitForFunction(() => {
      const input = document.querySelector('#source-trade-history');
      return input instanceof HTMLInputElement && !input.disabled;
    });
    await this.tradeHistorySource.check();
    await this.page.waitForFunction(() => {
      const button = document.querySelector('#sync-portfolio-btn');
      return button instanceof HTMLButtonElement && !button.disabled;
    });
  }

  async syncPortfolio(expectedRunCount) {
    await this.syncPortfolioButton.click();
    await this.page.waitForFunction(
      (runCount) => window.__CSBOARD_E2E__?.state.syncRunCount === runCount &&
        document.querySelector('#popup-notice')?.textContent === 'Manual portfolio sync finished.',
      expectedRunCount,
    );
  }

  async unpair() {
    await this.unpairButton.click();
    await this.pairForm.waitFor({ state: 'visible' });
    await this.page.waitForFunction(
      () => document.querySelector('#portfolio-summary')?.textContent?.startsWith('Pair with a one-time code'),
    );
  }

  async requestReview() {
    await this.price.fill(fixture.priceInput);
    await this.reviewButton.click();
    await this.review.waitFor({ state: 'visible' });
  }

  async confirmPublish() {
    await this.confirmButton.click();
    await this.page.waitForFunction(
      (listingId) => {
        const select = document.querySelector('#p2p-asset-select');
        const option = select instanceof HTMLSelectElement ? select.selectedOptions[0] : null;
        return option?.textContent?.startsWith('[Listed] ') &&
          document.querySelector('#popup-notice')?.textContent === 'P2P listing published.' &&
          document.querySelector('#review-p2p-btn')?.textContent === 'Review unpublish' &&
          window.__CSBOARD_E2E__?.state.listingId === listingId;
      },
      fixture.listingId,
    );
  }
}

async function installChromeStub(context) {
  await context.addInitScript((data) => {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const state = {
      calls: [],
      listed: false,
      listingId: null,
      paired: false,
      lastAttemptedAt: null,
      lastSuccessfulAt: null,
      syncRunCount: 0,
    };

    let settings = {
      schemaVersion: 2,
      currency: 'USD',
      priceSource: 'buff163',
      followCsboardSettings: true,
      showCsboardPricesOnCsfloat: true,
      showBetterBuffOnBuff: false,
      // Model stale consent left behind by an interrupted/failed unpair. The
      // production worker clears it before every successful new pairing.
      portfolioSyncEnabled: true,
      portfolioSources: {
        inventory: true,
        tradeOffers: false,
        tradeHistory: true,
        marketHistory: false,
      },
    };

    const sourceStatus = (source) => {
      const enabled = settings.portfolioSources[source] === true;
      return {
        enabled,
        state: enabled ? (state.syncRunCount > 0 ? 'success' : 'idle') : 'disabled',
        records: enabled && state.syncRunCount > 0
          ? (source === 'inventory' ? 300 : 40)
          : 0,
        lastAttemptedAt: enabled ? state.lastAttemptedAt : null,
        lastSuccessfulAt: enabled ? state.lastSuccessfulAt : null,
      };
    };

    const portfolioStatus = () => ({
      connectionState: state.paired ? 'paired' : 'unpaired',
      steamId: state.paired ? data.steamId : null,
      paused: false,
      sources: {
        inventory: sourceStatus('inventory'),
        tradeOffers: { enabled: false, state: 'disabled' },
        tradeHistory: sourceStatus('tradeHistory'),
        marketHistory: { enabled: false, state: 'disabled' },
      },
      lastAttemptedAt: state.lastAttemptedAt,
      lastSuccessfulAt: state.lastSuccessfulAt,
      queuedRecords: 0,
      retryAt: null,
    });

    const eligibleAssets = () => ({
      assets: [{
        operationalAssetId: data.assetId,
        assetRevision: data.assetRevision,
        marketHashName: data.marketHashName,
        contextId: '2',
        eligibility: !state.listed,
        reasons: state.listed
          ? [{ code: 'already_listed', message: 'This asset already has a listing.' }]
          : [],
        listingId: state.listed ? data.listingId : null,
        listingState: state.listed ? 'active' : null,
        currency: 'USD',
        snapshotCompletedAt: new Date(Date.now() - 60_000).toISOString(),
      }],
    });

    const responseFor = (message) => {
      switch (message?.type) {
        case 'GET_AUTH_STATUS':
          return {
            isLoggedIn: true,
            user: {
              id: 'user_e2e',
              steamId: data.steamId,
              name: 'Popup E2E User',
              avatar: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32"%3E%3Crect width="32" height="32" rx="16" fill="%234f8ef7"/%3E%3C/svg%3E',
              isPremium: true,
              balance: 0,
              frozenBalance: 0,
            },
          };
        case 'GET_EXTENSION_SETTINGS':
          return {
            settings,
            sync: { state: 'success', lastSyncedAt: Date.now() - 30_000 },
          };
        case 'UPDATE_EXTENSION_SETTINGS':
          settings = {
            ...settings,
            ...(message.data?.patch ?? {}),
            portfolioSources: message.data?.patch?.portfolioSources
              ? { ...settings.portfolioSources, ...message.data.patch.portfolioSources }
              : settings.portfolioSources,
          };
          return {
            success: true,
            settings,
            sync: { state: 'success', lastSyncedAt: Date.now() },
          };
        case 'GET_PRICE_ENGINE_STATUS':
          return {
            loaded: true,
            count: 42,
            lastFetched: Date.now() - 15_000,
            currency: 'USD',
            priceSource: 'buff163',
          };
        case 'REFRESH_PRICES':
          return { success: true, count: 42 };
        case 'GET_PORTFOLIO_SYNC_STATUS':
          return { status: portfolioStatus() };
        case 'PAIR_DEVICE':
          if (![data.pairingCode, data.rePairingCode].includes(message.data?.code)) {
            return { error: 'PAIR_CODE_MISMATCH' };
          }
          settings = {
            ...settings,
            portfolioSyncEnabled: false,
            portfolioSources: {
              inventory: false,
              tradeOffers: false,
              tradeHistory: false,
              marketHistory: false,
            },
          };
          state.paired = true;
          return { status: portfolioStatus() };
        case 'UNPAIR_DEVICE':
          state.paired = false;
          state.lastAttemptedAt = null;
          state.lastSuccessfulAt = null;
          state.syncRunCount = 0;
          settings = {
            ...settings,
            portfolioSyncEnabled: false,
            portfolioSources: {
              inventory: false,
              tradeOffers: false,
              tradeHistory: false,
              marketHistory: false,
            },
          };
          return { status: portfolioStatus() };
        case 'RUN_MANUAL_SYNC': {
          if (!state.paired || !settings.portfolioSyncEnabled ||
              !Object.values(settings.portfolioSources).some(Boolean)) {
            return { error: 'E2E_SYNC_PRECONDITION_FAILED' };
          }
          state.syncRunCount += 1;
          state.lastAttemptedAt = Date.now();
          state.lastSuccessfulAt = state.lastAttemptedAt;
          return { status: portfolioStatus() };
        }
        case 'GET_P2P_ELIGIBLE_ASSETS':
          return eligibleAssets();
        case 'PREPARE_P2P_LISTING': {
          const request = message.data;
          if (request?.action !== 'create' ||
              request.operationalAssetId !== data.assetId ||
              request.assetRevision !== data.assetRevision ||
              request.priceMinor !== data.priceMinor || state.listed) {
            return { error: 'E2E_UNEXPECTED_PREPARE_BINDING' };
          }
          return {
            review: {
              reviewId: data.reviewId,
              action: 'create',
              operationalAssetId: data.assetId,
              assetRevision: data.assetRevision,
              marketHashName: data.marketHashName,
              listingId: null,
              priceMinor: data.priceMinor,
              currency: 'USD',
              termsVersion: 'p2p-listing-v1',
              expiresAt: Date.now() + 90_000,
            },
          };
        }
        case 'CONFIRM_P2P_LISTING':
          if (message.data?.reviewId !== data.reviewId || state.listed) {
            return { error: 'E2E_UNEXPECTED_CONFIRM_BINDING' };
          }
          state.listed = true;
          state.listingId = data.listingId;
          return { success: true, action: 'create', listingId: data.listingId };
        case 'CANCEL_P2P_LISTING_REVIEW':
          return { success: true };
        default:
          return { error: `E2E_UNHANDLED_MESSAGE_${String(message?.type)}` };
      }
    };

    const runtime = {
      id: 'csboard-popup-e2e-extension',
      lastError: undefined,
      getURL: (path = '') => `chrome-extension://csboard-popup-e2e-extension/${path}`,
      sendMessage(message, callback) {
        state.calls.push(clone(message));
        const response = responseFor(message);
        if (typeof callback === 'function') {
          queueMicrotask(() => callback(clone(response)));
        }
        return Promise.resolve(clone(response));
      },
    };

    const makeStorageArea = () => {
      const values = {};
      return {
        async get(keys) {
          if (keys == null) return clone(values);
          const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          return Object.fromEntries(names.filter((key) => key in values).map((key) => [key, clone(values[key])]));
        },
        async set(next) {
          Object.assign(values, clone(next));
        },
        async remove(keys) {
          for (const key of typeof keys === 'string' ? [keys] : keys) delete values[key];
        },
      };
    };

    Object.defineProperty(window, 'chrome', {
      configurable: false,
      value: {
        runtime,
        storage: { local: makeStorageArea(), session: makeStorageArea() },
        tabs: {
          async create(options) {
            state.calls.push({ type: '__TABS_CREATE__', data: clone(options) });
            return { id: 1, ...clone(options) };
          },
          async query() {
            return [];
          },
        },
      },
    });
    Object.defineProperty(window, '__CSBOARD_E2E__', {
      configurable: false,
      value: { state },
    });
    window.confirm = () => true;
  }, fixture);
}

async function main() {
  assertFreshPopupBuild();
  const initialBuildHashes = captureBuildHashes();
  const builtPopupDocument = inlineBuiltPopup();
  mkdirSync(dirname(screenshotPath), { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CSBOARD_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CSBOARD_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext({ viewport: { width: 520, height: 1_000 } });
  await installChromeStub(context);
  const page = await context.newPage();
  const externalRequests = [];
  const pageErrors = [];
  let passed = false;

  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });
  await context.route('**/*', async (route) => {
    externalRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });

  try {
    const popup = new PopupPage(page);
    await page.goto(
      `data:text/html;base64,${Buffer.from(builtPopupDocument).toString('base64')}`,
      { waitUntil: 'domcontentloaded' },
    );
    await popup.waitForInitialState();

    assert.equal((await popup.connectionLabel.textContent())?.trim(), 'Connected');
    assert.equal(await popup.currency.inputValue(), 'USD');
    assert.equal(await popup.priceSource.inputValue(), 'buff163');
    assert.equal(await popup.betterBuff.isChecked(), false);
    assert.equal(await popup.portfolioToggle.isChecked(), true, 'fixture must start with stale consent');
    assert.equal(await popup.inventorySource.isChecked(), true, 'fixture must start with a stale source');
    assert.equal(await popup.tradeHistorySource.isChecked(), true, 'fixture must start with a stale source');
    assert.equal((await popup.priceCount.textContent())?.trim(), 'Price data: 42');
    assert.equal(await popup.assetSelect.inputValue(), fixture.assetId);
    assert.match((await popup.assetSelect.locator('option:checked').textContent()) ?? '', /Karambit/u);
    assert.equal(
      await popup.pairingHelp.getAttribute('href'),
      'https://csfolder.com/portfolio/import?tab=csboard-extension&utm_source=csboard_extension&utm_medium=pairing',
      'Unpaired users must land on the CSFolder extension pairing tab',
    );

    await popup.betterBuff.click();
    await page.waitForFunction(() =>
      window.__CSBOARD_E2E__?.state.calls.some((call) =>
        call.type === 'UPDATE_EXTENSION_SETTINGS' &&
        call.data?.patch?.showBetterBuffOnBuff === true));
    assert.equal(await popup.betterBuff.isChecked(), true);

    await popup.pair();
    assert.equal(await popup.portfolioToggle.isChecked(), false, 'pairing must clear stale upload consent');
    assert.equal(await popup.inventorySource.isChecked(), false, 'pairing must clear stale sources');
    assert.equal(await popup.tradeHistorySource.isChecked(), false, 'pairing must clear stale sources');
    assert.equal(
      (await popup.portfolioSummary.textContent())?.trim(),
      'Paired. Portfolio uploads remain off until you enable them.',
    );
    await popup.enablePortfolioSources();
    await popup.syncPortfolio(1);
    assert.match((await page.locator('#source-inventory-status').textContent()) ?? '', /^Synced · 300 records$/u);
    assert.match((await page.locator('#source-trade-history-status').textContent()) ?? '', /^Synced · 40 records$/u);

    await popup.unpair();
    assert.equal(await popup.portfolioToggle.isChecked(), false);
    assert.equal(await popup.inventorySource.isChecked(), false);
    assert.equal(await popup.tradeHistorySource.isChecked(), false);
    assert.equal(
      await popup.pairingHelp.getAttribute('href'),
      'https://csfolder.com/portfolio/import?tab=csboard-extension&utm_source=csboard_extension&utm_medium=pairing',
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: unpairedScreenshotPath, fullPage: true });

    await popup.pair(fixture.rePairingCode);
    await popup.enablePortfolioSources();
    await popup.syncPortfolio(1);

    await popup.requestReview();
    assert.equal((await popup.reviewAction.textContent())?.trim(), 'Publish listing');
    assert.equal((await popup.reviewItem.textContent())?.trim(), fixture.marketHashName);
    assert.equal((await popup.reviewPrice.textContent())?.trim(), '$1234.56 USD');
    assert.equal((await popup.reviewTerms.textContent())?.trim(), 'p2p-listing-v1');

    const callsBeforeConfirm = await page.evaluate(() => window.__CSBOARD_E2E__.state.calls);
    assert.deepEqual(
      callsBeforeConfirm.filter((call) => call.type === 'PAIR_DEVICE'),
      [
        { type: 'PAIR_DEVICE', version: 1, data: { code: fixture.pairingCode } },
        { type: 'PAIR_DEVICE', version: 1, data: { code: fixture.rePairingCode } },
      ],
    );
    assert.equal(callsBeforeConfirm.filter((call) => call.type === 'UNPAIR_DEVICE').length, 1);
    assert.equal(callsBeforeConfirm.filter((call) => call.type === 'RUN_MANUAL_SYNC').length, 2);
    const lifecycleCalls = callsBeforeConfirm
      .filter((call) => ['PAIR_DEVICE', 'RUN_MANUAL_SYNC', 'UNPAIR_DEVICE'].includes(call.type))
      .map((call) => call.type);
    assert.deepEqual(lifecycleCalls, [
      'PAIR_DEVICE',
      'RUN_MANUAL_SYNC',
      'UNPAIR_DEVICE',
      'PAIR_DEVICE',
      'RUN_MANUAL_SYNC',
    ]);
    assert.deepEqual(
      callsBeforeConfirm.filter((call) =>
        call.type === 'UPDATE_EXTENSION_SETTINGS' &&
        call.data?.patch?.showBetterBuffOnBuff !== undefined),
      [{
        type: 'UPDATE_EXTENSION_SETTINGS',
        version: 2,
        data: { patch: { showBetterBuffOnBuff: true } },
      }],
    );
    assert.deepEqual(
      callsBeforeConfirm.filter((call) => call.type === 'PREPARE_P2P_LISTING'),
      [{
        type: 'PREPARE_P2P_LISTING',
        version: 1,
        data: {
          action: 'create',
          operationalAssetId: fixture.assetId,
          assetRevision: fixture.assetRevision,
          priceMinor: fixture.priceMinor,
        },
      }],
    );
    assert.equal(
      callsBeforeConfirm.filter((call) => call.type === 'CONFIRM_P2P_LISTING').length,
      0,
      'Review click must not commit the listing',
    );

    await popup.confirmPublish();
    await popup.notice.waitFor({ state: 'visible' });
    assert.equal((await popup.notice.textContent())?.trim(), 'P2P listing published.');

    const callsAfterConfirm = await page.evaluate(() => window.__CSBOARD_E2E__.state.calls);
    assert.deepEqual(
      callsAfterConfirm.filter((call) => call.type === 'CONFIRM_P2P_LISTING'),
      [{
        type: 'CONFIRM_P2P_LISTING',
        version: 1,
        data: { reviewId: fixture.reviewId },
      }],
    );
    assert.ok(
      callsAfterConfirm.filter((call) => call.type === 'GET_P2P_ELIGIBLE_ASSETS').length >= 2,
      'Successful confirm must refresh the listing state',
    );
    assert.deepEqual(externalRequests, [], 'Popup attempted a non-loopback network request');
    assert.deepEqual(pageErrors, [], 'Popup emitted a browser error');
    assert.deepEqual(captureBuildHashes(), initialBuildHashes, 'Popup build changed during smoke run');

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: screenshotPath, fullPage: true });
    rmSync(failureScreenshotPath, { force: true });
    passed = true;
    process.stdout.write([
      'PASS popup pairing, sync and P2P smoke',
      `artifact=${screenshotPath}`,
      `unpairedArtifact=${unpairedScreenshotPath}`,
      `messages=${callsAfterConfirm.length}`,
      'pairingLifecycle=pair-sync-unpair-repair-sync',
      'externalRequests=0',
    ].join('\n') + '\n');
  } finally {
    if (!passed && !page.isClosed()) {
      await page.screenshot({ path: failureScreenshotPath, fullPage: true }).catch(() => {});
    }
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
