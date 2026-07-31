import { join } from 'node:path';

import {
  attemptRequestMatchesRecord,
  createAttemptRecord,
  createDecisionRecord,
  decisionRequestMatchesRecord,
  decodeAttemptRecord,
  decodeDecisionRecord,
  foldWorkHistory,
  isAttemptId,
  isDecisionId,
  type AttemptCreateRequest,
  type AttemptRecordV1,
  type DecisionCreateRequest,
  type DecisionRecordV1,
  type WorkHistorySummary,
} from '../domain/autonomous-work-ledger.js';
import { isIntendedChangeId, type IntendedChangeRecordV1 } from '../domain/autonomous-work-state.js';
import {
  publishWorkStateRecord,
  readGoalRecords,
  readIntendedChangeRecords,
  readRecordDirectory,
  readRecordFile,
  parseRecordFile,
  requireIntendedChangeRecord,
  workStateNow,
  type WorkStateCollectionReadResult,
  type WorkStateCreateOptions,
  type WorkStateCreateResult,
  type WorkStateRecordReadResult,
} from './autonomous-work-state.js';

export const ATTEMPTS_DIR = join('.scipquery', 'attempts');
export const DECISIONS_DIR = join('.scipquery', 'decisions');

export interface WorkLedgerCollectionReadResult<RecordType> extends WorkStateCollectionReadResult<RecordType> {
  integrityIssues: string[];
}

export interface WorkHistoryReadResult {
  attempts: WorkLedgerCollectionReadResult<AttemptRecordV1>;
  decisions: WorkLedgerCollectionReadResult<DecisionRecordV1>;
  summary: WorkHistorySummary;
  goalCompatibility: ReturnType<typeof readGoalRecords>['compatibility'];
  changeCompatibility: ReturnType<typeof readIntendedChangeRecords>['compatibility'];
  integrityIssues: string[];
}

export function createAttemptRecordFile(
  projectRoot: string,
  collaborationDomainId: string,
  request: AttemptCreateRequest,
  options: WorkStateCreateOptions,
): WorkStateCreateResult<AttemptRecordV1> {
  const change = requireIntendedChangeRecord(projectRoot, collaborationDomainId, request.changeId);
  const record = createAttemptRecord({
    collaborationDomainId,
    request,
    createdAt: (options.now ?? workStateNow)(),
    toolVersion: options.toolVersion,
  });
  if (record.changeId !== change.changeId) throw new Error('attempt does not name its validated intended change');
  if (record.reconcilesAttemptId) {
    const original = readAttemptRecordFile(projectRoot, record.reconcilesAttemptId);
    if (original.state !== 'current') {
      throw new Error(`reconciled attempt ${record.reconcilesAttemptId} is not a readable current record`);
    }
    if (original.record.changeId !== record.changeId) {
      throw new Error(`reconciled attempt ${record.reconcilesAttemptId} belongs to another intended change`);
    }
    const reconciliation = foldWorkHistory([original.record, record], []);
    if (!reconciliation.reconciliations.some((candidate) => candidate.attemptId === original.record.attemptId)) {
      throw new Error(
        `attempt ${record.attemptId} does not carry an observation at or after unknown attempt ${original.record.attemptId}`,
      );
    }
  }
  return publishWorkStateRecord(
    projectRoot,
    {
      relativeDirectory: ATTEMPTS_DIR,
      identity: record.attemptId,
      record,
      readExisting: () => readAttemptRecordFile(projectRoot, record.attemptId),
      matchesExisting: (existing) => attemptRequestMatchesRecord(collaborationDomainId, request, existing),
      collisionMessage: (relativePath) =>
        `attempt idempotency collision at ${relativePath}: this key already names a different action`,
    },
    options,
  );
}

export function createDecisionRecordFile(
  projectRoot: string,
  collaborationDomainId: string,
  request: DecisionCreateRequest,
  options: WorkStateCreateOptions,
): WorkStateCreateResult<DecisionRecordV1> {
  requireIntendedChangeRecord(projectRoot, collaborationDomainId, request.changeId);
  const attempts = readAttemptRecords(projectRoot);
  const attemptsById = new Map(attempts.records.map((attempt) => [attempt.attemptId, attempt]));
  for (const attemptId of request.basisAttemptIds) {
    const attempt = attemptsById.get(attemptId);
    if (!attempt) throw new Error(`decision basis attempt ${attemptId} is not a readable current record`);
    if (attempt.changeId !== request.changeId) {
      throw new Error(`decision basis attempt ${attemptId} belongs to another intended change`);
    }
  }
  const current = foldWorkHistory(attempts.records, []);
  if (
    request.disposition === 'retry-safe' &&
    request.basisAttemptIds.some((attemptId) => current.unsafeToRepeatAttemptIds.includes(attemptId))
  ) {
    throw new Error('retry-safe cannot authorize repetition of an unresolved non-idempotent attempt');
  }
  const record = createDecisionRecord({
    collaborationDomainId,
    request,
    createdAt: (options.now ?? workStateNow)(),
    toolVersion: options.toolVersion,
  });
  return publishWorkStateRecord(
    projectRoot,
    {
      relativeDirectory: DECISIONS_DIR,
      identity: record.decisionId,
      record,
      readExisting: () => readDecisionRecordFile(projectRoot, record.decisionId),
      matchesExisting: (existing) => decisionRequestMatchesRecord(collaborationDomainId, request, existing),
      collisionMessage: (relativePath) =>
        `decision idempotency collision at ${relativePath}: this key already names a different conclusion`,
    },
    options,
  );
}

