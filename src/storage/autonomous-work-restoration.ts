import {
  buildAutonomousRestorationProjection,
  type AutonomousRestorationProjection,
} from '../domain/autonomous-work-restoration.js';
import { foldWorkHistory } from '../domain/autonomous-work-ledger.js';
import { foldObligationLifecycle } from '../domain/autonomous-work-obligations.js';
import type { RecordCompatibilitySummary } from '../domain/record-compatibility.js';
import { readAttemptRecords, readDecisionRecords } from './autonomous-work-ledger.js';
import { readObligationAdmissions, readObligationTransitions } from './autonomous-work-obligations.js';
import { readGoalRecords, readIntendedChangeRecords } from './autonomous-work-state.js';

/**
 * Read every durable work-state collection once and derive the resumption
 * view from the resulting immutable facts. Compatibility omissions and
 * relationship failures remain visible and make the projection unsafe.
 */
export function readAutonomousRestorationProjection(projectRoot: string): AutonomousRestorationProjection {
  const goals = readGoalRecords(projectRoot);
  const changes = readIntendedChangeRecords(projectRoot, goals);
  const attempts = readAttemptRecords(projectRoot, changes.records);
  const decisions = readDecisionRecords(projectRoot, changes.records, attempts.records);
  const admissions = readObligationAdmissions(projectRoot, changes.records, attempts.records);
  const transitions = readObligationTransitions(projectRoot, changes.records, admissions.records, attempts.records);
  const workHistory = foldWorkHistory(attempts.records, decisions.records);
  const obligationLifecycle = foldObligationLifecycle(admissions.records, transitions.records);
  const coverageIssues = [
    ...compatibilityIssues('goal', goals.compatibility),
    ...compatibilityIssues('intended change', changes.compatibility),
    ...compatibilityIssues('attempt', attempts.compatibility),
    ...compatibilityIssues('decision', decisions.compatibility),
    ...compatibilityIssues('obligation admission', admissions.compatibility),
    ...compatibilityIssues('obligation transition', transitions.compatibility),
  ];
  const integrityIssues = [
    ...changes.integrityIssues,
    ...attempts.integrityIssues,
    ...decisions.integrityIssues,
    ...admissions.integrityIssues,
    ...transitions.integrityIssues,
    ...workHistory.reconciliationConflicts,
    ...obligationLifecycle.conflicts,
    ...obligationLifecycle.orphanTransitionIds.map(
      (transitionId) => `${transitionId} references an unknown obligation`,
    ),
  ];
  return buildAutonomousRestorationProjection({
    goals: goals.records,
    changes: changes.records,
    workHistory,
    obligationLifecycle,
    coverageIssues,
    integrityIssues,
  });
}

function compatibilityIssues(label: string, summary: RecordCompatibilitySummary): string[] {
  return summary.issues.map((issue) => `${label} record ${issue.path} is ${issue.state}: ${issue.reason}`);
}
