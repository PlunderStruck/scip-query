import { createHash } from 'node:crypto';

import {
  compareAttemptRecords,
  foldWorkHistory,
  type AttemptRecordV1,
  type DecisionRecordV1,
  type WorkHistorySummary,
} from './autonomous-work-ledger.js';
import {
  type FoldedObligationState,
  type Obligation,
  type ObligationLifecycleSummary,
  type ObligationSource,
} from './autonomous-work-obligations.js';
import type { GoalRecordV1, IntendedChangeRecordV1 } from './autonomous-work-state.js';
import { stableJson } from './stable-json.js';

export const AUTONOMOUS_RESTORATION_SCHEMA_VERSION = 1 as const;
export const AUTONOMOUS_RESTORATION_CONTEXT_BUDGET_BYTES = 16 * 1024;
const MIN_RESTORATION_CONTEXT_BUDGET_BYTES = 1_024;

export interface AutonomousRestorationAttempt {
  attemptId: string;
  intendedCondition: string;
  actionFamily: string;
  actionSummary: string;
  effectClass: AttemptRecordV1['action']['effectClass'];
  observedEffect: string;
  outcome: AttemptRecordV1['outcome'];
  path: string;
}

export interface AutonomousRestorationDecision {
  decisionId: string;
  disposition: DecisionRecordV1['disposition'];
  rationale: string;
  nextAction?: string;
  path: string;
}

export interface AutonomousRestorationObligation {
  obligationId: string;
  category: Obligation['category'];
  title: string;
  requiredCondition: string;
  source: ObligationSource;
  path: string;
}

export interface AutonomousRestorationGoal {
  goalId: string;
  feature: string;
  invariants: readonly string[];
  acceptanceScenarioNames: readonly string[];
  path: string;
}

export interface AutonomousRestorationChange {
  changeId: string;
  title: string;
  intendedOutcome: string;
  path: string;
  goal?: AutonomousRestorationGoal;
  currentCondition: string;
  attemptSummary: {
    total: number;
    failed: number;
    unresolvedUnknown: number;
    supersededWithinFamily: number;
  };
  latestAttempt?: AutonomousRestorationAttempt;
  lastDistinctUnsuccessfulAttempts: readonly AutonomousRestorationAttempt[];
  latestDecision?: AutonomousRestorationDecision;
  liveObligations: readonly AutonomousRestorationObligation[];
  unsafeToRepeatAttemptIds: readonly string[];
  continuationCommands: readonly string[];
}

/**
 * A restoration projection is a bounded resumption view derived from the
 * immutable repository-work ledger. It differs from a transcript summary by
 * preserving only facts that causally constrain the next safe action and by
 * linking every condensation back to its complete committed records.
 */
export interface AutonomousRestorationProjection {
  schemaVersion: typeof AUTONOMOUS_RESTORATION_SCHEMA_VERSION;
  cursor: string;
  safeToContinue: boolean;
  issues: readonly string[];
  changes: readonly AutonomousRestorationChange[];
}

export interface BuildAutonomousRestorationProjectionInput {
  goals: readonly GoalRecordV1[];
  changes: readonly IntendedChangeRecordV1[];
  workHistory: WorkHistorySummary;
  obligationLifecycle: ObligationLifecycleSummary;
  coverageIssues?: readonly string[];
  integrityIssues?: readonly string[];
}

export function buildAutonomousRestorationProjection(
  input: BuildAutonomousRestorationProjectionInput,
): AutonomousRestorationProjection {
  const goalsById = new Map(input.goals.map((goal) => [goal.goalId, goal]));
  const issues = [...new Set([...(input.coverageIssues ?? []), ...(input.integrityIssues ?? [])])].sort();
  const changes = [...input.changes]
    .sort(compareChanges)
    .map((change) =>
      projectChange(change, goalsById.get(change.goalId), input.workHistory, input.obligationLifecycle.obligations),
    )
    .filter((change): change is AutonomousRestorationChange => change !== undefined);
  const meaning = {
    schemaVersion: AUTONOMOUS_RESTORATION_SCHEMA_VERSION,
    safeToContinue: issues.length === 0,
    issues,
    changes,
  };
  return {
    ...meaning,
    cursor: createHash('sha256').update(stableJson(meaning)).digest('hex'),
  };
}

