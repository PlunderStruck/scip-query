import { describe, expect, it } from 'vitest';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';
import {
  CLAIM_ACTION_POLICY_VERSION,
  deriveClaimQualification,
  evaluateClaimQualification,
  isClaimQualificationV1,
  type CommandClaimContract,
} from '../../src/runtime/claim-qualification.js';

const heuristicContract: CommandClaimContract = {
  origin: 'heuristic',
  observedSources: ['repository-snapshot'],
  producerValidation: { status: 'not-evaluated' },
};

describe('claim qualifications', () => {
  it('keeps complete coverage independent from heuristic origin and producer validation', () => {
    const qualification = deriveClaimQualification({
      contract: heuristicContract,
      receipt: fixedReceipt(),
      coverage: {
        complete: true,
        totalKnown: true,
        returned: 3,
        total: 3,
        omitted: 0,
      },
    });

    expect(qualification).toMatchObject({
      origin: 'heuristic',
      coverage: { state: 'complete', returned: 3, totalKnown: true, total: 3, omitted: 0 },
      producerValidation: { status: 'not-evaluated' },
      stateAuthority: { authority: 'completion' },
      repositoryPolicy: { permission: 'not-established' },
    });
    expect(isClaimQualificationV1(qualification)).toBe(true);
  });

  it('keeps an immutable graph result advisory when whole-content state is not established', () => {
    const receipt: ObservationReceiptV2 = {
      schemaVersion: 2,
      observedAt: '2026-07-30T12:00:00.000Z',
      facts: {
        collaborationDomain: createObservationIdentity('collaboration', 1, 'shared'),
        index: {
          generation: createObservationIdentity('generation', 1, 'generation-a'),
          source: 'immutable',
        },
      },
      observedSources: [{ kind: 'index-generation' }],
      stabilityProofs: [{ source: 'index-generation', kind: 'immutable' }],
    };

    const qualification = deriveClaimQualification({
      contract: {
        origin: 'compiler-graph',
        observedSources: ['index-generation'],
        producerValidation: { status: 'not-evaluated' },
      },
      receipt,
      coverage: { complete: true, totalKnown: true, returned: 1, total: 1, omitted: 0 },
    });

    expect(qualification.origin).toBe('compiler-graph');
    expect(qualification.coverage.state).toBe('complete');
    expect(qualification.stateAuthority).toMatchObject({
      authority: 'advisory',
      reasons: expect.arrayContaining(['wholeContent:unknown']),
    });
  });

  it('does not let completion-authoritative state override advisory repository policy', () => {
    const qualification = deriveClaimQualification({
      contract: heuristicContract,
      receipt: fixedReceipt(),
      repositoryPolicy: {
        policyId: 'repo:residue-rollout',
        policyVersion: CLAIM_ACTION_POLICY_VERSION,
        permission: 'advise',
        reasons: ['Detector remains in its advisory calibration period.'],
      },
    });

    const evaluation = evaluateClaimQualification(qualification, {
      stateAuthority: ['completion'],
      actionPermission: ['block'],
    });

    expect(evaluation).toEqual({
      satisfied: false,
      predicates: [
        {
          predicate: 'state-authority',
          satisfied: true,
          required: ['completion'],
          actual: 'completion',
        },
        {
          predicate: 'action-permission',
          satisfied: false,
          required: ['block'],
          actual: 'advise',
        },
      ],
    });
  });

  it('retains result-family provenance for mixed producers', () => {
    const qualification = deriveClaimQualification({
      contract: {
        origin: 'mixed',
        observedSources: ['index-generation', 'live-workspace'],
        producerValidation: { status: 'not-evaluated' },
        families: [
          {
            id: 'findings',
            selector: 'findings[]',
            origin: {
              kind: 'result-field',
              field: 'evidence',
              values: {
                'graph-fact': 'compiler-graph',
                heuristic: 'heuristic',
              },
            },
          },
        ],
      },
      receipt: fixedReceipt(),
    });

    expect(qualification.families).toEqual([
      {
        id: 'findings',
        selector: 'findings[]',
        origin: {
          kind: 'result-field',
          field: 'evidence',
          values: {
            'graph-fact': 'compiler-graph',
            heuristic: 'heuristic',
          },
        },
      },
    ]);
    expect(isClaimQualificationV1(qualification)).toBe(true);
  });
});

function fixedReceipt(): ObservationReceiptV2 {
  const content = createObservationIdentity('repository-content', 1, 'same bytes');
  return {
    schemaVersion: 2,
    observedAt: '2026-07-30T12:00:00.000Z',
    facts: {
      collaborationDomain: createObservationIdentity('collaboration', 1, 'shared'),
      wholeContent: content,
    },
    observedSources: [{ kind: 'repository-snapshot', identity: content }],
    stabilityProofs: [{ source: 'repository-snapshot', kind: 'fixed-snapshot' }],
  };
}
