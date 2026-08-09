#!/usr/bin/env node

import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { chromium } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'csboard-buff-smoke-'));
const bundlePath = join(temporaryDirectory, 'buff.js');
const stagingRoot = join(temporaryDirectory, 'project');
const screenshotPath = join(projectRoot, 'artifacts', 'e2e', 'buff-smoke.png');

let browser;
try {
  // Isolate esbuild from unrelated ancestor package.json files in the shared
  // workspace, matching the production build's package-boundary strategy.
  await mkdir(stagingRoot, { recursive: true });
  await cp(join(projectRoot, 'src'), join(stagingRoot, 'src'), { recursive: true });
  await cp(join(projectRoot, 'package.json'), join(stagingRoot, 'package.json'));
  await symlink(join(projectRoot, 'node_modules'), join(stagingRoot, 'node_modules'), 'dir');

  await build({
    absWorkingDir: stagingRoot,
    bundle: true,
    entryPoints: ['src/content-scripts/buff/buff.ts'],
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    outfile: bundlePath,
    logLevel: 'silent',
    loader: { '.json': 'json' },
  });

  const bundle = await readFile(bundlePath, 'utf8');
  const stylesheet = await readFile(join(projectRoot, 'src', 'styles', 'csboard-buff.css'), 'utf8');
  await mkdir(join(projectRoot, 'artifacts', 'e2e'), { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1_180, height: 760 } });
  const externalRequests = [];
  const pageErrors = [];
  page.on('request', (request) => {
    if (/^https?:/i.test(request.url())) externalRequests.push(request.url());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setContent(`
    <!doctype html>
    <html>
      <body>
        <div class="criteria"><div class="l_Left"></div></div>
        <table><tbody>
          <tr class="selling">
            <td><a href="https://buff.163.com/goods/123?sell_order_id=order-1"><h3>AK-47 | Redline (Field-Tested)</h3></a></td>
            <td class="fixture-actions"></td>
          </tr>
        </tbody></table>
      </body>
    </html>
  `);
  await page.addStyleTag({ content: stylesheet });

  await page.evaluate(() => {
    const listeners = [];
    const privilegedCalls = [];
    const state = {
      csboard_settings: {
        currency: 'EUR',
        priceSource: 'csfloat',
        showBetterBuffOnBuff: true,
      },
      csboard_exchange_rates: { USD: 1, CNY: 7.2, EUR: 0.9 },
      csboard_all_prices: {
        'AK-47 | Redline (Field-Tested)': { cf: 10_000 },
      },
      csboard_prices: {},
    };

    globalThis.chrome = {
      runtime: {
        getURL: () => 'data:text/javascript,',
        sendMessage: (...args) => {
          privilegedCalls.push(args);
          return Promise.resolve({});
        },
      },
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.map((key) => [key, state[key]])),
        },
        onChanged: {
          addListener: (listener) => listeners.push(listener),
        },
      },
    };

    globalThis.__csboardBuffToggle = (nextEnabled) => {
      const oldValue = state.csboard_settings;
      state.csboard_settings = { ...oldValue, showBetterBuffOnBuff: nextEnabled };
      for (const listener of listeners) {
        listener({ csboard_settings: { oldValue, newValue: state.csboard_settings } }, 'local');
      }
    };
    globalThis.__csboardBuffPrivilegedCalls = privilegedCalls;
  });

  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() =>
    document.querySelector('.csboard-buff-toolbar') !== null);

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('CSBOARD_BUFF_API_RESPONSE_V1', {
      detail: {
        version: 1,
        status: 200,
        url: 'https://buff.163.com/api/market/goods/sell_order?game=csgo',
        data: {
          code: 'OK',
          data: {
            goods_infos: {
              123: {
                market_hash_name: 'AK-47 | Redline (Field-Tested)',
                steam_price_cny: '880',
              },
            },
            items: [{
              id: 'order-1',
              goods_id: 123,
              price: '760',
              created_at: Math.floor(Date.now() / 1000) - 7200,
              allow_bargain: true,
              lowest_bargain_price: '700',
              asset_info: {
                assetid: '789',
                classid: '456',
                instanceid: '0',
                paintwear: '0.18',
                info: { paintindex: 282, paintseed: 12 },
              },
            }],
          },
        },
      },
    }));
  });

  await page.waitForSelector('.csboard-buff-panel');
  const panelText = await page.locator('.csboard-buff-panel').innerText();
  assert.match(panelText, /CSBOARD · BUFF-reported/);
  assert.match(panelText, /Listed 2h ago/);
  assert.match(panelText, /Live sell \/ listing/);
  assert.match(panelText, /CSBOARD reference \(csfloat\)/);
  assert.match(panelText, /BUFF-reported floor/);

  const csfloat = page.locator('.csboard-buff-panel a', { hasText: 'CSFloat' });
  assert.equal(await csfloat.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(new URL(await csfloat.getAttribute('href')).hostname, 'csfloat.com');
  assert.deepEqual(
    await page.evaluate(() => globalThis.__csboardBuffPrivilegedCalls),
    [],
    'forgeable page events must not reach the extension message router',
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('CSBOARD_BUFF_NAVIGATION_V1', {
      detail: { version: 1, url: 'https://buff.163.com/goods/123' },
    }));
  });
  await page.waitForFunction(() => document.querySelector('.csboard-buff-panel') === null);
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('CSBOARD_BUFF_API_RESPONSE_V1', {
      detail: {
        version: 1,
        status: 200,
        url: 'https://buff.163.com/api/market/goods/sell_order?game=csgo',
        data: {
          data: {
            goods_infos: { 999: { market_hash_name: 'Forged mismatch' } },
            items: [{ id: 'wrong-order', goods_id: 999, price: '1' }],
          },
        },
      },
    }));
  });
  await page.waitForTimeout(150);
  assert.equal(
    await page.locator('.csboard-buff-panel').count(),
    0,
    'mismatched page-world economics must not attach to a row by position',
  );

  await page.evaluate(() => globalThis.__csboardBuffToggle(false));
  await page.waitForFunction(() =>
    document.querySelector('[class^="csboard-buff-"], [class*=" csboard-buff-"]') === null);

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('CSBOARD_BUFF_API_RESPONSE_V1', {
      detail: {
        version: 1,
        status: 200,
        url: 'https://buff.163.com/api/market/goods/sell_order?game=csgo',
        data: {
          data: {
            goods_infos: { 123: { market_hash_name: 'AK-47 | Redline (Field-Tested)' } },
            items: [{ id: 'order-1', goods_id: 123, price: '760' }],
          },
        },
      },
    }));
  });
  await page.waitForTimeout(150);
  assert.equal(
    await page.locator('[class^="csboard-buff-"], [class*=" csboard-buff-"]').count(),
    0,
    'disabled content script must ignore forged API events after cleanup',
  );
  assert.deepEqual(externalRequests, [], 'fixture rendering must make no HTTP(S) requests');
  assert.deepEqual(pageErrors, [], 'fixture rendering emitted a browser error');

  process.stdout.write(`Buff fixture smoke passed\nartifact=${screenshotPath}\n`);
} finally {
  await browser?.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
