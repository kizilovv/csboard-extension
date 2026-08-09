#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const builtScript = join(projectRoot, 'build', 'content', 'csfloat.js');
const sourceScript = join(projectRoot, 'src', 'content-scripts', 'csfloat', 'csfloat.ts');
const screenshotPath = join(projectRoot, 'artifacts', 'e2e', 'csfloat-listing-metadata-smoke.png');
const failureScreenshotPath = join(projectRoot, 'artifacts', 'e2e', 'csfloat-listing-metadata-smoke-failure.png');

const marketHashName = 'AK-47 | Redline (Field-Tested)';

function listing({ id, createdMinutesAgo, soldMinutesAgo = null }) {
  const now = Date.now();
  return {
    id,
    created_at: new Date(now - createdMinutesAgo * 60_000).toISOString(),
    ...(soldMinutesAgo === null
      ? { state: 'listed' }
      : {
          state: 'sold',
          sold_at: new Date(now - soldMinutesAgo * 60_000).toISOString(),
        }),
    item: {
      market_hash_name: marketHashName,
      asset_id: `asset-${id}`,
      float_value: 0.2112,
      def_index: 7,
      paint_index: 282,
    },
    price: 1_100,
    type: 'buy_now',
  };
}

function assertFreshBuild() {
  assert.ok(existsSync(builtScript), 'Missing built CSFloat content script; run npm run build');
  assert.ok(statSync(builtScript).size > 0, 'Built CSFloat content script is empty');
  assert.ok(
    statSync(builtScript).mtimeMs >= statSync(sourceScript).mtimeMs,
    'Built CSFloat script is older than its source; run npm run build',
  );
  const code = readFileSync(builtScript, 'utf8');
  assert.match(code, /csboard-listing-age/u);
  assert.match(code, /csboard-sold-status-button/u);
}

