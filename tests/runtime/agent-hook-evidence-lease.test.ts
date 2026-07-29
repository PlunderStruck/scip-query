import { describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '../../src/domain/types.js';
import type { IndexFreshness, IndexFreshnessState } from '../../src/runtime/index-freshness.js';
import {
  assertStopHookEvidenceLease,
  prepareStopHookEvidenceLease,
  StopHookEvidenceLeaseError,
  type StopHookEvidenceDependencies,
  type StopHookIndexObservation,
} from '../../src/runtime/agent-hooks.js';

const workspace = {
  projectRoot: '/repo',
  config: { watch: { enabled: false, autoRefresh: false } } satisfies ProjectConfig,
  paths: {
    cacheDir: '/cache',
    dbPath: '/cache/index.db',
    indexPath: '/cache/index.scip',
    metaPath: '/cache/meta.json',
  },
};

describe('Stop hook evidence lease', () => {
  it('refuses a missing index instead of turning absence into a clean stop', async () => {
    const dependencies = dependenciesFor([observation('missing')]);

    await expect(prepareStopHookEvidenceLease(workspace, dependencies)).rejects.toMatchObject({
      name: 'StopHookEvidenceLeaseError',
      state: 'missing',
    });
  });

  it('waits for an accepted watcher refresh and leases the resulting generation', async () => {
    const refresh = vi.fn(async () => 'watcher accepted refresh request');
    const dependencies = dependenciesFor(
      [observation('stale', 'generation-a', 'worktree-a'), observation('fresh', 'generation-b', 'worktree-a')],
      refresh,
    );

    const lease = await prepareStopHookEvidenceLease(workspaceWithAutomaticRefresh(), dependencies, {
      waitMs: 100,
      pollMs: 10,
    });

    expect(lease).toMatchObject({
      generationIdentity: 'generation-b',
      worktreeIdentity: 'worktree-a',
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('refuses certification when the source or generation changes during the gate', () => {
    const dependencies = dependenciesFor([observation('fresh', 'generation-b', 'worktree-b')]);

    expect(() =>
      assertStopHookEvidenceLease(
        workspace,
        {
          generationIdentity: 'generation-a',
          generationSource: 'legacy',
          worktreeIdentity: 'worktree-a',
          observedAt: '2026-07-28T00:00:00.000Z',
        },
        dependencies,
      ),
    ).toThrow(StopHookEvidenceLeaseError);
  });
});

function workspaceWithAutomaticRefresh() {
  return {
    ...workspace,
    config: { watch: { enabled: true, autoRefresh: true } } satisfies ProjectConfig,
  };
}

function dependenciesFor(
  observations: StopHookIndexObservation[],
  refresh: StopHookEvidenceDependencies['refresh'] = async () => undefined,
): StopHookEvidenceDependencies {
  let now = 0;
  return {
    refresh,
    observe: vi.fn(() => observations.shift() ?? observation('stale')),
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  };
}

function observation(
  state: IndexFreshnessState,
  generationIdentity?: string,
  worktreeIdentity?: string,
): StopHookIndexObservation {
  const freshness: IndexFreshness = {
    state,
    checkedAt: '2026-07-28T00:00:00.000Z',
    metaPath: '/cache/meta.json',
    reason: `${state} fixture`,
  };
  return {
    freshness,
    ...(generationIdentity ? { generationIdentity } : {}),
    ...(worktreeIdentity ? { worktreeIdentity } : {}),
  };
}
