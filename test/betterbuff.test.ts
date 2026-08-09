import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildBuffShareUrl,
  classifyBuffApiUrl,
  computeBuffListingDifference,
  formatBuffRelativeAge,
  normalizeBuffInterceptEvent,
} from '../src/shared/buff-enhancer.ts';
import {
  buildBuffActionLinks,
  convertCnyToCurrency,
  extractBuffApiModels,
  resolveLocalReferencePrice,
} from '../src/content-scripts/buff/model.ts';

test('Buff API classifier accepts only HTTPS Buff endpoints used by the enhancer', () => {
  assert.equal(
    classifyBuffApiUrl('https://buff.163.com/api/market/goods/sell_order?game=csgo'),
    'sell_order',
  );
  assert.equal(
    classifyBuffApiUrl('https://buff.163.com/api/market/goods/buy_order?game=csgo'),
    'buy_order',
  );
  assert.equal(
    classifyBuffApiUrl('https://buff.163.com/api/market/goods?game=csgo&page_num=1'),
    'market_goods',
  );
  assert.equal(
    classifyBuffApiUrl('https://buff.163.com/api/market/shop/U123/sell_order'),
    'shop_sell_order',
  );
  assert.equal(classifyBuffApiUrl('http://buff.163.com/api/market/goods'), null);
  assert.equal(classifyBuffApiUrl('https://evil.example/api/market/goods'), null);
  assert.equal(classifyBuffApiUrl('https://buff.163.com/api/user/info'), null);
  assert.equal(classifyBuffApiUrl('not a url'), null);
});

test('Buff interceptor boundary rejects wrong versions, hosts, failures, and oversized bodies', () => {
  const valid = normalizeBuffInterceptEvent({
    version: 1,
    status: 200,
    url: 'https://buff.163.com/api/market/goods/sell_order?game=csgo',
    data: { data: { items: [] } },
  });
  assert.equal(valid?.kind, 'sell_order');

  assert.equal(normalizeBuffInterceptEvent({ ...valid, version: 2 }), null);
  assert.equal(normalizeBuffInterceptEvent({
    version: 1,
    status: 200,
    url: 'https://evil.example/api/market/goods/sell_order',
    data: {},
  }), null);
  assert.equal(normalizeBuffInterceptEvent({
    version: 1,
    status: 500,
    url: 'https://buff.163.com/api/market/goods/sell_order',
    data: {},
  }), null);
  assert.equal(normalizeBuffInterceptEvent({
    version: 1,
    status: 200,
    url: 'https://buff.163.com/api/market/goods/sell_order',
    data: { text: 'x'.repeat(1_500_001) },
  }), null);
  assert.equal(normalizeBuffInterceptEvent({
    version: 1,
    status: 200,
    url: 'https://buff.163.com/api/market/goods/sell_order',
    // This is below the JavaScript code-unit cap but above 1.5 MB in UTF-8.
    data: { text: '😀'.repeat(500_000) },
  }), null);
});

test('listing age follows minute, hour, and day boundaries without future negatives', () => {
  const now = Date.UTC(2026, 7, 8, 12, 0, 0);
  assert.equal(formatBuffRelativeAge(Math.floor((now - 59_000) / 1_000), now), 'just now');
  assert.equal(formatBuffRelativeAge(Math.floor((now - 60_000) / 1_000), now), '1m ago');
  assert.equal(formatBuffRelativeAge(Math.floor((now - 119 * 60_000) / 1_000), now), '119m ago');
  assert.equal(formatBuffRelativeAge(Math.floor((now - 120 * 60_000) / 1_000), now), '2h ago');
  assert.equal(formatBuffRelativeAge(Math.floor((now - 49 * 3_600_000) / 1_000), now), '2d ago');
  assert.equal(formatBuffRelativeAge(Math.floor((now + 60_000) / 1_000), now), 'just now');
});

test('listing difference has explicit reference and finite percentage math', () => {
  assert.deepEqual(computeBuffListingDifference(90, 100), {
    differenceCny: -10,
    percentage: -10,
    direction: 'cheaper',
  });
  assert.deepEqual(computeBuffListingDifference(110, 100), {
    differenceCny: 10,
    percentage: 10,
    direction: 'more_expensive',
  });
  assert.equal(computeBuffListingDifference(Number.NaN, 100), null);
  assert.equal(computeBuffListingDifference(100, 0), null);
});

test('Buff share URLs are HTTPS, canonical, and reject malformed identifiers', () => {
  assert.equal(
    buildBuffShareUrl({
      goodsId: '123',
      classId: '456',
      instanceId: '0',
      assetId: '789',
      sellOrderId: 'abc-123',
    }),
    'https://buff.163.com/goods/123?appid=730&classid=456&instanceid=0&assetid=789&contextid=2&sell_order_id=abc-123',
  );
  assert.equal(buildBuffShareUrl({
    goodsId: 'javascript:alert(1)',
    classId: '456',
    instanceId: '0',
    assetId: '789',
    sellOrderId: 'abc',
  }), null);
});

