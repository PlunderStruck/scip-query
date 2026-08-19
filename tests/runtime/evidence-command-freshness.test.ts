import { describe, expect, it, vi } from 'vitest';

import type { IndexFreshness } from '../../src/runtime/index-freshness.js';
import {
  ensureEvidenceCommandFreshness,
  type EvidenceCommandFreshnessDependencies,
} from '../../src/runtime/evidence-command-freshness.js';
import type { resolveIndexStoragePaths } from '../../src/platform/cache-layout.js';

describe('evidence command freshness', () => {
  it('leaves an explicitly supplied index under caller ownership', async () => {
    const dependencies = fixtureDependencies([freshness('stale')]);

    await expect(
      ensureEvidenceCommandFreshness({ ...workspace(), dbPathSource: 'env' }, dependencies),
    ).resolves.toMatchObject({ source: 'explicit-index' });

    expect(dependencies.prepare).not.toHaveBeenCalled();
    expect(dependencies.ensureService).not.toHaveBeenCalled();
    expect(dependencies.reindex).not.toHaveBeenCalled();
  });

  it('reuses a fresh generation and keeps the watcher ready for later edits', async () => {
    const currentWorkspace = workspace();
    const dependencies = fixtureDependencies([freshness('fresh')]);

    await expect(ensureEvidenceCommandFreshness(currentWorkspace, dependencies)).resolves.toMatchObject({
      source: 'existing',
      service: { kind: 'reused' },
    });

    expect(dependencies.prepare).toHaveBeenCalledOnce();
    expect(dependencies.ensureService).toHaveBeenCalledOnce();
    expect(dependencies.requestRefresh).not.toHaveBeenCalled();
    expect(dependencies.reindex).not.toHaveBeenCalled();
    expect(dependencies.freshness).toHaveBeenNthCalledWith(
      1,
      currentWorkspace.projectRoot,
      currentWorkspace.config,
      currentWorkspace.paths,
      { gitContext: currentWorkspace.gitContext },
    );
  });

  it('reuses the fresh observation returned by local preflight', async () => {
    const dependencies = fixtureDependencies([freshness('stale')]);
    vi.mocked(dependencies.prepare).mockReturnValueOnce({
      kind: 'local-fresh',
      freshness: freshness('fresh'),
    });

    await expect(ensureEvidenceCommandFreshness(workspace(), dependencies)).resolves.toMatchObject({
      source: 'existing',
    });

    expect(dependencies.freshness).not.toHaveBeenCalled();
    expect(dependencies.ensureService).toHaveBeenCalledOnce();
  });

  it('answers from a stale readable index without waiting or starting a second reindex', async () => {
    const dependencies = fixtureDependencies([freshness('stale')]);

    await expect(ensureEvidenceCommandFreshness(workspace(), dependencies)).resolves.toMatchObject({
      source: 'stale',
    });

    expect(dependencies.requestRefresh).toHaveBeenCalledOnce();
    expect(dependencies.wait).not.toHaveBeenCalled();
    expect(dependencies.reindex).not.toHaveBeenCalled();
  });

  it('does not start a competing reindex when the watcher is paused over a stale index', async () => {
    const dependencies = fixtureDependencies([freshness('stale')], 'budget-paused');

    await expect(ensureEvidenceCommandFreshness(workspace(), dependencies)).resolves.toMatchObject({
      source: 'stale',
    });

    expect(dependencies.requestRefresh).toHaveBeenCalledOnce();
    expect(dependencies.wait).not.toHaveBeenCalled();
    expect(dependencies.reindex).not.toHaveBeenCalled();
  });

  it('does not wait on the cache lock when a rebuild is already running over a readable index', async () => {
    const dependencies = fixtureDependencies([freshness('stale')], 'indexing');

    await expect(ensureEvidenceCommandFreshness(workspace(), dependencies)).resolves.toMatchObject({
      source: 'stale',
    });

    expect(dependencies.reindex).not.toHaveBeenCalled();
  });

  it('still rebuilds when the stale generation requires repair and the watcher is idle', async () => {
    const currentWorkspace = workspace();
    const dependencies = fixtureDependencies([
      freshness('stale', 'SQLite generation requires repair: generation checksum drifted'),
      freshness('fresh'),
    ]);

    await expect(ensureEvidenceCommandFreshness(currentWorkspace, dependencies, { waitMs: 0 })).resolves.toMatchObject({
      source: 'synchronous-reindex',
    });

    expect(dependencies.requestRefresh).toHaveBeenCalledOnce();
    expect(dependencies.reindex).toHaveBeenCalledOnce();
    expect(dependencies.freshness).toHaveBeenNthCalledWith(
      2,
      currentWorkspace.projectRoot,
      currentWorkspace.config,
      currentWorkspace.paths,
      { gitContext: currentWorkspace.gitContext },
    );
  });

  it('waits for a missing index only until the watcher publishes one', async () => {
    const currentWorkspace = workspace();
    const dependencies = fixtureDependencies([freshness('missing'), freshness('fresh')]);

    await expect(
      ensureEvidenceCommandFreshness(currentWorkspace, dependencies, { waitMs: 20, pollMs: 10 }),
    ).resolves.toMatchObject({ source: 'watcher' });

    expect(dependencies.requestRefresh).toHaveBeenCalledOnce();
    expect(dependencies.wait).toHaveBeenCalledOnce();
    expect(dependencies.reindex).not.toHaveBeenCalled();
    expect(dependencies.freshness).toHaveBeenNthCalledWith(
      2,
      currentWorkspace.projectRoot,
      currentWorkspace.config,
      currentWorkspace.paths,
      { gitContext: currentWorkspace.gitContext },
    );
  });

  it('fails fast when no readable index exists and the watcher is already rebuilding', async () => {
    const dependencies = fixtureDependencies([freshness('missing')], 'indexing');

    await expect(ensureEvidenceCommandFreshness(workspace(), dependencies)).rejects.toThrow(
      'index remained missing (missing fixture) while the watcher is indexing',
    );
    expect(dependencies.reindex).not.toHaveBeenCalled();
  });

  it('fails fast when no readable index exists and the watcher budget is paused', async () => {
    const dependencies = fixtureDependencies([freshness('missing')], 'budget-paused');

    await expect(ensureEvidenceCommandFreshness(workspace(), dependencies)).rejects.toThrow(
      'index remained missing (missing fixture) while the watcher is budget-paused',
    );
    expect(dependencies.reindex).not.toHaveBeenCalled();
  });

  it('uses the same synchronous fallback when the watch service cannot start', async () => {
    const dependencies = fixtureDependencies([freshness('missing'), freshness('fresh')], 'failed');

    await expect(ensureEvidenceCommandFreshness(workspace(), dependencies)).resolves.toMatchObject({
      source: 'synchronous-reindex',
      service: { kind: 'failed' },
    });

    expect(dependencies.requestRefresh).not.toHaveBeenCalled();
    expect(dependencies.reindex).toHaveBeenCalledOnce();
  });

  it('fails in the same command with the refresh cause instead of delegating recovery to the agent', async () => {
    const dependencies = fixtureDependencies([freshness('missing')], 'failed');
    vi.mocked(dependencies.reindex).mockRejectedValueOnce(new Error('indexer unavailable'));

    await expect(ensureEvidenceCommandFreshness(workspace(), dependencies)).rejects.toThrow(
      'Could not prepare fresh evidence for scip-query context: indexer unavailable',
    );
  });
});

