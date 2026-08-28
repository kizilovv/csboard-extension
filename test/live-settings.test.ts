import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const csfloatSource = readFileSync(
  new URL('../src/content-scripts/csfloat/csfloat.ts', import.meta.url),
  'utf8',
);
const inventorySource = readFileSync(
  new URL('../src/content-scripts/steam/inventory.ts', import.meta.url),
  'utf8',
);

test('CSFloat price panel is fail-closed and reacts to its persisted live toggle', () => {
  assert.match(csfloatSource, /let showCsboardPricesOnCsfloat = false;/);
  assert.match(csfloatSource, /changes\['csboard_settings'\]/);
  assert.match(
    csfloatSource,
    /if \(!csboardPanelSettingsReady \|\| !showCsboardPricesOnCsfloat\) return;/,
  );
  assert.match(
    csfloatSource,
    /document\.querySelectorAll\('\.csboard-panel'\)\.forEach\(\(panel\) => panel\.remove\(\)\);/,
  );
  assert.match(csfloatSource, /priceEngine\.reload\(\)/);
});

test('CSBOARD quote on CSFloat uses extension currency with explicit provenance', () => {
  const panelStart = csfloatSource.indexOf('function injectCsboardPanel');
  const panelEnd = csfloatSource.indexOf('// APP-SELL-DIALOG', panelStart);
  const panelSource = csfloatSource.slice(panelStart, panelEnd);

  assert.match(csfloatSource, /priceEngine\.getSettings\(\)\.currency\.toUpperCase\(\)/);
  assert.match(csfloatSource, /extensionExchangeRates\[currency\]/);
  assert.match(csfloatSource, /return null;\n  }\n\n  const converted/);
  assert.match(panelSource, /CSBOARD min ask · csgoskins\.gg ·/);
  assert.doesNotMatch(panelSource, /formatCsfPrice\(cbCents\)/);
});

