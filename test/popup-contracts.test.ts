import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_POPUP_SETTINGS,
  POPUP_PORTFOLIO_PROTOCOL_VERSION,
  POPUP_SETTINGS_SCHEMA_VERSION,
  SUPPORTED_CURRENCIES,
  SUPPORTED_PRICE_SOURCES,
  isSupportedCurrency,
  isSupportedPriceSource,
  type PopupInternalRequest,
} from '../src/popup/contracts.ts';

test('popup migration defaults preserve shipped preference sync but keep portfolio opt-in off', () => {
  assert.equal(DEFAULT_POPUP_SETTINGS.schemaVersion, 2);
  assert.equal(DEFAULT_POPUP_SETTINGS.followCsboardSettings, true);
  assert.equal(DEFAULT_POPUP_SETTINGS.showCsboardPricesOnCsfloat, true);
  assert.equal(DEFAULT_POPUP_SETTINGS.showBetterBuffOnBuff, false);
  assert.equal(DEFAULT_POPUP_SETTINGS.portfolioSyncEnabled, false);
  assert.deepEqual(DEFAULT_POPUP_SETTINGS.portfolioSources, {
    inventory: false,
    tradeOffers: false,
    tradeHistory: false,
    marketHistory: false,
  });
});

test('popup allowlists expose only price-engine sources and currencies', () => {
  assert.equal(SUPPORTED_PRICE_SOURCES.includes('buff163'), true);
  assert.equal(SUPPORTED_PRICE_SOURCES.includes('csfloat'), true);
  assert.equal((SUPPORTED_PRICE_SOURCES as readonly string[]).includes('csboard'), false);
  assert.equal(isSupportedPriceSource('lisskins'), true);
  assert.equal(isSupportedPriceSource('CSBOARD'), false);

  assert.equal(SUPPORTED_CURRENCIES.includes('USD'), true);
  assert.equal(isSupportedCurrency('EUR'), true);
  assert.equal(isSupportedCurrency('BTC'), false);
});

test('portfolio and pairing commands are explicitly versioned internal messages', () => {
  const messages: PopupInternalRequest[] = [
    { type: 'GET_EXTENSION_SETTINGS', version: POPUP_SETTINGS_SCHEMA_VERSION },
    { type: 'GET_PORTFOLIO_SYNC_STATUS', version: POPUP_PORTFOLIO_PROTOCOL_VERSION },
    {
      type: 'PAIR_DEVICE',
      version: POPUP_PORTFOLIO_PROTOCOL_VERSION,
      data: { code: 'PAIR-123456' },
    },
    { type: 'UNPAIR_DEVICE', version: POPUP_PORTFOLIO_PROTOCOL_VERSION },
    { type: 'RUN_MANUAL_SYNC', version: POPUP_PORTFOLIO_PROTOCOL_VERSION },
  ];

  assert.deepEqual(messages.map((message) => message.type), [
    'GET_EXTENSION_SETTINGS',
    'GET_PORTFOLIO_SYNC_STATUS',
    'PAIR_DEVICE',
    'UNPAIR_DEVICE',
    'RUN_MANUAL_SYNC',
  ]);
});

test('accepted-offer enrichment follows trade-history consent and stays out of popup controls', () => {
  const worker = readFileSync(
    new URL('../src/background/service-worker.ts', import.meta.url),
    'utf8',
  );
  const popup = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');

  assert.match(
    worker,
    /tradeOffers:\s*settings\.portfolioSyncEnabled\s*&&\s*settings\.portfolioSources\.tradeHistory/,
  );
  assert.doesNotMatch(worker, /tradeOffers: result\.offers/);
  assert.doesNotMatch(popup, /data-source="tradeOffers"/);
  assert.doesNotMatch(popup, /id="source-trade-offers-status"/);
});

test('portfolio sync diagnostics distinguish auth, Steam availability, and partial history', () => {
  const source = readFileSync(new URL('../src/popup/popup.ts', import.meta.url), 'utf8');

  for (const code of [
    'STEAM_SESSION_REQUIRED',
    'STEAM_ACCOUNT_MISMATCH',
    'STEAM_RATE_LIMITED',
    'STEAM_UNAVAILABLE',
    'STEAM_RESPONSE_INVALID',
    'TRADE_HISTORY_TRUNCATED',
  ]) {
    assert.match(source, new RegExp(`${code}:`));
  }
  assert.match(source, /Trade History was partially synced/);
  assert.match(source, /newest records were uploaded; older records were not included in this run/);
  assert.match(source, /warningCodes\.has\('OVERSIZED_RECORDS_DROPPED'\)/);
});

test('P2P listing UI requires distinct review and confirm clicks and exposes ineligibility reasons', () => {
  const html = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/popup/popup.ts', import.meta.url), 'utf8');

  assert.match(html, /id="p2p-asset-select"/);
  assert.match(html, /id="p2p-price-input"/);
  assert.match(html, /id="p2p-reasons"/);
  assert.match(html, /id="review-p2p-btn"/);
  assert.match(html, /id="confirm-p2p-btn"/);
  assert.match(source, /type: 'PREPARE_P2P_LISTING'/);
  assert.match(source, /type: 'CONFIRM_P2P_LISTING'/);
  assert.doesNotMatch(source, /P2P_(?:BUY|ORDER|STEAM)/);
});
