import { describe, expect, it } from 'vitest';

import {
  architectureCompletenessPolicy,
  evaluateArchitectureCompleteness,
} from '../../src/runtime/architecture-completeness.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';
import type { ArchitectureConfig } from '../../src/domain/config-types.js';
import type { DiffGateFinding } from '../../src/queries/impact/diff-gate.js';

const CHANGE_ID = 'SQC-0123456789ABCDEF0123456789ABCDEF';
const COLLABORATION_DOMAIN = '70a26367-a22f-46a7-aa64-f4ea5f09cc51';
const ARCHITECTURE: ArchitectureConfig = {
  boundaries: [
    { name: 'domain', paths: ['src/domain/**'] },
    { name: 'runtime', paths: ['src/runtime/**'] },
  ],
  allowedDependencies: { domain: [], runtime: ['domain'] },
  requireCompletePolicy: true,
};

describe('architecture completeness admission', () => {
  it('admits a declared architecture violation whose current edge intersects the candidate diff', () => {
    const decisions = evaluateArchitectureCompleteness({
      changeId: CHANGE_ID,
      architecture: ARCHITECTURE,
      diffGate: {
        changedFiles: ['src/domain/model.ts'],
        checksRun: ['architecture'],
        findings: [architectureFinding()],
      },
      receipt: fixedReceipt(),
    });

    expect(decisions).toMatchObject([
      {
        disposition: 'admit',
        rule: { ruleId: 'declared-architecture', category: 'architecture' },
        obligationRequest: {
          changeId: CHANGE_ID,
          category: 'architecture',
          source: { kind: 'detector-finding', check: 'architecture', findingId: 'SQ-ARCH-1' },
          requiredCondition: 'Remove the forbidden domain-to-runtime dependency.',
        },
      },
    ]);
  });

  it('withholds admission when the architecture fact has no current referent in the candidate diff', () => {
    const [decision] = evaluateArchitectureCompleteness({
      changeId: CHANGE_ID,
      architecture: ARCHITECTURE,
      diffGate: {
        changedFiles: ['src/other.ts'],
        checksRun: ['architecture'],
        findings: [architectureFinding()],
      },
      receipt: fixedReceipt(),
    });

    expect(decision).toMatchObject({
      disposition: 'insufficient-evidence',
      reasons: expect.arrayContaining([expect.stringContaining('not been tied to this intended change')]),
    });
  });

  it('withholds admission when producer coverage or fixed-state authority is not established', () => {
    const [decision] = evaluateArchitectureCompleteness({
      changeId: CHANGE_ID,
      architecture: ARCHITECTURE,
      diffGate: {
        changedFiles: ['src/domain/model.ts'],
        checksRun: [],
        findings: [architectureFinding()],
      },
      receipt: fixedReceipt(false),
    });

    expect(decision).toMatchObject({ disposition: 'insufficient-evidence' });
    expect(decision?.reasons.join(' ')).toMatch(/coverage|state-authority/u);
  });

  it('keeps architecture descriptive when the repository declares no enforceable rule', () => {
    const policy = architectureCompletenessPolicy({
      boundaries: ARCHITECTURE.boundaries,
    });

    expect(policy.rules).toEqual([]);
  });
});

function architectureFinding(): DiffGateFinding {
  return {
    id: 'SQ-ARCH-1',
    check: 'architecture',
    severity: 'error',
    evidence: 'baseline',
    actionTier: 'direct',
    confidence: 1,
    file: 'src/domain/model.ts',
    relatedFiles: ['src/domain/model.ts', 'src/runtime/start.ts'],
    sourceAnalyzer: 'architecture',
    rootCauseKey: 'forbidden-edge:domain:runtime',
    message: 'new architecture boundary violation',
    why: ['Declared boundary rule rejects domain -> runtime.'],
    remediation: 'Remove the forbidden domain-to-runtime dependency.',
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
