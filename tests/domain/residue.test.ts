import { describe, expect, it } from 'vitest';
import {
  RESIDUE_EVIDENCE_CONTRACT_VERSION,
  evaluateResidueObservation,
  residueObservationId,
  type ResidueObservation,
  type ResidueReferent,
} from '../../src/domain/residue.js';

describe('residue evidence contract', () => {
  it('classifies a change-tied callable without a current role as a residue candidate', () => {
    expect(evaluateResidueObservation(observation()).disposition).toBe('candidate');
  });

  it('lets a concrete current production role defeat residue suspicion', () => {
    const input = observation();
    const evaluation = evaluateResidueObservation({
      ...input,
      currentRoleProofs: [
        {
          kind: 'production-consumers',
          referent: input.referent,
          evidencePaths: ['src/current-consumer.ts'],
          consumers: ['src/current-consumer.ts'],
          reasons: ['src/current-consumer.ts still calls legacyFlow.'],
        },
      ],
    });

    expect(evaluation.disposition).toBe('current-role-proven');
    expect(evaluation.observation.currentRoleProofs[0]?.consumers).toEqual(['src/current-consumer.ts']);
  });

  it('does not convert partial coverage or detector silence into a deletion claim', () => {
    const partial = observation();
    expect(
      evaluateResidueObservation({
        ...partial,
        coverage: {
          ...partial.coverage,
          state: 'partial',
          omitted: [{ file: 'src/registry.ts', reason: 'parser unavailable' }],
        },
      }).disposition,
    ).toBe('insufficient-evidence');

    expect(
      evaluateResidueObservation({
        ...observation(),
        changeEvidence: [],
      }).disposition,
    ).toBe('insufficient-evidence');
  });

  it('rejects a role proof that names a different callable', () => {
    const input = observation();
    const evaluation = evaluateResidueObservation({
      ...input,
      currentRoleProofs: [
        {
          kind: 'declared-external-root',
          referent: { ...input.referent, symbol: 'other-symbol' },
          evidencePaths: ['src/legacy.ts'],
          policyReferents: ['.scipquery.json#entryRoots'],
          reasons: ['A different callable is rooted.'],
        },
      ],
    });

    expect(evaluation.disposition).toBe('candidate');
  });
});

function observation(): ResidueObservation {
  const referent: ResidueReferent = {
    kind: 'callable',
    symbol: 'scip-typescript npm fixture 1.0.0 src/`legacy.ts`/legacyFlow().',
    file: 'src/legacy.ts',
    displayName: 'legacyFlow',
  };
  return {
    observationId: residueObservationId(referent),
    contractVersion: RESIDUE_EVIDENCE_CONTRACT_VERSION,
    referent,
    changeEvidence: [
      {
        kind: 'removed-call',
        changedFile: 'src/registry.ts',
        baseOccurrences: 1,
        currentOccurrences: 0,
      },
    ],
    currentRoleProofs: [],
    coverage: {
      state: 'complete',
      scope: 'changed-source-reference-delta-to-current-production-callables',
      analyzedFiles: ['src/registry.ts'],
      notApplicableFiles: [],
      omitted: [],
      unresolvedReferences: [],
    },
  };
}
