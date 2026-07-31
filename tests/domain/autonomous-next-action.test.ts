import { describe, expect, it } from 'vitest';

import {
  AUTONOMOUS_MAX_EQUIVALENT_ATTEMPTS,
  AUTONOMOUS_STRATEGY_DEADLINE_MS,
  selectAutonomousNextAction,
  type AutonomousNextActionInput,
} from '../../src/domain/autonomous-next-action.js';
import type {
  CompletionAuthorityAssessment,
  CompletionPredicateJudgment,
  CompletionTerminalDecision,
} from '../../src/domain/autonomous-completion.js';
import {
  createAttemptRecord,
  foldWorkHistory,
  type AttemptOutcome,
  type AttemptRecordV1,
} from '../../src/domain/autonomous-work-ledger.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const CHANGE_ID = 'SQC-0123456789ABCDEF0123456789ABCDEF';
const GOAL_ID = 'SQG-0123456789ABCDEF0123456789ABCDEF';
const EVALUATED_AT = Date.parse('2026-07-30T13:00:00.000Z');

describe('autonomous next-action policy', () => {
  it('reconciles an unknown side effect before accepting completion or retrying it', () => {
    const unknown = attempt('unknown-effect', 'unknown', 'non-idempotent-write');
    const action = selectAutonomousNextAction(
      policyInput({
        decision: { state: 'complete' },
        predicates: establishedPredicates(),
        attempts: [unknown],
      }),
    );

    expect(action).toMatchObject({
      kind: 'reconcile-unknown',
      disposition: 'reconcile-unknown',
      blocker: 'work',
      basisAttemptIds: [unknown.attemptId],
    });
    expect(action.instruction).toContain('without repeating it');
  });

  it('permits a bounded safe retry, then forces a materially different strategy after three failures', () => {
    const first = attempt(
      'same-1',
      'failed',
      'read-only',
      'inspect-callers',
      'Find callers',
      '2026-07-30T12:45:00.000Z',
    );
    const retry = selectAutonomousNextAction(
      policyInput({
        decision: blocked([]),
        predicates: [],
        attempts: [first],
      }),
    );
    expect(retry).toMatchObject({
      kind: 'retry',
      disposition: 'retry-safe',
      limits: {
        maxEquivalentAttempts: AUTONOMOUS_MAX_EQUIVALENT_ATTEMPTS,
        strategyDeadlineMs: AUTONOMOUS_STRATEGY_DEADLINE_MS,
      },
    });
    const expired = selectAutonomousNextAction(
      policyInput({
        decision: blocked([]),
        predicates: [],
        attempts: [
          attempt(
            'expired',
            'failed',
            'read-only',
            'inspect-callers',
            'Find callers another way',
            '2026-07-30T12:00:00.000Z',
          ),
        ],
      }),
    );
    expect(expired).toMatchObject({ kind: 'replan', disposition: 'change-strategy' });
    expect(expired.rationale).toContain('exceeded its strategy deadline');

    const failures = [
      first,
      attempt('same-2', 'failed', 'read-only', 'inspect-callers', 'Find callers', '2026-07-30T12:46:00.000Z'),
      attempt('same-3', 'failed', 'read-only', 'inspect-callers', 'Find callers', '2026-07-30T12:47:00.000Z'),
    ];
    const replan = selectAutonomousNextAction(
      policyInput({
        decision: blocked(['invariants-preserved']),
        predicates: [predicate('invariants-preserved', 'disproven')],
        attempts: failures,
      }),
    );
    expect(replan).toMatchObject({
      kind: 'replan',
      disposition: 'change-strategy',
      basisAttemptIds: failures.map((candidate) => candidate.attemptId),
    });
    expect(replan.instruction).toContain('materially different strategy');
    expect(replan.avoidedStrategyKeys).toContain('inspect-callers | find callers | read-only');
  });

  it('repairs ordinary findings and gathers named unknown evidence without requesting approval', () => {
    const repair = selectAutonomousNextAction(
      policyInput({
        decision: blocked(['invariants-preserved']),
        predicates: [predicate('invariants-preserved', 'disproven')],
        findings: [{ id: 'SQ-FINDING', check: 'architecture', remediation: 'Remove the forbidden dependency.' }],
      }),
    );
    expect(repair).toMatchObject({
      kind: 'repair',
      blocker: 'work',
      instruction: 'Repair SQ-FINDING: Remove the forbidden dependency.',
    });

    const gather = selectAutonomousNextAction(
      policyInput({
        decision: blocked(['goal-fulfilled', 'coverage-complete']),
        predicates: [predicate('goal-fulfilled', 'unknown'), predicate('coverage-complete', 'unknown')],
      }),
    );
    expect(gather).toMatchObject({
      kind: 'gather-evidence',
      blocker: 'work',
      namedPredicates: ['goal-fulfilled', 'coverage-complete'],
    });
    expect(gather.instruction).toContain('do not edit the goal or evaluator');
  });

  it('distinguishes repairable candidate-controlled authority from genuinely missing authorization', () => {
    const candidateControlled = selectAutonomousNextAction(
      policyInput({
        decision: blocked(['goal-fulfilled']),
        predicates: [predicate('goal-fulfilled', 'unknown')],
        authority: authority({
          candidateControlled: [{ class: 'goal', authority: 'fixed-predecessor', paths: ['.scipquery/goals/x.json'] }],
          violations: [
            {
              class: 'goal',
              predicates: ['goal-fulfilled'],
              reason: 'The candidate changed the goal used to judge itself.',
            },
          ],
        }),
      }),
    );
    expect(candidateControlled).toMatchObject({ kind: 'repair', blocker: 'work' });

    const missing = selectAutonomousNextAction(
      policyInput({
        decision: blocked(['policy-permitted']),
        predicates: [predicate('policy-permitted', 'unknown')],
        authority: authority({
          violations: [
            {
              class: 'configuration',
              predicates: ['policy-permitted'],
              reason: 'No fixed predecessor establishes repository policy.',
            },
          ],
        }),
      }),
    );
    expect(missing).toMatchObject({
      kind: 'halt-authority',
      blocker: 'missing-authorization',
      disposition: 'continue',
      goalId: GOAL_ID,
    });
    expect(missing.instruction).toContain(`without weakening goal ${GOAL_ID}`);
  });

  it('carries work only to the controller-authorized successor', () => {
    const decision: CompletionTerminalDecision = {
      state: 'superseded',
      transitionRuleId: 'SQTR-0123456789ABCDEF0123456789ABCDEF',
      successorGoalId: 'SQG-FEDCBA9876543210FEDCBA9876543210',
    };
    const action = selectAutonomousNextAction(policyInput({ decision, predicates: establishedPredicates() }));
    expect(action).toMatchObject({
      kind: 'carry-forward',
      disposition: 'continue',
      goalId: GOAL_ID,
    });
    expect(action.instruction).toContain(decision.successorGoalId);
  });
});