function workspace() {
  return {
    commandName: 'context',
    projectRoot: '/repo',
    config: { languages: ['typescript'], watch: { enabled: true } } as const,
    paths: {
      cacheDir: '/cache',
      dbPath: '/cache/index.db',
      indexPath: '/cache/index.scip',
      metaPath: '/cache/meta.json',
    } as ReturnType<typeof resolveIndexStoragePaths>,
    dbPathSource: 'configured' as const,
    gitContext: {
      projectRoot: '/repo',
      gitDir: '/repo/.git',
      commonDir: '/repo/.git',
      repositoryId: 'repository',
      worktreeId: 'worktree',
      headCommit: 'commit',
      treeOid: 'tree',
      clean: true,
    },
  };
}

function fixtureDependencies(
  freshnessStates: IndexFreshness[],
  serviceState: 'idle' | 'budget-paused' | 'indexing' | 'failed' = 'idle',
): EvidenceCommandFreshnessDependencies {
  let now = 0;
  const nextFreshness = vi.fn(() => freshnessStates.shift() ?? freshness('stale'));
  return {
    prepare: vi.fn(() => ({ kind: 'local-fresh' })),
    freshness: nextFreshness,
    ensureService: vi.fn(() =>
      serviceState === 'failed'
        ? { kind: 'failed', message: 'watch unavailable' }
        : ({
            kind: 'reused',
            state: {
              watcher:
                serviceState === 'budget-paused'
                  ? {
                      state: 'budget-paused',
                      until: 10_000,
                      dirty: true,
                      reason: 'test budget',
                      rebuilt: 3,
                      estimatedWriteBytes: 1_000,
                    }
                  : serviceState === 'indexing'
                    ? { state: 'indexing', startedAt: 1 }
                    : { state: 'idle' },
            },
          } as ReturnType<EvidenceCommandFreshnessDependencies['ensureService']>),
    ),
    inspectService: vi.fn(() => ({ classification: { kind: 'stopped' } }) as never),
    requestRefresh: vi.fn(),
    reindex: vi.fn(async () => ({ reused: false }) as never),
    wait: vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    }),
    now: () => now,
  };
}

function freshness(state: IndexFreshness['state'], reason = `${state} fixture`): IndexFreshness {
  return {
    state,
    checkedAt: '2026-08-01T00:00:00.000Z',
    metaPath: '/cache/meta.json',
    reason,
  };
}
