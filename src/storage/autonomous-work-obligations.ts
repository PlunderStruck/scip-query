import { join } from 'node:path';

import {
  createObligationAdmission,
  createObligationTransition,
  decodeObligationAdmissionRecord,
  decodeObligationRecord,
  decodeObligationTransitionRecord,
  foldObligationLifecycle,
  isObligationId,
  isObligationTransitionId,
  obligationAdmissionRequestMatchesRecord,
  obligationTransitionRequestMatchesRecord,
  terminalEvidenceIsCurrent,
  type FoldedObligationState,
  type Obligation,
  type ObligationAdmissionRecordV1,
  type ObligationAdmissionRequest,
  type ObligationLifecycleSummary,
  type ObligationTransitionRecordV1,
  type ObligationTransitionRequest,
} from '../domain/autonomous-work-obligations.js';
import { isIntendedChangeId, type IntendedChangeRecordV1 } from '../domain/autonomous-work-state.js';
import { readAttemptRecords, type WorkLedgerCollectionReadResult } from './autonomous-work-ledger.js';
import {
  parseRecordFile,
  publishWorkStateRecord,
  readGoalRecords,
  readIntendedChangeRecords,
  readRecordDirectory,
  readRecordFile,
  requireIntendedChangeRecord,
  type WorkStateCollectionReadResult,
  type WorkStateCreateOptions,
  type WorkStateCreateResult,
  type WorkStateRecordReadResult,
} from './autonomous-work-state.js';

export const OBLIGATIONS_DIR = join('.scipquery', 'obligations');
export const OBLIGATION_TRANSITIONS_DIR = join('.scipquery', 'obligation-transitions');

export interface ObligationCollectionReadResult<RecordType> extends WorkStateCollectionReadResult<RecordType> {
  integrityIssues: string[];
}

export interface ObligationLifecycleReadResult {
  admissions: ObligationCollectionReadResult<ObligationAdmissionRecordV1>;
  transitions: ObligationCollectionReadResult<ObligationTransitionRecordV1>;
  summary: ObligationLifecycleSummary;
  goalCompatibility: ReturnType<typeof readGoalRecords>['compatibility'];
  changeCompatibility: ReturnType<typeof readIntendedChangeRecords>['compatibility'];
  attemptCompatibility: WorkLedgerCollectionReadResult<unknown>['compatibility'];
  integrityIssues: string[];
}

export function createObligationAdmissionFile(
  projectRoot: string,
  collaborationDomainId: string,
  request: ObligationAdmissionRequest,
  options: WorkStateCreateOptions,
): WorkStateCreateResult<ObligationAdmissionRecordV1> {
  requireIntendedChangeRecord(projectRoot, collaborationDomainId, request.changeId);
  requireBasisAttempts(projectRoot, request.changeId, request.basisAttemptIds);
  const record = createObligationAdmission({
    collaborationDomainId,
    request,
    createdAt: (options.now ?? defaultNow)(),
    toolVersion: options.toolVersion,
  });
  return publishWorkStateRecord(
    projectRoot,
    {
      relativeDirectory: OBLIGATIONS_DIR,
      identity: record.obligationId,
      record,
      readExisting: () => readObligationAdmissionRecordFile(projectRoot, record.obligationId),
      matchesExisting: (existing) => obligationAdmissionRequestMatchesRecord(collaborationDomainId, request, existing),
      collisionMessage: (relativePath) =>
        `obligation idempotency collision at ${relativePath}: this key already names a different required condition`,
    },
    options,
  );
}

