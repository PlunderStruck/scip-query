import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  OBLIGATION_ADMISSION_SCHEMA_VERSION,
  OBLIGATION_TRANSITION_SCHEMA_VERSION,
  createObligationAdmission,
  createObligationTransition,
  decodeObligationAdmissionRecord,
  decodeObligationTransitionRecord,
  foldObligationLifecycle,
  terminalEvidenceIsCurrent,
  type ObligationAdmissionRequest,
  type ObligationTransitionRequest,
} from '../../src/domain/autonomous-work-obligations.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const CHANGE_ID = 'SQC-0123456789ABCDEF0123456789ABCDEF';
const NEXT_CHANGE_ID = 'SQC-FEDCBA9876543210FEDCBA9876543210';
const CREATED_AT = '2026-07-30T12:00:00.000Z';

describe('autonomous work obligations domain', () => {
  it('derives retry-stable admission identity while binding the complete condition meaning', () => {
    const request = admissionRequest('cleanup');
    const first = admission(request);
    const retry = admission({
      ...request,
      title: ' Remove   obsolete adapter ',
      requiredCondition: ' The obsolete adapter has no remaining source or consumer ',
    });
    const collision = admission({ ...request, requiredCondition: 'A different condition' });

    expect(first.obligationId).toMatch(/^SQO-[A-F0-9]{32}$/u);
    expect(retry.obligationId).toBe(first.obligationId);
    expect(retry.idempotency.requestDigest).toBe(first.idempotency.requestDigest);
    expect(collision.obligationId).toBe(first.obligationId);
    expect(collision.idempotency.requestDigest).not.toBe(first.idempotency.requestDigest);
    expect(decodeObligationAdmissionRecord(first)).toEqual({ state: 'current', record: first });
  });

  it('keeps an obligation live until fixed current evidence supports a terminal transition', () => {
    const admitted = admission(admissionRequest('cleanup'));
    const stale = transition(
      transitionRequest(admitted.obligationId, 'stale', 'fulfilled', [receipt('2026-07-30T11:59:00.000Z', 'stale')]),
    );
    const unstable = transition(
      transitionRequest(admitted.obligationId, 'unstable', 'fulfilled', [
        receipt('2026-07-30T12:05:00.000Z', 'unstable', 'bracketed'),
      ]),
    );
    const current = transition(
      transitionRequest(admitted.obligationId, 'current', 'fulfilled', [
        receipt('2026-07-30T12:05:00.000Z', 'current'),
      ]),
    );

    expect(terminalEvidenceIsCurrent(obligation(admitted), stale.evidenceReceipts)).toBe(false);
    expect(terminalEvidenceIsCurrent(obligation(admitted), unstable.evidenceReceipts)).toBe(false);
    expect(foldObligationLifecycle([admitted], [stale, unstable]).liveObligationIds).toEqual([admitted.obligationId]);
    expect(foldObligationLifecycle([admitted], [current]).fulfilledObligationIds).toEqual([admitted.obligationId]);
  });

  it('exposes conflicting branch transitions instead of selecting the last writer', () => {
    const admitted = admission(admissionRequest('cleanup'));
    const fulfilled = transition(
      transitionRequest(admitted.obligationId, 'fulfilled', 'fulfilled', [
        receipt('2026-07-30T12:05:00.000Z', 'fulfilled'),
      ]),
    );
    const invalidated = transition({
      ...transitionRequest(admitted.obligationId, 'invalidated', 'invalidated', [
        receipt('2026-07-30T12:06:00.000Z', 'invalidated'),
      ]),
      reason: 'premise-disproven',
    });
    const first = foldObligationLifecycle([admitted], [invalidated, fulfilled]);
    const second = foldObligationLifecycle([admitted], [fulfilled, invalidated]);

    expect(first).toEqual(second);
    expect(first.conflictedObligationIds).toEqual([admitted.obligationId]);
    expect(first.liveObligationIds).toEqual([]);
    expect(first.conflicts).toEqual([expect.stringContaining('conflicting terminal transitions')]);
  });

  it('atomically closes a predecessor and introduces a live successor', () => {
    const admitted = admission(admissionRequest('cleanup'));
    const carried = transition({
      ...transitionRequest(admitted.obligationId, 'carry', 'carried-forward', [
        receipt('2026-07-30T12:05:00.000Z', 'carry'),
      ]),
      reason: 'successor-change-authorized',
      successor: {
        ...admissionRequest('successor'),
        changeId: NEXT_CHANGE_ID,
        title: 'Finish cleanup in the successor change',
      },
    });
    const summary = foldObligationLifecycle([admitted], [carried]);

    expect(summary.carriedForwardObligationIds).toEqual([admitted.obligationId]);
    expect(summary.liveObligationIds).toEqual([carried.successor?.obligationId]);
    expect(summary.obligations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'live',
          obligation: expect.objectContaining({
            origin: 'carried-forward',
            introducingTransitionId: carried.transitionId,
          }),
        }),
      ]),
    );
  });

  it('does not introduce a successor when concurrent transitions disagree about the predecessor', () => {
    const admitted = admission(admissionRequest('cleanup'));
    const carried = transition({
      ...transitionRequest(admitted.obligationId, 'carry', 'carried-forward', [
        receipt('2026-07-30T12:05:00.000Z', 'carry'),
      ]),
      reason: 'successor-change-authorized',
      successor: {
        ...admissionRequest('successor'),
        changeId: NEXT_CHANGE_ID,
      },
    });
    const fulfilled = transition(
      transitionRequest(admitted.obligationId, 'fulfilled', 'fulfilled', [
        receipt('2026-07-30T12:06:00.000Z', 'fulfilled'),
      ]),
    );
    const summary = foldObligationLifecycle([admitted], [carried, fulfilled]);

    expect(summary.conflictedObligationIds).toEqual([admitted.obligationId]);
    expect(summary.liveObligationIds).toEqual([]);
    expect(summary.obligations.some((candidate) => candidate.obligation.origin === 'carried-forward')).toBe(false);
  });

  it('classifies future schemas and rejects contradictory transition records', () => {
    const admitted = admission(admissionRequest('cleanup'));
    const fulfilled = transition(
      transitionRequest(admitted.obligationId, 'fulfilled', 'fulfilled', [
        receipt('2026-07-30T12:05:00.000Z', 'fulfilled'),
      ]),
    );

    expect(
      decodeObligationAdmissionRecord({
        ...admitted,
        schemaVersion: OBLIGATION_ADMISSION_SCHEMA_VERSION + 1,
      }),
    ).toEqual(expect.objectContaining({ state: 'unsupported-future' }));
    expect(
      decodeObligationTransitionRecord({
        ...fulfilled,
        schemaVersion: OBLIGATION_TRANSITION_SCHEMA_VERSION + 1,
      }),
    ).toEqual(expect.objectContaining({ state: 'unsupported-future' }));
    expect(decodeObligationTransitionRecord({ ...fulfilled, from: 'fulfilled' })).toEqual(
      expect.objectContaining({ state: 'malformed' }),
    );
  });

  it('keeps packaged obligation schemas aligned with runtime discriminators', () => {
    const schemas = join(process.cwd(), 'docs', 'schemas');
    const admission = JSON.parse(readFileSync(join(schemas, 'obligation-admission-record.schema.json'), 'utf8')) as {
      required: string[];
      properties: Record<string, { const?: unknown }>;
      additionalProperties: boolean;
    };
    const transitionSchema = JSON.parse(
      readFileSync(join(schemas, 'obligation-transition-record.schema.json'), 'utf8'),
    ) as {
      required: string[];
      properties: Record<string, { const?: unknown }>;
      additionalProperties: boolean;
    };

    expect(admission.properties['kind']?.const).toBe('scip-query-obligation-admission');
    expect(admission.properties['schemaVersion']?.const).toBe(OBLIGATION_ADMISSION_SCHEMA_VERSION);
    expect(admission.required).toEqual(
      expect.arrayContaining(['obligationId', 'changeId', 'requiredCondition', 'source', 'idempotency']),
    );
    expect(admission.additionalProperties).toBe(false);
    expect(transitionSchema.properties['kind']?.const).toBe('scip-query-obligation-transition');
    expect(transitionSchema.properties['schemaVersion']?.const).toBe(OBLIGATION_TRANSITION_SCHEMA_VERSION);
    expect(transitionSchema.required).toEqual(
      expect.arrayContaining(['transitionId', 'obligationId', 'from', 'to', 'reason', 'evidenceReceipts']),
    );
    expect(transitionSchema.additionalProperties).toBe(false);
  });
});

