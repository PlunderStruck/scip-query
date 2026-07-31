import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareObservationReceipts,
  createObservationIdentity,
  decodeObservationReceipt,
  deriveObservationStateAuthority,
  isObservationReceipt,
  type ObservationReceiptV1,
  type ObservationReceiptV2,
} from '../../src/domain/observation-receipt.js';
import { stableJson } from '../../src/domain/stable-json.js';
import { buildObservationReceipt } from '../../src/runtime/observation-receipt.js';

describe('observation receipts', () => {
  it('preserves the version-1 identity preimage while using the bounded fast path', () => {
    const identity = createObservationIdentity('projection', 3, 'canonical value');
    expect(identity.digest).toBe(
      createHash('sha256')
        .update(
          stableJson({
            canonicalizationVersion: 1,
            projection: 'projection',
            projectionVersion: 3,
            value: 'canonical value',
          }),
        )
        .digest('hex'),
    );
  });

  it('records independent v2 collaboration, workspace, generation, source, and stability facts', () => {
    const receipt = buildObservationReceipt({
      projectRoot: '/repo',
      collaborationDomainId: '5ea57d1a-936c-4c91-b58f-5d61e45173a5',
      observedAt: new Date('2026-07-28T00:00:00.000Z'),
      db: {
        config: {
          projectRoot: '/repo',
          dbPath: '/cache/index.db',
          indexPath: '/cache/index.scip',
          collaborationDomainId: '5ea57d1a-936c-4c91-b58f-5d61e45173a5',
        },
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
    });

    expect(receipt).toMatchObject({
      schemaVersion: 2,
      observedAt: '2026-07-28T00:00:00.000Z',
      facts: {
        collaborationDomain: { projection: { name: 'scip-query:collaboration-domain', version: 1 } },
        workspaceInstance: { projection: { name: 'scip-query:workspace-instance', version: 1 } },
        index: {
          generation: { projection: { name: 'scip-query:index-generation', version: 1 } },
          source: 'immutable',
        },
      },
      observedSources: [{ kind: 'index-generation' }, { kind: 'live-workspace' }],
      stabilityProofs: [
        { source: 'index-generation', kind: 'immutable' },
        { source: 'live-workspace', kind: 'not-established' },
      ],
      diagnostics: { clean: false, headCommit: 'head-a', treeOid: 'tree-a' },
    });
    expect(receipt.facts).not.toHaveProperty('wholeContent');
    expect(isObservationReceipt(receipt)).toBe(true);
  });

  it('records only the state sources declared by the evidence producer', () => {
    const receipt = buildObservationReceipt({
      projectRoot: '/repo',
      collaborationDomainId: '5ea57d1a-936c-4c91-b58f-5d61e45173a5',
      db: {
        config: {
          projectRoot: '/repo',
          dbPath: '/cache/index.db',
          indexPath: '/cache/index.scip',
        },
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
      observedSourceKinds: ['index-generation'],
    });

    expect(receipt.observedSources).toEqual([
      {
        kind: 'index-generation',
        identity: expect.objectContaining({ projection: { name: 'scip-query:index-generation', version: 1 } }),
      },
    ]);
    expect(receipt.stabilityProofs).toEqual([{ source: 'index-generation', kind: 'immutable' }]);
  });

  it('resolves live-workspace identity only when the producer declares that source', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-receipt-source-'));
    try {
      execFileSync('git', ['-C', projectRoot, 'init'], { stdio: 'ignore' });

      const receipt = buildObservationReceipt({
        projectRoot,
        observedSourceKinds: ['live-workspace'],
      });

      expect(receipt.facts.workspaceInstance).toMatchObject({
        projection: { name: 'scip-query:workspace-instance', version: 1 },
      });
      expect(receipt.observedSources).toEqual([
        {
          kind: 'live-workspace',
          identity: expect.objectContaining({
            projection: { name: 'scip-query:workspace-instance', version: 1 },
          }),
        },
      ]);
      expect(receipt.stabilityProofs).toEqual([{ source: 'live-workspace', kind: 'not-established' }]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('establishes equal content across separate clones without equating their workspaces', () => {
    const left = receiptV2({ workspace: 'clone-a', content: 'same bytes' });
    const right = receiptV2({ workspace: 'clone-b', content: 'same bytes' });

    const comparison = compareObservationReceipts(left, right);

    expect(comparison.collaborationDomain.state).toBe('established');
    expect(comparison.wholeContent.state).toBe('established');
    expect(comparison.workspaceInstance.state).toBe('disproven');
    expect(comparison.observationStability.state).toBe('established');
    expect(deriveObservationStateAuthority(left, right, comparison)).toMatchObject({
      policyVersion: 1,
      authority: 'completion',
      reasons: [],
    });
  });

  it('establishes exact generation alignment from one fixed snapshot projection', () => {
    const indexInputs = {
      version: 2,
      languages: ['typescript'] as const,
      pnpmWorkspaces: false,
      typescriptProjectMode: 'single',
      typescriptProjects: [],
      files: [{ path: 'source.ts', size: 24, hash: 'source-hash' }],
    };
    const receipt = buildObservationReceipt({
      projectRoot: '/repo',
      collaborationDomainId: '5ea57d1a-936c-4c91-b58f-5d61e45173a5',
      db: {
        config: {
          projectRoot: '/repo',
          dbPath: '/cache/index.db',
          indexPath: '/cache/index.scip',
        },
        generation: {
          identity: 'generation-a',
          databasePath: '/cache/generation-a/index.db',
          source: 'immutable',
          metadataRaw: JSON.stringify({
            version: 3,
            status: 'complete',
            updatedAt: '2026-07-28T00:00:00.000Z',
            fingerprint: indexInputs,
            indexedLanguages: ['typescript'],
          }),
        },
      },
      snapshot: {
        projectRoot: '/repo',
        capturedAt: '2026-07-28T00:00:01.000Z',
        repositoryContent: {
          version: 1,
          files: [
            {
              path: 'source.ts',
              kind: 'file',
              executable: false,
              size: 24,
              sha256: 'source-hash',
            },
          ],
        },
        indexInputs,
        paths: [],
        files: new Map(),
        missing: new Set(),
        fingerprints: new Map(),
        dispose() {},
      },
    });

    expect(receipt).toMatchObject({
      observedAt: '2026-07-28T00:00:01.000Z',
      facts: {
        wholeContent: { projection: { name: 'scip-query:repository-content', version: 1 } },
        relevantInputs: [
          {
            subject: 'scip-query:index-inputs',
            identity: { projection: { name: 'scip-query:index-inputs', version: 2 } },
          },
        ],
        index: {
          inputs: { projection: { name: 'scip-query:index-inputs', version: 2 } },
        },
      },
      observedSources: [{ kind: 'index-generation' }, { kind: 'repository-snapshot' }],
      stabilityProofs: [
        { source: 'index-generation', kind: 'immutable' },
        { source: 'repository-snapshot', kind: 'fixed-snapshot' },
      ],
    });
    expect(compareObservationReceipts(receipt, receipt).indexInput.state).toBe('established');
    expect(deriveObservationStateAuthority(receipt, receipt).authority).toBe('completion');
    expect(isObservationReceipt(receipt)).toBe(true);
  });

  it('keeps unknown distinct from disproven and never satisfies completion with either', () => {
    const baseline = receiptV2({ workspace: 'clone-a', content: 'state-a' });
    const missingContent = receiptV2({ workspace: 'clone-a' });
    const differentContent = receiptV2({ workspace: 'clone-a', content: 'state-b' });

    const unknown = compareObservationReceipts(baseline, missingContent);
    const disproven = compareObservationReceipts(baseline, differentContent);

    expect(unknown.wholeContent).toMatchObject({
      state: 'unknown',
      reasons: ['right-fact-missing'],
    });
    expect(disproven.wholeContent).toMatchObject({
      state: 'disproven',
      reasons: ['identities-different'],
    });
    expect(deriveObservationStateAuthority(baseline, missingContent).authority).toBe('advisory');
    expect(deriveObservationStateAuthority(baseline, differentContent).authority).toBe('none');
  });

  it('treats bracketed live-workspace equality as advisory rather than fixed-snapshot proof', () => {
    const left = receiptV2({ workspace: 'clone-a', content: 'same bytes', stability: 'bracketed' });
    const right = receiptV2({ workspace: 'clone-b', content: 'same bytes', stability: 'bracketed' });

    expect(compareObservationReceipts(left, right).observationStability).toMatchObject({
      state: 'unknown',
      reasons: ['left-observation-not-fixed', 'right-observation-not-fixed'],
    });
    expect(deriveObservationStateAuthority(left, right).authority).toBe('advisory');
  });

  it('reads v1 facts without inventing v2 collaboration, content, workspace, or stability proof', () => {
    const left = receiptV1('generation-a', 'mixed-worktree-a');
    const right = receiptV1('generation-a', 'mixed-worktree-a');

    expect(decodeObservationReceipt(left)).toMatchObject({
      kind: 'legacy',
      schemaVersion: 1,
    });
    const comparison = compareObservationReceipts(left, right);
    expect(comparison.indexGeneration.state).toBe('established');
    expect(comparison.collaborationDomain.state).toBe('unknown');
    expect(comparison.workspaceInstance.state).toBe('unknown');
    expect(comparison.wholeContent.state).toBe('unknown');
    expect(comparison.observationStability).toMatchObject({
      state: 'unknown',
      reasons: ['legacy-fact-not-comparable'],
    });
    expect(deriveObservationStateAuthority(left, right).authority).toBe('advisory');
  });

  it('keeps every symmetric relationship symmetric', () => {
    const left = receiptV2({ domain: 'domain-a', workspace: 'clone-a', content: 'state-a' });
    const right = receiptV2({ domain: 'domain-b', workspace: 'clone-b', content: 'state-b' });
    const forward = compareObservationReceipts(left, right);
    const reverse = compareObservationReceipts(right, left);

    for (const key of [
      'collaborationDomain',
      'repositoryLineage',
      'workspaceInstance',
      'wholeContent',
      'indexInput',
      'indexGeneration',
      'observationStability',
    ] as const) {
      expect(forward[key].state).toBe(reverse[key].state);
      expect(forward[key].reasons).toEqual(reverse[key].reasons);
      expect(forward[key].facts.left).toEqual(reverse[key].facts.right);
      expect(forward[key].facts.right).toEqual(reverse[key].facts.left);
    }
  });

  it('rejects malformed and unsupported receipts without weakening the discriminator', () => {
    expect(decodeObservationReceipt({ schemaVersion: 2 })).toMatchObject({ kind: 'malformed' });
    expect(decodeObservationReceipt({ schemaVersion: 3 })).toEqual({
      kind: 'unsupported',
      schemaVersion: 3,
      direction: 'future',
    });
    expect(isObservationReceipt({ schemaVersion: 2 })).toBe(false);
  });

  it('rejects contradictory source identities and impossible stability proofs', () => {
    const receipt = receiptV2({ workspace: 'clone-a', content: 'state-a' });
    const contradictorySource = structuredClone(receipt);
    contradictorySource.observedSources = [
      {
        kind: 'repository-snapshot',
        identity: createObservationIdentity('scip-query:repository-content', 1, 'different-state'),
      },
    ];
    expect(decodeObservationReceipt(contradictorySource)).toMatchObject({ kind: 'malformed' });

    const impossibleProof = receiptV2({ workspace: 'clone-a' });
    impossibleProof.stabilityProofs = [{ source: 'live-workspace', kind: 'immutable' }];
    expect(decodeObservationReceipt(impossibleProof)).toMatchObject({ kind: 'malformed' });
  });
});

function receiptV2(input: {
  domain?: string;
  workspace: string;
  content?: string;
  stability?: 'fixed-snapshot' | 'bracketed';
}): ObservationReceiptV2 {
  const contentIdentity = input.content
    ? createObservationIdentity('scip-query:repository-content', 1, input.content)
    : undefined;
  const workspace = createObservationIdentity('scip-query:workspace-instance', 1, input.workspace);
  return {
    schemaVersion: 2,
    observedAt: '2026-07-28T00:00:00.000Z',
    facts: {
      collaborationDomain: createObservationIdentity('scip-query:collaboration-domain', 1, input.domain ?? 'domain-a'),
      workspaceInstance: workspace,
      ...(contentIdentity ? { wholeContent: contentIdentity } : {}),
    },
    observedSources: contentIdentity
      ? [{ kind: 'repository-snapshot', identity: contentIdentity }]
      : [{ kind: 'live-workspace', identity: workspace }],
    stabilityProofs: [
      {
        source: contentIdentity ? 'repository-snapshot' : 'live-workspace',
        kind: input.stability ?? (contentIdentity ? 'fixed-snapshot' : 'not-established'),
      },
    ],
  };
}

function receiptV1(generationIdentity: string, worktreeIdentity: string): ObservationReceiptV1 {
  return {
    schemaVersion: 1,
    authorityKind: 'index-worktree',
    observedAt: '2026-07-28T00:00:00.000Z',
    projectIdentity: 'project-a',
    index: { generationIdentity, source: 'immutable', alignment: 'not-certified' },
    worktree: { identity: worktreeIdentity, clean: false },
  };
}
