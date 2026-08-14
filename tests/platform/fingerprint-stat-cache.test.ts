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
  it('reuses a hash only when inode, size, mtime, ctime, and kind match', () => {
    const projectRoot = temporaryDirectory('scip-query-stat-cache-');
    const stats = { dev: 1, ino: 2, mtimeMs: 10, ctimeMs: 11, size: 4 };
    rememberProjectFileFingerprint(projectRoot, 'value.ts', 'file', stats, {
      hash: 'abc',
      size: 4,
    });

    expect(lookupProjectFileFingerprint(projectRoot, 'value.ts', 'file', stats)).toEqual({ hash: 'abc', size: 4 });
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
    });
    persistProjectFileFingerprintCache(projectRoot);
    resetProjectFileFingerprintCacheForTest(projectRoot);

    expect(lookupProjectFileFingerprint(projectRoot, 'src/keep.ts', 'file', stats)).toEqual({
      hash: 'persisted-hash',
      size: 4,
    });
  });
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}
