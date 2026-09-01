import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildCsfolderInspectUrl,
  canonicalAccessoryMarketName,
  upsertCsfolderScreenshotAction,
} from '../src/shared/inspect-actions.ts';

const inspectLink =
  'steam://run/730//+csgo_econ_action_preview%207C6CF88390E2D17D64655C1C547D4C7844BE8B98897F3C8578145B0C64904061B1';

test('builds one shareable RU CSFolder path and preserves the complete inspect action', () => {
  const result = buildCsfolderInspectUrl(inspectLink);
  assert.ok(result);

  const url = new URL(result);
  assert.equal(url.origin, 'https://csfolder.com');
  assert.equal(url.pathname.startsWith('/ru/inspect/'), true);
  assert.equal(decodeURIComponent(url.pathname.slice('/ru/inspect/'.length)), inspectLink);
});

test('refuses non-CS2 actions instead of creating a paid screenshot link', () => {
  assert.equal(buildCsfolderInspectUrl('https://example.com/skin'), null);
  assert.equal(buildCsfolderInspectUrl('steam://run/440//+inspect%20something'), null);
});

test('extracts the exact accessory market name without swallowing its scrape level', () => {
  assert.equal(
    canonicalAccessoryMarketName(
      'Sticker | Astralis (Gold) | Katowice 2019\nSticker Scrape Level: 0.143011615',
    ),
    'Sticker | Astralis (Gold) | Katowice 2019',
  );
  assert.equal(
    canonicalAccessoryMarketName(
      'Sticker | IEM (Gold) | Katowice 2019Sticker Scrape Level: 0.119022653',
    ),
    'Sticker | IEM (Gold) | Katowice 2019',
  );
  assert.equal(canonicalAccessoryMarketName('The Overpass Collection'), null);
});

class FakeClassList {
  readonly values = new Set<string>();

  add(...names: string[]): void {
    names.forEach((name) => this.values.add(name));
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }
}

class FakeAnchor {
  readonly classList = new FakeClassList();
  readonly ownerDocument: FakeDocument;
  nextElementSibling: FakeAnchor | null = null;
  previousElementSibling: FakeAnchor | null = null;
  href = '';
  target = '';
  rel = '';
  textContent = '';
  title = '';
  removed = false;
  insertions = 0;

  constructor(ownerDocument: FakeDocument) {
    this.ownerDocument = ownerDocument;
  }

  insertAdjacentElement(position: string, element: FakeAnchor): FakeAnchor {
    assert.equal(position, 'afterend');
    this.insertions += 1;
    this.nextElementSibling = element;
    element.previousElementSibling = this;
    return element;
  }

  remove(): void {
    this.removed = true;
    if (this.previousElementSibling?.nextElementSibling === this) {
      this.previousElementSibling.nextElementSibling = null;
    }
  }
}

class FakeDocument {
  creations = 0;

  createElement(tagName: string): FakeAnchor {
    assert.equal(tagName, 'a');
    this.creations += 1;
    return new FakeAnchor(this);
  }
}

test('keeps one screenshot button immediately after Inspect in Game across rerenders', () => {
  const ownerDocument = new FakeDocument();
  const inspect = new FakeAnchor(ownerDocument);
  inspect.href = inspectLink;
  const screenshotHref = buildCsfolderInspectUrl(inspectLink);
  assert.ok(screenshotHref);

  const first = upsertCsfolderScreenshotAction(
    inspect as unknown as HTMLAnchorElement,
    screenshotHref,
  );
  const second = upsertCsfolderScreenshotAction(
    inspect as unknown as HTMLAnchorElement,
    screenshotHref,
  );

  assert.equal(first, second);
  assert.equal(inspect.nextElementSibling, first);
  assert.equal(ownerDocument.creations, 1);
  assert.equal(inspect.insertions, 1);
  assert.equal(first?.textContent, 'Get screenshot');
  assert.equal(first?.href, screenshotHref);
});

test('inventory keeps screenshot out of the volatile top lookup block', () => {
  const source = readFileSync(
    new URL('../src/content-scripts/steam/inventory.ts', import.meta.url),
    'utf8',
  );
  const blockStart = source.indexOf('const buildLookupBlock');
  const blockEnd = source.indexOf('const injectLookupLinksNearInspect');
  assert.ok(blockStart >= 0 && blockEnd > blockStart);
  assert.doesNotMatch(source.slice(blockStart, blockEnd), /Get screenshot/);
  assert.match(source, /upsertCsfolderScreenshotAction\(inspectLink, screenshotHref\)/);
});
