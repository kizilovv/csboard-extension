import assert from 'node:assert/strict';
import test from 'node:test';

const STEAM_ID = '76561198000000042';

function tradeItem(index: number) {
  return {
    appId: '730',
    contextId: '2',
    assetId: String(50000000000 + index),
    classId: '3745384988',
    instanceId: '188530170',
    amount: '1',
    marketHashName: 'AWP | Printstream (Field-Tested)',
  };
}

function provider(offerItemCount: number) {
  return {
    readInventoryContext: async (contextId: '2' | '16') => ({
      contextId,
      complete: true as const,
      items: [{
        appId: '730',
        contextId,
        assetId: '4000000001',
        classId: '3745384988',
        instanceId: '188530170',
        amount: '1',
        marketHashName: 'AK-47 | Redline (Field-Tested)',
        tradable: true,
        marketable: true,
        onHold: contextId === '16',
      }],
    }),
    readRecentTrades: async () => ({ complete: true as const, trades: [], icons: {}, nameColors: {} }),
    readTradeOffers: async () => ({
      complete: true as const,
      offers: [{
        offerId: '9285043358',
        direction: 'received' as const,
        partnerAccountId: '123456789',
        state: 3,
        createdAt: 1786000000,
        itemsToGive: [tradeItem(0)],
        itemsToReceive: Array.from({ length: offerItemCount }, (_, i) => tradeItem(i + 1)),
      }],
    }),
    offerAccessToken: () => {},
    forgetSession: () => {},
  } as never;
}

test('one oversized offer no longer kills the whole portfolio sync', async () => {
  // Steam legally returns offers with far more than the 200 items per side the
  // gateway DTO accepts — this user had a real 375-item one, and it aborted
  // every sync attempt, so no portfolio could ever be uploaded.
  const { collectPortfolioSync } = await import('../src/background/portfolio-collector.ts');
  const collected = await collectPortfolioSync({ steamId: STEAM_ID, provider: provider(375) });

  assert.equal(collected.snapshot.offers.length, 0, 'the oversized offer is dropped');
  assert.ok(collected.chunks.length > 0, 'the rest of the portfolio still syncs');
  assert.ok(
    collected.summary.warningCodes.includes('OVERSIZED_RECORDS_DROPPED'),
    'the gap is reported, not hidden',
  );
  assert.equal(
    collected.snapshot.completeness.offers,
    false,
    'a source that lost a record must not claim completeness',
  );
  // Inventory is untouched, so P2P eligibility still works for this user.
  assert.equal(collected.snapshot.completeness.inventoryContext2, true);
  assert.equal(collected.snapshot.completeness.inventoryContext16, true);
});

test('a normal offer keeps its completeness claim', async () => {
  const { collectPortfolioSync } = await import('../src/background/portfolio-collector.ts');
  const collected = await collectPortfolioSync({ steamId: STEAM_ID, provider: provider(12) });

  assert.equal(collected.snapshot.offers.length, 1);
  // The offers source is deliberately narrowed to accepted offers, so it never
  // claims to be a complete account of everything Steam holds.
  assert.equal(collected.snapshot.completeness.offers, false);
  assert.deepEqual(collected.summary.warningCodes, []);
});

test('the portfolio carries only offers that actually moved items', async () => {
  // Measured on a real trading account: 333 offers, of which 268 were declined,
  // countered, cancelled or invalid — offers that changed nothing and cost a
  // sync 40x its useful payload. Offers still in flight belong to P2P order
  // tracking, not to a record of what the account owns and traded.
  const { createSteamReadSessionProvider } = await import(
    '../src/background/steam-read-session-provider.ts'
  );
  const states = [
    { state: 3, keep: true, name: 'accepted' },
    { state: 2, keep: false, name: 'active' },
    { state: 4, keep: false, name: 'countered' },
    { state: 6, keep: false, name: 'cancelled' },
    { state: 7, keep: false, name: 'declined' },
    { state: 8, keep: false, name: 'invalid items' },
    { state: 10, keep: false, name: 'cancelled by second factor' },
  ];

  let requestedUrl = '';
  const provider = createSteamReadSessionProvider({
    steamId: STEAM_ID,
    now: () => Date.UTC(2026, 7, 8),
    fetchImpl: (async (input: unknown) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        response: {
          trade_offers_sent: states.map((entry, index) => ({
            tradeofferid: String(9200000000 + index),
            accountid_other: '123456789',
            trade_offer_state: entry.state,
            time_created: 1786000000,
            items_to_give: [{
              appid: '730',
              contextid: '2',
              assetid: String(50000000000 + index),
              classid: '3745384988',
              instanceid: '188530170',
              amount: '1',
            }],
            items_to_receive: [],
          })),
          descriptions: [],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  provider.offerAccessToken('a'.repeat(40), STEAM_ID);

  const result = await provider.readTradeOffers();
  // The portfolio provider is intentionally narrower than the page-facing
  // readTradeOffersForDisplay path: only accepted offers may cross it.
  assert.deepEqual(result.offers.map((offer) => offer.state), [3]);
  // The historical half is bounded too, so a long-lived account does not pull
  // years of dead offers just to discard them.
  assert.match(requestedUrl, /time_historical_cutoff=\d+/);
});
