import { describe, expect, it } from 'vitest';
import {
  compareObservationReceipts,
  isObservationReceipt,
  type ObservationReceipt,
} from '../../src/domain/observation-receipt.js';
import { buildObservationReceipt } from '../../src/runtime/observation-receipt.js';

describe('observation receipts', () => {
  it('identifies the immutable index generation and exact Git/worktree observation', () => {
    const receipt = buildObservationReceipt({
      projectRoot: '/repo',
      observedAt: new Date('2026-07-28T00:00:00.000Z'),
      db: {
        generation: {
          identity: 'generation-a',
          databasePath: '/cache/generation-a/index.db',
          source: 'immutable',
        },
      },
      gitContext: {
        projectRoot: '/repo',
        gitDir: '/repo/.git',
        commonDir: '/repo/.git',
        repositoryId: 'repository-a',
        worktreeId: 'worktree-a',
        headCommit: 'head-a',
        treeOid: 'tree-a',
        clean: false,
      },
      statusPorcelain: ' M src/a.ts',
      trackedDiff: 'diff-a',
    });

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      authorityKind: 'index-worktree',
      observedAt: '2026-07-28T00:00:00.000Z',
      index: {
        generationIdentity: 'generation-a',
        source: 'immutable',
        alignment: 'not-certified',
      },
      worktree: { clean: false, headCommit: 'head-a', treeOid: 'tree-a' },
    });
    expect(isObservationReceipt(receipt)).toBe(true);
  });

  it('rejects mixed generation and worktree complete-set claims', () => {
    const baseline = receipt('generation-a', 'worktree-a');

    expect(compareObservationReceipts(baseline, receipt('generation-a', 'worktree-a'))).toEqual({
      compatible: true,
      reasons: [],
    });
    expect(compareObservationReceipts(baseline, receipt('generation-b', 'worktree-b'))).toEqual({
      compatible: false,
      reasons: ['generation-mismatch', 'worktree-mismatch'],
    });
    expect(
      compareObservationReceipts(baseline, {
        schemaVersion: 1,
        authorityKind: 'process-local',
        observedAt: '2026-07-28T00:00:01.000Z',
        projectIdentity: baseline.projectIdentity,
      }),
    ).toEqual({
      compatible: false,
      reasons: ['index-authority-missing', 'worktree-authority-missing'],
    });
  });
});

function receipt(generationIdentity: string, worktreeIdentity: string): ObservationReceipt {
  return {
    schemaVersion: 1,
    authorityKind: 'index-worktree',
    observedAt: '2026-07-28T00:00:00.000Z',
    projectIdentity: 'project-a',
    index: { generationIdentity, source: 'immutable', alignment: 'not-certified' },
    worktree: { identity: worktreeIdentity, clean: false },
  };
}