function admissionRequest(idempotencyKey: string): ObligationAdmissionRequest {
  return {
    changeId: CHANGE_ID,
    idempotencyKey,
    category: 'residue',
    title: 'Remove obsolete adapter',
    requiredCondition: 'The obsolete adapter has no remaining source or consumer',
    source: { kind: 'agent-discovery', referent: 'src/obsolete-adapter.ts' },
    basisAttemptIds: [],
    evidenceReceipts: [],
  };
}

function transitionRequest(
  obligationId: string,
  idempotencyKey: string,
  to: ObligationTransitionRequest['to'],
  evidenceReceipts: readonly ObservationReceiptV2[],
): ObligationTransitionRequest {
  return {
    changeId: CHANGE_ID,
    obligationId,
    idempotencyKey,
    to,
    reason: to === 'fulfilled' ? 'condition-established' : 'premise-disproven',
    basisAttemptIds: [],
    evidenceReceipts,
    rationale: 'The current fixed repository observation establishes the transition',
  };
}

function admission(request: ObligationAdmissionRequest) {
  return createObligationAdmission({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request,
    createdAt: CREATED_AT,
    toolVersion: '0.20.0',
  });
}

function transition(request: ObligationTransitionRequest) {
  return createObligationTransition({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request,
    createdAt: '2026-07-30T12:10:00.000Z',
    toolVersion: '0.20.0',
  });
}

function obligation(record: ReturnType<typeof admission>) {
  return {
    obligationId: record.obligationId,
    collaborationDomainId: record.collaborationDomainId,
    changeId: record.changeId,
    category: record.category,
    title: record.title,
    requiredCondition: record.requiredCondition,
    source: record.source,
    basisAttemptIds: record.basisAttemptIds,
    evidenceReceipts: record.evidenceReceipts,
    admittedAt: record.createdAt,
    origin: 'admission' as const,
  };
}

function receipt(
  observedAt: string,
  identity: string,
  proof: 'fixed-snapshot' | 'bracketed' = 'fixed-snapshot',
): ObservationReceiptV2 {
  const content = createObservationIdentity('scip-query:repository-content', 1, identity);
  const source = proof === 'bracketed' ? 'live-workspace' : 'repository-snapshot';
  return {
    schemaVersion: 2,
    observedAt,
    facts: {
      collaborationDomain: createObservationIdentity('scip-query:collaboration-domain', 1, COLLABORATION_DOMAIN),
      wholeContent: content,
    },
    observedSources: [source === 'repository-snapshot' ? { kind: source, identity: content } : { kind: source }],
    stabilityProofs: [{ source, kind: proof }],
  };
}
