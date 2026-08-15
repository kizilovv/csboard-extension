#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];
const fail = (message) => failures.push(message);

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.git.broken') continue;
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

const manifest = JSON.parse(readFileSync(resolve(root, 'build/manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

if (manifest.version !== pkg.version) fail(`manifest/package version mismatch: ${manifest.version} != ${pkg.version}`);
if (manifest.action?.default_popup !== 'popup/popup.html') fail('built manifest does not expose the packaged popup');

const externalOrigins = manifest.externally_connectable?.matches || [];
const exactExternal = [
  'https://csboard.com/*',
  'https://csboard.trade/*',
  'https://csfolder.com/*',
];
if (JSON.stringify(externalOrigins) !== JSON.stringify(exactExternal)) {
  fail(`externally_connectable must be the reviewed exact origins, got ${JSON.stringify(externalOrigins)}`);
}
if ((manifest.host_permissions || []).some((value) =>
  typeof value === 'string' && value.includes('csfolder.com'))) {
  fail('CSFolder external messaging must not grant CSFolder host access');
}

const forbiddenPermissions = new Set([
  'cookies',
  'debugger',
  'scripting',
  'tabs',
  'webRequest',
  'webRequestBlocking',
  'declarativeNetRequest',
  'declarativeNetRequestWithHostAccess',
]);
for (const permission of manifest.permissions || []) {
  if (forbiddenPermissions.has(permission)) fail(`forbidden broad permission: ${permission}`);
}

const expectedBuffMatches = ['https://buff.163.com/*', 'https://*.buff.163.com/*'];
const buffHostPermissions = (manifest.host_permissions || [])
  .filter((value) => typeof value === 'string' && value.includes('buff.163.com'));
if (JSON.stringify(buffHostPermissions) !== JSON.stringify(expectedBuffMatches)) {
  fail(`Buff host permissions must be exact HTTPS origins, got ${JSON.stringify(buffHostPermissions)}`);
}
const buffContent = (manifest.content_scripts || []).find((entry) =>
  Array.isArray(entry.js) && entry.js.includes('content/buff.js'));
if (!buffContent ||
    JSON.stringify(buffContent.matches) !== JSON.stringify(expectedBuffMatches) ||
    JSON.stringify(buffContent.css) !== JSON.stringify(['styles/csboard-buff.css']) ||
    buffContent.run_at !== 'document_start') {
  fail('built Buff content-script scope, stylesheet, or run_at is not exact');
}
const buffResources = (manifest.web_accessible_resources || []).find((entry) =>
  Array.isArray(entry.resources) && entry.resources.includes('injectToPage/buffInterceptor.js'));
if (!buffResources ||
    JSON.stringify(buffResources.resources) !== JSON.stringify(['injectToPage/buffInterceptor.js']) ||
    JSON.stringify(buffResources.matches) !== JSON.stringify(expectedBuffMatches)) {
  fail('Buff page-world resource scope is not exact');
}

const steamCredentialContent = (manifest.content_scripts || []).find((entry) =>
  Array.isArray(entry.js) && entry.js.includes('content/page-credential-bridge.js'));
if (!steamCredentialContent ||
    JSON.stringify(steamCredentialContent.matches) !==
      JSON.stringify(['https://steamcommunity.com/*']) ||
    steamCredentialContent.run_at !== 'document_idle' ||
    (steamCredentialContent.css || []).length !== 0) {
  fail('Steam credential bridge scope must remain exact HTTPS/document_idle with no stylesheet');
}

const sourceFiles = walk(resolve(root, 'src')).filter((file) => /\.(?:ts|js|json|html)$/.test(file));
for (const file of sourceFiles) {
  const rel = relative(root, file);
  const text = readFileSync(file, 'utf8');

  if (/https:\/\/csfloat\.com\/search/.test(text) && !/csfloat-lookup\.ts$/.test(rel)) {
    fail(`manual CSFloat search URL outside canonical builder: ${rel}`);
  }

  if (/csboard_steam_access_token/.test(text) && rel !== 'src/shared/storage.ts') {
    fail(`legacy plaintext token key outside one-way migration: ${rel}`);
  }

  if (/(?:eval\s*\(|new\s+Function\s*\(|import\s*\(\s*["']https?:)/.test(text)) {
    fail(`remote/dynamic executable code pattern: ${rel}`);
  }

  const blankAnchors = text.match(/<a\b(?=[^>]*\btarget=["']_blank["'])[^>]*>/gis) || [];
  for (const anchor of blankAnchors) {
    if (!/\brel=["'][^"']*\bnoopener\b[^"']*\bnoreferrer\b[^"']*["']/i.test(anchor)) {
      fail(`target=_blank anchor lacks noopener noreferrer: ${rel}`);
    }
  }
  if (/\.rel\s*=\s*["']noopener["']/.test(text)) {
    fail(`DOM-created external anchor lacks noreferrer: ${rel}`);
  }
}

const popupHtml = readFileSync(resolve(root, 'build/popup/popup.html'), 'utf8');
if (/\.ts(?:["?#])/.test(popupHtml)) fail('built popup references TypeScript instead of bundled JavaScript');

const builtJavascript = walk(resolve(root, 'build')).filter((file) => file.endsWith('.js'));
for (const file of builtJavascript) {
  const rel = relative(root, file);
  const text = readFileSync(file, 'utf8');
  if (/(?:\beval\s*\(|new\s+Function\s*\(|import\s*\(\s*["']https?:)/.test(text)) {
    fail(`packaged remote/dynamic executable code pattern: ${rel}`);
  }
  if (/test-only-root/i.test(text)) {
    fail(`packaged test-only gateway root leaked into artifact: ${rel}`);
  }
  if (/"d"\s*:|"k"\s*:/.test(text) && /define_CSBOARD_GATEWAY_ROOT_JWK|gatewayRoot/i.test(text)) {
    fail(`packaged gateway root appears to include private/symmetric key material: ${rel}`);
  }
}

const serviceWorkerMeta = JSON.parse(
  readFileSync(resolve(root, 'artifacts/build-meta/service-worker.json'), 'utf8'),
);
const serviceWorkerInputs = Object.keys(serviceWorkerMeta.inputs || {});
for (const forbiddenInput of [
  'src/shared/steam-trade.ts',
  'src/shared/trade-history.ts',
  'src/shared/crypto.ts',
]) {
  if (serviceWorkerInputs.includes(forbiddenInput)) {
    fail(`dangerous legacy module is reachable from the service worker: ${forbiddenInput}`);
  }
}

const serviceWorker = readFileSync(resolve(root, 'build/service-worker.js'), 'utf8');
for (const forbiddenCapability of [
  '/tradeoffer/new/send',
  'trade_offer_access_token',
  '/api/p2p/ext/',
  'P2P_CREATE_AND_ANNOTATE',
  'P2P_BUY',
  'P2P_EXECUTE',
  'createSteamTradeOffer',
]) {
  if (serviceWorker.includes(forbiddenCapability)) {
    fail(`unapproved service-worker capability is packaged: ${forbiddenCapability}`);
  }
}
const allowedTokenMigrationOccurrences = (serviceWorker.match(/csboard_steam_access_token/g) || []).length;
if (allowedTokenMigrationOccurrences > 2) {
  fail(`legacy Steam access-token storage key appears outside one-way migration (${allowedTokenMigrationOccurrences} occurrences)`);
}
if (!serviceWorker.includes('GET_EXTENSION_STATUS') ||
    !serviceWorker.includes('PAIR_AND_ENABLE_PORTFOLIO_SYNC') ||
    !serviceWorker.includes('REACTIVATE_PORTFOLIO_SYNC')) {
  fail('reviewed bounded external protocol is missing from the packaged service worker');
}

const steamCredentialBridge = readFileSync(
  resolve(root, 'build/content/page-credential-bridge.js'),
  'utf8',
);
if (!steamCredentialBridge.includes('OFFER_STEAM_PAGE_CREDENTIAL')) {
  fail('Steam credential bridge message is missing from the packaged content script');
}
for (const forbiddenCapability of [
  'chrome.storage',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'fetch(',
  'XMLHttpRequest',
  'sendBeacon',
]) {
  if (steamCredentialBridge.includes(forbiddenCapability)) {
    fail(`Steam credential bridge includes forbidden capability: ${forbiddenCapability}`);
  }
}

const buffInterceptor = readFileSync(
  resolve(root, 'build/injectToPage/buffInterceptor.js'),
  'utf8',
);
for (const forbiddenCapability of [
  'document.cookie',
  'localStorage',
  'sessionStorage',
  'window.g',
  'XMLHttpRequest.prototype.send',
  'chrome.runtime',
]) {
  if (buffInterceptor.includes(forbiddenCapability)) {
    fail(`Buff interceptor includes forbidden capability: ${forbiddenCapability}`);
  }
}
if (!buffInterceptor.includes("requestMethod === 'GET'") ||
    !buffInterceptor.includes("meta.method !== 'GET'") ||
    !buffInterceptor.includes('MAX_JSON_BYTES = 1_500_000')) {
  fail('Buff interceptor no longer proves GET-only capture with the reviewed response cap');
}
const xhrJsonBranch = buffInterceptor.match(
  /if \(this\.responseType === 'json'\) \{([\s\S]*?)\n\s*\}/,
)?.[1] ?? '';
if (!xhrJsonBranch.includes('Fail closed') ||
    /emitApiResponse|JSON\.stringify|this\.response/.test(xhrJsonBranch)) {
  fail('Buff XHR responseType=json must remain fail-closed before object allocation/stringification');
}

const buffBundle = readFileSync(resolve(root, 'build/content/buff.js'), 'utf8');
for (const forbiddenCapability of [
  '/api/p2p/',
  'PAIR_DEVICE',
  'RUN_MANUAL_SYNC',
  'FETCH_STEAM_TRADE_OFFERS',
  'FETCH_TRADE_HISTORY',
  'FETCH_INVENTORY_WITH_PROPERTIES',
]) {
  if (buffBundle.includes(forbiddenCapability)) {
    fail(`Buff content bundle reaches an unrelated privileged capability: ${forbiddenCapability}`);
  }
}

if (failures.length) {
  console.error('[capability-audit] FAIL');
  for (const message of failures) console.error(` - ${message}`);
  process.exit(1);
}

console.log('[capability-audit] PASS');
