import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  authorizeListingRemovalFromUserGesture,
  authorizeSellFromUserGesture,
  batchStopReasonForError,
  classifySellConfirmation,
  classifyMarketRefusalMessage,
  classifyMarketWriteHttpStatus,
  computeSellTarget,
  getSellBlockReason,
  hasIndividualPremiumRisk,
  hasDownwardPriceDrift,
  INITIAL_BATCH_SELL_STATE,
  MAX_SELL_BATCH_SIZE,
  parseReceivedAmount,
  reduceBatchSellState,
  sellTargetFromReceived,
  summarizeSellTargets,
} from '../src/shared/market-actions';
import { classifyMarketReadHttpStatus, type OrderBook } from '../src/shared/market-orders';
import {
  buyerPaysForReceived,
  DEFAULT_WALLET_FEES,
  normalizeWalletFeeInfo,
  receivedForBuyerPays,
} from '../src/shared/steam-fees';

const wallet = DEFAULT_WALLET_FEES;

function orderBook(overrides: Partial<OrderBook> = {}): OrderBook {
  return {
    marketHashName: 'AK-47 | Redline (Field-Tested)',
    itemNameId: '123',
    highestBuyOrder: 115,
    lowestSellOrder: 116,
    buyOrderCount: 1,
    fetchedAt: 1,
    ...overrides,
  };
}

test('Quick sell is exactly one wallet minor unit below the lowest ask', () => {
  const target = computeSellTarget('quick', orderBook(), wallet);
  assert.ok(target);
  assert.equal(target.buyerPays, 115);
  assert.match(target.basis, /one wallet minor unit/);

  // Quick never silently changes meaning to Instant when the ask is absent.
  assert.equal(
    computeSellTarget('quick', orderBook({ lowestSellOrder: null, highestBuyOrder: 115 }), wallet),
    null,
  );
});

test('Instant sell meets the highest standing bid', () => {
  const target = computeSellTarget('instant', orderBook(), wallet);
  assert.ok(target);
  assert.equal(target.buyerPays, 115);
  assert.match(target.basis, /highest buy order/);
  assert.equal(computeSellTarget('instant', orderBook({ highestBuyOrder: null }), wallet), null);
});

test('Editable Sell parses received amount and preserves Steam fee split', () => {
  assert.equal(parseReceivedAmount('12.34'), 1234);
  assert.equal(parseReceivedAmount('12,34'), 1234);
  assert.equal(parseReceivedAmount('1.234'), null);
  assert.equal(parseReceivedAmount('-1'), null);

  const target = sellTargetFromReceived(100, wallet);
  assert.ok(target);
  assert.equal(target.mode, 'sell');
  assert.deepEqual(target.split, {
    received: 100,
    steamFee: 5,
    publisherFee: 10,
    fees: 15,
    buyerPays: 115,
  });
});

test('Steam fee math round-trips exact representable buyer prices', () => {
  const split = buyerPaysForReceived(100, wallet);
  assert.equal(split.buyerPays, 115);
  assert.deepEqual(receivedForBuyerPays(split.buyerPays, wallet), split);

  // Steam and publisher minimum fees protect the low-price floor.
  assert.deepEqual(buyerPaysForReceived(1, wallet), {
    received: 1,
    steamFee: 1,
    publisherFee: 1,
    fees: 2,
    buyerPays: 3,
  });
});

test('Malformed wallet globals cannot authorize fee math for writes', () => {
  assert.deepEqual(normalizeWalletFeeInfo({ ...wallet, fromPage: true }), {
    ...wallet,
    fromPage: true,
  });
  assert.equal(normalizeWalletFeeInfo({ ...wallet, feePercent: -1, fromPage: true }), null);
  assert.equal(normalizeWalletFeeInfo({ ...wallet, country: 'USA', fromPage: true }), null);
  assert.equal(normalizeWalletFeeInfo({ ...wallet, currencyId: Number.NaN, fromPage: true }), null);
});

test('Own-inventory gate rejects wrong owner, context 16, holds, and unmarketable assets', () => {
  const ownSteamId = '76561198000000000';
  const item = {
    appid: '730',
    contextid: '2',
    assetid: '123456789',
    amount: 1,
    market_hash_name: 'AK-47 | Redline (Field-Tested)',
    marketable: 1,
    tradable: 1,
    tradabilityShort: '',
    owner: ownSteamId,
  };

  assert.equal(getSellBlockReason(item, ownSteamId, true), null);
  assert.match(getSellBlockReason(item, ownSteamId, false) ?? '', /wallet currency unavailable/);
  assert.match(getSellBlockReason({ ...item, owner: '76561198000000001' }, ownSteamId, true) ?? '', /own/);
  assert.match(getSellBlockReason({ ...item, contextid: '16' }, ownSteamId, true) ?? '', /protected/);
  assert.match(getSellBlockReason({ ...item, tradabilityShort: '3d' }, ownSteamId, true) ?? '', /hold/);
  assert.match(getSellBlockReason({ ...item, marketable: 0 }, ownSteamId, true) ?? '', /not marketable/);
});

test('Knives, gloves, patterns, and sticker value trigger the premium warning', () => {
  assert.equal(hasIndividualPremiumRisk({ market_hash_name: '★ Karambit | Doppler' }), true);
  assert.equal(hasIndividualPremiumRisk({ market_hash_name: 'Sport Gloves | Vice' }), true);
  assert.equal(hasIndividualPremiumRisk({ market_hash_name: 'AK-47 | Case Hardened', patternInfo: {} }), true);
  assert.equal(hasIndividualPremiumRisk({ market_hash_name: 'AK-47 | Redline', stickerTotal: 100 }), true);
  assert.equal(hasIndividualPremiumRisk({ market_hash_name: 'AK-47 | Redline' }), false);
});

