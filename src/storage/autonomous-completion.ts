import { join } from 'node:path';

import {
  completionEvaluationRequestMatchesRecord,
  completionTransitionMatchesEvaluation,
  createCompletionEvaluationRecord,
  createCompletionTransitionRecord,
  decodeCompletionRecord,
  decodeCompletionEvaluationRecord,
  decodeCompletionTransitionRecord,
  foldCompletionHistory,
  isCompletionEvaluationId,
  isCompletionTransitionId,
  type CompletionEvaluationRecordV1,
  type CompletionEvaluationRequest,
  type CompletionHistorySummary,
  type CompletionPredicate,
  type CompletionTransitionRecordV1,
} from '../domain/autonomous-completion.js';
import {
  createObservationIdentity,
  observationReceiptStabilityLabel,
  type ObservationReceiptV2,
} from '../domain/observation-receipt.js';
import { stableJson } from '../domain/stable-json.js';
import { readObligationLifecycle, type ObligationLifecycleReadResult } from './autonomous-work-obligations.js';
import {
  parseRecordFile,
  publishWorkStateRecord,
  readGoalRecords,
  readIntendedChangeRecords,
  readRecordDirectory,
  readRecordFile,
  requireIntendedChangeRecord,
  workStateNow,
  type WorkStateCollectionReadResult,
  type WorkStateCreateOptions,
  type WorkStateCreateResult,
  type WorkStateRecordReadResult,
} from './autonomous-work-state.js';

export const COMPLETION_EVALUATIONS_DIR = join('.scipquery', 'completion-evaluations');
export const COMPLETION_TRANSITIONS_DIR = join('.scipquery', 'completion-transitions');

export interface CompletionEvaluationCreateResult {
  evaluation: WorkStateCreateResult<CompletionEvaluationRecordV1>;
  transition?: WorkStateCreateResult<CompletionTransitionRecordV1>;
}

export interface CompletionCollectionReadResult<RecordType> extends WorkStateCollectionReadResult<RecordType> {
  integrityIssues: string[];
}

export interface CompletionHistoryReadResult {
  evaluations: CompletionCollectionReadResult<CompletionEvaluationRecordV1>;
  transitions: CompletionCollectionReadResult<CompletionTransitionRecordV1>;
  summary: CompletionHistorySummary;
  goalCompatibility: ReturnType<typeof readGoalRecords>['compatibility'];
  changeCompatibility: ReturnType<typeof readIntendedChangeRecords>['compatibility'];
  obligationCompatibility: {
    admissions: ObligationLifecycleReadResult['admissions']['compatibility'];
    transitions: ObligationLifecycleReadResult['transitions']['compatibility'];
  };
  integrityIssues: string[];
}

/**
 * Publishes the controller's immutable evaluation and, only when that
 * evaluation derives "complete", its idempotent completion transition.
 * Repository facts independently constrain predicates whose truth can be
 * checked at this boundary.
 */
export function createCompletionEvaluationFiles(
  projectRoot: string,
  collaborationDomainId: string,
  request: CompletionEvaluationRequest,
  options: WorkStateCreateOptions,
): CompletionEvaluationCreateResult {
  if (request.authorizedSuccessor) {
    throw new Error('successor completion requires a stored transition rule; direct authorization is refused');
  }
  const change = requireIntendedChangeRecord(projectRoot, collaborationDomainId, request.changeId);
  if (change.goalId !== request.goalId) {
    throw new Error(`intended change ${request.changeId} is governed by goal ${change.goalId}, not ${request.goalId}`);
  }
  const createdAt = (options.now ?? workStateNow)();
  validateRepositoryPredicates(
    collaborationDomainId,
    request,
    readObligationLifecycle(projectRoot, request.changeId),
    createdAt,
  );
  const record = createCompletionEvaluationRecord({
    collaborationDomainId,
    request,
    createdAt,
    toolVersion: options.toolVersion,
  });
  const evaluation = publishWorkStateRecord(
    projectRoot,
    {
      relativeDirectory: COMPLETION_EVALUATIONS_DIR,
      identity: record.evaluationId,
      record,
      readExisting: () => readCompletionEvaluationRecordFile(projectRoot, record.evaluationId),
      matchesExisting: (existing) => completionEvaluationRequestMatchesRecord(collaborationDomainId, request, existing),
      collisionMessage: (relativePath) =>
        `completion-evaluation idempotency collision at ${relativePath}: this key already names a different judgment`,
    },
    options,
  );
  if (evaluation.record.decision.state !== 'complete') return { evaluation };
  const transitionRecord = createCompletionTransitionRecord(evaluation.record);
  const transition = publishWorkStateRecord(
    projectRoot,
    {
      relativeDirectory: COMPLETION_TRANSITIONS_DIR,
      identity: transitionRecord.transitionId,
      record: transitionRecord,
      readExisting: () => readCompletionTransitionRecordFile(projectRoot, transitionRecord.transitionId),
      matchesExisting: (existing) => completionTransitionMatchesEvaluation(existing, evaluation.record),
      collisionMessage: (relativePath) =>
        `completion-transition identity collision at ${relativePath}: existing record has different meaning`,
    },
    options,
  );
  return { evaluation, transition };
}

