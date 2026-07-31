import { describe, expect, it } from 'vitest';
import {
  RESIDUE_EVIDENCE_CONTRACT_VERSION,
  evaluateResidueObservation,
  residueObservationId,
  type CurrentRoleProof,
  type ResidueEvidenceCoverage,
  type ResidueObservation,
  type ResidueReferent,
} from '../../src/domain/residue.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';
import type { DiffGateFinding } from '../../src/queries/impact/diff-gate.js';
import type { NewlyUnreferencedResidueResult } from '../../src/queries/impact/newly-unreferenced-residue.js';
import { evaluateResidueCompleteness } from '../../src/runtime/residue-completeness.js';

const CHANGE_ID = 'SQC-0123456789ABCDEF0123456789ABCDEF';
const COLLABORATION_DOMAIN = '70a26367-a22f-46a7-aa64-f4ea5f09cc51';

describe('residue completeness admission', () => {
  it('admits a direct newly-unreferenced implementation observed against fixed, complete evidence', () => {
    const result = evaluateResidueCompleteness({
      changeId: CHANGE_ID,
      residue: residueResult(evaluateResidueObservation(residueObservation())),
      diffGate: { changedFiles: ['src/registry.ts'], checksRun: [], findings: [] },
      receipt: fixedReceipt(),
    });

    expect(result.decisions).toMatchObject([
      {
        disposition: 'admit',
        rule: { ruleId: 'newly-unreferenced-implementation', category: 'residue' },
        obligationRequest: {
          changeId: CHANGE_ID,
          category: 'residue',
          source: {
            kind: 'detector-finding',
            check: 'newly-unreferenced',
          },
        },
      },
    ]);
  });

  it('retains current-role proof without creating an obligation', () => {
    const input = residueObservation();
    const proof: CurrentRoleProof = {
      kind: 'production-consumers',
      referent: input.referent,
      evidencePaths: ['src/compat-client.ts'],
      consumers: ['src/compat-client.ts'],
      reasons: ['A current production caller remains.'],
    };
    const evaluation = evaluateResidueObservation({ ...input, currentRoleProofs: [proof] });
    const result = evaluateResidueCompleteness({
      changeId: CHANGE_ID,
      residue: residueResult(evaluation),
      diffGate: { changedFiles: ['src/registry.ts'], checksRun: [], findings: [] },
      receipt: fixedReceipt(),
    });

    expect(result.currentRoleProofs).toHaveLength(1);
    expect(result.decisions).toEqual([]);
  });

  it('withholds admission when coverage or fixed-state authority is not established', () => {
    const coverage = completeCoverage();
    const partialCoverage: ResidueEvidenceCoverage = {
      ...coverage,
      state: 'partial',
      omitted: [{ file: 'src/registry.ts', reason: 'parser unavailable' }],
    };
    const partial = evaluateResidueCompleteness({
      changeId: CHANGE_ID,
      residue: {
        available: true,
        base: 'HEAD',
        coverage: partialCoverage,
        evaluations: [
          evaluateResidueObservation({
            ...residueObservation(),
            coverage: partialCoverage,
          }),
        ],
      },
      diffGate: { changedFiles: ['src/registry.ts'], checksRun: [], findings: [] },
      receipt: fixedReceipt(),
    });
    const moving = evaluateResidueCompleteness({
      changeId: CHANGE_ID,
      residue: residueResult(evaluateResidueObservation(residueObservation())),
      diffGate: { changedFiles: ['src/registry.ts'], checksRun: [], findings: [] },
      receipt: fixedReceipt(false),
    });

    expect(partial.decisions[0]).toMatchObject({ disposition: 'insufficient-evidence' });
    expect(moving.decisions[0]).toMatchObject({ disposition: 'insufficient-evidence' });
  });

  it('admits direct new-dead evidence while leaving descriptive documentation and twin signals advisory', () => {
    const findings = [
      finding('new-dead', 'SQ-NEW-DEAD', 'graph-fact', 'direct', 0.9),
      finding('doc-reference', 'SQ-DOC', 'change-graph', 'direct', 1),
      finding('twin-partner', 'SQ-TWIN', 'heuristic', 'signal', 0.99),
    ];
    const result = evaluateResidueCompleteness({
      changeId: CHANGE_ID,
      residue: { available: true, base: 'HEAD', coverage: completeCoverage(), evaluations: [] },
      diffGate: {
        changedFiles: ['src/changed.ts'],
        checksRun: ['new-dead', 'doc-reference', 'twin-partner'],
        findings,
      },
      receipt: fixedReceipt(),
    });

    expect(result.decisions.map((decision) => decision.disposition)).toEqual(['admit', 'advisory', 'advisory']);
  });

  it('admits the newly-unreferenced subtype carried by the production diff gate', () => {
    const residueFinding = {
      ...finding('new-dead', 'SQR-NEWLY-UNREFERENCED', 'change-graph', 'direct', 0.95),
      sourceAnalyzer: 'newly-unreferenced-residue',
      relatedFiles: ['src/registry.ts'],
    };
    const result = evaluateResidueCompleteness({
      changeId: CHANGE_ID,
      diffGate: {
        changedFiles: ['src/registry.ts', 'src/legacy.ts'],
        checksRun: ['new-dead'],
        findings: [residueFinding],
      },
      receipt: fixedReceipt(),
    });

    expect(result.decisions).toMatchObject([
      {
        disposition: 'admit',
        rule: { ruleId: 'new-dead-implementation', category: 'residue' },
      },
    ]);
  });
});

function residueResult(evaluation: ReturnType<typeof evaluateResidueObservation>): NewlyUnreferencedResidueResult {
  return {
    available: true,
    base: 'HEAD',
    coverage: evaluation.observation.coverage,
    evaluations: [evaluation],
  };
}

function residueObservation(): ResidueObservation {
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
    coverage: completeCoverage(),
  };
}

function completeCoverage(): ResidueEvidenceCoverage {
  return {
    state: 'complete',
    scope: 'changed-source-reference-delta-to-current-production-callables',
    analyzedFiles: ['src/registry.ts'],
    notApplicableFiles: [],
    omitted: [],
    unresolvedReferences: [],
  };
}

function finding(
  check: DiffGateFinding['check'],
  id: string,
  evidence: DiffGateFinding['evidence'],
  actionTier: NonNullable<DiffGateFinding['actionTier']>,
  confidence: number,
): DiffGateFinding {
  return {
    id,
    check,
    severity: 'warning',
    evidence,
    actionTier,
    confidence,
    file: 'src/changed.ts',
    message: `${check} finding`,
    why: ['Fixture evidence.'],
    remediation: `Resolve ${check}.`,
  };
}

function fixedReceipt(fixed = true): ObservationReceiptV2 {
  const wholeContent = createObservationIdentity('repository-content', 1, fixed ? 'fixed' : 'moving');
  return {
    schemaVersion: 2,
    observedAt: '2026-07-30T12:00:00.000Z',
    facts: {
      collaborationDomain: createObservationIdentity('scip-query:collaboration-domain', 1, COLLABORATION_DOMAIN),
      ...(fixed ? { wholeContent } : {}),
    },
    observedSources: fixed ? [{ kind: 'repository-snapshot', identity: wholeContent }] : [],
    stabilityProofs: fixed ? [{ source: 'repository-snapshot', kind: 'fixed-snapshot' }] : [],
  };
}
