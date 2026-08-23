#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { relative, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const buildDir = resolve(root, 'build');
const releasesDir = resolve(root, 'artifacts/releases');
const profilePath = resolve(root, 'artifacts/build-profile.json');
const mode = process.argv[2];

function fail(message) {
  console.error(`[package-release] ${message}`);
  process.exit(1);
}

if (mode !== '--store' && mode !== '--local-preflight') {
  fail('choose exactly --store or --local-preflight');
}
if (!existsSync(resolve(buildDir, 'manifest.json')) || !existsSync(profilePath)) {
  fail('the matching build and artifacts/build-profile.json are required first');
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(buildDir, 'manifest.json'), 'utf8'));
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
if (profile.extensionVersion !== manifest.version || manifest.version !== pkg.version) {
  fail('package, manifest and build-profile versions do not match');
}

const exactHosts = new Set(['https://csboard.com', 'https://csboard.trade']);
if (!Array.isArray(profile.gatewayHosts) || profile.gatewayHosts.length !== exactHosts.size ||
    new Set(profile.gatewayHosts).size !== exactHosts.size ||
    profile.gatewayHosts.some((host) => !exactHosts.has(host))) {
  fail('build profile does not contain the two exact production gateway origins');
}

let sourceCommit = null;
let sourceDirty = null;
try {
  sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  sourceDirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }).trim() !== '';
} catch {
  // A local preflight can still be reproduced outside git. Store cannot.
}

const isStore = mode === '--store';
if (isStore) {
  if (profile.profile !== 'store' || profile.gatewayRootConfigured !== true ||
      typeof profile.gatewayRootKid !== 'string' ||
      !/^[A-Za-z0-9._-]{3,128}$/.test(profile.gatewayRootKid) ||
      typeof profile.gatewayRootFingerprintSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(profile.gatewayRootFingerprintSha256)) {
    fail('Store packaging requires a store build with a pinned public discovery root');
  }
  if (/test|dev|local|example/i.test(profile.gatewayRootKid)) {
    fail(`refusing non-production discovery root kid: ${profile.gatewayRootKid}`);
  }
  if (!sourceCommit || sourceDirty !== false) {
    fail('Store packaging requires a clean committed source tree for provenance');
  }
} else if (profile.profile !== 'local' || profile.gatewayRootConfigured !== false) {
  fail('Local preflight requires a default fail-closed local build without a root key');
}

// Gate the exact files that are about to be archived.
execFileSync(process.execPath, [resolve(root, 'scripts/audit-capabilities.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
execFileSync(process.execPath, [
  '--test',
  resolve(root, 'test-artifact/external-router.test.mjs'),
], { cwd: root, stdio: 'inherit' });
if (isStore) {
  // A store archive is only emitted after the built popup proves the complete
  // pair -> sync -> unpair -> re-pair lifecycle in a real browser. The smoke
  // runner keeps Playwright and Chrome paths configurable for release hosts.
  execFileSync('npm', ['run', 'test:e2e:popup'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
}

function lexicalCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir).sort(lexicalCompare)) {
    const path = resolve(dir, name);
    const rel = relative(buildDir, path).replaceAll('\\', '/');
    if (name.startsWith('_') || name === '.DS_Store' || /\s\d+(\.[\w]+)?$/.test(name)) {
      fail(`forbidden artifact path: ${rel}`);
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`release artifact contains a symlink: ${rel}`);
    if (stat.isDirectory()) files.push(...walk(path));
    else if (stat.isFile()) files.push({ name: rel, contents: readFileSync(path) });
  }
  return files;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const output = Buffer.allocUnsafe(2);
  output.writeUInt16LE(value, 0);
  return output;
}

function u32(value) {
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32LE(value >>> 0, 0);
  return output;
}

function createZipEntry(name, contents, offset) {
  const nameBytes = Buffer.from(name, 'utf8');
  const compressed = deflateRawSync(contents, { level: 9 });
  const crc = crc32(contents);
  const flags = 0x0800; // UTF-8 file names.
  const method = 8;
  const dosTime = 0;
  const dosDate = 0x21; // 1980-01-01: deterministic and timezone-independent.
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(flags), u16(method), u16(dosTime), u16(dosDate),
    u32(crc), u32(compressed.length), u32(contents.length), u16(nameBytes.length),
    u16(0), nameBytes, compressed,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50), u16(0x0314), u16(20), u16(flags), u16(method), u16(dosTime),
    u16(dosDate), u32(crc), u32(compressed.length), u32(contents.length),
    u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
    u32(0o100644 << 16), u32(offset), nameBytes,
  ]);
  return { local, central };
}

const files = walk(buildDir);
if (!isStore) {
  files.push({
    name: 'UNCONFIGURED-NOT-FOR-WEB-STORE.txt',
    contents: Buffer.from(
      'Local preflight only. Portfolio gateway root is intentionally unconfigured. Do not upload this archive to Chrome Web Store.\n',
      'utf8',
    ),
  });
}
files.sort((a, b) => lexicalCompare(a.name, b.name));
if (files.length === 0 || files.length > 0xffff) fail('invalid Zip32 file count');