export function createObligationTransitionFile(
  projectRoot: string,
  collaborationDomainId: string,
  request: ObligationTransitionRequest,
  options: WorkStateCreateOptions,
): WorkStateCreateResult<ObligationTransitionRecordV1> {
  const sourceChange = requireIntendedChangeRecord(projectRoot, collaborationDomainId, request.changeId);
  requireBasisAttempts(projectRoot, request.changeId, request.basisAttemptIds);
  const record = createObligationTransition({
    collaborationDomainId,
    request,
    createdAt: (options.now ?? defaultNow)(),
    toolVersion: options.toolVersion,
  });
  const existing = readObligationTransitionRecordFile(projectRoot, record.transitionId);
  if (
    existing.state === 'current' &&
    obligationTransitionRequestMatchesRecord(collaborationDomainId, request, existing.record)
  ) {
    return publishTransition(projectRoot, collaborationDomainId, request, existing.record, options);
  }
  const lifecycle = readObligationLifecycle(projectRoot);
  if (
    !lifecycle.admissions.compatibility.complete ||
    !lifecycle.transitions.compatibility.complete ||
    lifecycle.integrityIssues.length > 0
  ) {
    throw new Error('obligation lifecycle is incomplete or inconsistent; refusing a new terminal transition');
  }
  const current = lifecycle.summary.obligations.find(
    (candidate) => candidate.obligation.obligationId === request.obligationId,
  );
  if (!current) throw new Error(`obligation ${request.obligationId} is not a readable current obligation`);
  if (current.state !== 'live') {
    throw new Error(`obligation ${request.obligationId} is ${current.state}; terminal obligations cannot transition`);
  }
  requireMatchingSource(current.obligation, collaborationDomainId, request.changeId);
  if (!terminalEvidenceIsCurrent(current.obligation, record.evidenceReceipts, record.createdAt)) {
    throw new Error(
      `transition ${record.transitionId} lacks fixed current evidence for obligation ${request.obligationId}`,
    );
  }
  if (record.successor) {
    const successorChange = requireIntendedChangeRecord(projectRoot, collaborationDomainId, record.successor.changeId);
    if (successorChange.goalId !== sourceChange.goalId) {
      throw new Error('a carried-forward successor must remain governed by the same goal');
    }
    requireBasisAttempts(projectRoot, record.successor.changeId, record.successor.basisAttemptIds);
  }
  return publishTransition(projectRoot, collaborationDomainId, request, record, options);
}

export function readObligationAdmissionRecordFile(
  projectRoot: string,
  obligationId: string,
): WorkStateRecordReadResult<ObligationAdmissionRecordV1> {
  if (!isObligationId(obligationId)) throw new Error(`invalid obligation identity: ${obligationId}`);
  return readRecordFile(projectRoot, join(OBLIGATIONS_DIR, `${obligationId}.json`), decodeObligationAdmissionRecord);
}

export function readObligationTransitionRecordFile(
  projectRoot: string,
  transitionId: string,
): WorkStateRecordReadResult<ObligationTransitionRecordV1> {
  if (!isObligationTransitionId(transitionId)) {
    throw new Error(`invalid obligation-transition identity: ${transitionId}`);
  }
  return readRecordFile(
    projectRoot,
    join(OBLIGATION_TRANSITIONS_DIR, `${transitionId}.json`),
    decodeObligationTransitionRecord,
  );
}

export function readObligationRecordPath(path: string) {
  return parseRecordFile(path, 'obligation record', decodeObligationRecord);
}

export function readObligationAdmissions(
  projectRoot: string,
  changes: readonly IntendedChangeRecordV1[] = readIntendedChangeRecords(projectRoot).records,
): ObligationCollectionReadResult<ObligationAdmissionRecordV1> {
  const result = readRecordDirectory(
    projectRoot,
    OBLIGATIONS_DIR,
    'obligation admission record',
    decodeObligationAdmissionRecord,
    (record) => record.obligationId,
  );
  const attempts = readAttemptRecords(projectRoot, changes);
  const integrityIssues = result.records.flatMap((record) =>
    obligationRelationshipIssues(record, changes, attempts.records),
  );
  return { ...result, integrityIssues };
}