export function readCompletionEvaluationRecordFile(
  projectRoot: string,
  evaluationId: string,
): WorkStateRecordReadResult<CompletionEvaluationRecordV1> {
  if (!isCompletionEvaluationId(evaluationId)) {
    throw new Error(`invalid completion-evaluation identity: ${evaluationId}`);
  }
  return readRecordFile(
    projectRoot,
    join(COMPLETION_EVALUATIONS_DIR, `${evaluationId}.json`),
    decodeCompletionEvaluationRecord,
  );
}

export function readCompletionTransitionRecordFile(
  projectRoot: string,
  transitionId: string,
): WorkStateRecordReadResult<CompletionTransitionRecordV1> {
  if (!isCompletionTransitionId(transitionId)) {
    throw new Error(`invalid completion-transition identity: ${transitionId}`);
  }
  return readRecordFile(
    projectRoot,
    join(COMPLETION_TRANSITIONS_DIR, `${transitionId}.json`),
    decodeCompletionTransitionRecord,
  );
}

export function readCompletionRecordPath(path: string): ReturnType<typeof decodeCompletionRecord> {
  return parseRecordFile(path, 'completion record', decodeCompletionRecord);
}

export function readCompletionEvaluations(
  projectRoot: string,
): CompletionCollectionReadResult<CompletionEvaluationRecordV1> {
  const goals = readGoalRecords(projectRoot);
  const changes = readIntendedChangeRecords(projectRoot, goals);
  const result = readRecordDirectory(
    projectRoot,
    COMPLETION_EVALUATIONS_DIR,
    'completion evaluation record',
    decodeCompletionEvaluationRecord,
    (record) => record.evaluationId,
  );
  const changesById = new Map(changes.records.map((change) => [change.changeId, change]));
  const integrityIssues = result.records.flatMap((record) => {
    const issues: string[] = [];
    const change = changesById.get(record.changeId);
    if (!change) issues.push(`${record.evaluationId} references missing intended change ${record.changeId}`);
    else {
      if (change.goalId !== record.goalId) {
        issues.push(`${record.evaluationId} evaluates goal ${record.goalId} instead of ${change.goalId}`);
      }
      if (change.collaborationDomainId !== record.collaborationDomainId) {
        issues.push(`${record.evaluationId} and change ${record.changeId} belong to different collaboration domains`);
      }
    }
    if (
      predicateState(record.predicates, 'evidence-compatible') === 'established' &&
      !targetObservationIsAdmissible(record.collaborationDomainId, record.context.targetObservation, record.createdAt)
    ) {
      issues.push(`${record.evaluationId} claims evidence compatibility without a fixed same-domain observation`);
    }
    for (const judgment of record.predicates) {
      if (
        judgment.state === 'established' &&
        (judgment.evidenceReceipts.length === 0 ||
          judgment.evidenceReceipts.some(
            (receipt) => !targetObservationIsAdmissible(record.collaborationDomainId, receipt, record.createdAt),
          ))
      ) {
        issues.push(`${record.evaluationId} establishes ${judgment.predicate} without fixed same-domain evidence`);
      }
    }
    return issues;
  });
  return { ...result, integrityIssues };
}

export function readCompletionTransitions(
  projectRoot: string,
  evaluations: readonly CompletionEvaluationRecordV1[] = readCompletionEvaluations(projectRoot).records,
): CompletionCollectionReadResult<CompletionTransitionRecordV1> {
  const result = readRecordDirectory(
    projectRoot,
    COMPLETION_TRANSITIONS_DIR,
    'completion transition record',
    decodeCompletionTransitionRecord,
    (record) => record.transitionId,
  );
  const evaluationsById = new Map(evaluations.map((evaluation) => [evaluation.evaluationId, evaluation]));
  const integrityIssues = result.records.flatMap((record) => {
    const evaluation = evaluationsById.get(record.evaluationId);
    if (!evaluation) return [`${record.transitionId} references missing evaluation ${record.evaluationId}`];
    return completionTransitionMatchesEvaluation(record, evaluation)
      ? []
      : [`${record.transitionId} does not match evaluation ${record.evaluationId}`];
  });
  return { ...result, integrityIssues };
}

