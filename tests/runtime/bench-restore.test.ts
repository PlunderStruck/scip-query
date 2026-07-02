import { describe, expect, it } from 'vitest';
import {
  benchRestoreMarkerPath,
  finishBenchIndexCacheRestore,
  moveBenchIndexCacheAside,
  restoreBenchIndexCache,
} from '../../src/runtime/commands/command-handlers.js';

describe('bench cold-index restore marker', () => {
  it('writes a marker before moving the cache and removes it after discarding the backup', () => {
    const fs = fakeFs(['/project/.cache/scip-query']);
    const cacheDir = '/project/.cache/scip-query';
    const backupDir = '/project/.cache/scip-query.bench-backup-1';

    expect(moveBenchIndexCacheAside(cacheDir, backupDir, fs)).toBe(true);
    expect(fs.existsSync(cacheDir)).toBe(false);
    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.existsSync(benchRestoreMarkerPath(cacheDir))).toBe(true);

    finishBenchIndexCacheRestore(cacheDir, backupDir, true, 'discard-backup', fs);

    expect(fs.existsSync(backupDir)).toBe(false);
    expect(fs.existsSync(benchRestoreMarkerPath(cacheDir))).toBe(false);
  });

  it('restores a moved cache when the marker is present on the next bench run', () => {
    const cacheDir = '/project/.cache/scip-query';
    const backupDir = '/project/.cache/scip-query.bench-backup-1';
    const markerPath = benchRestoreMarkerPath(cacheDir);
    const fs = fakeFs([backupDir], {
      [markerPath]: JSON.stringify({ originalPath: cacheDir, backupPath: backupDir }),
    });

    expect(restoreBenchIndexCache(cacheDir, fs)).toBe(true);

    expect(fs.existsSync(cacheDir)).toBe(true);
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('clears a stale marker when the backup is missing', () => {
    const cacheDir = '/project/.cache/scip-query';
    const markerPath = benchRestoreMarkerPath(cacheDir);
    const fs = fakeFs([], {
      [markerPath]: JSON.stringify({ originalPath: cacheDir, backupPath: '/missing/backup' }),
    });

    expect(restoreBenchIndexCache(cacheDir, fs)).toBe(true);

    expect(fs.existsSync(cacheDir)).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});

function fakeFs(initialPaths: string[], initialFiles: Record<string, string> = {}) {
  const paths = new Set(initialPaths);
  const files = new Map(Object.entries(initialFiles));
  for (const file of files.keys()) paths.add(file);
  return {
    existsSync(path: string): boolean {
      return paths.has(path);
    },
    readFileSync(path: string): string {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing file: ${path}`);
      return value;
    },
    writeFileSync(path: string, data: string): void {
      paths.add(path);
      files.set(path, data);
    },
    renameSync(oldPath: string, newPath: string): void {
      if (!paths.has(oldPath)) throw new Error(`missing path: ${oldPath}`);
      paths.delete(oldPath);
      paths.add(newPath);
      const data = files.get(oldPath);
      if (data !== undefined) {
        files.delete(oldPath);
        files.set(newPath, data);
      }
    },
    rmSync(path: string): void {
      paths.delete(path);
      files.delete(path);
    },
    unlinkSync(path: string): void {
      paths.delete(path);
      files.delete(path);
    },
  };
}
