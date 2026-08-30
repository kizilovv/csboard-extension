#!/usr/bin/env node
// ── CSBoard Extension Build Script ────────────────────────────
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, rmSync, statSync, mkdtempSync, symlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import {
  assertNoStagingPath,
  bundledPackageName,
  stagedEntry,
} from './scripts/build-reproducibility.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, 'src');
const BUILD = resolve(__dirname, 'build');
const BUILD_META = resolve(__dirname, 'artifacts/build-meta');
const BUILD_PROFILE = resolve(__dirname, 'artifacts/build-profile.json');
const metafiles = new Map();

function bundle(name, options) {
  const result = buildSync({ ...options, metafile: true });
  metafiles.set(name, result.metafile);
}

function normalizeMetaPath(path) {
  if (path.startsWith('<')) return path;
  const normalized = path.replace(/\\/g, '/');
  for (const marker of ['/src/', '/node_modules/', '/build/']) {
    const index = normalized.lastIndexOf(marker);
    if (index >= 0) return normalized.slice(index + 1);
  }
  return normalized;
}

function normalizeMetafile(metafile) {
  const normalizeImports = (imports = []) => imports.map((entry) => ({
    ...entry,
    path: normalizeMetaPath(entry.path),
  }));
  return {
    inputs: Object.fromEntries(Object.entries(metafile.inputs).map(([path, input]) => [
      normalizeMetaPath(path),
      { ...input, imports: normalizeImports(input.imports) },
    ])),
    outputs: Object.fromEntries(Object.entries(metafile.outputs).map(([path, output]) => [
      normalizeMetaPath(path),
      {
        ...output,
        ...(output.entryPoint ? { entryPoint: normalizeMetaPath(output.entryPoint) } : {}),
        imports: normalizeImports(output.imports),
        inputs: Object.fromEntries(Object.entries(output.inputs || {}).map(([inputPath, value]) => [
          normalizeMetaPath(inputPath),
          value,
        ])),
      },
    ])),
  };
}

const gatewayHosts = (process.env.CSBOARD_GATEWAY_HOSTS ||
  'https://csboard.com,https://csboard.trade')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
let gatewayRootJwk = null;
if (process.env.CSBOARD_GATEWAY_ROOT_JWK) {
  try {
    gatewayRootJwk = JSON.parse(process.env.CSBOARD_GATEWAY_ROOT_JWK);
  } catch {
    throw new Error('CSBOARD_GATEWAY_ROOT_JWK must be valid JSON');
  }
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// esbuild parses every ancestor package.json while discovering package
// boundaries. This repository may live inside a larger, independently edited
// workspace; a conflict in that parent must not mutate or block this artifact.
// Bundle an exact temporary snapshot under the OS temp root, with the local
// dependency tree symlinked and preserved as its package boundary.
const STAGING_ROOT = mkdtempSync(resolve(tmpdir(), 'csboard-extension-build-'));
const BUNDLE_SRC = resolve(STAGING_ROOT, 'src');
cpSync(SRC, BUNDLE_SRC, { recursive: true });
cpSync(resolve(__dirname, 'package.json'), resolve(STAGING_ROOT, 'package.json'));
symlinkSync(resolve(__dirname, 'node_modules'), resolve(STAGING_ROOT, 'node_modules'), 'dir');
process.on('exit', () => rmSync(STAGING_ROOT, { recursive: true, force: true }));

// ── Clean Chrome junk before build ───────────────────────────
// Chrome rejects extensions where any file/dir name starts with "_" (those
// are reserved), and macOS / iCloud sync sometimes spawns " 2", " 3" etc
// duplicates. Strip all of them recursively before bundling.
function purgeJunk(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = resolve(dir, f);
    // Reserved names ("_metadata", "_metadata 2", any "_*" file/dir)
    if (f.startsWith('_')) {
      rmSync(p, { recursive: true, force: true });
      continue;
    }
    // " 2", " 3" duplicate suffix: matches both dirs ("content 2") and files
    // ("inventoryExtractor 2.js" → " 2.js" tail).
    if (/\s\d+(\.[\w]+)?$/.test(f)) {
      rmSync(p, { recursive: true, force: true });
      continue;
    }
    if (statSync(p).isDirectory()) purgeJunk(p);
  }
}

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });

// ── Common esbuild options ───────────────────────────────────
const common = {
  absWorkingDir: STAGING_ROOT,
  bundle: true,
  platform: 'browser',
  target: 'chrome110',
  format: 'iife',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  loader: { '.json': 'json', '.js': 'js' },
  preserveSymlinks: true,
  define: {
    'process.env.NODE_ENV': '"production"',
    __CSBOARD_GATEWAY_HOSTS__: JSON.stringify(gatewayHosts),
    __CSBOARD_GATEWAY_ROOT_JWK__: JSON.stringify(gatewayRootJwk),
  },
};

// ── Build service worker ─────────────────────────────────────
console.log('Building service worker...');
bundle('service-worker', {
  ...common,
  entryPoints: [stagedEntry(STAGING_ROOT, BUNDLE_SRC, 'background/service-worker.ts')],
  outfile: resolve(BUILD, 'service-worker.js'),
  format: 'esm',
});

