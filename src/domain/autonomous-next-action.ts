import type {
  CompletionAuthorityAssessment,
  CompletionPredicate,
  CompletionPredicateJudgment,
  CompletionTerminalDecision,
} from './autonomous-completion.js';
import type { AttemptRecordV1, DecisionDisposition, WorkHistorySummary } from './autonomous-work-ledger.js';

export const AUTONOMOUS_MAX_EQUIVALENT_ATTEMPTS = 3;
export const AUTONOMOUS_STRATEGY_DEADLINE_MS = 30 * 60 * 1_000;

export type AutonomousNextActionKind =
  | 'complete'
  | 'continue'
  | 'gather-evidence'
  | 'repair'
  | 'retry'
  | 'reconcile-unknown'
  | 'replan'
  | 'carry-forward'
  | 'halt-authority';

export type AutonomousBlockerClass = 'none' | 'work' | 'missing-authorization';

export interface AutonomousPolicyFinding {
  id: string;
  check: string;
  remediation: string;
}

export interface AutonomousNextAction {
  kind: AutonomousNextActionKind;
  blocker: AutonomousBlockerClass;
  changeId: string;
  goalId: string;
  disposition: DecisionDisposition;
  rationale: string;
  instruction: string;
  basisAttemptIds: readonly string[];
  namedPredicates: readonly CompletionPredicate[];
  avoidedStrategyKeys: readonly string[];
  limits: {
    maxEquivalentAttempts: typeof AUTONOMOUS_MAX_EQUIVALENT_ATTEMPTS;
    strategyDeadlineMs: typeof AUTONOMOUS_STRATEGY_DEADLINE_MS;
  };
}

export interface AutonomousNextActionInput {
  changeId: string;
  goalId: string;
  decision: CompletionTerminalDecision;
  predicates: readonly CompletionPredicateJudgment[];
  authority?: CompletionAuthorityAssessment;
  findings: readonly AutonomousPolicyFinding[];
  history: WorkHistorySummary;
  evaluatedAtMs: number;
}

/**
 * Selects one goal-preserving action from the controller judgment and durable
 * work history. It never treats a retry, suppression, or replan as permission
 * to change the goal that the action remains relative to.
 */
