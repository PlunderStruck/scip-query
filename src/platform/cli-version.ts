import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileWithinLimit, SMALL_ARTIFACT_MAX_BYTES } from '../filesystem/bounded-file.js';

const require = createRequire(import.meta.url);

/** The installed scip-query package version that produced persistent artifacts. */
const packageInfo = loadCliPackageInfo();
export const cliVersion = packageInfo.version;

let buildIdentity: string | undefined;

/**
 * Identify this package's runtime bytes, including fixed-name implementation
 * bundles. The caller's launcher is unrelated when the package is used as a library.
 * Memoization pins cache identity for this process; unreadable installations get
 * a process-private identity so they cannot reuse another process's artifacts.
 */
export function cliBuildIdentity(): string {
  if (buildIdentity !== undefined) return buildIdentity;
  try {
    if (!packageInfo.path) throw new Error('Package location unavailable');
    const root = dirname(packageInfo.path);
    const location = relative(root, fileURLToPath(import.meta.url));
    const runtimeDirectory = location.startsWith(`src${sep}`) ? 'src' : 'dist';
    buildIdentity = packageRuntimeIdentity(root, runtimeDirectory);
  } catch {
    buildIdentity = `unavailable:${randomUUID()}`;
  }
  return buildIdentity;
}

/** Hash the complete runtime tree with relative names so installation location is irrelevant. */
export function packageRuntimeIdentity(root: string, runtimeDirectory: 'src' | 'dist'): string {
  const hash = createHash('sha256').update('scip-query-runtime-v2\0');
  const extensions =
    runtimeDirectory === 'src'
      ? new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'])
      : new Set(['.js', '.mjs', '.cjs', '.json']);
  const files = runtimeFiles(join(root, runtimeDirectory), extensions);
  if (files.length === 0) throw new Error('Package runtime is empty');
  for (const file of [join(root, 'package.json'), ...files]) {
    const bytes = readFileWithinLimit(file, {
      maxBytes: SMALL_ARTIFACT_MAX_BYTES,
      inputKind: 'Package runtime input',
    });
    hash.update(relative(root, file).split(sep).join('/')).update('\0');
    hash.update(String(bytes.length)).update('\0').update(bytes);
  }
  return hash.digest('hex').slice(0, 16);
}

function runtimeFiles(directory: string, extensions: ReadonlySet<string>): string[] {
  const files: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...runtimeFiles(path, extensions));
    else if (!entry.isFile()) throw new Error(`Unsupported runtime entry: ${path}`);
    else if (extensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function loadCliPackageInfo(): { version: string; path?: string } {
  for (const path of ['../package.json', '../../package.json']) {
    try {
      const info = require(path) as { name?: string; version?: string };
      if (info.name === 'scip-query' && typeof info.version === 'string') {
        return { version: info.version, path: require.resolve(path) };
      }
    } catch {
      // Source modules live in src/platform; bundled modules live in dist.
    }
  }
  return { version: '0.0.0' };
}
