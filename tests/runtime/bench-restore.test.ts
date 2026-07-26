import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureOwnedCacheDir } from '../../src/platform/cache-layout.js';
import {
  benchRestoreMarkerPath,
  finishBenchIndexCacheRestore,
  moveBenchIndexCacheAside,
  restoreBenchIndexCache,
} from '../../src/runtime/commands/command-handlers.js';

const roots: string[] = [];
const originalXdgCache = process.env['XDG_CACHE_HOME'];

afterEach(() => {
  if (originalXdgCache === undefined) delete process.env['XDG_CACHE_HOME'];
  else process.env['XDG_CACHE_HOME'] = originalXdgCache;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bench cold-index owned-cache recovery', () => {
  it('writes a private marker before moving the cache and validates ownership before discarding the backup', () => {
    const { projectRoot, cacheDir } = fixture();
    const backupDir = `${cacheDir}.bench-backup-1`;
    writeFileSync(join(cacheDir, 'index.db'), 'old');

    expect(moveBenchIndexCacheAside(projectRoot, cacheDir, backupDir)).toBe(true);
    const markerPath = benchRestoreMarkerPath(cacheDir);
    expect(readFileSync(markerPath, 'utf8')).toContain('"ownerSha256"');

    ensureOwnedCacheDir(projectRoot, cacheDir);
    writeFileSync(join(cacheDir, 'index.db'), 'new');
    finishBenchIndexCacheRestore(projectRoot, cacheDir, backupDir, true, 'discard-backup');

    expect(() => readFileSync(backupDir)).toThrow();
    expect(() => readFileSync(markerPath)).toThrow();
    expect(readFileSync(join(cacheDir, 'index.db'), 'utf8')).toBe('new');
  });

  it('restores the exact owned backup after an interrupted move', () => {
    const { projectRoot, cacheDir } = fixture();
    const backupDir = `${cacheDir}.bench-backup-2`;
    writeFileSync(join(cacheDir, 'index.db'), 'old');
    moveBenchIndexCacheAside(projectRoot, cacheDir, backupDir);

    expect(restoreBenchIndexCache(projectRoot, cacheDir)).toBe(true);

    expect(readFileSync(join(cacheDir, 'index.db'), 'utf8')).toBe('old');
    expect(() => readFileSync(backupDir)).toThrow();
    expect(() => readFileSync(benchRestoreMarkerPath(cacheDir))).toThrow();
  });

  it('refuses a forged marker and leaves an external sentinel untouched', () => {
    const { root, projectRoot, cacheDir } = fixture();
    const external = join(root, 'external');
    mkdirSync(external);
    const sentinel = join(external, 'sentinel');
    writeFileSync(sentinel, 'keep');
    const markerPath = benchRestoreMarkerPath(cacheDir);
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        canonicalProjectRoot: projectRoot,
        originalCachePath: cacheDir,
        backupPath: external,
        ownerSha256: 'a'.repeat(64),
      })}\n`,
    );

    expect(() => restoreBenchIndexCache(projectRoot, cacheDir)).toThrow();
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
  });

  it('refuses to move a directory without a valid ownership record', () => {
    const root = temporaryRoot();
    const projectRoot = join(root, 'project');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'sentinel'), 'keep');

    expect(() => moveBenchIndexCacheAside(projectRoot, cacheDir, `${cacheDir}.bench-backup-3`)).toThrow(
      'unowned cache directory',
    );
    expect(readFileSync(join(cacheDir, 'sentinel'), 'utf8')).toBe('keep');
  });
});

function fixture(): { root: string; projectRoot: string; cacheDir: string } {
  const root = temporaryRoot();
  process.env['XDG_CACHE_HOME'] = join(root, 'xdg-cache');
  const projectRoot = join(root, 'project');
  const requestedCacheDir = join(projectRoot, '.cache');
  mkdirSync(projectRoot);
  const cacheDir = ensureOwnedCacheDir(projectRoot, requestedCacheDir);
  return { root, projectRoot, cacheDir };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-bench-owner-'));
  roots.push(root);
  return root;
}
