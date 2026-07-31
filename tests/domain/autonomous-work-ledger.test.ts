import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_RECORD_KIND,
  ATTEMPT_RECORD_SCHEMA_VERSION,
  DECISION_RECORD_KIND,
  DECISION_RECORD_SCHEMA_VERSION,
  createAttemptRecord,
  createDecisionRecord,
  decodeAttemptCreateRequest,
  decodeAttemptRecord,
  decodeDecisionRecord,
  foldWorkHistory,
  type AttemptCreateRequest,
  type DecisionCreateRequest,
} from '../../src/domain/autonomous-work-ledger.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const CHANGE_ID = 'SQC-0123456789ABCDEF0123456789ABCDEF';
const CREATED_AT = '2026-07-30T12:00:00.000Z';

describe('autonomous work ledger domain', () => {
  it('derives retry-stable opaque attempt identity while binding the complete action meaning', () => {
    const request = attemptRequest('attempt-1', 'unknown');
    const first = attemptRecord(request, CREATED_AT);
    const retry = attemptRecord(
      {
        ...request,
        intendedCondition: '  The   migration has one effect ',
        action: { ...request.action, summary: ' Apply   migration once ' },
      },
      '2026-07-31T12:00:00.000Z',
    );
    const collision = attemptRecord({ ...request, observedEffect: 'A different observed effect' }, CREATED_AT);

    expect(first.attemptId).toMatch(/^SQA-[A-F0-9]{32}$/u);
    expect(retry.attemptId).toBe(first.attemptId);
    expect(retry.idempotency.requestDigest).toBe(first.idempotency.requestDigest);
    expect(collision.attemptId).toBe(first.attemptId);
    expect(collision.idempotency.requestDigest).not.toBe(first.idempotency.requestDigest);
    expect(decodeAttemptRecord(first)).toEqual({ state: 'current', record: first });
  });

  it('keeps an unknown non-idempotent effect unsafe until a later observation reconciles it', () => {
    const unknown = attemptRecord(attemptRequest('unknown-action', 'unknown'), CREATED_AT);
    const stale = attemptRecord(
      {
        ...attemptRequest('stale-reconciliation', 'succeeded'),
        evidenceReceipts: [receipt('2026-07-30T11:59:59.000Z', 'stale')],
        reconcilesAttemptId: unknown.attemptId,
      },
      '2026-07-30T12:05:00.000Z',
    );
    const current = attemptRecord(
      {
        ...attemptRequest('current-reconciliation', 'succeeded'),
        evidenceReceipts: [receipt('2026-07-30T12:04:00.000Z', 'current')],
        reconcilesAttemptId: unknown.attemptId,
      },
      '2026-07-30T12:05:00.000Z',
    );

    expect(foldWorkHistory([unknown, stale], []).unsafeToRepeatAttemptIds).toEqual([unknown.attemptId]);
    const reconciled = foldWorkHistory([current, unknown, stale], []);
    expect(reconciled.unresolvedUnknownAttemptIds).toEqual([]);
    expect(reconciled.unsafeToRepeatAttemptIds).toEqual([]);
    expect(reconciled.reconciliations).toEqual([
      {
        attemptId: unknown.attemptId,
        reconciliationAttemptId: current.attemptId,
        outcome: 'succeeded',
      },
    ]);
  });

  it('exposes conflicting reconciliation facts rather than applying last-writer-wins', () => {
    const unknown = attemptRecord(attemptRequest('unknown-action', 'unknown'), CREATED_AT);
    const succeeded = reconciliation('succeeded-reconciliation', unknown.attemptId, 'succeeded');
    const failed = reconciliation('failed-reconciliation', unknown.attemptId, 'failed');
    const summary = foldWorkHistory([unknown, succeeded, failed], []);

    expect(summary.reconciliations).toEqual([]);
    expect(summary.unresolvedUnknownAttemptIds).toEqual([unknown.attemptId]);
    expect(summary.reconciliationConflicts).toEqual([expect.stringContaining(`conflicting reconciliation outcomes`)]);
  });

  it('folds concurrent decisions in stable time-and-identity order', () => {
    const attempt = attemptRecord(attemptRequest('attempt', 'failed'), CREATED_AT);
    const left = decisionRecord(decisionRequest(attempt.attemptId, 'left'), '2026-07-30T13:00:00.000Z');
    const right = decisionRecord(decisionRequest(attempt.attemptId, 'right'), '2026-07-30T13:00:00.000Z');
    const first = foldWorkHistory([attempt], [right, left]);
    const second = foldWorkHistory([attempt], [left, right]);

    expect(first).toEqual(second);
    expect(first.decisions.map((decision) => decision.decisionId)).toEqual(
      [...first.decisions.map((decision) => decision.decisionId)].sort(),
    );
    expect(first.latestDecision).toEqual(first.decisions.at(-1));
  });

  it('classifies versions and rejects unsupported evidence or an evidence-free reconciliation', () => {
    const attempt = attemptRecord(attemptRequest('attempt', 'failed'), CREATED_AT);
    const decision = decisionRecord(decisionRequest(attempt.attemptId, 'decision'), CREATED_AT);

    expect(decodeAttemptRecord({ ...attempt, schemaVersion: ATTEMPT_RECORD_SCHEMA_VERSION + 1 })).toEqual(
      expect.objectContaining({ state: 'unsupported-future' }),
    );
    expect(decodeDecisionRecord({ ...decision, schemaVersion: DECISION_RECORD_SCHEMA_VERSION - 1 })).toEqual(
      expect.objectContaining({ state: 'unsupported-older' }),
    );
    expect(
      decodeAttemptCreateRequest({
        ...attemptRequest('reconcile', 'succeeded'),
        evidenceReceipts: [],
        reconcilesAttemptId: attempt.attemptId,
      }),
    ).toEqual(expect.objectContaining({ ok: false }));
    expect(
      decodeAttemptCreateRequest({
        ...attemptRequest('legacy-evidence', 'succeeded'),
        evidenceReceipts: [
          {
            schemaVersion: 1,
            authorityKind: 'worktree-only',
            observedAt: CREATED_AT,
            projectIdentity: 'legacy',
            worktree: { identity: 'legacy', clean: true },
          },
        ],
      }),
    ).toEqual(expect.objectContaining({ ok: false }));
  });

  it('keeps packaged attempt and decision schemas aligned with runtime discriminators', () => {
    const schemas = join(process.cwd(), 'docs', 'schemas');
    const attempt = JSON.parse(readFileSync(join(schemas, 'attempt-record.schema.json'), 'utf8')) as {
      required: string[];
      properties: Record<string, { const?: unknown }>;
      additionalProperties: boolean;
    };
    const decision = JSON.parse(readFileSync(join(schemas, 'decision-record.schema.json'), 'utf8')) as {
      required: string[];
      properties: Record<string, { const?: unknown }>;
      additionalProperties: boolean;
    };
    const attemptRequestSchema = JSON.parse(
      readFileSync(join(schemas, 'attempt-create-request.schema.json'), 'utf8'),
    ) as { required: string[]; additionalProperties: boolean };
    const decisionRequestSchema = JSON.parse(
      readFileSync(join(schemas, 'decision-create-request.schema.json'), 'utf8'),
    ) as { required: string[]; additionalProperties: boolean };

    expect(attempt.properties['kind']?.const).toBe(ATTEMPT_RECORD_KIND);
    expect(attempt.properties['schemaVersion']?.const).toBe(ATTEMPT_RECORD_SCHEMA_VERSION);
    expect(attempt.required).toEqual(
      expect.arrayContaining(['attemptId', 'changeId', 'action', 'evidenceReceipts', 'outcome', 'idempotency']),
    );
    expect(attempt.additionalProperties).toBe(false);
    expect(decision.properties['kind']?.const).toBe(DECISION_RECORD_KIND);
    expect(decision.properties['schemaVersion']?.const).toBe(DECISION_RECORD_SCHEMA_VERSION);
    expect(decision.required).toEqual(
      expect.arrayContaining(['decisionId', 'changeId', 'basisAttemptIds', 'disposition', 'idempotency']),
    );
    expect(decision.additionalProperties).toBe(false);
    expect(attemptRequestSchema.required).toEqual(
      expect.arrayContaining(['changeId', 'idempotencyKey', 'intendedCondition', 'action', 'outcome']),
    );
    expect(attemptRequestSchema.additionalProperties).toBe(false);
    expect(decisionRequestSchema.required).toEqual(
      expect.arrayContaining(['changeId', 'idempotencyKey', 'basisAttemptIds', 'disposition', 'rationale']),
    );
    expect(decisionRequestSchema.additionalProperties).toBe(false);
  });
});

