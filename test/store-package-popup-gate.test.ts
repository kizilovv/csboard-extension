import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('store packaging gates the built popup lifecycle without burdening local preflight', async () => {
  const [packageJson, packager] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../scripts/package-store.mjs', import.meta.url), 'utf8'),
  ]);

  assert.equal(
    packageJson.scripts['test:e2e:popup'],
    'node scripts/e2e-popup-smoke.mjs',
  );

  const invocation = "execFileSync('npm', ['run', 'test:e2e:popup']";
  assert.equal(packager.split(invocation).length - 1, 1, 'popup smoke must have one release gate');

  const invocationIndex = packager.indexOf(invocation);
  const storeGuardIndex = packager.lastIndexOf('if (isStore) {', invocationIndex);
  const guardEndIndex = packager.indexOf('\n}', invocationIndex);
  assert.ok(storeGuardIndex >= 0 && guardEndIndex > invocationIndex);
  assert.match(
    packager.slice(storeGuardIndex, guardEndIndex),
    /env:\s*process\.env/u,
    'release hosts must be able to provide dynamic Playwright and Chrome paths',
  );
  assert.ok(
    packager.indexOf('const files = walk(buildDir);') > guardEndIndex,
    'browser smoke must pass before the archive is assembled',
  );
});