async function installExtensionStubs(context) {
  await context.addInitScript((name) => {
    const values = {
      csboard_all_prices: { [name]: { b: 1_000, bo: 900 } },
      csboard_exchange_rates: { USD: 1 },
      csboard_settings: {
        currency: 'USD',
        priceSource: 'buff163',
        showCsboardPricesOnCsfloat: false,
      },
      csboard_prices: {},
    };
    const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const listeners = [];
    Object.defineProperty(window, 'chrome', {
      configurable: false,
      value: {
        runtime: {
          getURL(path = '') {
            return path.endsWith('.js')
              ? 'data:text/javascript,void%200'
              : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
          },
        },
        storage: {
          local: {
            async get(keys) {
              const names = typeof keys === 'string'
                ? [keys]
                : Array.isArray(keys)
                  ? keys
                  : Object.keys(keys ?? values);
              return Object.fromEntries(
                names.filter((key) => key in values).map((key) => [key, clone(values[key])]),
              );
            },
            async set(next) {
              Object.assign(values, clone(next));
            },
          },
          onChanged: {
            addListener(listener) {
              listeners.push(listener);
            },
          },
        },
      },
    });
    window.fetch = async () => new Response(JSON.stringify({ usd: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }, marketHashName);
}

async function dispatchListing(page, payload) {
  await page.evaluate((value) => {
    document.dispatchEvent(new CustomEvent('csboard_api', {
      detail: {
        url: `https://csfloat.com/api/v1/listings/${value.id}`,
        data: value,
      },
    }));
  }, payload);
}

async function main() {
  assertFreshBuild();
  mkdirSync(dirname(screenshotPath), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 720, height: 520 } });
  await installExtensionStubs(context);
  const page = await context.newPage();
  const pageErrors = [];
  let passed = false;

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });

  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <head><meta charset="utf-8"><title>CSFloat metadata fixture</title></head>
        <body style="background:#10131a;color:#fff;font-family:Arial;padding:24px">
          <item-detail>
            <item-card width="100%" style="display:block;width:540px;padding:20px;background:#1b202b;border-radius:12px">
              <app-item-name>
                <div class="item-name">AK-47 | Redline</div>
                <div class="subtext">Field-Tested</div>
              </app-item-name>
              <div class="price-row"><span class="price">$11.00</span></div>
              <button class="status-button" title="Available now" disabled>
                <span class="mdc-button__label">Buy now</span>
              </button>
            </item-card>
          </item-detail>
        </body>
      </html>
    `);
    await page.addScriptTag({ path: builtScript });

    await dispatchListing(page, listing({ id: 'listing-one', createdMinutesAgo: 180, soldMinutesAgo: 30 }));
    await page.waitForFunction(() => {
      const age = document.querySelector('.csboard-listing-age')?.textContent ?? '';
      const label = document.querySelector('.status-button .mdc-button__label')?.textContent ?? '';
      return age.startsWith('Listed 3h ago') && label.startsWith('Sold 30min ago (');
    });

    const soldState = await page.evaluate(() => ({
      age: document.querySelector('.csboard-listing-age')?.textContent,
      ageCount: document.querySelectorAll('.csboard-listing-age').length,
      cardAgeCount: document.querySelectorAll('item-card .csboard-listing-age').length,
      ageAria: document.querySelector('.csboard-listing-age')?.getAttribute('aria-label'),
      status: document.querySelector('.status-button .mdc-button__label')?.textContent,
      statusTitle: document.querySelector('.status-button')?.getAttribute('title'),
      statusClass: document.querySelector('.status-button')?.classList.contains('csboard-sold-status-button'),
      lookup: document.querySelector('.csboard-csfloat-lookup')?.getAttribute('href'),
    }));
    assert.match(soldState.age ?? '', /^Listed 3h ago$/u);
    assert.equal(soldState.ageCount, 1);
    assert.equal(soldState.cardAgeCount, 1);
    assert.match(soldState.ageAria ?? '', /^Listed at /u);
    assert.match(soldState.status ?? '', /^Sold 30min ago \(/u);
    assert.match(soldState.statusTitle ?? '', /^Sold at /u);
    assert.equal(soldState.statusClass, true);
    assert.match(soldState.lookup ?? '', /sort_by=lowest_price/u);

    await dispatchListing(page, listing({ id: 'listing-two', createdMinutesAgo: 60 }));
    await page.waitForFunction(() => {
      const age = document.querySelector('.csboard-listing-age')?.textContent ?? '';
      const button = document.querySelector('.status-button');
      const label = button?.querySelector('.mdc-button__label')?.textContent ?? '';
      return age.startsWith('Listed 60min ago') &&
        label === 'Buy now' &&
        button?.getAttribute('title') === 'Available now' &&
        !button?.classList.contains('csboard-sold-status-button');
    });

    const resetState = await page.evaluate(() => ({
      age: document.querySelector('.csboard-listing-age')?.textContent,
      ageCount: document.querySelectorAll('.csboard-listing-age').length,
      cardAgeCount: document.querySelectorAll('item-card .csboard-listing-age').length,
      soldNodeCount: document.querySelectorAll('.csboard-sold-status').length,
      status: document.querySelector('.status-button .mdc-button__label')?.textContent,
      statusTitle: document.querySelector('.status-button')?.getAttribute('title'),
      statusClass: document.querySelector('.status-button')?.classList.contains('csboard-sold-status-button'),
    }));
    assert.match(resetState.age ?? '', /^Listed 60min ago$/u);
    assert.equal(resetState.ageCount, 1);
    assert.equal(resetState.cardAgeCount, 1);
    assert.equal(resetState.soldNodeCount, 0);
    assert.equal(resetState.status, 'Buy now');
    assert.equal(resetState.statusTitle, 'Available now');
    assert.equal(resetState.statusClass, false);
    assert.deepEqual(pageErrors, []);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    rmSync(failureScreenshotPath, { force: true });
    passed = true;
    process.stdout.write([
      'PASS CSFloat listing metadata smoke',
      `artifact=${screenshotPath}`,
      `sold=${soldState.status}`,
      `reset=${resetState.status}`,
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