export function readAttemptRecordFile(
  projectRoot: string,
  attemptId: string,
): WorkStateRecordReadResult<AttemptRecordV1> {
  if (!isAttemptId(attemptId)) throw new Error(`invalid attempt identity: ${attemptId}`);
  return readRecordFile(projectRoot, join(ATTEMPTS_DIR, `${attemptId}.json`), decodeAttemptRecord);
}

export function readDecisionRecordFile(
  projectRoot: string,
  decisionId: string,
): WorkStateRecordReadResult<DecisionRecordV1> {
  if (!isDecisionId(decisionId)) throw new Error(`invalid decision identity: ${decisionId}`);
  return readRecordFile(projectRoot, join(DECISIONS_DIR, `${decisionId}.json`), decodeDecisionRecord);
}

export function readAttemptRecordPath(path: string) {
  return parseRecordFile(path, 'attempt record', decodeAttemptRecord);
}

export function readDecisionRecordPath(path: string) {
  return parseRecordFile(path, 'decision record', decodeDecisionRecord);
}

export function readAttemptRecords(
  projectRoot: string,
  changes: readonly IntendedChangeRecordV1[] = readIntendedChangeRecords(projectRoot).records,
): WorkLedgerCollectionReadResult<AttemptRecordV1> {
  const result = readRecordDirectory(
    projectRoot,
    ATTEMPTS_DIR,
    'attempt record',
    decodeAttemptRecord,
    (record) => record.attemptId,
  );
  const changesById = new Map(changes.map((change) => [change.changeId, change]));
  const recordsById = new Map(result.records.map((attempt) => [attempt.attemptId, attempt]));
  const integrityIssues = result.records.flatMap((attempt) => {
    const issues: string[] = [];
    const change = changesById.get(attempt.changeId);
    if (!change) {
      issues.push(`${attempt.attemptId} references missing or incompatible change ${attempt.changeId}`);
    } else if (change.collaborationDomainId !== attempt.collaborationDomainId) {
      issues.push(`${attempt.attemptId} and change ${attempt.changeId} belong to different collaboration domains`);
    }
    if (attempt.reconcilesAttemptId) {
      const original = recordsById.get(attempt.reconcilesAttemptId);
      if (!original) {
        issues.push(`${attempt.attemptId} references missing reconciliation target ${attempt.reconcilesAttemptId}`);
      } else if (original.changeId !== attempt.changeId) {
        issues.push(`${attempt.attemptId} reconciles an attempt from another intended change`);
      } else if (
        !foldWorkHistory([original, attempt], []).reconciliations.some(
          (candidate) => candidate.attemptId === original.attemptId,
        )
      ) {
        issues.push(`${attempt.attemptId} does not validly reconcile unknown attempt ${original.attemptId}`);
      }
    }
    return issues;
  });
  return { ...result, integrityIssues };
}

export function readDecisionRecords(
  projectRoot: string,
  changes: readonly IntendedChangeRecordV1[] = readIntendedChangeRecords(projectRoot).records,
  attempts: readonly AttemptRecordV1[] = readAttemptRecords(projectRoot, changes).records,
): WorkLedgerCollectionReadResult<DecisionRecordV1> {
  const result = readRecordDirectory(
    projectRoot,
    DECISIONS_DIR,
    'decision record',
    decodeDecisionRecord,
    (record) => record.decisionId,
  );
  const changesById = new Map(changes.map((change) => [change.changeId, change]));
  const attemptsById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  const integrityIssues = result.records.flatMap((decision) => {
    const issues: string[] = [];
    const change = changesById.get(decision.changeId);
    if (!change) {
      issues.push(`${decision.decisionId} references missing or incompatible change ${decision.changeId}`);
    } else if (change.collaborationDomainId !== decision.collaborationDomainId) {
      issues.push(`${decision.decisionId} and change ${decision.changeId} belong to different collaboration domains`);
    }
    for (const attemptId of decision.basisAttemptIds) {
      const attempt = attemptsById.get(attemptId);
      if (!attempt) issues.push(`${decision.decisionId} references missing basis attempt ${attemptId}`);
      else if (attempt.changeId !== decision.changeId) {
        issues.push(`${decision.decisionId} references basis attempt ${attemptId} from another intended change`);
      }
    }
    return issues;
  });
  return { ...result, integrityIssues };
}

export function readWorkHistory(projectRoot: string, changeId?: string): WorkHistoryReadResult {
  if (changeId !== undefined && !isIntendedChangeId(changeId)) {
    throw new Error(`invalid intended-change identity: ${changeId}`);
  }
  const goals = readGoalRecords(projectRoot);
  const changes = readIntendedChangeRecords(projectRoot, goals);
  const attempts = readAttemptRecords(projectRoot, changes.records);
  const decisions = readDecisionRecords(projectRoot, changes.records, attempts.records);
  const selectedAttempts = changeId
    ? attempts.records.filter((attempt) => attempt.changeId === changeId)
    : attempts.records;
  const selectedDecisions = changeId
    ? decisions.records.filter((decision) => decision.changeId === changeId)
    : decisions.records;
  const summary = foldWorkHistory(selectedAttempts, selectedDecisions);
  const integrityIssues = [
    ...changes.integrityIssues,
    ...(changeId && !changes.records.some((change) => change.changeId === changeId)
      ? [`intended change ${changeId} is not a readable current record`]
      : []),
    ...attempts.integrityIssues,
    ...decisions.integrityIssues,
    ...summary.reconciliationConflicts,
  ];
  return {
    attempts,
    decisions,
    summary,
    goalCompatibility: goals.compatibility,
    changeCompatibility: changes.compatibility,
    integrityIssues,
  };
}