const localParts = [];
const centralParts = [];
let offset = 0;
for (const file of files) {
  if (file.contents.length > 0xffffffff || offset > 0xffffffff) {
    fail(`Zip32 size limit exceeded at ${file.name}`);
  }
  const entry = createZipEntry(file.name, file.contents, offset);
  localParts.push(entry.local);
  centralParts.push(entry.central);
  offset += entry.local.length;
}
const central = Buffer.concat(centralParts);
if (central.length > 0xffffffff || offset > 0xffffffff) fail('Zip32 archive limit exceeded');
const end = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
  u32(central.length), u32(offset), u16(0),
]);
const archive = Buffer.concat([...localParts, central, end]);
const digest = createHash('sha256').update(archive).digest('hex');
const suffix = isStore ? 'store' : 'local-preflight';
const archiveName = `csboard-extension-${pkg.version}-${suffix}.zip`;

function deterministicSpdxSbom() {
  let raw;
  try {
    raw = execFileSync('npm', [
      'sbom',
      '--package-lock-only',
      '--omit=dev',
      '--sbom-format',
      'spdx',
      '--sbom-type',
      'application',
    ], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim() : '';
    fail(`unable to generate SPDX SBOM${detail ? `: ${detail}` : ''}`);
  }

  const sbom = JSON.parse(raw);
  const lockDigest = createHash('sha256')
    .update(readFileSync(resolve(root, 'package-lock.json')))
    .digest('hex');
  let created = '1970-01-01T00:00:00.000Z';
  if (sourceCommit) {
    try {
      created = new Date(execFileSync('git', [
        'show', '-s', '--format=%cI', sourceCommit,
      ], { cwd: root, encoding: 'utf8' }).trim()).toISOString();
    } catch {
      // The epoch fallback keeps non-git preflight output deterministic.
    }
  }

  sbom.documentNamespace = `https://csboard.com/sbom/csboard-extension/${pkg.version}/${suffix}/${lockDigest}/${digest}`;
  sbom.creationInfo = {
    created,
    creators: ['Tool: CSBOARD deterministic release packager/1'],
  };
  if (Array.isArray(sbom.packages)) {
    sbom.packages.sort((left, right) => lexicalCompare(left.SPDXID ?? '', right.SPDXID ?? ''));
    const describedId = Array.isArray(sbom.documentDescribes) ? sbom.documentDescribes[0] : null;
    const application = sbom.packages.find((entry) => entry.SPDXID === describedId);
    if (application) {
      application.packageFileName = archiveName;
      application.checksums = [{ algorithm: 'SHA256', checksumValue: digest }];
    }
  }
  if (Array.isArray(sbom.relationships)) {
    sbom.relationships.sort((left, right) => lexicalCompare(
      `${left.spdxElementId ?? ''}\0${left.relationshipType ?? ''}\0${left.relatedSpdxElement ?? ''}`,
      `${right.spdxElementId ?? ''}\0${right.relationshipType ?? ''}\0${right.relatedSpdxElement ?? ''}`,
    ));
  }
  return Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
}

const sbom = deterministicSpdxSbom();
const sbomName = `${archiveName}.sbom.spdx.json`;
const sbomDigest = createHash('sha256').update(sbom).digest('hex');

mkdirSync(releasesDir, { recursive: true });
writeFileSync(resolve(releasesDir, archiveName), archive);
writeFileSync(resolve(releasesDir, `${archiveName}.sha256`), `${digest}  ${archiveName}\n`);
writeFileSync(resolve(releasesDir, sbomName), sbom);
writeFileSync(resolve(releasesDir, `${sbomName}.sha256`), `${sbomDigest}  ${sbomName}\n`);
writeFileSync(resolve(releasesDir, `${archiveName}.json`), JSON.stringify({
  schemaVersion: 1,
  archive: archiveName,
  extensionVersion: pkg.version,
  profile: suffix,
  publishable: isStore,
  sha256: digest,
  bytes: archive.length,
  fileCount: files.length,
  sourceCommit,
  sourceDirty,
  sbom: sbomName,
  sbomSha256: sbomDigest,
  gatewayRootKid: profile.gatewayRootKid ?? null,
  gatewayRootFingerprintSha256: profile.gatewayRootFingerprintSha256 ?? null,
}, null, 2) + '\n');

console.log(`[package-release] ${isStore ? 'STORE CANDIDATE' : 'LOCAL PREFLIGHT — NOT FOR STORE'}`);
console.log(`[package-release] ${archiveName}`);
console.log(`[package-release] sha256=${digest}`);
console.log(`[package-release] sbom=${sbomName}`);
console.log(`[package-release] sbomSha256=${sbomDigest}`);
