import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildBuffActionLinks,
  convertCnyToCurrency,
  createStaticBuffModel,
  extractBuffApiModels,
  formatCnyWithSelected,
  resolveLocalReferencePrice,
} from '../src/content-scripts/buff/model.ts';

test('sell-order payloads retain exact asset identity, age, and server bargain floor', () => {
  const result = extractBuffApiModels('sell_order', {
    code: 'OK',
    data: {
      goods_infos: {
        123: {
          goods_id: 123,
          market_hash_name: '★ Karambit | Doppler (Factory New)',
          steam_price_cny: '7200.00',
          tags: { exterior: { category: 'Exterior', localized_tag_name: 'Factory New' } },
        },
      },
      items: [{
        id: 'order-1',
        goods_id: 123,
        price: '6800.50',
        created_at: 1_723_100_000,
        allow_bargain: true,
        lowest_bargain_price: '6500.00',
        asset_info: {
          assetid: '789',
          classid: '456',
          instanceid: '0',
          paintwear: '0.01012345',
          info: { paintindex: 418, paintseed: 321 },
        },
      }],
    },
  });

  assert.equal(result.items.length, 1);
  const item = result.items[0]!;
  assert.equal(item.name, '★ Karambit | Doppler (Factory New)');
  assert.equal(item.listingPriceCny, 6800.5);
  assert.equal(item.liveSellPriceCny, 6800.5);
  assert.equal(item.steamPriceCny, 7200);
  assert.equal(item.allowBargain, true);
  assert.equal(item.lowestBargainPriceCny, 6500);
  assert.equal(item.floatValue, 0.01012345);
  assert.equal(item.paintIndex, 418);
  assert.equal(item.paintSeed, 321);
});

test('bargain is fail-closed unless the API supplies strict true and a finite positive floor', () => {
  const cases = [
    { allow_bargain: 1, lowest_bargain_price: '80' },
    { allow_bargain: true, lowest_bargain_price: '' },
    { allow_bargain: true, lowest_bargain_price: 'Infinity' },
    { allow_bargain: true, lowest_bargain_price: '-1' },
  ];
  for (const candidate of cases) {
    const result = extractBuffApiModels('sell_order', {
      data: { items: [{ id: 'order', goods_id: 1, price: '100', ...candidate }] },
    });
    assert.equal(result.items[0]?.allowBargain, false);
    assert.equal(result.items[0]?.lowestBargainPriceCny, null);
  }
});

test('market cards keep sell, buy, BUFF reference, and Steam reference semantically separate', () => {
  const result = extractBuffApiModels('market_goods', {
    data: {
      items: [{
        id: 321,
        market_hash_name: 'AK-47 | Redline (Field-Tested)',
        sell_min_price: '88.00',
        buy_max_price: '82.50',
        sell_reference_price: '85.00',
        goods_info: {
          steam_price_cny: '110.00',
          info: {
            tags: {
              exterior: { category: 'Exterior', localized_tag_name: 'Field-Tested' },
            },
          },
        },
      }],
    },
  });
  const item = result.items[0]!;
  assert.equal(item.goodsId, '321');
  assert.equal(item.liveSellPriceCny, 88);
  assert.equal(item.liveBuyPriceCny, 82.5);
  assert.equal(item.buffReferencePriceCny, 85);
  assert.equal(item.steamPriceCny, 110);
  assert.deepEqual(item.tags, [{ category: 'Exterior', localized_tag_name: 'Field-Tested' }]);
});

test('price history summarizes only allowed price series without serializing raw points', () => {
  const result = extractBuffApiModels('price_history', {
    data: {
      currency: 'CNY',
      currency_symbol: '¥',
      days: 30,
      lines: [
        { chart_type: 'number', allow: true, points: [[1, 99_999]] },
        { chart_type: 'price', allow: true, points: [[1, 95], [2, 90], [3, 110]] },
      ],
    },
  });
  assert.deepEqual(result.priceHistory, {
    days: 30,
    latest: 110,
    minimum: 90,
    maximum: 110,
    currency: 'CNY',
    currencySymbol: '¥',
  });
});

