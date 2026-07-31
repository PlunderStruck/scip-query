import { join } from 'node:path';

import {
  completionContextRequestMatchesRecord,
  createCompletionContextSnapshotRecord,
  decodeCompletionContextSnapshotRecord,
  isCompletionContextSnapshotId,
  type CompletionContextSnapshotRecordV1,
  type CompletionContextSnapshotRequest,
} from '../domain/autonomous-completion-context.js';
import { hashIdentity } from '../domain/autonomous-work-state.js';
import { stableJson } from '../domain/stable-json.js';
import {
  publishWorkStateRecord,
  readGoalRecordFile,
  readIntendedChangeRecordFile,
  readRecordDirectory,
  readRecordFile,
  workStateNow,
  type WorkStateCollectionReadResult,
  type WorkStateCreateOptions,
  type WorkStateCreateResult,
  type WorkStateRecordReadResult,
} from './autonomous-work-state.js';

export const COMPLETION_CONTEXTS_DIR = join('.scipquery', 'completion-contexts');

export interface CompletionContextCollectionReadResult extends WorkStateCollectionReadResult<CompletionContextSnapshotRecordV1> {
  integrityIssues: string[];
}

export function createCompletionContextSnapshotFile(
  projectRoot: string,
  collaborationDomainId: string,
  request: CompletionContextSnapshotRequest,
  options: WorkStateCreateOptions,
): WorkStateCreateResult<CompletionContextSnapshotRecordV1> {
  const record = createCompletionContextSnapshotRecord({
    collaborationDomainId,
    request,
    capturedAt: (options.now ?? workStateNow)(),
    toolVersion: options.toolVersion,
  });
  return publishWorkStateRecord(
    projectRoot,
    {
      relativeDirectory: COMPLETION_CONTEXTS_DIR,
      identity: record.contextSnapshotId,
      record,
      readExisting: () => readCompletionContextSnapshotFile(projectRoot, record.contextSnapshotId),
      matchesExisting: (existing) => completionContextRequestMatchesRecord(collaborationDomainId, request, existing),
      collisionMessage: (relativePath) =>
        `completion-context identity collision at ${relativePath}: existing record fixes different inputs`,
    },
    options,
  );
}

export function readCompletionContextSnapshotFile(
  projectRoot: string,
  contextSnapshotId: string,
): WorkStateRecordReadResult<CompletionContextSnapshotRecordV1> {
  if (!isCompletionContextSnapshotId(contextSnapshotId)) {
    throw new Error(`invalid completion-context identity: ${contextSnapshotId}`);
  }
  return readRecordFile(
    projectRoot,
    join(COMPLETION_CONTEXTS_DIR, `${contextSnapshotId}.json`),
    decodeCompletionContextSnapshotRecord,
  );
}

export function readCompletionContextSnapshots(projectRoot: string): CompletionContextCollectionReadResult {
  const result = readRecordDirectory(
    projectRoot,
    COMPLETION_CONTEXTS_DIR,
    'completion context record',
    decodeCompletionContextSnapshotRecord,
    (record) => record.contextSnapshotId,
  );
  const integrityIssues = result.records.flatMap((record) => {
    const issues: string[] = [];
    const goal = readGoalRecordFile(projectRoot, record.goalId);
    if (goal.state !== 'current') {
      issues.push(`${record.contextSnapshotId} references missing or incompatible goal ${record.goalId}`);
    } else {
      if (goal.record.collaborationDomainId !== record.collaborationDomainId) {
        issues.push(`${record.contextSnapshotId} and goal ${record.goalId} belong to different collaboration domains`);
      }
      if (hashIdentity(stableJson(goal.record)) !== record.goalRecordDigest) {
        issues.push(`${record.contextSnapshotId} does not match current goal record ${record.goalId}`);
      }
    }
    const change = readIntendedChangeRecordFile(projectRoot, record.changeId);
    if (change.state !== 'current') {
      issues.push(`${record.contextSnapshotId} references missing or incompatible intended change ${record.changeId}`);
    } else if (
      change.record.goalId !== record.goalId ||
      change.record.collaborationDomainId !== record.collaborationDomainId
    ) {
      issues.push(`${record.contextSnapshotId} is not aligned with intended change ${record.changeId}`);
    }
    return issues;
  });
  return { ...result, integrityIssues };
}
