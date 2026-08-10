import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const privacy = readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const popupHtml = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
const popupSource = readFileSync(new URL('../src/popup/popup.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(
  readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'),
) as {
  host_permissions?: string[];
  content_scripts?: Array<{ matches?: string[] }>;
};
const storeListing = readFileSync(
  new URL('../docs/releases/STORE-LISTING-1.1.0.md', import.meta.url),
  'utf8',
);
const worker = readFileSync(
  new URL('../src/background/service-worker.ts', import.meta.url),
  'utf8',
);

test('portfolio disclosures match the supported upload sources and hourly opt-in scheduler', () => {
  assert.match(worker, /const PORTFOLIO_AUTO_SYNC_MINUTES = 60;/);
  assert.match(worker, /source === 'tradeOffers' \|\| source === 'marketHistory'/);

  assert.match(privacy, /up to 100 (?:most )?recent Steam trades/i);
  assert.match(privacy, /automatic sync[^.]*once per hour/i);
  assert.match(privacy, /does not upload (?:active )?trade offers/i);
  assert.match(privacy, /does not upload Steam Market (?:sales\/listing )?history/i);
  assert.match(privacy, /Chrome Web Store User Data Policy[^.]*Limited Use/i);
  assert.doesNotMatch(privacy, /^\| Trade offers \|/m);
  assert.doesNotMatch(privacy, /uploads the deterministically newest 1,000/i);

  const popupDisclosure = popupHtml.match(
    /<details class="privacy-disclosure" open>([\s\S]*?)<\/details>/,
  )?.[1] ?? '';
  assert.match(popupDisclosure, /up to 100 (?:most )?recent Steam trades/i);
  assert.match(popupDisclosure, /automatic sync[^.]*once per hour/i);
  assert.match(popupDisclosure, /Trade offers and Steam Market history are not uploaded/i);
  assert.doesNotMatch(popupDisclosure, /market facts/i);

  assert.match(popupHtml, /allows manual sync and automatic sync[^.]*once per hour/i);
  assert.ok(
    popupHtml.indexOf('class="privacy-disclosure" open') <
      popupHtml.indexOf('id="portfolio-sync-toggle"'),
    'the data disclosure must be visible before the upload consent control',
  );
  assert.match(popupSource, /Enabled for manual and hourly sync/);
  assert.match(popupSource, /Enabled sources sync automatically[^.]*once per hour/i);

  assert.match(storeListing, /up to 100 most recent Steam trades/i);
  assert.match(storeListing, /automatic sync[^.]*once per hour/i);
  assert.match(storeListing, /does not upload active trade offers/i);
  assert.match(storeListing, /does not upload[^.]*Steam Market history/i);
  assert.doesNotMatch(storeListing, /uploads (?:active )?trade offers/i);

  for (const publicReleaseCopy of [readme, changelog]) {
    const normalizedCopy = publicReleaseCopy.replace(/\s+/g, ' ');
    assert.match(normalizedCopy, /up to 100 most recent Steam trades/i);
    assert.match(normalizedCopy, /automatic sync[^.]*once per hour/i);
    assert.match(
      normalizedCopy,
      /(?:does not upload active trade offers|active trade offers[^.]*not uploaded)/i,
    );
    assert.doesNotMatch(
      publicReleaseCopy,
      /portfolio sync[^.\n]*(?:includes|for)[^.\n]*trade offers/i,
    );
  }
});

test('Store manifest does not request the unused Steam Store host', () => {
  assert.equal(
    manifest.host_permissions?.some((permission) =>
      permission.includes('store.steampowered.com')),
    false,
  );
  assert.equal(
    manifest.content_scripts?.some((entry) =>
      entry.matches?.some((match) => match.includes('store.steampowered.com'))),
    false,
  );
  assert.equal(manifest.host_permissions?.includes('*://steamcommunity.com/*'), true);
  assert.equal(manifest.host_permissions?.includes('*://api.steampowered.com/*'), true);
});