export function renderAutonomousRestorationProjection(
  projection: AutonomousRestorationProjection,
  maxBytes = AUTONOMOUS_RESTORATION_CONTEXT_BUDGET_BYTES,
): string | undefined {
  if (projection.changes.length === 0 && projection.issues.length === 0) return undefined;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_RESTORATION_CONTEXT_BUDGET_BYTES) {
    throw new Error(
      `autonomous restoration context budget must be at least ${MIN_RESTORATION_CONTEXT_BUDGET_BYTES} bytes`,
    );
  }

  const full = renderProjectionHeader(projection)
    .concat(projection.changes.flatMap(renderChange), renderProjectionIssueResolution(projection))
    .join('\n');
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;

  const continuation = [
    '',
    `Restoration detail exceeded the registered ${maxBytes}-byte hook budget; no record meaning was truncated.`,
    'Recover the complete committed state exactly with:',
    '- scip-query goal status',
    '- scip-query change status',
    '- scip-query attempt status',
    '- scip-query decision status',
    '- scip-query obligation status',
  ];
  const compact = [
    `Restored autonomous work state from committed .scipquery records (cursor ${projection.cursor.slice(0, 16)}).`,
    projection.safeToContinue
      ? 'Ledger safety: compatible and internally consistent.'
      : `Ledger safety: UNVERIFIED by ${projection.issues.length} record issue(s). Do not claim completion or repeat an unsafe effect until the exact status commands below resolve them.`,
  ];
  let includedChanges = 0;
  for (const change of projection.changes) {
    const line = `Active change ${change.changeId}: ${change.title}; goal=${change.goal?.goalId ?? 'unresolved'}; live obligations=${change.liveObligations.length}.`;
    if (Buffer.byteLength([...compact, line, ...continuation].join('\n'), 'utf8') > maxBytes) break;
    compact.push(line);
    includedChanges += 1;
  }
  if (includedChanges < projection.changes.length) {
    compact.push(
      `${projection.changes.length - includedChanges} additional active change(s) require the commands below.`,
    );
  }
  const rendered = [...compact, ...continuation].join('\n');
  if (Buffer.byteLength(rendered, 'utf8') > maxBytes) {
    throw new Error(
      'autonomous restoration header and exact continuation commands exceed the registered context budget',
    );
  }
  return rendered;
}

