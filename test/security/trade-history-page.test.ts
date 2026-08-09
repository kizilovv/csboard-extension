import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../src/pages/trade-history-page.js', import.meta.url),
  'utf8',
);

test('trade-history extension page renders the normalized contract without raw HTML facts', () => {
  assert.match(source, /function escapeHtml\(value\)/);
  assert.match(source, /last\.tradeId/);
  assert.match(source, /last\.occurredAt/);
  assert.match(source, /escapeHtml\(name\)/);
  assert.match(source, /rel="noopener noreferrer"/);
  // `partnerName` stays banned: it is attacker-controlled display text from
  // Steam and this page interpolates into HTML. The money fields are different —
  // they are numbers the worker derives from the price engine, and the owner
  // asked for the P/L view back. Every interpolation that carries one must
  // format it, so a non-numeric value can never reach the DOM verbatim.
  assert.doesNotMatch(source, /partnerName/);
  const interpolations = [...source.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1]);
  for (const field of ['profitLossUsd', 'totalGivenUsd', 'totalReceivedUsd']) {
    for (const expression of interpolations) {
      if (!expression.includes(field)) continue;
      assert.ok(
        expression.includes('toFixed'),
        `${field} reaches the template unformatted in \`${expression}\``,
      );
    }
  }
  assert.match(source, /toFixed\(2\)/);
  assert.doesNotMatch(source, /Error: \$\{err\}/);
});
