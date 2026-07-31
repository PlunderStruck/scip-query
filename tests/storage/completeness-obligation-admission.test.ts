import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CLAIM_ACTION_POLICY_VERSION, deriveClaimQualification } from '../../src/domain/claim-qualification.js';
import {
  evaluateCompletenessAdmission,
  type CompletenessAdmissionObservation,
  type CompletenessObligationPolicy,
} from '../../src/domain/completeness-obligation-admission.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';
import {
  readCompletenessAdmissionRecords,
  recordCompletenessAdmissionDecision,
} from '../../src/storage/completeness-obligation-admission.js';
import { readObligationAdmissions } from '../../src/storage/autonomous-work-obligations.js';
import { createGoalRecordFile, createIntendedChangeRecordFile } from '../../src/storage/autonomous-work-state.js';

const COLLABORATION_DOMAIN = '70a26367-a22f-46a7-aa64-f4ea5f09cc51';
const TOOL_VERSION = '0.20.0';
const fixtureDirectories = new Set<string>();

afterEach(() => {
  for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true });
  fixtureDirectories.clear();
});

describe('completeness obligation admission storage', () => {
  it('records later evidence without duplicating the stable obligation and preserves advisory observations', () => {
    const root = fixtureDirectory();
    const changeId = createChange(root);
    const first = recordCompletenessAdmissionDecision(
      root,
      COLLABORATION_DOMAIN,
      evaluateCompletenessAdmission(observation(changeId, strictPolicy(), receipt('first'))),
      { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:05:00.000Z' },
    );
    const later = recordCompletenessAdmissionDecision(
      root,
      COLLABORATION_DOMAIN,
      evaluateCompletenessAdmission(observation(changeId, strictPolicy(), receipt('later'))),
      { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:10:00.000Z' },
    );
    const advisoryPolicy: CompletenessObligationPolicy = {
      policyId: 'repo:advisory',
      policyVersion: 1,
      rules: [],
    };
    const advisory = recordCompletenessAdmissionDecision(
      root,
      COLLABORATION_DOMAIN,
      evaluateCompletenessAdmission(observation(changeId, advisoryPolicy, receipt('advisory'))),
      { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:11:00.000Z' },
    );

    expect(first.obligation).toMatchObject({ publication: 'created' });
    expect(later.obligation).toEqual({
      obligationId: first.obligation?.obligationId,
      publication: 'existing',
    });
    expect(advisory.obligation).toBeUndefined();
    expect(readObligationAdmissions(root).records).toHaveLength(1);
    const observations = readCompletenessAdmissionRecords(root);
    expect(observations.records).toHaveLength(3);
    expect(observations.records.map((record) => record.disposition).sort()).toEqual(['admit', 'admit', 'advisory']);
    expect(observations.records.filter((record) => record.disposition === 'admit')).toEqual([
      expect.objectContaining({ obligationId: first.obligation?.obligationId }),
      expect.objectContaining({ obligationId: first.obligation?.obligationId }),
    ]);
    expect(observations.integrityIssues).toEqual([]);
  });
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'scip-query-completeness-admission-'));
  fixtureDirectories.add(directory);
  return directory;
}

function createChange(root: string): string {
  const goal = createGoalRecordFile(
    root,
    COLLABORATION_DOMAIN,
    {
      feature: 'Completion reconciles repository structure and residue',
      invariants: ['Only qualified change-relevant findings become obligations'],
      acceptanceScenarios: [
        {
          name: 'Strict architecture blocks completion',
          given: ['the repository declares a forbidden dependency'],
          when: ['the candidate introduces that dependency'],
          then: ['one architecture obligation remains live'],
        },
      ],
      authorization: {
        kind: 'repository-delegation',
        principal: 'repository-owner',
        source: 'codex-task',
      },
    },
    { toolVersion: TOOL_VERSION },
  ).record;
  return createIntendedChangeRecordFile(
    root,
    COLLABORATION_DOMAIN,
    {
      goalId: goal.goalId,
      idempotencyKey: 'completeness-storage',
      title: 'Reconcile repository completeness',
      intendedOutcome: 'Qualified findings become durable obligations',
    },
    { toolVersion: TOOL_VERSION },
  ).record.changeId;
}

function observation(
  changeId: string,
  policy: CompletenessObligationPolicy,
  evidence: ObservationReceiptV2,
): CompletenessAdmissionObservation {
  return {
    changeId,
    policy,
    candidate: {
      findingId: 'SQ-ARCH-1',
      check: 'architecture',
      evidence: 'graph-fact',
      actionTier: 'direct',
      confidence: 1,
      advisory: false,
      file: 'src/runtime/feature.ts',
      relatedFiles: ['src/domain/policy.ts'],
      message: 'runtime depends on a forbidden domain',
      remediation: 'Remove the forbidden runtime-to-domain dependency.',
    },
    relevance: {
      state: 'in-scope',
      basis: 'candidate-diff',
      paths: ['src/runtime/feature.ts'],
      reasons: ['The evaluated candidate introduced the forbidden edge.'],
    },
    qualification: deriveClaimQualification({
      contract: {
        origin: 'compiler-graph',
        observedSources: ['repository-snapshot'],
        producerValidation: { status: 'not-applicable' },
      },
      receipt: evidence,
      coverage: { complete: true, totalKnown: true, returned: 1, total: 1, omitted: 0 },
      repositoryPolicy: {
        policyId: policy.policyId,
        policyVersion: CLAIM_ACTION_POLICY_VERSION,
        permission: policy.rules.length > 0 ? 'block' : 'advise',
        reasons: ['The repository policy determines whether this finding is required work.'],
      },
    }),
    evidenceReceipts: [evidence],
  };
}

function strictPolicy(): CompletenessObligationPolicy {
  return {
    policyId: 'repo:strict-architecture',
    policyVersion: 1,
    rules: [
      {
        ruleId: 'strict-architecture',
        checks: ['architecture'],
        category: 'architecture',
        admissibleActionTiers: ['direct'],
        minimumConfidence: 1,
        allowProducerAdvisory: false,
        qualification: {
          origins: ['compiler-graph'],
          producerValidation: ['not-applicable'],
        },
      },
    ],
  };
}

function receipt(label: string): ObservationReceiptV2 {
  const content = createObservationIdentity('scip-query:repository-content', 1, label);
  return {
    schemaVersion: 2,
    observedAt:
      label === 'first'
        ? '2026-07-30T12:00:00.000Z'
        : label === 'later'
          ? '2026-07-30T12:09:00.000Z'
          : '2026-07-30T12:10:00.000Z',
    facts: {
      collaborationDomain: createObservationIdentity('scip-query:collaboration-domain', 1, COLLABORATION_DOMAIN),
      wholeContent: content,
    },
    observedSources: [{ kind: 'repository-snapshot', identity: content }],
    stabilityProofs: [{ source: 'repository-snapshot', kind: 'fixed-snapshot' }],
  };
}