function projectChange(
  change: IntendedChangeRecordV1,
  goal: GoalRecordV1 | undefined,
  workHistory: WorkHistorySummary,
  obligationStates: readonly FoldedObligationState[],
): AutonomousRestorationChange | undefined {
  const attempts = workHistory.attempts.filter((attempt) => attempt.changeId === change.changeId);
  const decisions = workHistory.decisions.filter((decision) => decision.changeId === change.changeId);
  const history = foldWorkHistory(attempts, decisions);
  const latestAttempt = history.attempts.at(-1);
  const liveObligations = obligationStates
    .filter(
      (state): state is Extract<FoldedObligationState, { state: 'live' }> =>
        state.state === 'live' && state.obligation.changeId === change.changeId,
    )
    .map(({ obligation }) => projectObligation(obligation))
    .sort((left, right) => left.obligationId.localeCompare(right.obligationId));
  const latestDecision = history.latestDecision;
  const mustRemainVisible =
    liveObligations.length > 0 ||
    history.unresolvedUnknownAttemptIds.length > 0 ||
    history.reconciliationConflicts.length > 0;
  if (latestDecision?.disposition === 'abandon' && !mustRemainVisible) return undefined;

  const unresolvedUnknownIds = new Set(history.unresolvedUnknownAttemptIds);
  const latestByFamily = new Map<string, AttemptRecordV1>();
  for (const attempt of history.attempts) latestByFamily.set(attempt.action.family, attempt);
  const lastDistinctUnsuccessfulAttempts = [...latestByFamily.values()]
    .filter(
      (attempt) =>
        attempt.outcome === 'failed' || (attempt.outcome === 'unknown' && unresolvedUnknownIds.has(attempt.attemptId)),
    )
    .sort(compareAttemptRecords)
    .map(projectAttempt);

  return {
    changeId: change.changeId,
    title: change.title,
    intendedOutcome: change.intendedOutcome,
    path: `.scipquery/changes/${change.changeId}.json`,
    ...(goal ? { goal: projectGoal(goal) } : {}),
    currentCondition: latestDecision?.nextAction ?? latestAttempt?.intendedCondition ?? change.intendedOutcome,
    attemptSummary: {
      total: history.attempts.length,
      failed: history.attempts.filter((attempt) => attempt.outcome === 'failed').length,
      unresolvedUnknown: history.unresolvedUnknownAttemptIds.length,
      supersededWithinFamily: Math.max(0, history.attempts.length - latestByFamily.size),
    },
    ...(latestAttempt ? { latestAttempt: projectAttempt(latestAttempt) } : {}),
    lastDistinctUnsuccessfulAttempts,
    ...(latestDecision ? { latestDecision: projectDecision(latestDecision) } : {}),
    liveObligations,
    unsafeToRepeatAttemptIds: history.unsafeToRepeatAttemptIds,
    continuationCommands: [
      ...(goal ? [] : [`scip-query goal read ${change.goalId}`]),
      ...(lastDistinctUnsuccessfulAttempts.length > 0 || history.unresolvedUnknownAttemptIds.length > 0
        ? [`scip-query attempt status ${change.changeId}`]
        : []),
      ...(liveObligations.length > 0 ? [`scip-query obligation status ${change.changeId}`] : []),
    ],
  };
}

function projectGoal(goal: GoalRecordV1): AutonomousRestorationGoal {
  return {
    goalId: goal.goalId,
    feature: goal.gherkin.feature,
    invariants: goal.gherkin.invariants,
    acceptanceScenarioNames: goal.gherkin.acceptanceScenarios.map((scenario) => scenario.name),
    path: `.scipquery/goals/${goal.goalId}.json`,
  };
}

function projectAttempt(attempt: AttemptRecordV1): AutonomousRestorationAttempt {
  return {
    attemptId: attempt.attemptId,
    intendedCondition: attempt.intendedCondition,
    actionFamily: attempt.action.family,
    actionSummary: attempt.action.summary,
    effectClass: attempt.action.effectClass,
    observedEffect: attempt.observedEffect,
    outcome: attempt.outcome,
    path: `.scipquery/attempts/${attempt.attemptId}.json`,
  };
}

function projectDecision(decision: DecisionRecordV1): AutonomousRestorationDecision {
  return {
    decisionId: decision.decisionId,
    disposition: decision.disposition,
    rationale: decision.rationale,
    ...(decision.nextAction ? { nextAction: decision.nextAction } : {}),
    path: `.scipquery/decisions/${decision.decisionId}.json`,
  };
}

function projectObligation(obligation: Obligation): AutonomousRestorationObligation {
  return {
    obligationId: obligation.obligationId,
    category: obligation.category,
    title: obligation.title,
    requiredCondition: obligation.requiredCondition,
    source: obligation.source,
    path:
      obligation.origin === 'admission'
        ? `.scipquery/obligations/${obligation.obligationId}.json`
        : `.scipquery/obligation-transitions/${obligation.introducingTransitionId}.json`,
  };
}

function renderProjectionHeader(projection: AutonomousRestorationProjection): string[] {
  const lines = [
    `Restored autonomous work state from committed .scipquery records (cursor ${projection.cursor.slice(0, 16)}).`,
    projection.safeToContinue
      ? 'Ledger safety: compatible and internally consistent.'
      : 'Ledger safety: UNVERIFIED. Do not claim completion or repeat an unsafe effect until these record issues are resolved.',
  ];
  for (const issue of projection.issues) lines.push(`- Record issue: ${issue}`);
  return lines;
}