test('real Buff sell-order shapes produce exact safe actions and never guess a bargain floor', () => {
  const payload = {
    data: {
      goods_infos: {
        123: {
          market_hash_name: '★ StatTrak™ Karambit | Doppler (Factory New)',
          tags: {
            type: { category: 'Type', localized_tag_name: 'Knife' },
            wear: { category: 'Exterior', localized_tag_name: 'Factory New' },
          },
        },
      },
      items: [{
        id: 'order-1',
        goods_id: 123,
        price: '100.50',
        created_at: 1_754_650_000,
        allow_bargain: true,
        lowest_bargain_price: '80.25',
        asset_info: {
          assetid: '789',
          classid: '456',
          instanceid: '0',
          paintwear: '0.0212',
          info: { paintindex: 415, paintseed: 246 },
        },
      }],
    },
  };
  const model = extractBuffApiModels(
    'sell_order',
    payload,
    'https://buff.163.com/api/market/goods/sell_order?game=csgo&goods_id=123',
  ).items[0]!;
  assert.equal(model.allowBargain, true);
  assert.equal(model.lowestBargainPriceCny, 80.25);
  const links = buildBuffActionLinks(model);
  assert.match(links.share ?? '', /^https:\/\/buff\.163\.com\/goods\/123\?/u);
  const csfloat = new URL(links.csfloat!);
  assert.equal(csfloat.searchParams.get('category'), '2');
  assert.equal(csfloat.searchParams.get('min_float'), '0');
  assert.equal(csfloat.searchParams.get('max_float'), '0.03');

  const noServerPermission = extractBuffApiModels('sell_order', {
    data: {
      goods_infos: payload.data.goods_infos,
      items: [{ ...payload.data.items[0], allow_bargain: false }],
    },
  }).items[0]!;
  assert.equal(noServerPermission.allowBargain, false);
  assert.equal(noServerPermission.lowestBargainPriceCny, null);
});

test('market-search nested tags and local cached prices retain their exact units', () => {
  const model = extractBuffApiModels('market_goods', {
    data: {
      items: [{
        id: 321,
        market_hash_name: 'Crimson Web (Field-Tested)',
        sell_min_price: '500',
        goods_info: {
          info: {
            tags: {
              type: { category: 'Type', localized_tag_name: 'Gloves' },
              wear: { category: 'Exterior', localized_tag_name: 'Field-Tested' },
            },
          },
        },
      }],
    },
  }).items[0]!;
  assert.equal(model.tags.some((tag) => tag.localized_tag_name === 'Gloves'), true);

  assert.equal(convertCnyToCurrency(70, 'EUR', { CNY: 7, EUR: 0.9 }), 9);
  assert.deepEqual(resolveLocalReferencePrice('Crimson Web (Field-Tested)', {
    currency: 'EUR',
    priceSource: 'buff163',
    exchangeRates: { CNY: 7, EUR: 0.9 },
    allPrices: { 'Crimson Web (Field-Tested)': { b: 10_000 } },
    csboardPrices: {},
  }), {
    cny: 700,
    source: 'buff163',
    usdCents: 10_000,
  });
});

test('manifest exposes only the scoped Buff surface and keeps broad permissions absent', () => {
  const manifest = JSON.parse(readFileSync(
    new URL('../src/manifest.json', import.meta.url),
    'utf8',
  )) as {
    permissions?: string[];
    host_permissions?: string[];
    content_scripts?: Array<{ matches?: string[]; js?: string[]; run_at?: string }>;
    web_accessible_resources?: Array<{ resources?: string[]; matches?: string[] }>;
  };

  assert.equal(manifest.permissions?.includes('tabs'), false);
  assert.equal(manifest.permissions?.includes('cookies'), false);
  assert.deepEqual(
    manifest.host_permissions?.filter((value) => value.includes('buff.163.com')),
    ['https://buff.163.com/*', 'https://*.buff.163.com/*'],
  );
  const content = manifest.content_scripts?.find((entry) =>
    entry.js?.includes('src/content-scripts/buff/buff.ts'));
  assert.equal(content?.run_at, 'document_start');
  assert.deepEqual(content?.matches, [
    'https://buff.163.com/*',
    'https://*.buff.163.com/*',
  ]);
  const resource = manifest.web_accessible_resources?.find((entry) =>
    entry.resources?.includes('injectToPage/buffInterceptor.js'));
  assert.deepEqual(resource?.matches, [
    'https://buff.163.com/*',
    'https://*.buff.163.com/*',
  ]);
});