export function readCompletionHistory(projectRoot: string, changeId?: string): CompletionHistoryReadResult {
  const goals = readGoalRecords(projectRoot);
  const changes = readIntendedChangeRecords(projectRoot, goals);
  const evaluations = readCompletionEvaluations(projectRoot);
  const transitions = readCompletionTransitions(projectRoot, evaluations.records);
  const obligations = readObligationLifecycle(projectRoot, changeId);
  const selectedChanges = changeId ? changes.records.filter((change) => change.changeId === changeId) : changes.records;
  const selectedEvaluations = changeId
    ? evaluations.records.filter((evaluation) => evaluation.changeId === changeId)
    : evaluations.records;
  const selectedTransitions = changeId
    ? transitions.records.filter((transition) => transition.changeId === changeId)
    : transitions.records;
  const summary = foldCompletionHistory(selectedChanges, selectedEvaluations, selectedTransitions);
  const completedChangeIds = new Set(
    summary.states.filter((state) => state.state === 'complete').map((state) => state.changeId),
  );
  const liveAfterCompletion = obligations.summary.obligations
    .filter((obligation) => obligation.state === 'live' && completedChangeIds.has(obligation.obligation.changeId))
    .map(
      (obligation) =>
        `${obligation.obligation.changeId} is complete but obligation ${obligation.obligation.obligationId} is live`,
    );
  const integrityIssues = [
    ...changes.integrityIssues,
    ...(changeId && selectedChanges.length === 0
      ? [`intended change ${changeId} is not a readable current record`]
      : []),
    ...evaluations.integrityIssues,
    ...transitions.integrityIssues,
    ...summary.conflicts,
    ...summary.orphanTransitionIds.map(
      (transitionId) => `${transitionId} does not have a matching complete evaluation`,
    ),
    ...obligations.integrityIssues,
    ...liveAfterCompletion,
  ];
  return {
    evaluations,
    transitions,
    summary,
    goalCompatibility: goals.compatibility,
    changeCompatibility: changes.compatibility,
    obligationCompatibility: {
      admissions: obligations.admissions.compatibility,
      transitions: obligations.transitions.compatibility,
    },
    integrityIssues: [...new Set(integrityIssues)].sort(),
  };
}

function validateRepositoryPredicates(
  collaborationDomainId: string,
  request: CompletionEvaluationRequest,
  obligations: ObligationLifecycleReadResult,
  evaluatedAt: string,
): void {
  for (const judgment of request.predicates) {
    if (judgment.state !== 'established') continue;
    if (
      judgment.evidenceReceipts.length === 0 ||
      judgment.evidenceReceipts.some(
        (receipt) => !targetObservationIsAdmissible(collaborationDomainId, receipt, evaluatedAt),
      )
    ) {
      throw new Error(
        `${judgment.predicate} cannot be established without fixed, same-domain evidence observed by evaluation time`,
      );
    }
  }
  if (
    predicateState(request.predicates, 'evidence-compatible') === 'established' &&
    !targetObservationIsAdmissible(collaborationDomainId, request.context.targetObservation, evaluatedAt)
  ) {
    throw new Error(
      'evidence-compatible cannot be established without a fixed, same-domain target observation made by evaluation time',
    );
  }
  if (
    predicateState(request.predicates, 'obligations-reconciled') === 'established' &&
    !obligationsAreReconciled(obligations)
  ) {
    throw new Error(
      'obligations-reconciled cannot be established while obligations are live, conflicted, or unreadable',
    );
  }
}

function targetObservationIsAdmissible(
  collaborationDomainId: string,
  receipt: ObservationReceiptV2,
  evaluatedAt: string,
): boolean {
  const expectedDomain = createObservationIdentity('scip-query:collaboration-domain', 1, collaborationDomainId);
  return (
    stableJson(receipt.facts.collaborationDomain) === stableJson(expectedDomain) &&
    receipt.facts.wholeContent !== undefined &&
    observationReceiptStabilityLabel(receipt) === 'fixed' &&
    Date.parse(receipt.observedAt) <= Date.parse(evaluatedAt)
  );
}

function obligationsAreReconciled(lifecycle: ObligationLifecycleReadResult): boolean {
  return (
    lifecycle.goalCompatibility.complete &&
    lifecycle.changeCompatibility.complete &&
    lifecycle.attemptCompatibility.complete &&
    lifecycle.admissions.compatibility.complete &&
    lifecycle.transitions.compatibility.complete &&
    lifecycle.integrityIssues.length === 0 &&
    lifecycle.summary.liveObligationIds.length === 0 &&
    lifecycle.summary.conflictedObligationIds.length === 0 &&
    lifecycle.summary.orphanTransitionIds.length === 0
  );
}

function predicateState(
  predicates: CompletionEvaluationRequest['predicates'],
  predicate: CompletionPredicate,
): CompletionEvaluationRequest['predicates'][number]['state'] | undefined {
  return predicates.find((candidate) => candidate.predicate === predicate)?.state;
}