test('CNY conversion and local reference use the exact selected source row', () => {
  const state = {
    currency: 'EUR',
    priceSource: 'csfloat',
    exchangeRates: { USD: 1, CNY: 7.2, EUR: 0.9 },
    allPrices: { 'AK-47 | Redline (Field-Tested)': { b: 10_000, cf: 12_000 } },
    csboardPrices: {},
  };
  assert.equal(convertCnyToCurrency(720, 'EUR', state.exchangeRates), 90);
  assert.equal(formatCnyWithSelected(720, 'EUR', state.exchangeRates), 'CN¥720.00 · €90.00');
  assert.deepEqual(resolveLocalReferencePrice('AK-47 | Redline (Field-Tested)', state), {
    cny: 864,
    source: 'csfloat',
    usdCents: 12_000,
  });
});

test('action links are canonical and exact share requires every credential-free identity field', () => {
  const model = createStaticBuffModel({
    goodsId: 123,
    orderId: 'order-1',
    name: '★ Karambit | Doppler (Factory New)',
    assetId: 789,
    classId: 456,
    instanceId: 0,
    floatValue: 0.0101,
    paintIndex: 418,
    paintSeed: 321,
  });
  const links = buildBuffActionLinks(model);
  assert.equal(new URL(links.csfloat!).hostname, 'csfloat.com');
  assert.equal(new URL(links.steamMarket!).hostname, 'steamcommunity.com');
  assert.equal(new URL(links.findSimilar!).hostname, 'buff.163.com');
  assert.equal(
    links.share,
    'https://buff.163.com/goods/123?appid=730&classid=456&instanceid=0&assetid=789&contextid=2&sell_order_id=order-1',
  );

  const generic = buildBuffActionLinks(createStaticBuffModel({ goodsId: 123, name: 'AK-47 | Redline' }));
  assert.equal(generic.share, null);
  assert.equal(generic.goods, 'https://buff.163.com/goods/123?from=market');
});

test('Buff DOM implementation is namespace-clean and never injects untrusted HTML or raw logging', async () => {
  const source = await readFile(new URL('../src/content-scripts/buff/buff.ts', import.meta.url), 'utf8');
  const interceptor = await readFile(new URL('../src/injectToPage/buffInterceptor.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /console\.|logger\./);
  assert.doesNotMatch(interceptor, /console\.|logger\./);
  assert.doesNotMatch(interceptor, /clone\(\)\.text\(\)/);
  assert.doesNotMatch(interceptor, /Number\([^\n]*getResponseHeader\(['"]content-length/);
  assert.doesNotMatch(interceptor, /Number\([^\n]*headers\.get\(['"]content-length/);
  assert.match(interceptor, /const declaredContentLength = \(rawValue\) =>/);
  assert.match(interceptor, /body\.getReader\(\)/);
  assert.match(interceptor, /totalBytes > MAX_JSON_BYTES/);
  assert.match(source, /if \(!enabled \|\| !\(event instanceof CustomEvent\)\) return/);
  assert.match(source, /document\.querySelectorAll\(OWNED_SELECTOR\)\.forEach\(\(node\) => node\.remove\(\)\)/);
  assert.match(source, /link\.rel = 'noopener noreferrer'/);
  assert.match(source, /CSBOARD · BUFF-reported/);
  assert.doesNotMatch(source, /rowIndex\s*>=\s*index/);

  const xhrJsonBranch = interceptor.match(
    /if \(this\.responseType === 'json'\) \{([\s\S]*?)\n\s*\}/,
  )?.[1] ?? '';
  assert.match(xhrJsonBranch, /Fail closed/);
  assert.doesNotMatch(xhrJsonBranch, /emitApiResponse|JSON\.stringify|this\.response/);
});