test('CSFloat item detail lookup is canonical and asset/float keyed', () => {
  assert.match(csfloatSource, /buildCsfloatSearchUrl\(\{/);
  assert.match(csfloatSource, /dynamicFloatForGloves: true/);
  assert.match(csfloatSource, /Find comparable listings on CSFloat/);
  assert.match(csfloatSource, /listing\.item\.asset_id \?\? ''/);
  assert.match(csfloatSource, /Number\.isFinite\(listing\.item\.float_value\)/);
  assert.match(csfloatSource, /popupMatchesRoute/);
  assert.match(csfloatSource, /noopener noreferrer/);
});

test('CSFloat listing metadata uses intercepted created/sold timestamps only', () => {
  assert.match(csfloatSource, /created_at\?: string;/);
  assert.match(csfloatSource, /sold_at\?: string;/);
  assert.match(csfloatSource, /state\?: string;/);
  assert.match(csfloatSource, /function injectListingMetadata/);
  assert.match(csfloatSource, /buildListingMetadataView\(\{/);
  assert.match(csfloatSource, /createdAt: listing\.created_at/);
  assert.match(csfloatSource, /soldAt: listing\.sold_at/);
  assert.match(csfloatSource, /state: listing\.state/);
  assert.match(csfloatSource, /age\.textContent = metadata\.listed\.label/);
  assert.match(csfloatSource, /injectSoldStatus\(card, metadata\.sold\)/);
  assert.match(csfloatSource, /csboardOriginalLabel/);
  assert.match(csfloatSource, /csboardOriginalTitle/);
  assert.match(csfloatSource, /statusButton\.removeAttribute\('title'\)/);
  assert.match(csfloatSource, /resetListingMetadata\(card\)/);
  assert.doesNotMatch(csfloatSource, /fetch\([^)]*sold_at/);
});

test('inventory settings repaint keeps the merged context 2 + 16 asset view', () => {
  const settingsStart = inventorySource.indexOf('// 10. Listen for settings changes');
  const settingsEnd = inventorySource.indexOf('// 11. Add sorting function bar', settingsStart);
  const settingsSource = inventorySource.slice(settingsStart, settingsEnd);

  assert.match(settingsSource, /const rawItems = readAllContextItems\(\);/);
  assert.doesNotMatch(settingsSource, /getItemInfoFromPage\('730', '2'\)/);

  const mergeStart = inventorySource.indexOf('const readAllContextItems');
  const mergeEnd = inventorySource.indexOf('const onFullInventoryLoad', mergeStart);
  const mergeSource = inventorySource.slice(mergeStart, mergeEnd);
  assert.match(mergeSource, /getItemInfoFromPage\('730', '2'\)/);
  assert.match(mergeSource, /getItemInfoFromPage\('730', '16'\)/);
  assert.match(mergeSource, /const seen = new Set<string>\(\);/);
  assert.match(mergeSource, /const identity = `\$\{item\.appid \|\| '730'\}:\$\{item\.contextid\}:\$\{item\.assetid\}`;/);
  assert.match(mergeSource, /seen\.has\(identity\)/);
  assert.match(mergeSource, /seen\.add\(identity\)/);
});

/*
  The master off switch, and the one thing it must never reach.

  Turning the extension "off" is about what it DRAWS. A seller who mutes the
  overlays and thereby stops delivering sales he already accepted — or stops
  cancelling a Steam offer for an order csboard has closed, which is the one job
  only his browser can do — has been broken by a settings toggle. These
  assertions are the guard on that boundary.
*/
test('every drawing content script is gated on the master switch, delivery is not', () => {
  const gated = [
    'steam/inventory', 'steam/market-home', 'steam/market', 'steam/market-search',
    'steam/profile', 'steam/trade-history', 'steam/trade-offers', 'steam/trade-offer',
    'csfloat/csfloat',
  ];
  for (const name of gated) {
    const source = readFileSync(
      new URL(`../src/content-scripts/${name}.ts`, import.meta.url),
      'utf8',
    );
    assert.match(source, /whenEnhancementsEnabled\(bootstrap\)/, `${name} must be gated`);
  }

  // Buff reads it live, so the overlay clears without a reload.
  const buffSource = readFileSync(
    new URL('../src/content-scripts/buff/buff.ts', import.meta.url),
    'utf8',
  );
  assert.match(buffSource, /settings\.enhancementsEnabled !== false/);

  for (const name of ['steam/p2p-send', 'steam/page-credential-bridge']) {
    const source = readFileSync(
      new URL(`../src/content-scripts/${name}.ts`, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /whenEnhancementsEnabled/,
      `${name} must keep running while enhancements are off`,
    );
  }
});

test('the settings patch validator accepts the master switch', () => {
  const workerSource = readFileSync(
    new URL('../src/background/service-worker.ts', import.meta.url),
    'utf8',
  );
  // The allow-list rejects unknown keys outright, so a toggle missing from it
  // does not degrade — it throws INVALID_SETTINGS_PATCH at the user.
  const allowedBlock = workerSource.slice(
    workerSource.indexOf('const allowed = new Set(['),
    workerSource.indexOf('const patch: Partial<'),
  );
  assert.match(allowedBlock, /'enhancementsEnabled'/);
  assert.match(workerSource, /enhancementsEnabled: settings\.enhancementsEnabled !== false/);
});

/*
  A control the panel draws but nothing reads is worse than no control.

  This shipped once: the markup for the master switch landed, the wiring in
  popup.ts did not, and the toggle rendered permanently disabled and inert. The
  build was green, the capability audit passed, and the only way to see it was
  to open the packaged popup.js and find the id absent. So the id is asserted on
  BOTH sides here.
*/
test('the master switch is wired, not just drawn', () => {
  const popupHtml = readFileSync(
    new URL('../src/popup/popup.html', import.meta.url),
    'utf8',
  );
  const popupSource = readFileSync(
    new URL('../src/popup/popup.ts', import.meta.url),
    'utf8',
  );

  assert.match(popupHtml, /id="enhancements-toggle"/);
  assert.match(popupHtml, /id="enhancements-status"/);

  // Reads the state, enables the control, and persists a change.
  assert.match(popupSource, /enhancements\.checked = settings\.enhancementsEnabled;/);
  assert.match(popupSource, /enhancements\.disabled = unavailableOrBusy;/);
  assert.match(popupSource, /#enhancements-toggle'\)\.addEventListener\('change'/);
  assert.match(popupSource, /updateSettings\(\s*\{ enhancementsEnabled: enabled \}/);
  // Names what the switch does NOT stop.
  assert.match(popupSource, /Sale delivery still works/);
});

/*
  The sales counter on the toolbar icon.

  Two things it must not become: a badge that pastes a permanent "0" on the
  icon, and a badge on the tracker's clock — that clock drops to hourly exactly
  when a seller has nothing in flight, which is when a NEW sale most needs
  announcing.
*/
test('the sales badge counts the delivery queue on its own clock', () => {
  const badgeSource = readFileSync(
    new URL('../src/background/p2p-sales-badge.ts', import.meta.url),
    'utf8',
  );

  // The queue that needs a human, not the ones parked in Steam's hold.
  assert.match(badgeSource, /scope=delivery/);
  // Empty string clears; '0' would sit on the icon forever.
  assert.match(badgeSource, /count > 0 \? \(count > 99 \? '99\+' : String\(count\)\) : ''/);
  // A failed read keeps the last known count rather than claiming zero sales.
  assert.match(badgeSource, /if \(sales === null\) return 'signed_out';/);
  // Its own alarm, and it backs off when nobody is signed in.
  assert.match(badgeSource, /P2P_SALES_BADGE_ALARM/);
  // The page-drawing master switch has no say over the extension's own icon.
  assert.doesNotMatch(badgeSource, /enhancementsEnabled/);

  /*
    Notifications: announced once per ORDER, never per pass.

    A count-based check cannot tell a second sale from the first one still
    sitting unhandled, and re-announcing every five minutes is how an extension
    gets uninstalled. The seen-set is keyed by order id and pruned to the live
    queue, and the whole thing has its own opt-out separate from the page
    switch, because this one leaves the browser.
  */
  assert.match(badgeSource, /const NOTIFIED_KEY = 'csboard_p2p_notified_sales';/);
  assert.match(badgeSource, /sales\.filter\(\(sale\) => !alreadyTold\.has\(sale\.orderId\)\)/);
  assert.match(badgeSource, /getSettings\(\)\)\.salesNotifications !== false/);
  assert.match(badgeSource, /chrome\.notifications\.create\(/);
  // Clicking it lands on the order it is about.
  assert.match(badgeSource, /p2p\/order\/\$\{orderId\}/);

  const workerSource = readFileSync(
    new URL('../src/background/service-worker.ts', import.meta.url),
    'utf8',
  );
  assert.match(workerSource, /case P2P_SALES_BADGE_ALARM:/);
  // Painted on wake too, not only on the first alarm.
  assert.match(workerSource, /await registerAlarms\(\);\n  void runSalesBadgePass\(\);/);
});

/*
  The two readers are not interchangeable, and picking the wrong one is silent.

  `readTradeOffers` is the PORTFOLIO reader: it drops every offer that is not
  accepted (`if (state !== 3) return []`), because portfolio sync records item
  movement. The P2P tracker and the cancellation pass watch offers precisely
  BEFORE they are accepted, and while they die — so on that reader every
  pending, cancelled and declined offer simply did not exist. The tracker
  skipped them, the cancellation pass never saw one turn dead, and not one
  cancellation was ever confirmed. Nothing errored; it just never happened.

  And `readRecentTrades` rejects anything over 100 rows before it makes a
  request, so asking for 200 threw INVALID_PAYLOAD on every single pass and the
  completed-trade half — the one reversal detection rides on — had never run.
*/
test('the P2P pass uses the unfiltered offer reader and a legal history size', () => {
  const workerSource = readFileSync(
    new URL('../src/background/service-worker.ts', import.meta.url),
    'utf8',
  );
  const pass = workerSource.slice(
    workerSource.indexOf('async function runP2PTrackingPass'),
    workerSource.indexOf('async function registerAlarms'),
  );

  assert.doesNotMatch(pass, /provider\.readTradeOffers\(\)/);
  // Both the tracker and the cancellation pass read it.
  assert.equal(
    (pass.match(/readTradeOffersForDisplay\(\{ received: false \}\)/g) ?? []).length,
    2,
  );
  // 100 because the provider rejects more before it makes a request, and
  // tolerant rows because one malformed trade must not take the page down.
  assert.match(pass, /provider\.readRecentTrades\(100, \{ skipUnreadableRows: true \}\)/);

  const providerSource = readFileSync(
    new URL('../src/background/steam-read-session-provider.ts', import.meta.url),
    'utf8',
  );
  // The cap that made 200 illegal, and the filter that made the other reader
  // the wrong one. If either moves, this test is the reminder.
  assert.match(providerSource, /maxTrades > 100/);
  assert.match(providerSource, /if \(state !== 3\) return \[\];/);

  /*
    An offer missing from a successful sent-offer read counts as settled. That
    is the judgement that lets a cancellation ever be confirmed, and reverting
    it to "unknown" silently strands orders, so it is asserted rather than left
    to a comment.
  */
  const cancelSource = readFileSync(
    new URL('../src/background/p2p-trade-cancel.ts', import.meta.url),
    'utf8',
  );
  assert.match(cancelSource, /return state === undefined \|\| OFFER_DEAD_STATES\.has\(state\);/);
});