function renderProjectionIssueResolution(projection: AutonomousRestorationProjection): string[] {
  if (projection.issues.length === 0) return [];
  return [
    '',
    'Inspect unresolved record safety: scip-query goal status ; scip-query change status ; ' +
      'scip-query attempt status ; scip-query decision status ; scip-query obligation status',
  ];
}

function renderChange(change: AutonomousRestorationChange): string[] {
  const lines = [
    '',
    `Active change ${change.changeId}: ${change.title}`,
    change.goal
      ? `Goal ${change.goal.goalId}: ${change.goal.feature}`
      : 'Goal: unresolved because its committed record is missing or incompatible.',
  ];
  if (change.goal) {
    for (const invariant of change.goal.invariants) lines.push(`- Goal invariant: ${invariant}`);
    lines.push(`Acceptance scenarios: ${change.goal.acceptanceScenarioNames.join('; ') || 'none'}`);
  }
  lines.push(`Next condition: ${change.currentCondition}`);
  if (change.latestDecision) {
    lines.push(
      `Decision ${change.latestDecision.decisionId}: ${change.latestDecision.disposition}; ${change.latestDecision.rationale}`,
    );
  }
  const unsafeAttemptIds = new Set(change.unsafeToRepeatAttemptIds);
  if (change.attemptSummary.total > 0) {
    lines.push(
      `Attempt history: ${change.attemptSummary.total} total; ${change.attemptSummary.failed} failed; ` +
        `${change.attemptSummary.unresolvedUnknown} unresolved unknown; ` +
        `${change.attemptSummary.supersededWithinFamily} superseded within a strategy family.`,
    );
  }
  const latestIsListed = change.lastDistinctUnsuccessfulAttempts.some(
    (attempt) => attempt.attemptId === change.latestAttempt?.attemptId,
  );
  if (change.latestAttempt && !latestIsListed) {
    lines.push(
      `- Latest effect ${change.latestAttempt.attemptId} (${change.latestAttempt.actionFamily}, ` +
        `${change.latestAttempt.outcome}/${change.latestAttempt.effectClass}): ${change.latestAttempt.observedEffect}`,
    );
  }
  for (const attempt of change.lastDistinctUnsuccessfulAttempts) {
    lines.push(
      `- Avoid ${attempt.actionFamily} — ${attempt.actionSummary}: ${attempt.attemptId} was ` +
        `${attempt.outcome}/${attempt.effectClass}` +
        `${unsafeAttemptIds.has(attempt.attemptId) ? ' and is unsafe to repeat' : ''}; ` +
        `observed ${attempt.observedEffect}`,
    );
  }
  const unlistedUnsafeAttemptIds = change.unsafeToRepeatAttemptIds.filter(
    (attemptId) => !change.lastDistinctUnsuccessfulAttempts.some((attempt) => attempt.attemptId === attemptId),
  );
  if (unlistedUnsafeAttemptIds.length > 0) {
    lines.push(`- Unsafe to repeat until reconciled: ${unlistedUnsafeAttemptIds.join(', ')}`);
  }
  if (change.liveObligations.length > 0) lines.push(`Live obligations (${change.liveObligations.length}):`);
  for (const obligation of change.liveObligations) {
    lines.push(
      `- LIVE ${obligation.obligationId} [${obligation.category}] ${obligation.title}: ` +
        `${obligation.requiredCondition} (source: ${formatObligationSource(obligation.source)})`,
    );
  }
  if (change.continuationCommands.length > 0) {
    lines.push(`Inspect unresolved detail: ${change.continuationCommands.join(' ; ')}`);
  }
  return lines;
}

function formatObligationSource(source: ObligationSource): string {
  return source.kind === 'detector-finding'
    ? `${source.kind}:${source.check}:${source.findingId}`
    : `${source.kind}:${source.referent}`;
}

function compareChanges(left: IntendedChangeRecordV1, right: IntendedChangeRecordV1): number {
  return left.createdAt.localeCompare(right.createdAt) || left.changeId.localeCompare(right.changeId);
}