function attemptRequest(idempotencyKey: string, outcome: AttemptCreateRequest['outcome']): AttemptCreateRequest {
  return {
    changeId: CHANGE_ID,
    idempotencyKey,
    intendedCondition: 'The migration has one effect',
    action: {
      family: 'database-migration',
      summary: 'Apply migration once',
      effectClass: 'non-idempotent-write',
    },
    evidenceReceipts: [],
    observedEffect: outcome === 'unknown' ? 'The process disconnected before acknowledgment' : `The action ${outcome}`,
    outcome,
  };
}

function decisionRequest(attemptId: string, idempotencyKey: string): DecisionCreateRequest {
  return {
    changeId: CHANGE_ID,
    idempotencyKey,
    basisAttemptIds: [attemptId],
    evidenceReceipts: [],
    disposition: 'change-strategy',
    rationale: 'The first strategy did not establish the intended condition',
    nextAction: 'Use the alternate migration path',
  };
}

function attemptRecord(request: AttemptCreateRequest, createdAt: string) {
  return createAttemptRecord({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request,
    createdAt,
    toolVersion: '0.20.0',
  });
}

function decisionRecord(request: DecisionCreateRequest, createdAt: string) {
  return createDecisionRecord({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request,
    createdAt,
    toolVersion: '0.20.0',
  });
}

function reconciliation(idempotencyKey: string, reconcilesAttemptId: string, outcome: 'succeeded' | 'failed') {
  return attemptRecord(
    {
      ...attemptRequest(idempotencyKey, outcome),
      evidenceReceipts: [receipt('2026-07-30T12:04:00.000Z', idempotencyKey)],
      reconcilesAttemptId,
    },
    '2026-07-30T12:05:00.000Z',
  );
}

function receipt(observedAt: string, identity: string): ObservationReceiptV2 {
  const content = createObservationIdentity('scip-query:repository-content', 1, identity);
  return {
    schemaVersion: 2,
    observedAt,
    facts: {
      collaborationDomain: createObservationIdentity('scip-query:collaboration-domain', 1, COLLABORATION_DOMAIN),
      wholeContent: content,
    },
    observedSources: [{ kind: 'repository-snapshot', identity: content }],
    stabilityProofs: [{ source: 'repository-snapshot', kind: 'fixed-snapshot' }],
  };
}