// ── Build popup ──────────────────────────────────────────────
// Chrome executes the built JavaScript artifact. The source HTML intentionally
// references popup.ts for Vite development; the packaged HTML is rewritten to
// popup.js and is checked below so TypeScript can never become the runtime entry.
console.log('Building popup...');
const popupBuildDir = resolve(BUILD, 'popup');
mkdirSync(popupBuildDir, { recursive: true });
bundle('popup', {
  ...common,
  entryPoints: [stagedEntry(STAGING_ROOT, BUNDLE_SRC, 'popup/popup.ts')],
  outfile: resolve(popupBuildDir, 'popup.js'),
});

const popupSourceHtml = readFileSync(resolve(SRC, 'popup/popup.html'), 'utf-8');
const popupBuildHtml = popupSourceHtml.replace(
  /src=(['"])popup\.ts\1/g,
  'src="popup.js"',
);
if (popupBuildHtml.includes('popup.ts')) {
  throw new Error('Popup build still references TypeScript');
}
writeFileSync(resolve(popupBuildDir, 'popup.html'), popupBuildHtml);
cpSync(resolve(SRC, 'popup/popup.css'), resolve(popupBuildDir, 'popup.css'));

// ── Build content scripts ────────────────────────────────────
const contentScripts = [
  { entry: 'content-scripts/steam/trade-offer.ts', out: 'content/trade-offer.js' },
  { entry: 'content-scripts/steam/inventory.ts', out: 'content/inventory.js' },
  { entry: 'content-scripts/steam/trade-offers.ts', out: 'content/trade-offers.js' },
  { entry: 'content-scripts/steam/trade-history.ts', out: 'content/trade-history.js' },
  { entry: 'content-scripts/steam/market.ts', out: 'content/market.js' },
  { entry: 'content-scripts/csfloat/csfloat.ts', out: 'content/csfloat.js' },
  { entry: 'content-scripts/buff/buff.ts', out: 'content/buff.js' },
];

// Check for additional content scripts.
// Only ones the manifest actually registers: modules that exist purely to be
// imported by another content script (sell-ui.ts) would otherwise ship as an
// extra unreferenced bundle in the Web Store package.
const manifestForEntries = JSON.parse(readFileSync(resolve(SRC, 'manifest.json'), 'utf-8'));
const manifestEntries = new Set(
  (manifestForEntries.content_scripts || [])
    .flatMap((cs) => cs.js || [])
    .map((p) => p.replace(/^src\//, '')),
);

const steamDir = resolve(SRC, 'content-scripts/steam');
const existingEntries = new Set(contentScripts.map(s => s.entry));
if (existsSync(steamDir)) {
  for (const f of readdirSync(steamDir)) {
    if (f.endsWith('.ts') && !f.startsWith('_')) {
      const entry = `content-scripts/steam/${f}`;
      if (!existingEntries.has(entry) && manifestEntries.has(entry)) {
        const outName = f.replace('.ts', '.js');
        contentScripts.push({ entry, out: `content/${outName}` });
      }
    }
  }
}

console.log(`Building ${contentScripts.length} content scripts...`);

for (const { entry, out } of contentScripts) {
  const entryPath = resolve(BUNDLE_SRC, entry);
  if (!existsSync(entryPath)) {
    console.warn(`  ⚠ Skipping ${entry} (not found)`);
    continue;
  }
  mkdirSync(dirname(resolve(BUILD, out)), { recursive: true });
  bundle(out.replace(/[^a-z0-9.-]+/gi, '_'), {
    ...common,
    entryPoints: [stagedEntry(STAGING_ROOT, BUNDLE_SRC, entry)],
    outfile: resolve(BUILD, out),
  });
}

// ── Generate manifest.json ────────────────────────────────────
const srcManifest = JSON.parse(readFileSync(resolve(SRC, 'manifest.json'), 'utf-8'));

// Transform manifest: rewrite paths from src/ to build/
const buildManifest = {
  ...srcManifest,
  background: {
    service_worker: 'service-worker.js',
    type: 'module',
  },
  content_scripts: (srcManifest.content_scripts || []).map((cs) => ({
    ...cs,
    js: (cs.js || []).map((jsPath) => {
      // src/content-scripts/steam/foo.ts → content/foo.js
      const name = jsPath.split('/').pop().replace('.ts', '.js');
          return `content/${name}`;
    }),
    css: (cs.css || []).map((cssPath) => {
      const name = cssPath.split('/').pop();
      return `styles/${name}`;
    }),
  })),
};

/*
  The declarative ruleset is a manifest path too, and it is easy to forget.

  Chrome refuses to LOAD an extension whose rule_resources point at a file that
  is not in the package — the whole add-on fails, not just the rule. The source
  manifest names `src/steamcommunity_ruleset.json`; the packaged one has no
  `src/`, so rewrite the path here and copy the file below.
*/
if (srcManifest.declarative_net_request?.rule_resources) {
  buildManifest.declarative_net_request = {
    ...srcManifest.declarative_net_request,
    rule_resources: srcManifest.declarative_net_request.rule_resources.map((r) => ({
      ...r,
      path: r.path.split('/').pop(),
    })),
  };
}

writeFileSync(resolve(BUILD, 'manifest.json'), JSON.stringify(buildManifest, null, 2));

// ── Copy static assets ────────────────────────────────────────

// Declarative net request rulesets, named by the manifest above.
for (const r of srcManifest.declarative_net_request?.rule_resources ?? []) {
  const name = r.path.split('/').pop();
  cpSync(resolve(SRC, name), resolve(BUILD, name));
}

// Styles
mkdirSync(resolve(BUILD, 'styles'), { recursive: true });
if (existsSync(resolve(SRC, 'styles'))) {
  for (const f of readdirSync(resolve(SRC, 'styles'))) {
    if (f.endsWith('.css')) {
      cpSync(resolve(SRC, 'styles', f), resolve(BUILD, 'styles', f));
    }
  }
}

// Icons
mkdirSync(resolve(BUILD, 'icons'), { recursive: true });
if (existsSync(resolve(SRC, 'icons'))) {
  for (const f of readdirSync(resolve(SRC, 'icons'))) {
    if (f.endsWith('.png')) {
      cpSync(resolve(SRC, 'icons', f), resolve(BUILD, 'icons', f));
    }
  }
}

// InjectToPage scripts (JS files loaded via <script src>)
mkdirSync(resolve(BUILD, 'injectToPage'), { recursive: true });
if (existsSync(resolve(SRC, 'injectToPage'))) {
  for (const f of readdirSync(resolve(SRC, 'injectToPage'))) {
    if (f.endsWith('.js')) {
      cpSync(resolve(SRC, 'injectToPage', f), resolve(BUILD, 'injectToPage', f));
    }
  }
}

// Extension pages (HTML + JS)
mkdirSync(resolve(BUILD, 'pages'), { recursive: true });
if (existsSync(resolve(SRC, 'pages'))) {
  for (const f of readdirSync(resolve(SRC, 'pages'))) {
    cpSync(resolve(SRC, 'pages', f), resolve(BUILD, 'pages', f));
  }
}

// Ship the same license/privacy boundary that was reviewed with the code.
for (const name of ['LICENSE', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md']) {
  const source = resolve(__dirname, name);
  if (existsSync(source)) cpSync(source, resolve(BUILD, name));
}

// Preserve the exact upstream license text for every package actually present
// in an esbuild dependency graph, including transitive browser polyfills.
const bundledPackages = new Set();
for (const metafile of metafiles.values()) {
  for (const input of Object.keys(metafile.inputs || {})) {
    const packageName = bundledPackageName(input);
    if (packageName) bundledPackages.add(packageName);
  }
}
const licenseDir = resolve(BUILD, 'third_party_licenses');
mkdirSync(licenseDir, { recursive: true });
for (const packageName of [...bundledPackages].sort()) {
  const packageDir = resolve(__dirname, 'node_modules', packageName);
  const packageJson = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'));
  const licenseName = readdirSync(packageDir).find((name) => /^licen[cs]e(?:\.|$)/i.test(name));
  if (!licenseName) throw new Error(`Missing bundled license for ${packageName}`);
  const safeName = packageName.replace(/^@/, '').replace('/', '__');
  writeFileSync(
    resolve(licenseDir, `${safeName}.txt`),
    `${packageName} ${packageJson.version ?? 'unknown'} (${packageJson.license ?? 'see text'})\n\n` +
      readFileSync(resolve(packageDir, licenseName), 'utf8'),
  );
}

// Final sweep — guarantees we never leave Chrome-reserved or duplicate files
// behind, regardless of previous state.
purgeJunk(BUILD);

// A random mkdtemp suffix in esbuild's source-boundary comments makes two
// builds from the same commit produce different Store archives. Relative entry
// points should prevent it; keep this fail-closed assertion so a future esbuild
// change cannot silently break reproducibility or leak a local build path.
assertNoStagingPath(BUILD, STAGING_ROOT);

rmSync(BUILD_META, { recursive: true, force: true });
mkdirSync(BUILD_META, { recursive: true });
for (const [name, metafile] of metafiles) {
  writeFileSync(
    resolve(BUILD_META, `${name}.json`),
    JSON.stringify(normalizeMetafile(metafile), null, 2),
  );
}
purgeJunk(BUILD_META);

writeFileSync(BUILD_PROFILE, JSON.stringify({
  profile: process.env.CSBOARD_EXTENSION_BUILD_PROFILE === 'store' ? 'store' : 'local',
  extensionVersion: buildManifest.version,
  gatewayHosts,
  gatewayRootConfigured: gatewayRootJwk !== null,
  gatewayRootKid: gatewayRootJwk?.kid ?? null,
  gatewayRootFingerprintSha256: gatewayRootJwk ? sha256(stableJson(gatewayRootJwk)) : null,
}, null, 2));

console.log(`\n✅ Build complete!`);
console.log(`   Service worker: service-worker.js`);
console.log(`   Content scripts: ${contentScripts.length} IIFE bundles`);
console.log(`   Output: ${BUILD}`);
