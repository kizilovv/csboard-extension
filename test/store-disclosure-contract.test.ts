import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { en } from '../src/shared/locales/en.ts';
import { ru } from '../src/shared/locales/ru.ts';

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
  assert.match(
    worker,
    /tradeOffers:\s*settings\.portfolioSyncEnabled\s*&&\s*settings\.portfolioSources\.tradeHistory/,
  );

  assert.match(privacy, /up to 100 (?:most )?recent Steam trades/i);
  assert.match(privacy, /automatic sync[^.]*once per hour/i);
  assert.match(privacy, /accepted offers[^.]*last 30 days/i);
  assert.match(privacy, /completed trade id[^.]*marketplace hint/i);
  assert.match(privacy, /active trade offers[^.]*not uploaded/i);
  assert.match(privacy, /raw Steam (?:offer )?(?:notes|messages)[^.]*not uploaded/i);
  assert.match(privacy, /does not upload Steam Market (?:sales\/listing )?history/i);
  assert.match(privacy, /Chrome Web Store User Data Policy[^.]*Limited Use/i);
  assert.match(privacy, /^\| Accepted-offer correlation \|/m);
  assert.doesNotMatch(privacy, /uploads the deterministically newest 1,000/i);

  /*
    The disclosure is now a collapsed <details> instead of five open sentences,
    and it is the dictionary entry that carries the text.

    What is asserted is unchanged: every fact still ships, still sits directly
    above the consent control, and now has to exist in every locale — a Russian
    user consenting to a blank disclosure would be worse than a long one.
  */
  const popupDisclosure = popupHtml.match(
    /<details class="privacy-disclosure">([\s\S]*?)<\/details>/,
  )?.[1] ?? '';
  assert.match(popupDisclosure, /up to 100 (?:most )?recent Steam trades/i);
  assert.match(popupDisclosure, /automatic sync runs about once per hour/i);
  assert.match(popupDisclosure, /accepted offers from the last 30 days/i);
  assert.match(
    popupDisclosure,
    /never uploaded[^.]*active offers[^.]*raw Steam notes[^.]*Steam Market history/i,
  );
  assert.doesNotMatch(popupDisclosure, /market facts/i);

  assert.ok(
    popupHtml.indexOf('class="privacy-disclosure"') <
      popupHtml.indexOf('id="portfolio-sync-toggle"'),
    'the data disclosure must sit before the upload consent control',
  );
  const englishDisclosure = en['portfolio.disclosure.body'];
  assert.equal(popupDisclosure.includes(englishDisclosure), true,
    'the markup fallback must be the English dictionary entry, verbatim');
  assert.match(englishDisclosure, /Steam credentials/i);

  const russianDisclosure = ru['portfolio.disclosure.body'];
  assert.match(russianDisclosure, /до 100 последних обменов Steam/i);
  assert.match(russianDisclosure, /30 дней/i);
  assert.match(russianDisclosure, /раз в час/i);
  assert.match(russianDisclosure, /Никогда не уходят[^.]*активные предложения/i);
  assert.match(russianDisclosure, /история Steam Market/i);
  assert.match(russianDisclosure, /учётные данные Steam/i);

  // The paired-and-enabled summary is the other place the hourly cadence is
  // stated, and it is what a user sees without opening anything.
  assert.match(en['portfolio.state.pairedOn'], /about once per hour/i);
  assert.match(ru['portfolio.state.pairedOn'], /раз в час/i);
  assert.match(popupSource, /t\('portfolio\.state\.pairedOn'\)/);

  assert.match(storeListing, /up to 100 most recent Steam trades/i);
  assert.match(storeListing, /automatic sync[^.]*once per hour/i);
  assert.match(storeListing, /accepted offers[^.]*last 30 days/i);
  assert.match(storeListing, /completed trade id[^.]*marketplace hint/i);
  assert.match(storeListing, /active\s+trade offers[^.]*not uploaded/i);
  assert.match(storeListing, /raw Steam (?:offer )?(?:notes|messages)[^.]*not uploaded/i);
  assert.match(storeListing, /does not upload[^.]*Steam Market history/i);

  for (const publicReleaseCopy of [readme, changelog]) {
    const normalizedCopy = publicReleaseCopy.replace(/\s+/g, ' ');
    assert.match(normalizedCopy, /up to 100 most recent Steam trades/i);
    assert.match(normalizedCopy, /automatic sync[^.]*once per hour/i);
    assert.match(
      normalizedCopy,
      /accepted offers[^.]*last 30 days/i,
    );
    assert.match(normalizedCopy, /active (?:trade )?offers[^.]*not uploaded/i);
    assert.match(normalizedCopy, /raw Steam (?:offer )?(?:notes|messages)[^.]*not uploaded/i);
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
