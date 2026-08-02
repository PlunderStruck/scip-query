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
    const dependencies = fixtureDependencies([freshness('fresh')]);

    await expect(ensureEvidenceCommandFreshness(workspace(), dependencies)).resolves.toMatchObject({
      source: 'existing',
      service: { kind: 'reused' },
    });

    expect(dependencies.prepare).toHaveBeenCalledOnce();
    expect(dependencies.ensureService).toHaveBeenCalledOnce();
    expect(dependencies.requestRefresh).not.toHaveBeenCalled();
    expect(dependencies.reindex).not.toHaveBeenCalled();
  });

  it('waits inside the evidence command for an accepted watcher refresh', async () => {
    const dependencies = fixtureDependencies([freshness('stale'), freshness('fresh')]);

    await expect(
      ensureEvidenceCommandFreshness(workspace(), dependencies, { waitMs: 20, pollMs: 10 }),
    ).resolves.toMatchObject({ source: 'watcher' });

    expect(dependencies.requestRefresh).toHaveBeenCalledOnce();
    expect(dependencies.wait).toHaveBeenCalledOnce();
    expect(dependencies.reindex).not.toHaveBeenCalled();
  });

  it('falls back immediately when the watcher resource budget is paused', async () => {
    const dependencies = fixtureDependencies([freshness('stale'), freshness('fresh')], 'budget-paused');

    await expect(ensureEvidenceCommandFreshness(workspace(), dependencies)).resolves.toMatchObject({
      source: 'synchronous-reindex',
    });

    expect(dependencies.requestRefresh).toHaveBeenCalledOnce();
    expect(dependencies.wait).not.toHaveBeenCalled();
    expect(dependencies.reindex).toHaveBeenCalledOnce();
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
    const dependencies = fixtureDependencies([freshness('stale')], 'failed');
    vi.mocked(dependencies.reindex).mockRejectedValueOnce(new Error('indexer unavailable'));

    await expect(ensureEvidenceCommandFreshness(workspace(), dependencies)).rejects.toThrow(
      'Could not prepare fresh evidence for scip-query plan-context: indexer unavailable',
    );
  });
});

function workspace() {
  return {
    commandName: 'plan-context',
    projectRoot: '/repo',
    config: { languages: ['typescript'], watch: { enabled: true } } as const,
    paths: {
      cacheDir: '/cache',
      dbPath: '/cache/index.db',
      indexPath: '/cache/index.scip',
      metaPath: '/cache/meta.json',
    } as ReturnType<typeof resolveIndexStoragePaths>,
    dbPathSource: 'configured' as const,
  };
}

function fixtureDependencies(
  freshnessStates: IndexFreshness[],
  serviceState: 'idle' | 'budget-paused' | 'failed' = 'idle',
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

function freshness(state: IndexFreshness['state']): IndexFreshness {
  return {
    state,
    checkedAt: '2026-08-01T00:00:00.000Z',
    metaPath: '/cache/meta.json',
    reason: `${state} fixture`,
  };
}
