import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  COMPLETION_EVALUATION_SCHEMA_VERSION,
  COMPLETION_PREDICATES,
  COMPLETION_TRANSITION_SCHEMA_VERSION,
  applyCompletionAuthorityFirewall,
  beginCompletionEvaluation,
  createCompletionAuthorityAssessment,
  createCompletionEvaluationRecord,
  createCompletionTransitionRecord,
  decodeCompletionAuthorityAssessment,
  decodeCompletionEvaluationRecord,
  decodeCompletionTransitionRecord,
  foldCompletionHistory,
  type CompletionAuthorityReliance,
  type CompletionEvaluationRequest,
  type CompletionPredicateJudgment,
} from '../../src/domain/autonomous-completion.js';
import { completionProtectedArtifactSet } from '../../src/domain/autonomous-completion-context.js';
import type { ProtectedArtifactClass, ProtectedArtifactRule } from '../../src/domain/completion-protection.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const CHANGE_ID = 'SQC-0123456789ABCDEF0123456789ABCDEF';
const GOAL_ID = 'SQG-0123456789ABCDEF0123456789ABCDEF';
const SUCCESSOR_GOAL_ID = 'SQG-FEDCBA9876543210FEDCBA9876543210';
const CREATED_AT = '2026-07-30T12:00:00.000Z';

