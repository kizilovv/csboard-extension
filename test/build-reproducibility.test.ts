import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertNoStagingPath,
  bundledPackageName,
  stagedEntry,
} from '../scripts/build-reproducibility.mjs';

const buildSource = readFileSync(new URL('../build.mjs', import.meta.url), 'utf8');

test('Store build uses relative staged entries and rejects random temp paths', () => {
  assert.match(buildSource, /absWorkingDir: STAGING_ROOT/);
  assert.match(
    buildSource,
    /entryPoints: \[stagedEntry\(STAGING_ROOT, BUNDLE_SRC, 'background\/service-worker\.ts'\)\]/,
  );
  assert.match(
    buildSource,
    /entryPoints: \[stagedEntry\(STAGING_ROOT, BUNDLE_SRC, 'popup\/popup\.ts'\)\]/,
  );
  assert.match(buildSource, /entryPoints: \[stagedEntry\(STAGING_ROOT, BUNDLE_SRC, entry\)\]/);
  assert.doesNotMatch(buildSource, /entryPoints: \[resolve\(BUNDLE_SRC/);
  assert.doesNotMatch(buildSource, /entryPoints: \[entryPath\]/);
  assert.match(buildSource, /assertNoStagingPath\(BUILD, STAGING_ROOT\)/);
});

test('reproducibility helpers are path-independent and fail closed on leaked paths', () => {
  assert.equal(
    stagedEntry('/tmp/build-a', '/tmp/build-a/src', 'background/service-worker.ts'),
    'src/background/service-worker.ts',
  );
  assert.equal(
    stagedEntry('/tmp/build-b', '/tmp/build-b/src', 'background/service-worker.ts'),
    'src/background/service-worker.ts',
  );

  const stagingRoot = mkdtempSync(join(tmpdir(), 'csboard-extension-build-'));
  const artifactRoot = mkdtempSync(join(tmpdir(), 'csboard-artifact-test-'));
  try {
    const nested = join(artifactRoot, 'content');
    mkdirSync(nested);
    const bundle = join(nested, 'inventory.js');
    writeFileSync(bundle, '// src/content-scripts/steam/inventory.ts\n');
    assert.doesNotThrow(() => assertNoStagingPath(artifactRoot, stagingRoot));

    writeFileSync(bundle, `// ${stagingRoot}/src/content-scripts/steam/inventory.ts\n`);
    assert.throws(
      () => assertNoStagingPath(artifactRoot, stagingRoot),
      /Build artifact leaks non-deterministic staging path/,
    );

    writeFileSync(bundle, '// /private/tmp/csboard-extension-build-Other123/src/inventory.ts\n');
    assert.throws(
      () => assertNoStagingPath(artifactRoot, stagingRoot),
      /Build artifact leaks non-deterministic staging path/,
    );
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('bundled package detection preserves licenses for relative and absolute metafile paths', () => {
  assert.equal(
    bundledPackageName('node_modules/buffer/index.js'),
    'buffer',
  );
  assert.equal(
    bundledPackageName('node_modules/@csfloat/cs2-inspect-serializer/dist/index.mjs'),
    '@csfloat/cs2-inspect-serializer',
  );
  assert.equal(
    bundledPackageName('/tmp/build/node_modules/crc-32/crc32.js'),
    'crc-32',
  );
  assert.equal(
    bundledPackageName('C:\\build\\node_modules\\base64-js\\index.js'),
    'base64-js',
  );
  assert.equal(bundledPackageName('vendor-node_modules/fake/index.js'), null);
  assert.equal(bundledPackageName('src/shared/config.ts'), null);
});
