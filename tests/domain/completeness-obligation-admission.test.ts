import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CLAIM_ACTION_POLICY_VERSION, deriveClaimQualification } from '../../src/domain/claim-qualification.js';
import {
  COMPLETENESS_ADMISSION_SCHEMA_VERSION,
  createCompletenessAdmissionRecord,
  decodeCompletenessAdmissionRecord,
  evaluateCompletenessAdmission,
  type CompletenessAdmissionObservation,
  type CompletenessObligationPolicy,
} from '../../src/domain/completeness-obligation-admission.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';

const CHANGE_ID = 'SQC-0123456789ABCDEF0123456789ABCDEF';
const OBLIGATION_ID = 'SQO-0123456789ABCDEF0123456789ABCDEF';
const COLLABORATION_DOMAIN = '70a26367-a22f-46a7-aa64-f4ea5f09cc51';
const CREATED_AT = '2026-07-30T12:05:00.000Z';

describe('completeness obligation admission', () => {
  it('admits one qualified change-relevant finding and preserves a canonical decision record', () => {
    const decision = evaluateCompletenessAdmission(observation());

    expect(decision).toMatchObject({
      disposition: 'admit',
      rule: { ruleId: 'strict-architecture' },
      obligationRequest: {
        changeId: CHANGE_ID,
        category: 'architecture',
        source: { kind: 'detector-finding', check: 'architecture', findingId: 'SQ-ARCH-1' },
        basisAttemptIds: [],
      },
    });
    if (decision.disposition !== 'admit') throw new Error('expected admission');
    const record = createCompletenessAdmissionRecord({
      collaborationDomainId: COLLABORATION_DOMAIN,
      decision,
      obligationId: OBLIGATION_ID,
      createdAt: CREATED_AT,
      toolVersion: '0.20.0',
    });

    expect(record.admissionRecordId).toMatch(/^SQCA-[A-F0-9]{32}$/u);
    expect(decodeCompletenessAdmissionRecord(record)).toEqual({ state: 'current', record });
    expect(
      decodeCompletenessAdmissionRecord({
        ...record,
        schemaVersion: COMPLETENESS_ADMISSION_SCHEMA_VERSION + 1,
      }),
    ).toEqual(expect.objectContaining({ state: 'unsupported-future' }));
    expect(decodeCompletenessAdmissionRecord({ ...record, disposition: 'advisory' })).toEqual(
      expect.objectContaining({ state: 'malformed' }),
    );
  });

  it('keeps the same factual payload advisory when repository policy does not promote its detector', () => {
    const advisory = evaluateCompletenessAdmission(
      observation({
        policy: { policyId: 'repo:advisory', policyVersion: 1, rules: [] },
        qualificationPolicyId: 'repo:advisory',
      }),
    );

    expect(advisory).toMatchObject({
      disposition: 'advisory',
      reasons: [expect.stringContaining('has no obligation rule for architecture')],
    });
  });

  it('refuses blocking admission when repository state authority is unknown', () => {
    const decision = evaluateCompletenessAdmission(observation({ receipt: receipt('unknown', false) }));

    expect(decision).toMatchObject({
      disposition: 'insufficient-evidence',
      reasons: [expect.stringContaining('state-authority is advisory')],
    });
  });

  it('classifies a factually unrelated finding as out of scope without weakening its payload', () => {
    const candidate = observation().candidate;
    const decision = evaluateCompletenessAdmission(
      observation({
        relevance: {
          state: 'out-of-scope',
          basis: 'unrelated',
          paths: ['legacy/unrelated.ts'],
          reasons: ['The finding predates and does not intersect the candidate or affected surface.'],
        },
      }),
    );

    expect(decision.disposition).toBe('out-of-scope');
    expect(decision.observation.candidate).toEqual(candidate);
  });

  it('uses one stable obligation retry key while retaining later observations as distinct evidence', () => {
    const first = evaluateCompletenessAdmission(observation({ receipt: receipt('first') }));
    const later = evaluateCompletenessAdmission(observation({ receipt: receipt('later') }));
    if (first.disposition !== 'admit' || later.disposition !== 'admit') {
      throw new Error('expected both observations to be admitted');
    }

    expect(later.obligationRequest.idempotencyKey).toBe(first.obligationRequest.idempotencyKey);
    const firstRecord = createCompletenessAdmissionRecord({
      collaborationDomainId: COLLABORATION_DOMAIN,
      decision: first,
      obligationId: OBLIGATION_ID,
      createdAt: CREATED_AT,
      toolVersion: '0.20.0',
    });
    const laterRecord = createCompletenessAdmissionRecord({
      collaborationDomainId: COLLABORATION_DOMAIN,
      decision: later,
      obligationId: OBLIGATION_ID,
      createdAt: '2026-07-30T12:10:00.000Z',
      toolVersion: '0.20.0',
    });
    expect(laterRecord.admissionRecordId).not.toBe(firstRecord.admissionRecordId);
  });

  it('keeps the packaged record schema aligned with the runtime discriminator', () => {
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), 'docs', 'schemas', 'completeness-admission-record.schema.json'), 'utf8'),
    ) as {
      required: string[];
      properties: Record<string, { const?: unknown }>;
      additionalProperties: boolean;
    };

    expect(schema.properties['kind']?.const).toBe('scip-query-completeness-admission');
    expect(schema.properties['schemaVersion']?.const).toBe(COMPLETENESS_ADMISSION_SCHEMA_VERSION);
    expect(schema.required).toContain('qualification');
    expect(schema.required).toContain('disposition');
    expect(schema.additionalProperties).toBe(false);
  });

  it('rejects malformed qualification requirements in editable policy records', () => {
    const decision = evaluateCompletenessAdmission(
      observation({
        policy: {
          ...strictPolicy(),
          rules: [
            {
              ...strictPolicy().rules[0]!,
              qualification: { origins: ['invented-origin'] } as never,
            },
          ],
        },
      }),
    );

    expect(decision).toMatchObject({
      disposition: 'insufficient-evidence',
      reasons: [expect.stringContaining('is invalid')],
    });
  });
});

