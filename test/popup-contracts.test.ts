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
import { en } from '../src/shared/locales/en.ts';
import { ru } from '../src/shared/locales/ru.ts';

test('popup migration defaults preserve shipped preference sync but keep portfolio opt-in off', () => {
  assert.equal(DEFAULT_POPUP_SETTINGS.schemaVersion, 2);
  assert.equal(DEFAULT_POPUP_SETTINGS.followCsboardSettings, true);
  assert.equal(DEFAULT_POPUP_SETTINGS.showOnSteam, true);
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

/*
  A cause the user can act on, in whatever language the popup is showing.

  These codes are the difference between "sync failed" and "sign in to Steam".
  They arrive sanitized from the background and are looked up in the dictionary,
  so an untranslated one degrades to a de-cased code rather than disappearing —
  but a code shipped without a translation is still a regression, and every
  locale is checked, not just English.
*/
test('portfolio sync diagnostics distinguish auth, Steam availability, and partial history', () => {
  const source = readFileSync(new URL('../src/popup/popup.ts', import.meta.url), 'utf8');

  for (const code of [
    'STEAM_SESSION_REQUIRED',
    'STEAM_ACCOUNT_MISMATCH',
    'STEAM_RATE_LIMITED',
    'STEAM_UNAVAILABLE',
    'STEAM_RESPONSE_INVALID',
    'TRADE_HISTORY_TRUNCATED',
    'OVERSIZED_RECORDS_DROPPED',
  ]) {
    for (const [locale, dictionary] of [['en', en], ['ru', ru]] as const) {
      const message = (dictionary as Record<string, string>)[`code.${code}`];
      assert.ok(message && message.length > 0, `${locale} is missing code.${code}`);
    }
  }

  assert.match(source, /const key = `code\.\$\{safeCode\}`;/);
  assert.match(source, /warningCodes\.has\('OVERSIZED_RECORDS_DROPPED'\)/);
  // Partial trade history has its own notice: "finished" and "finished, but
  // only the newest rows" are different facts for someone reconciling a book.
  assert.match(source, /t\('notice\.syncTruncated'\)/);
  assert.match(en['notice.syncTruncated'], /newest records only/i);
});

/*
  Russian is typed against English, so a missing key is a compile error rather
  than a raw key id in the panel. This is the runtime half of that: an entry
  that exists but is empty type-checks and renders as blank UI.
*/
test('every message has a non-empty string in every shipped locale', () => {
  const keys = Object.keys(en);
  assert.ok(keys.length > 0);
  assert.deepEqual(Object.keys(ru).sort(), keys.slice().sort());

  for (const [locale, dictionary] of [['en', en], ['ru', ru]] as const) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', `${locale}.${key} is not a string`);
      assert.ok((value as string).trim().length > 0, `${locale}.${key} is empty`);
    }
  }
});

/*
  Placeholders are the one part of a translation that is not free text: a
  `{count}` dropped in Russian renders a sentence with a hole where the number
  belongs, and nothing else in the pipeline notices.
*/
test('placeholders survive translation', () => {
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  for (const [key, english] of Object.entries(en)) {
    assert.deepEqual(
      placeholders((ru as Record<string, string>)[key] ?? ''),
      placeholders(english),
      `ru.${key} does not carry the same placeholders as English`,
    );
  }
});

test('the popup no longer offers P2P listing: publishing lives on the site and in the app', () => {
  const html = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/popup/popup.ts', import.meta.url), 'utf8');
  const contracts = readFileSync(new URL('../src/popup/contracts.ts', import.meta.url), 'utf8');
  const worker = readFileSync(
    new URL('../src/background/service-worker.ts', import.meta.url),
    'utf8',
  );

  // The panel, its controls and its message types are gone together. A popup
  // that still asked for eligibility while the section was deleted would burn
  // a request on every open and log a missing-element error.
  for (const marker of [/p2p-asset-select/, /p2p-price-input/, /review-p2p-btn/, /confirm-p2p-btn/]) {
    assert.doesNotMatch(html, marker);
  }
  for (const artifact of [source, contracts, worker]) {
    assert.doesNotMatch(
      artifact,
      /GET_P2P_ELIGIBLE_ASSETS|PREPARE_P2P_LISTING|CONFIRM_P2P_LISTING|CANCEL_P2P_LISTING_REVIEW/,
    );
  }

  // The sync section is what the popup keeps, and it must be untouched.
  assert.match(html, /id="sync-portfolio-btn"/);
  assert.match(source, /type: 'RUN_MANUAL_SYNC'/);
});
