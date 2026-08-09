import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('no settings label both wraps its control and points at it', () => {
  // A <label for="x"> that also contains #x activates the control twice: the
  // browser forwards the label click AND the input receives the real one. The
  // checkbox flips back to where it started while `change` still fires, so the
  // popup shows "enabled" over a switch the user sees as off.
  const html = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
  const labels = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)];
  assert.ok(labels.length > 0, 'expected labels in the popup markup');

  for (const [, attrs, body] of labels) {
    const target = /for="([^"]+)"/.exec(attrs)?.[1];
    if (!target) continue;
    const control = new RegExp(`<input[^>]*id="${target}"[^>]*>`).exec(body)?.[0];
    // Only checkboxes flip state on activation. A label wrapping a select or a
    // text field just focuses it twice, which changes nothing.
    if (!control || !control.includes('type="checkbox"')) continue;
    assert.fail(`label for="${target}" also wraps that checkbox, which double-toggles it`);
  }
});

test('every settings switch the popup drives still exists', () => {
  const html = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
  for (const id of ['sync-preferences-toggle', 'csfloat-overlay-toggle', 'betterbuff-toggle']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
});
