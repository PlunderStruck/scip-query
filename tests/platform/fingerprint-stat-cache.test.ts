import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  lookupProjectFileFingerprint,
  persistProjectFileFingerprintCache,
  projectFileFingerprintCacheStats,
  rememberProjectFileFingerprint,
  resetProjectFileFingerprintCacheForTest,
  withProjectFileFingerprintCache,
} from '../../src/platform/fingerprint-stat-cache.js';

const tempDirs: string[] = [];
const originalCacheDir = process.env['SCIP_QUERY_CACHE_DIR'];

afterEach(() => {
  resetProjectFileFingerprintCacheForTest();
  if (originalCacheDir === undefined) delete process.env['SCIP_QUERY_CACHE_DIR'];
  else process.env['SCIP_QUERY_CACHE_DIR'] = originalCacheDir;
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('fingerprint stat cache', () => {
  it('keeps overlapping asynchronous index directories separate and restores the default scope', async () => {
    const projectRoot = temporaryDirectory('scip-query-stat-cache-scopes-');
    const first = temporaryDirectory('scip-query-stat-cache-first-');
    const second = temporaryDirectory('scip-query-stat-cache-second-');
    const stats = { dev: 1, ino: 2, mtimeMs: 10, ctimeMs: 11, size: 4 };
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = withProjectFileFingerprintCache(projectRoot, first, async () => {
      rememberProjectFileFingerprint(projectRoot, 'value.ts', 'file', stats, { hash: 'first', size: 4 });
      await ready;
      expect(lookupProjectFileFingerprint(projectRoot, 'value.ts', 'file', stats)?.hash).toBe('first');
      persistProjectFileFingerprintCache(projectRoot);
    });
    await withProjectFileFingerprintCache(projectRoot, second, async () => {
      expect(lookupProjectFileFingerprint(projectRoot, 'value.ts', 'file', stats)).toBeUndefined();
      rememberProjectFileFingerprint(projectRoot, 'value.ts', 'file', stats, { hash: 'second', size: 4 });
      release();
      await pending;
      expect(lookupProjectFileFingerprint(projectRoot, 'value.ts', 'file', stats)?.hash).toBe('second');
      persistProjectFileFingerprintCache(projectRoot);
    });
    expect(lookupProjectFileFingerprint(projectRoot, 'value.ts', 'file', stats)).toBeUndefined();
    resetProjectFileFingerprintCacheForTest(projectRoot);
    for (const [directory, hash] of [
      [first, 'first'],
      [second, 'second'],
    ]) {
      withProjectFileFingerprintCache(projectRoot, directory!, () => {
        expect(lookupProjectFileFingerprint(projectRoot, 'value.ts', 'file', stats)?.hash).toBe(hash);
      });
    }
  });

  it('reuses a hash only when inode, size, mtime, ctime, and kind match', () => {
    const projectRoot = temporaryDirectory('scip-query-stat-cache-');
    const stats = { dev: 1, ino: 2, mtimeMs: 10, ctimeMs: 11, size: 4 };
    rememberProjectFileFingerprint(projectRoot, 'value.ts', 'file', stats, {
      hash: 'abc',
      size: 4,
      semanticHash: 'tokens-abc',
    });

    expect(lookupProjectFileFingerprint(projectRoot, 'value.ts', 'file', stats)).toEqual({
      hash: 'abc',
      size: 4,
      semanticHash: 'tokens-abc',
    });
    expect(lookupProjectFileFingerprint(projectRoot, 'value.ts', 'file', { ...stats, mtimeMs: 99 })).toBeUndefined();
    expect(lookupProjectFileFingerprint(projectRoot, 'value.ts', 'symlink', stats)).toBeUndefined();
    expect(projectFileFingerprintCacheStats(projectRoot).hits).toBe(1);
  });

  it('reloads persisted hashes from an existing cache directory', () => {
    const projectRoot = temporaryDirectory('scip-query-stat-cache-persist-');
    const cacheDir = temporaryDirectory('scip-query-stat-cache-dir-');
    process.env['SCIP_QUERY_CACHE_DIR'] = cacheDir;
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/keep.ts'), 'export const keep = 1;\n');

    const stats = { dev: 1, ino: 2, mtimeMs: 10, ctimeMs: 11, size: 4 };
    rememberProjectFileFingerprint(projectRoot, 'src/keep.ts', 'file', stats, {
      hash: 'persisted-hash',
      size: 4,
      semanticHash: 'persisted-tokens',
    });
    persistProjectFileFingerprintCache(projectRoot);
    resetProjectFileFingerprintCacheForTest(projectRoot);

    expect(lookupProjectFileFingerprint(projectRoot, 'src/keep.ts', 'file', stats)).toEqual({
      hash: 'persisted-hash',
      size: 4,
      semanticHash: 'persisted-tokens',
    });
  });
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}