export function selectAutonomousNextAction(input: AutonomousNextActionInput): AutonomousNextAction {
  const limits = {
    maxEquivalentAttempts: AUTONOMOUS_MAX_EQUIVALENT_ATTEMPTS,
    strategyDeadlineMs: AUTONOMOUS_STRATEGY_DEADLINE_MS,
  } as const;
  const base = {
    changeId: input.changeId,
    goalId: input.goalId,
    namedPredicates: [] as readonly CompletionPredicate[],
    avoidedStrategyKeys: attemptedStrategyKeys(input.history.attempts),
    limits,
  };
  const unresolvedUnknown = firstUnresolvedUnknown(input.history);
  if (unresolvedUnknown) {
    const unsafe = input.history.unsafeToRepeatAttemptIds.includes(unresolvedUnknown.attemptId);
    return {
      ...base,
      kind: 'reconcile-unknown',
      blocker: 'work',
      disposition: 'reconcile-unknown',
      rationale:
        `Attempt ${unresolvedUnknown.attemptId} has an unobserved final effect` +
        (unsafe ? ' and is unsafe to repeat' : ''),
      instruction:
        `Observe the repository effect of ${unresolvedUnknown.attemptId} without repeating it; ` +
        'record a reconciliation attempt before choosing another action.',
      basisAttemptIds: [unresolvedUnknown.attemptId],
    };
  }

  if (input.decision.state === 'complete') {
    return {
      ...base,
      kind: 'complete',
      blocker: 'none',
      disposition: 'completion-candidate',
      rationale: 'Every protected completion predicate is established in the fixed evaluation context',
      instruction: `Finish intended change ${input.changeId}; do not broaden or rewrite goal ${input.goalId}.`,
      basisAttemptIds: [],
    };
  }

  if (input.decision.state === 'superseded') {
    return {
      ...base,
      kind: 'carry-forward',
      blocker: 'none',
      disposition: 'continue',
      rationale: `Stored transition rule ${input.decision.transitionRuleId} authorizes successor ${input.decision.successorGoalId}`,
      instruction:
        `Carry unfinished work into authorized successor goal ${input.decision.successorGoalId}; ` +
        `do not continue changing superseded goal ${input.goalId}.`,
      basisAttemptIds: [],
    };
  }

  const authorityBoundary = missingAuthorizationBoundary(input.authority, input.decision.blockedPredicates);
  if (authorityBoundary.length > 0) {
    return {
      ...base,
      kind: 'halt-authority',
      blocker: 'missing-authorization',
      disposition: 'continue',
      rationale: authorityBoundary.join('; '),
      instruction:
        `Halt work on ${input.changeId}: no fixed predecessor or authorized source establishes ` +
        `${authorityBoundary.join('; ')}. Obtain new authority without weakening goal ${input.goalId}.`,
      basisAttemptIds: [],
      namedPredicates: input.decision.blockedPredicates,
    };
  }

  const failedStrategy = latestFailedStrategy(input.history.attempts, input.evaluatedAtMs);
  if (failedStrategy?.exhausted) {
    return {
      ...base,
      kind: 'replan',
      blocker: 'work',
      disposition: 'change-strategy',
      rationale:
        `Strategy ${failedStrategy.key} failed ${failedStrategy.attempts.length} equivalent attempt(s)` +
        (failedStrategy.deadlineExceeded ? ' and exceeded its strategy deadline' : ''),
      instruction:
        `Choose a materially different strategy for ${input.changeId}. Do not repeat ${failedStrategy.key}; ` +
        'preserve the same goal and record the next useful operation automatically.',
      basisAttemptIds: failedStrategy.attempts.slice(-32).map((attempt) => attempt.attemptId),
    };
  }

  const candidateControlledAuthority = candidateControlledAuthorityViolations(
    input.authority,
    input.decision.blockedPredicates,
  );
  if (candidateControlledAuthority.length > 0) {
    return {
      ...base,
      kind: 'repair',
      blocker: 'work',
      disposition: 'continue',
      rationale: candidateControlledAuthority.map((violation) => violation.reason).join('; '),
      instruction: `Restore or independently authorize candidate-controlled ${candidateControlledAuthority
        .map((violation) => violation.class)
        .join(', ')} evidence; it cannot approve itself.`,
      basisAttemptIds: latestAttemptIds(input.history.attempts),
      namedPredicates: blockedAuthorityPredicates(input.decision.blockedPredicates, candidateControlledAuthority),
    };
  }

  if (input.findings.length > 0) {
    const finding = input.findings[0]!;
    return {
      ...base,
      kind: 'repair',
      blocker: 'work',
      disposition: 'continue',
      rationale: `${input.findings.length} blocking finding(s) remain; first is ${finding.id} (${finding.check})`,
      instruction: `Repair ${finding.id}: ${finding.remediation}`,
      basisAttemptIds: latestAttemptIds(input.history.attempts),
      namedPredicates: ['invariants-preserved'],
    };
  }

  const disproven = input.predicates.filter((predicate) => predicate.state === 'disproven');
  if (disproven.length > 0) {
    return {
      ...base,
      kind: 'repair',
      blocker: 'work',
      disposition: 'continue',
      rationale: predicateReasons(disproven),
      instruction: `Repair the disproven completion predicates: ${disproven
        .map((predicate) => predicate.predicate)
        .join(', ')}.`,
      basisAttemptIds: latestAttemptIds(input.history.attempts),
      namedPredicates: disproven.map((predicate) => predicate.predicate),
    };
  }

  const unknown = input.predicates.filter((predicate) => predicate.state === 'unknown');
  if (unknown.length > 0) {
    return {
      ...base,
      kind: 'gather-evidence',
      blocker: 'work',
      disposition: 'continue',
      rationale: predicateReasons(unknown),
      instruction:
        `Gather independent evidence for ${unknown.map((predicate) => predicate.predicate).join(', ')} ` +
        'against the fixed goal; do not edit the goal or evaluator to manufacture success.',
      basisAttemptIds: latestAttemptIds(input.history.attempts),
      namedPredicates: unknown.map((predicate) => predicate.predicate),
    };
  }

  if (failedStrategy) {
    if (failedStrategy.latest.action.effectClass === 'non-idempotent-write') {
      return {
        ...base,
        kind: 'replan',
        blocker: 'work',
        disposition: 'change-strategy',
        rationale: `Failed non-idempotent strategy ${failedStrategy.key} is not safe to repeat`,
        instruction: `Choose a non-repeating strategy after ${failedStrategy.latest.attemptId}; preserve goal ${input.goalId}.`,
        basisAttemptIds: [failedStrategy.latest.attemptId],
      };
    }
    return {
      ...base,
      kind: 'retry',
      blocker: 'work',
      disposition: 'retry-safe',
      rationale: `Latest failed strategy ${failedStrategy.key} remains within its bounded retry budget`,
      instruction:
        `Retry ${failedStrategy.key} once with the failure evidence addressed. ` +
        `Replan after ${AUTONOMOUS_MAX_EQUIVALENT_ATTEMPTS} equivalent failures or ` +
        `${AUTONOMOUS_STRATEGY_DEADLINE_MS / 60_000} minutes.`,
      basisAttemptIds: [failedStrategy.latest.attemptId],
    };
  }

  return {
    ...base,
    kind: 'continue',
    blocker: 'work',
    disposition: 'continue',
    rationale: `Controller blocked ${input.changeId} but no narrower repair, evidence, or retry action was derivable`,
    instruction: `Continue productive work toward goal ${input.goalId}, then return to the completion controller.`,
    basisAttemptIds: latestAttemptIds(input.history.attempts),
    namedPredicates: input.decision.blockedPredicates,
  };
}