function policyInput(
  overrides: Partial<AutonomousNextActionInput> & {
    decision: CompletionTerminalDecision;
    predicates: CompletionPredicateJudgment[];
    attempts?: AttemptRecordV1[];
  },
): AutonomousNextActionInput {
  return {
    changeId: CHANGE_ID,
    goalId: GOAL_ID,
    findings: [],
    evaluatedAtMs: EVALUATED_AT,
    history: foldWorkHistory(overrides.attempts ?? [], []),
    ...overrides,
  };
}

function blocked(
  blockedPredicates: Extract<CompletionTerminalDecision, { state: 'blocked' }>['blockedPredicates'],
): CompletionTerminalDecision {
  return { state: 'blocked', blockedPredicates, unknownPredicates: [] };
}

function predicate(
  name: CompletionPredicateJudgment['predicate'],
  state: CompletionPredicateJudgment['state'],
): CompletionPredicateJudgment {
  return { predicate: name, state, reasons: [`${name} is ${state}`], evidenceReceipts: [] };
}

function establishedPredicates(): CompletionPredicateJudgment[] {
  return [
    'goal-fulfilled',
    'invariants-preserved',
    'evidence-compatible',
    'coverage-complete',
    'obligations-reconciled',
    'policy-permitted',
  ].map((name) => predicate(name as CompletionPredicateJudgment['predicate'], 'established'));
}

function attempt(
  key: string,
  outcome: AttemptOutcome,
  effectClass: AttemptRecordV1['action']['effectClass'],
  family = 'repository-write',
  summary = 'Apply change',
  createdAt = '2026-07-30T12:00:00.000Z',
): AttemptRecordV1 {
  return createAttemptRecord({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request: {
      changeId: CHANGE_ID,
      idempotencyKey: key,
      intendedCondition: 'The intended condition is established',
      action: { family, summary, effectClass },
      evidenceReceipts: [],
      observedEffect: `The operation ${outcome}`,
      outcome,
    },
    createdAt,
    toolVersion: '0.20.0',
  });
}

function authority(overrides: Partial<CompletionAuthorityAssessment>): CompletionAuthorityAssessment {
  return {
    version: 1,
    assessmentId: 'SQA-0123456789ABCDEF0123456789ABCDEF',
    predecessor: { kind: 'unavailable', reason: 'no-fixed-predecessor' },
    candidateControlled: [],
    fixedOrAuthorized: [],
    violations: [],
    ...overrides,
  };
}
