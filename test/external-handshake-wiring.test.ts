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
  assert.doesNotMatch(registration, /UNPAIR_DEVICE|RUN_MANUAL_SYNC|steamLoginSecure|sessionid/);
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