describe('autonomous completion domain', () => {
  it('derives one complete evaluation and retry-stable transition from six established predicates', () => {
    const request = evaluationRequest('complete');
    const first = evaluation(request);
    const retry = evaluation({
      ...request,
      context: { ...request.context, evaluatorId: '  scip-query:completion-controller  ' },
    });
    const transition = createCompletionTransitionRecord(first);

    expect(first.evaluationId).toMatch(/^SQE-[A-F0-9]{32}$/u);
    expect(first.context.contextId).toMatch(/^SQX-[A-F0-9]{32}$/u);
    expect(first.decision).toEqual({ state: 'complete' });
    expect(retry.evaluationId).toBe(first.evaluationId);
    expect(retry.idempotency.requestDigest).toBe(first.idempotency.requestDigest);
    expect(transition.transitionId).toMatch(/^SQCT-[A-F0-9]{32}$/u);
    expect(decodeCompletionEvaluationRecord(first)).toEqual({ state: 'current', record: first });
    expect(decodeCompletionTransitionRecord(transition)).toEqual({
      state: 'current',
      record: transition,
    });
  });

  it('blocks unknown predicates without relabeling them as disproven', () => {
    const request = evaluationRequest('unknown');
    request.predicates = request.predicates.map((predicate) =>
      predicate.predicate === 'goal-fulfilled'
        ? { ...predicate, state: 'disproven', reasons: ['A protected scenario failed'] }
        : predicate,
    );
    const record = evaluation(request);

    expect(record.decision).toEqual({
      state: 'blocked',
      blockedPredicates: ['goal-fulfilled', 'policy-permitted'],
      unknownPredicates: ['policy-permitted'],
    });
    expect(() => createCompletionTransitionRecord(record)).toThrow(
      'a completion transition requires a complete evaluation',
    );
  });

  it('makes missing, duplicate, and caller-forged decisions invalid', () => {
    const complete = evaluation(evaluationRequest('complete'));

    expect(
      decodeCompletionEvaluationRecord({
        ...complete,
        predicates: complete.predicates.slice(1),
      }),
    ).toEqual(expect.objectContaining({ state: 'malformed' }));
    expect(
      decodeCompletionEvaluationRecord({
        ...complete,
        predicates: [complete.predicates[0], ...complete.predicates.slice(0, -1)],
      }),
    ).toEqual(expect.objectContaining({ state: 'malformed' }));
    expect(
      decodeCompletionEvaluationRecord({
        ...complete,
        decision: {
          state: 'blocked',
          blockedPredicates: ['goal-fulfilled'],
          unknownPredicates: [],
        },
      }),
    ).toEqual(
      expect.objectContaining({
        state: 'malformed',
        error: 'completion decision does not follow from its predicates',
      }),
    );
  });

  it('represents a pre-authorized successor as a distinct terminal state', () => {
    const request = evaluationRequest('complete');
    request.authorizedSuccessor = {
      transitionRuleId: 'SQTR-0123456789ABCDEF0123456789ABCDEF',
      successorGoalId: SUCCESSOR_GOAL_ID,
    };
    const record = evaluation(request);

    expect(record.decision).toEqual({
      state: 'superseded',
      transitionRuleId: 'SQTR-0123456789ABCDEF0123456789ABCDEF',
      successorGoalId: SUCCESSOR_GOAL_ID,
    });
    expect(() => createCompletionTransitionRecord(record)).toThrow();
  });

  it('folds pending, blocked, and repeated complete witnesses deterministically', () => {
    const blocked = evaluation(evaluationRequest('unknown'), CREATED_AT);
    const complete = evaluation(evaluationRequest('complete'), '2026-07-30T12:05:00.000Z');
    const transition = createCompletionTransitionRecord(complete);
    const changes = [{ changeId: CHANGE_ID, goalId: GOAL_ID }];

    expect(foldCompletionHistory(changes, [], []).states).toEqual([
      { state: 'pending', changeId: CHANGE_ID, goalId: GOAL_ID },
    ]);
    expect(foldCompletionHistory(changes, [blocked], []).states).toEqual([
      expect.objectContaining({
        state: 'blocked',
        unknownPredicates: ['policy-permitted'],
      }),
    ]);
    const left = foldCompletionHistory(changes, [complete, blocked], [transition, transition]);
    const right = foldCompletionHistory(changes, [blocked, complete], [transition]);

    expect(left).toEqual(right);
    expect(left.states).toEqual([
      {
        state: 'complete',
        changeId: CHANGE_ID,
        goalId: GOAL_ID,
        evaluationIds: [complete.evaluationId],
        transitionIds: [transition.transitionId],
      },
    ]);
  });

  it('keeps merged successor branches conflicted when they authorize different terminal meanings', () => {
    const leftRequest = evaluationRequest('complete');
    leftRequest.idempotencyKey = 'successor-left';
    leftRequest.authorizedSuccessor = {
      transitionRuleId: 'SQTR-11111111111111111111111111111111',
      successorGoalId: SUCCESSOR_GOAL_ID,
    };
    const rightRequest = evaluationRequest('complete');
    rightRequest.idempotencyKey = 'successor-right';
    rightRequest.authorizedSuccessor = {
      transitionRuleId: 'SQTR-22222222222222222222222222222222',
      successorGoalId: 'SQG-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };

    const summary = foldCompletionHistory(
      [{ changeId: CHANGE_ID, goalId: GOAL_ID }],
      [evaluation(leftRequest, '2026-07-30T12:05:00.000Z'), evaluation(rightRequest, '2026-07-30T12:06:00.000Z')],
      [],
    );

    expect(summary.states).toEqual([
      expect.objectContaining({
        state: 'conflicted',
        reasons: [expect.stringContaining('conflicting terminal completion meanings')],
      }),
    ]);
    expect(summary.conflicts).toEqual([expect.stringContaining('conflicting terminal completion meanings')]);
  });

  it('classifies future schemas and keeps packaged record discriminators aligned', () => {
    const complete = evaluation(evaluationRequest('complete'));
    const transition = createCompletionTransitionRecord(complete);

    expect(
      decodeCompletionEvaluationRecord({
        ...complete,
        schemaVersion: COMPLETION_EVALUATION_SCHEMA_VERSION + 1,
      }),
    ).toEqual(expect.objectContaining({ state: 'unsupported-future' }));
    expect(
      decodeCompletionTransitionRecord({
        ...transition,
        schemaVersion: COMPLETION_TRANSITION_SCHEMA_VERSION + 1,
      }),
    ).toEqual(expect.objectContaining({ state: 'unsupported-future' }));

    const schemas = join(process.cwd(), 'docs', 'schemas');
    const evaluationSchema = JSON.parse(
      readFileSync(join(schemas, 'completion-evaluation-record.schema.json'), 'utf8'),
    ) as {
      required: string[];
      properties: Record<string, { const?: unknown; $ref?: string }>;
      additionalProperties: boolean;
    };
    const transitionSchema = JSON.parse(
      readFileSync(join(schemas, 'completion-transition-record.schema.json'), 'utf8'),
    ) as {
      required: string[];
      properties: Record<string, { const?: unknown }>;
      additionalProperties: boolean;
    };

    expect(evaluationSchema.properties['kind']?.const).toBe('scip-query-completion-evaluation');
    expect(evaluationSchema.properties['schemaVersion']?.const).toBe(COMPLETION_EVALUATION_SCHEMA_VERSION);
    expect(evaluationSchema.required).toEqual(
      expect.arrayContaining(['evaluationId', 'changeId', 'goalId', 'context', 'predicates', 'decision']),
    );
    expect(evaluationSchema.properties['authority']?.$ref).toBe('#/$defs/authority');
    expect(evaluationSchema.additionalProperties).toBe(false);
    expect(transitionSchema.properties['kind']?.const).toBe('scip-query-completion-transition');
    expect(transitionSchema.properties['schemaVersion']?.const).toBe(COMPLETION_TRANSITION_SCHEMA_VERSION);
    expect(transitionSchema.required).toEqual(
      expect.arrayContaining(['transitionId', 'evaluationId', 'contextId', 'to']),
    );
    expect(transitionSchema.additionalProperties).toBe(false);
  });

  it('constructs only a valid evaluating process state', () => {
    const complete = evaluation(evaluationRequest('complete'));

    expect(beginCompletionEvaluation(CHANGE_ID, GOAL_ID, complete.context.contextId, CREATED_AT)).toEqual({
      state: 'evaluating',
      changeId: CHANGE_ID,
      goalId: GOAL_ID,
      contextId: complete.context.contextId,
      startedAt: CREATED_AT,
    });
    expect(() => beginCompletionEvaluation(CHANGE_ID, GOAL_ID, 'bad-context', CREATED_AT)).toThrow();
  });

  it.each([
    ['goal', '.scipquery/goals/SQG-example.json'],
    ['transition-rule', '.scipquery/transition-rules/SQTR-example.json'],
    ['evaluator', 'src/controller.ts'],
    ['test', 'tests/domain/controller.test.ts'],
    ['baseline', '.scipquery-baseline.json'],
    ['suppression', '.scipquery/suppressions/SQS-example.json'],
    ['configuration', '.scipquery.json'],
  ] satisfies readonly (readonly [ProtectedArtifactClass, string])[])(
    'partitions a changed %s artifact as candidate-controlled authority',
    (artifactClass, changedPath) => {
      const assessment = createCompletionAuthorityAssessment({
        predecessor: { kind: 'git-tree', treeOid: 'a'.repeat(40) },
        changedPaths: [changedPath],
        protectedArtifacts: protectedArtifactSet(),
        reliances: [authorityReliance(artifactClass)],
      });

      expect(assessment.candidateControlled).toEqual([
        expect.objectContaining({ class: artifactClass, paths: [changedPath] }),
      ]);
      expect(assessment.fixedOrAuthorized).toEqual([]);
      expect(assessment.violations).toEqual([
        {
          class: artifactClass,
          predicates: ['policy-permitted'],
          reason: `${artifactClass} evidence must not approve itself`,
        },
      ]);
      expect(decodeCompletionAuthorityAssessment(assessment)).toEqual({ ok: true, value: assessment });
    },
  );

  it('accepts an explicit predecessor-authorized referent for a changed protected artifact', () => {
    const assessment = createCompletionAuthorityAssessment({
      predecessor: { kind: 'git-tree', treeOid: 'a'.repeat(40) },
      changedPaths: ['.scipquery/suppressions/SQS-example.json'],
      protectedArtifacts: protectedArtifactSet(),
      reliances: [authorityReliance('suppression')],
      authorizedReferents: {
        suppression: 'SQTR-0123456789ABCDEF0123456789ABCDEF',
      },
    });

    expect(assessment.candidateControlled).toEqual([
      expect.objectContaining({
        class: 'suppression',
        paths: ['.scipquery/suppressions/SQS-example.json'],
      }),
    ]);
    expect(assessment.fixedOrAuthorized).toEqual([
      expect.objectContaining({
        class: 'suppression',
        referent: 'SQTR-0123456789ABCDEF0123456789ABCDEF',
      }),
    ]);
    expect(assessment.violations).toEqual([]);
  });

  it('turns reflexively established predicates unknown without erasing contrary evidence', () => {
    const assessment = createCompletionAuthorityAssessment({
      predecessor: { kind: 'git-tree', treeOid: 'a'.repeat(40) },
      changedPaths: ['src/controller.ts'],
      protectedArtifacts: protectedArtifactSet(),
      reliances: [
        {
          class: 'evaluator',
          predicates: ['goal-fulfilled', 'invariants-preserved'],
          reason: 'The changed evaluator cannot establish its own correctness',
        },
      ],
    });
    const predicates = evaluationRequest('complete').predicates.map((predicate) =>
      predicate.predicate === 'invariants-preserved'
        ? { ...predicate, state: 'disproven' as const, reasons: ['A fixed invariant failed'] }
        : predicate,
    );

    const firewalled = applyCompletionAuthorityFirewall(predicates, assessment);

    expect(firewalled.find((predicate) => predicate.predicate === 'goal-fulfilled')).toEqual(
      expect.objectContaining({
        state: 'unknown',
        reasons: expect.arrayContaining([
          'The changed evaluator cannot establish its own correctness',
          expect.stringContaining(`assessment ${assessment.assessmentId} blocks`),
        ]),
      }),
    );
    expect(firewalled.find((predicate) => predicate.predicate === 'invariants-preserved')).toEqual(
      expect.objectContaining({
        state: 'disproven',
        reasons: expect.arrayContaining(['A fixed invariant failed']),
      }),
    );
  });

  it('persists a canonical authority partition and rejects authority tampering', () => {
    const request = evaluationRequest('complete');
    request.authority = createCompletionAuthorityAssessment({
      predecessor: { kind: 'git-tree', treeOid: 'a'.repeat(40) },
      changedPaths: ['tests/domain/controller.test.ts'],
      protectedArtifacts: protectedArtifactSet(),
      reliances: [authorityReliance('test')],
      authorizedReferents: { test: 'SQTR-0123456789ABCDEF0123456789ABCDEF' },
    });
    const record = evaluation(request);

    expect(decodeCompletionEvaluationRecord(record)).toEqual({ state: 'current', record });
    expect(
      decodeCompletionEvaluationRecord({
        ...record,
        authority: {
          ...record.authority,
          candidateControlled: [
            {
              class: 'test',
              authority: 'fixed-predecessor',
              paths: ['tests/domain/other.test.ts'],
            },
          ],
        },
      }),
    ).toEqual(
      expect.objectContaining({
        state: 'malformed',
        error: 'authority assessment identity does not match its evidence partition',
      }),
    );
  });
});

function evaluationRequest(policyState: 'complete' | 'unknown'): CompletionEvaluationRequest {
  const target = receipt(CREATED_AT, 'target');
  return {
    changeId: CHANGE_ID,
    goalId: GOAL_ID,
    idempotencyKey: `evaluation:${policyState}`,
    context: {
      policyId: 'scip-query:completion-policy',
      policyVersion: 1,
      evaluatorId: 'scip-query:completion-controller',
      evaluatorVersion: '0.20.0',
      targetObservation: target,
    },
    predicates: COMPLETION_PREDICATES.map(
      (predicate): CompletionPredicateJudgment => ({
        predicate,
        state: predicate === 'policy-permitted' && policyState === 'unknown' ? 'unknown' : 'established',
        reasons: [
          predicate === 'policy-permitted' && policyState === 'unknown'
            ? 'No protected repository policy supplied permission'
            : `${predicate} is established by the fixed evaluation input`,
        ],
        evidenceReceipts: [target],
      }),
    ),
  };
}

function evaluation(
  request: CompletionEvaluationRequest,
  createdAt = CREATED_AT,
): ReturnType<typeof createCompletionEvaluationRecord> {
  return createCompletionEvaluationRecord({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request,
    createdAt,
    toolVersion: '0.20.0',
  });
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

function protectedArtifactSet() {
  const rules: readonly ProtectedArtifactRule[] = [
    { class: 'goal', selectors: ['.scipquery/goals/*'], authority: 'fixed-predecessor' },
    {
      class: 'transition-rule',
      selectors: ['.scipquery/transition-rules/*'],
      authority: 'fixed-predecessor',
    },
    { class: 'evaluator', selectors: ['src/controller.ts'], authority: 'bootstrap-trust-root' },
    { class: 'test', selectors: ['tests/**'], authority: 'fixed-predecessor' },
    { class: 'baseline', selectors: ['.scipquery-baseline.json'], authority: 'fixed-predecessor' },
    {
      class: 'suppression',
      selectors: ['.scipquery/suppressions/*'],
      authority: 'fixed-predecessor',
    },
    { class: 'configuration', selectors: ['.scipquery.json'], authority: 'fixed-predecessor' },
  ];
  return completionProtectedArtifactSet(rules);
}

function authorityReliance(artifactClass: ProtectedArtifactClass): CompletionAuthorityReliance {
  return {
    class: artifactClass,
    predicates: ['policy-permitted'],
    reason: `${artifactClass} evidence must not approve itself`,
  };
}