export function autonomousStrategyKey(attempt: AttemptRecordV1): string {
  return [attempt.action.family, attempt.action.summary, attempt.action.effectClass]
    .map((value) => value.trim().replace(/\s+/gu, ' ').toLowerCase())
    .join(' | ');
}

function firstUnresolvedUnknown(history: WorkHistorySummary): AttemptRecordV1 | undefined {
  const unresolved = new Set(history.unresolvedUnknownAttemptIds);
  return history.attempts.find((attempt) => unresolved.has(attempt.attemptId));
}

function attemptedStrategyKeys(attempts: readonly AttemptRecordV1[]): string[] {
  return [...new Set(attempts.map(autonomousStrategyKey))].sort();
}

function latestFailedStrategy(
  attempts: readonly AttemptRecordV1[],
  evaluatedAtMs: number,
):
  | {
      key: string;
      latest: AttemptRecordV1;
      attempts: AttemptRecordV1[];
      exhausted: boolean;
      deadlineExceeded: boolean;
    }
  | undefined {
  const latest = [...attempts].reverse().find((attempt) => attempt.outcome === 'failed');
  if (!latest) return undefined;
  const key = autonomousStrategyKey(latest);
  const equivalent = attempts.filter(
    (attempt) => attempt.outcome === 'failed' && autonomousStrategyKey(attempt) === key,
  );
  const firstAt = Date.parse(equivalent[0]?.createdAt ?? latest.createdAt);
  const deadlineExceeded = Number.isFinite(firstAt) && evaluatedAtMs - firstAt >= AUTONOMOUS_STRATEGY_DEADLINE_MS;
  return {
    key,
    latest,
    attempts: equivalent,
    exhausted: equivalent.length >= AUTONOMOUS_MAX_EQUIVALENT_ATTEMPTS || deadlineExceeded,
    deadlineExceeded,
  };
}

function missingAuthorizationBoundary(
  authority: CompletionAuthorityAssessment | undefined,
  blockedPredicates: readonly CompletionPredicate[],
): string[] {
  const candidateControlled = new Set(authority?.candidateControlled.map((entry) => entry.class) ?? []);
  return (authority?.violations ?? [])
    .filter(
      (violation) =>
        !candidateControlled.has(violation.class) &&
        violation.predicates.some((predicate) => blockedPredicates.includes(predicate)),
    )
    .map((violation) => `${violation.class}: ${violation.reason}`);
}

function candidateControlledAuthorityViolations(
  authority: CompletionAuthorityAssessment | undefined,
  blockedPredicates: readonly CompletionPredicate[],
): NonNullable<CompletionAuthorityAssessment['violations']> {
  const candidateControlled = new Set(authority?.candidateControlled.map((entry) => entry.class) ?? []);
  return (authority?.violations ?? []).filter(
    (violation) =>
      candidateControlled.has(violation.class) &&
      violation.predicates.some((predicate) => blockedPredicates.includes(predicate)),
  );
}

function blockedAuthorityPredicates(
  blockedPredicates: readonly CompletionPredicate[],
  violations: CompletionAuthorityAssessment['violations'],
): CompletionPredicate[] {
  const affected = new Set(violations.flatMap((violation) => violation.predicates));
  return blockedPredicates.filter((predicate) => affected.has(predicate));
}

function latestAttemptIds(attempts: readonly AttemptRecordV1[], limit = 8): string[] {
  return attempts.slice(-limit).map((attempt) => attempt.attemptId);
}

function predicateReasons(predicates: readonly CompletionPredicateJudgment[]): string {
  return predicates.map((predicate) => `${predicate.predicate}: ${predicate.reasons.join('; ')}`).join(' | ');
}