export function readObligationTransitions(
  projectRoot: string,
  changes: readonly IntendedChangeRecordV1[] = readIntendedChangeRecords(projectRoot).records,
  admissions: readonly ObligationAdmissionRecordV1[] = readObligationAdmissions(projectRoot, changes).records,
): ObligationCollectionReadResult<ObligationTransitionRecordV1> {
  const result = readRecordDirectory(
    projectRoot,
    OBLIGATION_TRANSITIONS_DIR,
    'obligation transition record',
    decodeObligationTransitionRecord,
    (record) => record.transitionId,
  );
  const attempts = readAttemptRecords(projectRoot, changes);
  const summary = foldObligationLifecycle(admissions, result.records);
  const obligationsById = new Map(
    summary.obligations.map((state) => [state.obligation.obligationId, state.obligation]),
  );
  const changesById = new Map(changes.map((change) => [change.changeId, change]));
  const integrityIssues = result.records.flatMap((record) => {
    const issues = relationshipIssues(record, changesById, attempts.records);
    const obligation = obligationsById.get(record.obligationId);
    if (!obligation) {
      issues.push(`${record.transitionId} references missing obligation ${record.obligationId}`);
      return issues;
    }
    if (obligation.collaborationDomainId !== record.collaborationDomainId || obligation.changeId !== record.changeId) {
      issues.push(`${record.transitionId} does not belong to the obligation's collaboration domain and change`);
    }
    if (!terminalEvidenceIsCurrent(obligation, record.evidenceReceipts, record.createdAt)) {
      issues.push(`${record.transitionId} lacks fixed current evidence for ${record.obligationId}`);
    }
    if (record.successor) {
      issues.push(...successorRelationshipIssues(record, changesById, attempts.records));
    }
    return issues;
  });
  return { ...result, integrityIssues };
}

export function readObligationLifecycle(projectRoot: string, changeId?: string): ObligationLifecycleReadResult {
  if (changeId !== undefined && !isIntendedChangeId(changeId)) {
    throw new Error(`invalid intended-change identity: ${changeId}`);
  }
  const goals = readGoalRecords(projectRoot);
  const changes = readIntendedChangeRecords(projectRoot, goals);
  const attempts = readAttemptRecords(projectRoot, changes.records);
  const admissions = readObligationAdmissions(projectRoot, changes.records);
  const allTransitions = readObligationTransitions(projectRoot, changes.records, admissions.records);
  const completeSummary = foldObligationLifecycle(admissions.records, allTransitions.records);
  const summary = changeId ? selectLifecycleSummary(completeSummary, changeId) : completeSummary;
  const integrityIssues = [
    ...changes.integrityIssues,
    ...(changeId && !changes.records.some((change) => change.changeId === changeId)
      ? [`intended change ${changeId} is not a readable current record`]
      : []),
    ...attempts.integrityIssues,
    ...admissions.integrityIssues,
    ...allTransitions.integrityIssues,
    ...summary.conflicts,
    ...summary.orphanTransitionIds.map((transitionId) => `${transitionId} references an unknown obligation`),
  ];
  return {
    admissions,
    transitions: allTransitions,
    summary,
    goalCompatibility: goals.compatibility,
    changeCompatibility: changes.compatibility,
    attemptCompatibility: attempts.compatibility,
    integrityIssues: [...new Set(integrityIssues)].sort(),
  };
}

function publishTransition(
  projectRoot: string,
  collaborationDomainId: string,
  request: ObligationTransitionRequest,
  record: ObligationTransitionRecordV1,
  options: WorkStateCreateOptions,
): WorkStateCreateResult<ObligationTransitionRecordV1> {
  return publishWorkStateRecord(
    projectRoot,
    {
      relativeDirectory: OBLIGATION_TRANSITIONS_DIR,
      identity: record.transitionId,
      record,
      readExisting: () => readObligationTransitionRecordFile(projectRoot, record.transitionId),
      matchesExisting: (candidate) =>
        obligationTransitionRequestMatchesRecord(collaborationDomainId, request, candidate),
      collisionMessage: (relativePath) =>
        `obligation transition idempotency collision at ${relativePath}: this key already names a different transition`,
    },
    options,
  );
}

function requireBasisAttempts(projectRoot: string, changeId: string, attemptIds: readonly string[]): void {
  if (attemptIds.length === 0) return;
  const attempts = readAttemptRecords(projectRoot);
  const attemptsById = new Map(attempts.records.map((attempt) => [attempt.attemptId, attempt]));
  for (const attemptId of attemptIds) {
    const attempt = attemptsById.get(attemptId);
    if (!attempt) throw new Error(`basis attempt ${attemptId} is not a readable current record`);
    if (attempt.changeId !== changeId) {
      throw new Error(`basis attempt ${attemptId} belongs to another intended change`);
    }
  }
}

