import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export function stagedEntry(stagingRoot, bundleSrc, entryPath) {
  return relative(stagingRoot, resolve(bundleSrc, entryPath)).replaceAll('\\', '/');
}

export function bundledPackageName(inputPath) {
  const normalized = inputPath.replaceAll('\\', '/');
  const relativeMarker = 'node_modules/';
  const absoluteMarker = '/node_modules/';
  const packagePath = normalized.startsWith(relativeMarker)
    ? normalized.slice(relativeMarker.length)
    : normalized.lastIndexOf(absoluteMarker) >= 0
      ? normalized.slice(normalized.lastIndexOf(absoluteMarker) + absoluteMarker.length)
      : null;
  if (packagePath === null) return null;
  const parts = packagePath.split('/');
  if (!parts[0]) return null;
  if (!parts[0].startsWith('@')) return parts[0];
  return parts[1] ? `${parts[0]}/${parts[1]}` : null;
}

export function assertNoStagingPath(dir, stagingRoot) {
  const normalizedStagingRoot = stagingRoot.replaceAll('\\', '/');
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) {
      assertNoStagingPath(path, stagingRoot);
      continue;
    }
    if (!name.endsWith('.js')) continue;
    const source = readFileSync(path, 'utf8').replaceAll('\\', '/');
    if (source.includes(normalizedStagingRoot) ||
        /csboard-extension-build-[A-Za-z0-9]+/.test(source)) {
      throw new Error(`Build artifact leaks non-deterministic staging path: ${path}`);
    }
  }
}