function observation(
  options: {
    policy?: CompletenessObligationPolicy;
    qualificationPolicyId?: string;
    receipt?: ObservationReceiptV2;
    relevance?: CompletenessAdmissionObservation['relevance'];
  } = {},
): CompletenessAdmissionObservation {
  const evidence = options.receipt ?? receipt('candidate');
  const policy = options.policy ?? strictPolicy();
  return {
    changeId: CHANGE_ID,
    policy,
    candidate: {
      findingId: 'SQ-ARCH-1',
      check: 'architecture',
      evidence: 'graph-fact',
      actionTier: 'direct',
      confidence: 1,
      advisory: false,
      file: 'src/feature.ts',
      relatedFiles: ['src/domain.ts'],
      message: 'runtime depends on a forbidden domain',
      remediation: 'Remove the forbidden runtime-to-domain dependency.',
    },
    relevance:
      options.relevance ??
      ({
        state: 'in-scope',
        basis: 'candidate-diff',
        paths: ['src/feature.ts'],
        reasons: ['The forbidden edge was introduced by the evaluated candidate.'],
      } as const),
    qualification: deriveClaimQualification({
      contract: {
        origin: 'compiler-graph',
        observedSources: ['repository-snapshot'],
        producerValidation: { status: 'not-applicable' },
      },
      receipt: evidence,
      coverage: { complete: true, totalKnown: true, returned: 1, total: 1, omitted: 0 },
      repositoryPolicy: {
        policyId: options.qualificationPolicyId ?? policy.policyId,
        policyVersion: CLAIM_ACTION_POLICY_VERSION,
        permission: 'block',
        reasons: ['The repository declares this relationship forbidden.'],
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

function receipt(label: string, fixed = true): ObservationReceiptV2 {
  const wholeContent = createObservationIdentity('repository-content', 1, label);
  return {
    schemaVersion: 2,
    observedAt: label === 'later' ? '2026-07-30T12:09:00.000Z' : '2026-07-30T12:00:00.000Z',
    facts: {
      collaborationDomain: createObservationIdentity('scip-query:collaboration-domain', 1, COLLABORATION_DOMAIN),
      ...(fixed ? { wholeContent } : {}),
    },
    observedSources: fixed ? [{ kind: 'repository-snapshot', identity: wholeContent }] : [],
    stabilityProofs: fixed ? [{ source: 'repository-snapshot', kind: 'fixed-snapshot' }] : [],
  };
}