function obligationRelationshipIssues(
  record: ObligationAdmissionRecordV1,
  changes: readonly IntendedChangeRecordV1[],
  attempts: ReturnType<typeof readAttemptRecords>['records'],
): string[] {
  return relationshipIssues(record, new Map(changes.map((change) => [change.changeId, change])), attempts);
}

function relationshipIssues(
  record: {
    obligationId?: string;
    transitionId?: string;
    changeId: string;
    collaborationDomainId: string;
    basisAttemptIds: readonly string[];
  },
  changesById: ReadonlyMap<string, IntendedChangeRecordV1>,
  attempts: ReturnType<typeof readAttemptRecords>['records'],
): string[] {
  const identity = record.transitionId ?? record.obligationId ?? 'obligation record';
  const issues: string[] = [];
  const change = changesById.get(record.changeId);
  if (!change) {
    issues.push(`${identity} references missing or incompatible change ${record.changeId}`);
  } else if (change.collaborationDomainId !== record.collaborationDomainId) {
    issues.push(`${identity} and change ${record.changeId} belong to different collaboration domains`);
  }
  const attemptsById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  for (const attemptId of record.basisAttemptIds) {
    const attempt = attemptsById.get(attemptId);
    if (!attempt) issues.push(`${identity} references missing basis attempt ${attemptId}`);
    else if (attempt.changeId !== record.changeId) {
      issues.push(`${identity} references basis attempt ${attemptId} from another intended change`);
    }
  }
  return issues;
}

function successorRelationshipIssues(
  transition: ObligationTransitionRecordV1,
  changesById: ReadonlyMap<string, IntendedChangeRecordV1>,
  attempts: ReturnType<typeof readAttemptRecords>['records'],
): string[] {
  if (!transition.successor) return [];
  const issues = relationshipIssues(
    {
      obligationId: transition.successor.obligationId,
      changeId: transition.successor.changeId,
      collaborationDomainId: transition.collaborationDomainId,
      basisAttemptIds: transition.successor.basisAttemptIds,
    },
    changesById,
    attempts,
  );
  const sourceChange = changesById.get(transition.changeId);
  const successorChange = changesById.get(transition.successor.changeId);
  if (sourceChange && successorChange && sourceChange.goalId !== successorChange.goalId) {
    issues.push(`${transition.transitionId} carries its obligation into a change governed by another goal`);
  }
  return issues;
}

function requireMatchingSource(obligation: Obligation, collaborationDomainId: string, changeId: string): void {
  if (obligation.collaborationDomainId !== collaborationDomainId) {
    throw new Error(`obligation ${obligation.obligationId} belongs to another collaboration domain`);
  }
  if (obligation.changeId !== changeId) {
    throw new Error(`obligation ${obligation.obligationId} belongs to another intended change`);
  }
}

function selectLifecycleSummary(summary: ObligationLifecycleSummary, changeId: string): ObligationLifecycleSummary {
  const obligations = summary.obligations.filter((state) => state.obligation.changeId === changeId);
  const selectedIds = new Set(obligations.map((state) => state.obligation.obligationId));
  const stateIds = (state: FoldedObligationState['state']) =>
    obligations.filter((candidate) => candidate.state === state).map((candidate) => candidate.obligation.obligationId);
  return {
    admissions: summary.admissions.filter((record) => record.changeId === changeId),
    transitions: summary.transitions.filter(
      (record) => selectedIds.has(record.obligationId) || record.successor?.changeId === changeId,
    ),
    obligations,
    liveObligationIds: stateIds('live'),
    fulfilledObligationIds: stateIds('fulfilled'),
    invalidatedObligationIds: stateIds('invalidated'),
    carriedForwardObligationIds: stateIds('carried-forward'),
    conflictedObligationIds: stateIds('conflicted'),
    conflicts: summary.conflicts.filter((conflict) => [...selectedIds].some((id) => conflict.includes(id))),
    orphanTransitionIds: summary.orphanTransitionIds,
  };
}

function defaultNow(): string {
  return new Date().toISOString();
}
