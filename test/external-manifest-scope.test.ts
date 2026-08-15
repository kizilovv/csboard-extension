import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface ManifestExternalScope {
  readonly externally_connectable?: { readonly matches?: readonly string[] };
  readonly host_permissions?: readonly string[];
  readonly permissions?: readonly string[];
}

test('external handshake manifest scope is exact and adds no CSFolder host access', () => {
  const manifest = JSON.parse(readFileSync(
    new URL('../src/manifest.json', import.meta.url),
    'utf8',
  )) as ManifestExternalScope;

  assert.deepEqual(manifest.externally_connectable?.matches, [
    'https://csboard.com/*',
    'https://csboard.trade/*',
    'https://csfolder.com/*',
  ]);
  assert.equal(
    manifest.host_permissions?.some((value) => value.includes('csfolder.com')),
    false,
    'CSFolder may message the extension but the extension must not read/fetch CSFolder pages',
  );
  assert.equal(manifest.permissions?.includes('cookies'), false);
  assert.equal(manifest.permissions?.includes('tabs'), false);
});
