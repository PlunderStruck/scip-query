import { createHash } from 'node:crypto';

import {
  selectAutonomousNextAction,
  type AutonomousNextAction,
  type AutonomousPolicyFinding,
} from '../domain/autonomous-next-action.js';
import type { CompletionEvaluationRecordV1 } from '../domain/autonomous-completion.js';
import { blockingFindings, type DiffGateResult } from '../queries/impact/diff-gate.js';
import type { WorkStateCreateOptions, WorkStateCreateResult } from '../storage/autonomous-work-state.js';
import { createDecisionRecordFile, readWorkHistory } from '../storage/autonomous-work-ledger.js';
import type { DecisionRecordV1 } from '../domain/autonomous-work-ledger.js';
import type { ProtectedGoalEvaluatorResult } from '../domain/protected-goal-evidence.js';

export interface PublishedAutonomousNextAction {
  action: AutonomousNextAction;
  decision: WorkStateCreateResult<DecisionRecordV1>;
}

export function publishAutonomousNextAction(input: {
  projectRoot: string;
  collaborationDomainId: string;
  evaluation: CompletionEvaluationRecordV1;
  result: DiffGateResult;
  protectedGoalEvidence?: {
    evidenceId: string;
    goalId: string;
    changeId: string;
    result: ProtectedGoalEvaluatorResult;
  };
  externalGoalEvidenceRequired?: boolean;
  options: WorkStateCreateOptions;
}): PublishedAutonomousNextAction {
  const history = readWorkHistory(input.projectRoot, input.evaluation.changeId);
  const findings: AutonomousPolicyFinding[] = blockingFindings(input.result.findings).map((finding) => ({
    id: finding.id,
    check: finding.check,
    remediation: finding.remediation,
    source: 'diff-gate',
    predicates: ['invariants-preserved'],
  }));
  findings.push(
    ...protectedEvaluatorFindings(
      input.protectedGoalEvidence?.goalId === input.evaluation.goalId &&
        input.protectedGoalEvidence.changeId === input.evaluation.changeId
        ? input.protectedGoalEvidence
        : undefined,
    ),
  );
  const action = selectAutonomousNextAction({
    changeId: input.evaluation.changeId,
    goalId: input.evaluation.goalId,
    decision: input.evaluation.decision,
    predicates: input.evaluation.predicates,
    ...(input.evaluation.authority ? { authority: input.evaluation.authority } : {}),
    ...(input.externalGoalEvidenceRequired ? { externalGoalEvidenceRequired: true } : {}),
    findings,
    history: history.summary,
    evaluatedAtMs: Date.parse(input.evaluation.createdAt),
  });
  const actionMeaning = JSON.stringify({
    evaluationId: input.evaluation.evaluationId,
    kind: action.kind,
    basisAttemptIds: action.basisAttemptIds,
    namedPredicates: action.namedPredicates,
    instruction: action.instruction,
  });
  const idempotencyKey = `stop-policy:${createHash('sha256').update(actionMeaning).digest('hex').slice(0, 32)}`;
  const decision = createDecisionRecordFile(
    input.projectRoot,
    input.collaborationDomainId,
    {
      changeId: input.evaluation.changeId,
      idempotencyKey,
      basisAttemptIds: action.basisAttemptIds,
      evidenceReceipts: [input.evaluation.context.targetObservation],
      disposition: action.disposition,
      rationale: boundedPolicyLine(action.rationale),
      nextAction: boundedPolicyLine(action.instruction),
    },
    input.options,
  );
  return { action, decision };
}

function protectedEvaluatorFindings(
  evidence:
    | {
        evidenceId: string;
        goalId: string;
        changeId: string;
        result: ProtectedGoalEvaluatorResult;
      }
    | undefined,
): AutonomousPolicyFinding[] {
  if (!evidence) return [];
  const rows: Array<{
    key: string;
    findings: readonly string[];
    predicates: AutonomousPolicyFinding['predicates'];
  }> = [
    {
      key: 'missed-affected-artifact',
      findings: evidence.result.missedAffectedArtifacts,
      predicates: ['goal-fulfilled', 'coverage-complete'],
    },
    {
      key: 'residue-defect',
      findings: evidence.result.residueDefects,
      predicates: ['goal-fulfilled', 'coverage-complete'],
    },
    {
      key: 'reintroduced-behavior',
      findings: evidence.result.reintroducedBehaviors,
      predicates: ['goal-fulfilled'],
    },
    {
      key: 'architecture-violation',
      findings: evidence.result.architectureViolations,
      predicates: ['invariants-preserved'],
    },
  ];
  return rows.flatMap((row) =>
    row.findings.map((finding, index) => ({
      id: `protected:${row.key}:${index + 1}`,
      check: `protected-evaluator:${evidence.evidenceId}`,
      remediation: finding,
      source: 'protected-evaluator' as const,
      predicates: row.predicates,
    })),
  );
}

export function formatAutonomousNextActions(actions: readonly PublishedAutonomousNextAction[]): string | undefined {
  if (actions.length === 0) return undefined;
  return actions
    .map(({ action, decision }) => {
      const instruction = decision.record.nextAction ?? boundedPolicyLine(action.instruction);
      return (
        `Autonomous next action (${action.kind}, ${action.blocker}): ${instruction} ` +
        `[decision ${decision.record.decisionId}; retry limit ${action.limits.maxEquivalentAttempts}; ` +
        `strategy deadline ${action.limits.strategyDeadlineMs / 60_000}m]`
      );
    })
    .join('\n');
}

function boundedPolicyLine(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return normalized.length <= 1_000 ? normalized : `${normalized.slice(0, 997)}...`;
}