test('Synthetic website clicks cannot mint a market-write authorization', () => {
  const result = authorizeSellFromUserGesture(
    new Event('click'),
    ['123456789'],
    '76561198000000000',
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.context?.stopBatch, 'user_gesture');

  const removal = authorizeListingRemovalFromUserGesture(
    new Event('click'),
    ['987654321'],
    '76561198000000000',
  );
  assert.equal(removal.ok, false);
  if (!removal.ok) assert.equal(removal.error.context?.stopBatch, 'user_gesture');
});

test('Review totals expose Steam and publisher fees separately', () => {
  assert.equal(MAX_SELL_BATCH_SIZE, 20);
  const first = sellTargetFromReceived(100, wallet);
  const second = sellTargetFromReceived(200, wallet);
  assert.ok(first && second);
  assert.deepEqual(summarizeSellTargets([first, second]), {
    itemCount: 2,
    received: 300,
    steamFee: 15,
    publisherFee: 30,
    fees: 45,
    buyerPays: 345,
  });
});

test('A lower refreshed price requires a new confirmation', () => {
  const reviewed = computeSellTarget('instant', orderBook({ highestBuyOrder: 115 }), wallet);
  const lower = computeSellTarget('instant', orderBook({ highestBuyOrder: 103 }), wallet);
  const higher = computeSellTarget('instant', orderBook({ highestBuyOrder: 230 }), wallet);
  assert.ok(reviewed && lower && higher);
  assert.equal(hasDownwardPriceDrift(reviewed, lower), true);
  assert.equal(hasDownwardPriceDrift(reviewed, higher), false);
});

test('Batch reducer keeps live and pending Steam confirmations distinct', () => {
  assert.equal(classifySellConfirmation({}), 'listed_live');
  assert.equal(classifySellConfirmation({ requires_confirmation: true }), 'pending_confirmation');
  assert.equal(
    classifySellConfirmation({ needs_mobile_confirmation: true }),
    'pending_mobile_confirmation',
  );
  assert.equal(
    classifySellConfirmation({ needs_email_confirmation: true }),
    'pending_email_confirmation',
  );

  let state = reduceBatchSellState(INITIAL_BATCH_SELL_STATE, { type: 'start', total: 4 });
  state = reduceBatchSellState(state, { type: 'listed', status: 'listed_live' });
  state = reduceBatchSellState(state, { type: 'listed', status: 'pending_mobile_confirmation' });
  state = reduceBatchSellState(state, { type: 'listed', status: 'pending_email_confirmation' });
  state = reduceBatchSellState(state, { type: 'failed' });
  state = reduceBatchSellState(state, { type: 'finish' });

  assert.deepEqual(state, {
    phase: 'complete',
    total: 4,
    processed: 4,
    listedLive: 1,
    pendingMobile: 1,
    pendingEmail: 1,
    pendingOther: 0,
    failed: 1,
    stopReason: null,
  });
});

test('Auth, account mismatch, and 429 are batch-stopping classifications', () => {
  assert.equal(batchStopReasonForError({ code: 'RATE_LIMITED' }), 'rate_limited');
  assert.equal(batchStopReasonForError({ code: 'AUTH_REQUIRED' }), 'authentication');
  assert.equal(
    batchStopReasonForError({ code: 'AUTH_EXPIRED', context: { stopBatch: 'account_mismatch' } }),
    'account_mismatch',
  );
  assert.equal(batchStopReasonForError({ code: 'API_ERROR' }), null);

  assert.equal(classifyMarketReadHttpStatus(401), 'AUTH_EXPIRED');
  assert.equal(classifyMarketReadHttpStatus(429), 'RATE_LIMITED');
  assert.equal(classifyMarketWriteHttpStatus(403), 'AUTH_EXPIRED');
  assert.equal(classifyMarketWriteHttpStatus(503), 'NETWORK_ERROR');
  assert.equal(classifyMarketRefusalMessage('You must be logged in to sell an item'), 'AUTH_EXPIRED');
  assert.equal(classifyMarketRefusalMessage('This item cannot be sold'), 'API_ERROR');
});

test('Shipped UI keeps the safety helpers on every write path', () => {
  const sellUi = readFileSync('src/content-scripts/steam/sell-ui.ts', 'utf8');
  const marketHome = readFileSync('src/content-scripts/steam/market-home.ts', 'utf8');

  assert.match(sellUi, /getSellBlockReason\(item, loggedInSteamId, wallet\.fromPage\)/);
  assert.match(sellUi, /queue\.length > MAX_SELL_BATCH_SIZE/);
  assert.ok((sellUi.match(/\{ force: true \}/g) ?? []).length >= 2);
  assert.match(sellUi, /ITEM REVIEW/);
  assert.match(sellUi, /BLOCKED \(never submitted\)/);
  assert.match(sellUi, /previewBookFetchedAt/);
  assert.match(sellUi, /if \(!e\.isTrusted\) return/);
  assert.match(marketHome, /if \(!event\.isTrusted\) return/);
  assert.match(marketHome, /authorizeListingRemovalFromUserGesture/);
});
