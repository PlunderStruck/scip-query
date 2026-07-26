import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertOwnedCacheDir,
  CACHE_OWNERSHIP_FILE,
  hardenOwnedCacheTreeIfOwned,
  resolveIndexStoragePaths,
} from '../../src/platform/cache-layout.js';

const roots: string[] = [];
const originalCacheDirectory = process.env['SCIP_QUERY_CACHE_DIR'];
const originalXdgCache = process.env['XDG_CACHE_HOME'];

afterEach(() => {
  restoreEnvironment('SCIP_QUERY_CACHE_DIR', originalCacheDirectory);
  restoreEnvironment('XDG_CACHE_HOME', originalXdgCache);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('owned project caches', () => {
  it.each([
    ['absolute', (root: string) => join(dirnameOf(root), 'external')],
    ['parent traversal', () => '../external'],
    ['project root', () => '.'],
  ])('rejects an unsafe tracked dbPath: %s', (_label, configuredPath) => {
    const root = project();
    expect(() => resolveIndexStoragePaths(root, { dbPath: configuredPath(root) })).toThrow(
      'refusing unsafe project dbPath',
    );
  });

  it('rejects a configured symlink escape before creating an external cache directory', () => {
    const root = project();
    const outside = project();
    symlinkSync(outside, join(root, 'linked'));

    expect(() => resolveIndexStoragePaths(root, { dbPath: 'linked/cache' })).toThrow('symlink-escape');
    expect(() => statSync(join(outside, 'cache'))).toThrow();
  });

  it('creates a private ownership record for a safe relative cache', () => {
    const root = project();
    const paths = resolveIndexStoragePaths(root, { dbPath: '.scip-cache' });
    const proof = assertOwnedCacheDir(root, paths.cacheDir);

    expect(proof.record).toMatchObject({
      schemaVersion: 1,
      canonicalProjectRoot: realpathSync(root),
      canonicalCacheDir: paths.cacheDir,
    });
    if (process.platform !== 'win32') {
      expect(statSync(paths.cacheDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(paths.cacheDir, CACHE_OWNERSHIP_FILE)).mode & 0o777).toBe(0o600);
    }
  });

  it('repairs file and directory modes only for an owned cache tree', () => {
    const root = project();
    const paths = resolveIndexStoragePaths(root, { dbPath: '.scip-cache' });
    const nestedDirectory = join(paths.cacheDir, 'typescript-index', 'responses');
    const response = join(nestedDirectory, 'response.json');
    mkdirSync(nestedDirectory, { recursive: true, mode: 0o755 });
    writeFileSync(response, '{}\n', { mode: 0o644 });

    expect(hardenOwnedCacheTreeIfOwned(root, paths.cacheDir)).toBe(true);
    expect(hardenOwnedCacheTreeIfOwned(root, join(root, 'absent-cache'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(nestedDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(response).mode & 0o777).toBe(0o600);
    }
  });

  it('adopts and hardens only a recognized legacy cache layout', () => {
    const root = project();
    const cache = join(root, '.legacy-cache');
    mkdirSync(cache);
    const database = join(cache, 'index.db');
    writeFileSync(database, 'legacy');
    chmodSync(cache, 0o755);
    chmodSync(database, 0o644);

    const paths = resolveIndexStoragePaths(root, { dbPath: '.legacy-cache' });

    expect(readFileSync(join(paths.cacheDir, CACHE_OWNERSHIP_FILE), 'utf8')).toContain('"canonicalProjectRoot"');
    if (process.platform !== 'win32') {
      expect(statSync(paths.cacheDir).mode & 0o777).toBe(0o700);
      expect(statSync(database).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses arbitrary existing data without deleting or rewriting it', () => {
    const root = project();
    const cache = join(root, '.not-a-cache');
    mkdirSync(cache);
    const sentinel = join(cache, 'sentinel.txt');
    writeFileSync(sentinel, 'keep');

    expect(() => resolveIndexStoragePaths(root, { dbPath: '.not-a-cache' })).toThrow('unrecognized existing entries');
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
    expect(() => readFileSync(join(cache, CACHE_OWNERSHIP_FILE))).toThrow();
  });

  it('rejects ownership tampering and a record copied from another project', () => {
    const first = project();
    const second = project();
    const firstPaths = resolveIndexStoragePaths(first, { dbPath: '.cache' });
    const secondPaths = resolveIndexStoragePaths(second, { dbPath: '.cache' });
    const firstOwner = join(firstPaths.cacheDir, CACHE_OWNERSHIP_FILE);
    const secondOwner = join(secondPaths.cacheDir, CACHE_OWNERSHIP_FILE);

    writeFileSync(firstOwner, readFileSync(secondOwner));
    expect(() => assertOwnedCacheDir(first, firstPaths.cacheDir)).toThrow('different project');

    writeFileSync(firstOwner, '{broken\n');
    expect(() => assertOwnedCacheDir(first, firstPaths.cacheDir)).toThrow('malformed ownership record');
  });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-cache-owner-'));
  roots.push(root);
  return root;
}

function dirnameOf(path: string): string {
  return join(path, '..');
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
