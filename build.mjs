#!/usr/bin/env node
// ── CSBoard Extension Build Script ────────────────────────────
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, rmSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, 'src');
const BUILD = resolve(__dirname, 'build');

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

mkdirSync(BUILD, { recursive: true });
purgeJunk(BUILD);
purgeJunk(SRC);

// ── Common esbuild options ───────────────────────────────────
const common = {
  bundle: true,
  platform: 'browser',
  target: 'chrome110',
  format: 'iife',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  loader: { '.json': 'json', '.js': 'js' },
  define: { 'process.env.NODE_ENV': '"production"' },
};

// ── Build service worker ─────────────────────────────────────
console.log('Building service worker...');
buildSync({
  ...common,
  entryPoints: [resolve(SRC, 'background/service-worker.ts')],
  outfile: resolve(BUILD, 'service-worker.js'),
  format: 'esm',
});

// ── Build content scripts ────────────────────────────────────
const contentScripts = [
  { entry: 'content-scripts/steam/trade-offer.ts', out: 'content/trade-offer.js' },
  { entry: 'content-scripts/steam/inventory.ts', out: 'content/inventory.js' },
  { entry: 'content-scripts/steam/trade-offers.ts', out: 'content/trade-offers.js' },
  { entry: 'content-scripts/steam/trade-history.ts', out: 'content/trade-history.js' },
  { entry: 'content-scripts/steam/market.ts', out: 'content/market.js' },
  { entry: 'content-scripts/csfloat/csfloat.ts', out: 'content/csfloat.js' },
];

// Check for additional content scripts
const steamDir = resolve(SRC, 'content-scripts/steam');
const existingEntries = new Set(contentScripts.map(s => s.entry));
if (existsSync(steamDir)) {
  for (const f of readdirSync(steamDir)) {
    if (f.endsWith('.ts') && !f.startsWith('_')) {
      const entry = `content-scripts/steam/${f}`;
      if (!existingEntries.has(entry)) {
        const outName = f.replace('.ts', '.js');
        contentScripts.push({ entry, out: `content/${outName}` });
      }
    }
  }
}

console.log(`Building ${contentScripts.length} content scripts...`);

for (const { entry, out } of contentScripts) {
  const entryPath = resolve(SRC, entry);
  if (!existsSync(entryPath)) {
    console.warn(`  ⚠ Skipping ${entry} (not found)`);
    continue;
  }
  mkdirSync(dirname(resolve(BUILD, out)), { recursive: true });
  buildSync({
    ...common,
    entryPoints: [entryPath],
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
  declarative_net_request: {
    rule_resources: [
      {
        id: 'steamcommunity_ruleset',
        enabled: true,
        path: 'rules/steamcommunity_ruleset.json',
      },
    ],
  },
};

writeFileSync(resolve(BUILD, 'manifest.json'), JSON.stringify(buildManifest, null, 2));

// ── Copy static assets ────────────────────────────────────────

// Styles
mkdirSync(resolve(BUILD, 'styles'), { recursive: true });
if (existsSync(resolve(SRC, 'styles/csboard-overlay.css'))) {
  cpSync(resolve(SRC, 'styles/csboard-overlay.css'), resolve(BUILD, 'styles/csboard-overlay.css'));
}

// Declarative net request rules
mkdirSync(resolve(BUILD, 'rules'), { recursive: true });
if (existsSync(resolve(SRC, 'steamcommunity_ruleset.json'))) {
  cpSync(resolve(SRC, 'steamcommunity_ruleset.json'), resolve(BUILD, 'rules/steamcommunity_ruleset.json'));
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

// Final sweep — guarantees we never leave Chrome-reserved or duplicate files
// behind, regardless of previous state.
purgeJunk(BUILD);

console.log(`\n✅ Build complete!`);
console.log(`   Service worker: service-worker.js`);
console.log(`   Content scripts: ${contentScripts.length} IIFE bundles`);
console.log(`   Output: ${BUILD}`);
