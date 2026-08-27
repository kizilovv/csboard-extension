import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = readFileSync(
  new URL('../src/background/service-worker.ts', import.meta.url),
  'utf8',
);
const externalRouter = readFileSync(
  new URL('../src/background/external-router.ts', import.meta.url),
  'utf8',
);

test('service worker pins CSFolder activation and enables exactly two visible sources', () => {
  const registration = /registerExternalStatusRouter\(\{([\s\S]*?)\n\}\);/
    .exec(worker)?.[1];
  assert.ok(registration, 'external router registration not found');
  assert.match(registration, /statusAllowedOrigins:\s*\['https:\/\/csboard\.com', 'https:\/\/csboard\.trade'\]/);
  assert.match(registration, /pairingAllowedOrigins:\s*\['https:\/\/csfolder\.com'\]/);
  assert.match(registration, /async isPaired\(\)/);
  assert.match(externalRouter, /REACTIVATE_PORTFOLIO_SYNC/);
  assert.match(externalRouter, /EXTERNAL_REACTIVATE_MESSAGE_TYPE/);
  assert.match(registration, /portfolioSyncEnabled:\s*true/);
  assert.match(registration, /inventory:\s*true/);
  assert.match(registration, /tradeHistory:\s*true/);
  assert.match(registration, /tradeOffers:\s*false/);
  assert.match(registration, /marketHistory:\s*false/);
  assert.match(registration, /void runPortfolioSync\(epoch\)/);
  assert.doesNotMatch(registration, /UNPAIR_DEVICE|steamLoginSecure|sessionid/);
});

test('CSBOARD gets exactly three sync commands, on its own origin list', () => {
  // 1.1.5 said "CSBOARD retains a read-only status probe and nothing else".
  // 1.1.6 moved that line by exactly two commands so the site can ask for the
  // fresh inventory snapshot a listing needs. This test is the record of how
  // far it moved: a further command, or a further origin, must fail here first.
  //
  // 2026-08-27 moved it once more, by one: `sendTradeForOrder`, so the site can
  // ask us to DELIVER a sold item. It is the narrowest command in the file —
  // the page names an order id and nothing else, and everything that decides
  // what leaves the seller's inventory is read from csboard's own record of
  // that order. It exists because the alternative was a manual link into
  // Steam's trade window, where a seller picks the items himself and can send a
  // different skin than the one that was bought.
  //
  // Still NOT here, and each absence is deliberate: no pairing, no credential
  // read, no way to get Steam data back out to the page. CSFolder's origins are
  // not on this list either — it has no orders and no business delivering
  // anybody's skins.
  const registration = /registerExternalStatusRouter\(\{([\s\S]*?)\n\}\);/
    .exec(worker)?.[1];
  assert.ok(registration, 'external router registration not found');
  assert.match(
    registration,
    /syncAllowedOrigins:\s*\['https:\/\/csboard\.com', 'https:\/\/csboard\.trade'\]/,
  );
  const syncHandlers = /syncHandlers:\s*\{([\s\S]*?)\n  \},/.exec(registration)?.[1];
  assert.ok(syncHandlers, 'sync handlers not wired');
  assert.match(syncHandlers, /requestManualSync:\s*requestExternalManualSync/);
  assert.match(syncHandlers, /readSyncStatus:\s*readExternalSyncStatus/);
  assert.match(syncHandlers, /sendTradeForOrder:/);
  assert.equal(
    syncHandlers.split('\n').filter((line) => /^\s*\w+:/.test(line)).length,
    3,
    'the site may trigger a sync, read its state, and deliver a paid order — nothing else',
  );

  // 1.1.7 moved the line again, and only in one place: an install that is not
  // enrolled in CSFolder no longer FAILS the refresh, it takes the direct
  // csboard road. What did not move is the thing this assertion was really
  // protecting — the trigger still never pairs a device and never switches
  // portfolio uploads on. A press on a listing page is consent to send the
  // seller's inventory to CSBOARD and to nothing else.
  const trigger = /async function requestExternalManualSync[\s\S]*?\n\}/.exec(worker)?.[0];
  assert.ok(trigger, 'manual sync trigger not found');
  assert.match(trigger, /return requestCsboardDirectSync\(\)/);
  assert.doesNotMatch(trigger, /updateSettings|pairPortfolioDevice|allowPortfolioUploads/);

  // The direct road and the gate that chooses it are held to the same rule.
  // If either could write CSFolder consent, the paragraph above is a lie.
  for (const name of ['requestCsboardDirectSync', 'gatewaySyncAvailable']) {
    const fn = new RegExp(`async function ${name}[\\s\\S]*?\\n\\}`).exec(worker)?.[0];
    assert.ok(fn, `${name} not found`);
    assert.doesNotMatch(fn, /updateSettings|pairPortfolioDevice|allowPortfolioUploads/);
  }

  // The direct road may send Steam data to exactly one place: our own ingest.
  const directSync = readFileSync(
    new URL('../src/background/csboard-direct-sync.ts', import.meta.url),
    'utf8',
  );
  assert.match(directSync, /CSBOARD_DIRECT_SYNC_PATH = '\/p2p\/ext\/inventory-sync'/);
  // And it reaches none of the CSFolder machinery: no device key store, no
  // gateway client, no outbox, no settings. Its only import is a type.
  const imports = [...directSync.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['../shared/gateway-dto']);

  // The status answer is two facts. A Steam id here would be a data leak.
  const statusReader = /async function readExternalSyncStatus[\s\S]*?\n\}/.exec(worker)?.[0];
  assert.ok(statusReader, 'sync status reader not found');
  assert.match(statusReader, /paired:\s*gateway\?\.paired === true \|\| directSyncEstablished/);
  assert.doesNotMatch(statusReader, /steamId|lastFailureCode|pendingEncryptedRequests/);
});

test('replayed pairing cannot clear consent on an already-paired device', () => {
  const pairing = /async function performPortfolioPairing[\s\S]*?(?=async function preparePortfolioPairing)/
    .exec(worker)?.[0];
  assert.ok(pairing, 'pairing implementation not found');
  const alreadyPairedGuard = pairing.indexOf("if ((await controller.status()).paired)");
  const reset = pairing.indexOf('await preparePortfolioPairing()');
  assert.ok(alreadyPairedGuard >= 0, 'already-paired replay guard missing');
  assert.ok(reset > alreadyPairedGuard, 'consent reset runs before replay guard');
});
