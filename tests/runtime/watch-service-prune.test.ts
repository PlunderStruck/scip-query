import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureOwnedCacheDir } from '../../src/platform/cache-layout.js';
import { WATCH_SERVICE_PROTOCOL_VERSION, watchServicePaths } from '../../src/platform/watch-service-state.js';
import { pruneOrphanWatchServices } from '../../src/runtime/watch-service-prune.js';
import { writeWatchServiceState } from '../../src/runtime/watch-service.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pruneOrphanWatchServices', () => {
  it('stops only owned caches whose project roots no longer exist', () => {
    const cacheRoot = temporaryDirectory('cache-root');
    const live = ownedProjectCache(cacheRoot, 'live');
    const orphan = ownedProjectCache(cacheRoot, 'orphan');
    rmSync(orphan.projectRoot, { recursive: true, force: true });
    const stopService = vi.fn(() => ({ disposition: 'stopped' as const, pid: 42 }));

    const report = pruneOrphanWatchServices({ cacheRoot, stopService });

    expect(stopService).toHaveBeenCalledTimes(1);
    expect(stopService).toHaveBeenCalledWith({
      projectRoot: orphan.projectRoot,
      cacheDir: orphan.cacheDir,
      cliVersion: 'orphan-prune',
    });
    expect(report).toMatchObject({
      scannedCacheDirs: 2,
      ownedCacheDirs: 2,
      retainedRoots: 1,
      orphanedRoots: 1,
      stoppedServices: 1,
      alreadyStoppedServices: 0,
      skipped: [],
      failures: [],
    });
    expect(live.projectRoot).not.toBe(orphan.projectRoot);
  });

  it('refuses conflicting watcher ownership records', () => {
    const cacheRoot = temporaryDirectory('cache-root');
    const orphan = ownedProjectCache(cacheRoot, 'orphan');
    const now = new Date().toISOString();
    writeWatchServiceState(watchServicePaths(orphan.cacheDir).statePath, {
      version: 1,
      protocolVersion: WATCH_SERVICE_PROTOCOL_VERSION,
      pid: 123,
      projectRoot: join(orphan.projectRoot, 'different-owner'),
      cliVersion: '0.1.0',
      startedAt: now,
      heartbeatAt: now,
      lastActivityAt: now,
      watcher: { state: 'idle' },
    });
    rmSync(orphan.projectRoot, { recursive: true, force: true });
    const stopService = vi.fn(() => ({ disposition: 'stopped' as const, pid: 123 }));

    const report = pruneOrphanWatchServices({ cacheRoot, stopService });

    expect(stopService).not.toHaveBeenCalled();
    expect(report.failures).toEqual([
      expect.objectContaining({ message: 'watch state belongs to a different project root' }),
    ]);
  });

  it('rechecks a missing root before entering the stop operation', () => {
    const cacheRoot = temporaryDirectory('cache-root');
    ownedProjectCache(cacheRoot, 'recreated');
    const rootIsCurrent = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const stopService = vi.fn(() => ({ disposition: 'stopped' as const, pid: 42 }));

    const report = pruneOrphanWatchServices({ cacheRoot, rootIsCurrent, stopService });

    expect(rootIsCurrent).toHaveBeenCalledTimes(2);
    expect(stopService).not.toHaveBeenCalled();
    expect(report.retainedRoots).toBe(1);
    expect(report.orphanedRoots).toBe(0);
  });

  it('skips cache entries without a valid ownership credential', () => {
    const cacheRoot = temporaryDirectory('cache-root');
    mkdirSync(join(cacheRoot, 'projects'), { recursive: true });
    mkdirSync(join(cacheRoot, 'projects', 'unowned'));
    const stopService = vi.fn(() => ({ disposition: 'stopped' as const, pid: 42 }));

    const report = pruneOrphanWatchServices({ cacheRoot, stopService });

    expect(stopService).not.toHaveBeenCalled();
    expect(report.skipped).toHaveLength(1);
    expect(report.ownedCacheDirs).toBe(0);
  });
});

function ownedProjectCache(cacheRoot: string, name: string): { projectRoot: string; cacheDir: string } {
  const projectRoot = realpathSync(temporaryDirectory(name));
  const cacheDir = join(cacheRoot, 'projects', name);
  mkdirSync(cacheDir, { recursive: true });
  ensureOwnedCacheDir(projectRoot, cacheDir);
  return { projectRoot, cacheDir };
}

function temporaryDirectory(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `scip-query-${name}-`));
  roots.push(root);
  return root;
}
