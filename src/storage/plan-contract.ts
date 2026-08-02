import { join } from 'node:path';

import {
  createPlanContractRecord,
  decodePlanContractRecord,
  isPlanContractId,
  planContractRequestMatchesRecord,
  type PlanContractRecordV1,
  type PlanContractRequest,
  type PlanContractSource,
} from '../change-control/plan-contract.js';
import type { ObservationReceiptV2 } from '../domain/observation-receipt.js';
import type { RecordCompatibilitySummary } from '../domain/record-compatibility.js';
import {
  publishWorkStateRecord,
  readGoalRecords,
  readIntendedChangeRecords,
  readRecordDirectory,
  readRecordFile,
  type WorkStateCreateOptions,
  type WorkStateCreateResult,
  type WorkStateRecordReadResult,
} from './autonomous-work-state.js';

export const PLAN_CONTRACTS_DIR = join('.scipquery', 'plans');

export interface PlanContractCollectionReadResult {
  records: PlanContractRecordV1[];
  currentRecords: PlanContractRecordV1[];
  compatibility: RecordCompatibilitySummary;
  warnings: string[];
  integrityIssues: string[];
}

export function createPlanContractRecordFile(
  projectRoot: string,
  collaborationDomainId: string,
  request: PlanContractRequest,
  source: PlanContractSource,
  compiledAgainst: ObservationReceiptV2,
  options: WorkStateCreateOptions,
): WorkStateCreateResult<PlanContractRecordV1> {
  const goals = readGoalRecords(projectRoot);
  const changes = readIntendedChangeRecords(projectRoot, goals);
  const change = changes.records.find((candidate) => candidate.changeId === request.changeId);
  if (!change) throw new Error(`intended change ${request.changeId} is not a readable current record`);
  if (change.collaborationDomainId !== collaborationDomainId) {
    throw new Error(`intended change ${request.changeId} belongs to another collaboration domain`);
  }
  if (change.goalId !== request.goalId) {
    throw new Error(`plan goal ${request.goalId} does not govern intended change ${request.changeId}`);
  }
  if (request.predecessorPlanId) {
    const predecessor = readPlanContractRecordFile(projectRoot, request.predecessorPlanId);
    if (predecessor.state !== 'current') {
      throw new Error(`predecessor plan ${request.predecessorPlanId} is not a readable current record`);
    }
    if (
      predecessor.record.collaborationDomainId !== collaborationDomainId ||
      predecessor.record.goalId !== request.goalId ||
      predecessor.record.changeId !== request.changeId
    ) {
      throw new Error(`predecessor plan ${request.predecessorPlanId} does not govern the same goal and change`);
    }
  }
  const record = createPlanContractRecord({
    collaborationDomainId,
    request,
    source,
    compiledAgainst,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
    toolVersion: options.toolVersion,
  });
  return publishWorkStateRecord(
    projectRoot,
    {
      relativeDirectory: PLAN_CONTRACTS_DIR,
      identity: record.planId,
      record,
      readExisting: () => readPlanContractRecordFile(projectRoot, record.planId),
      matchesExisting: (existing) =>
        planContractRequestMatchesRecord(collaborationDomainId, request, source, compiledAgainst, existing),
      collisionMessage: (relativePath) =>
        `plan contract identity collision at ${relativePath}: existing record has different meaning or metadata`,
    },
    options,
  );
}

export function readPlanContractRecordFile(
  projectRoot: string,
  planId: string,
): WorkStateRecordReadResult<PlanContractRecordV1> {
  if (!isPlanContractId(planId)) throw new Error(`invalid plan identity: ${planId}`);
  return readRecordFile(projectRoot, join(PLAN_CONTRACTS_DIR, `${planId}.json`), decodePlanContractRecord);
}

export function readPlanContractRecords(projectRoot: string): PlanContractCollectionReadResult {
  const collection = readRecordDirectory(
    projectRoot,
    PLAN_CONTRACTS_DIR,
    'plan contract record',
    decodePlanContractRecord,
    (record) => record.planId,
  );
  const goals = readGoalRecords(projectRoot);
  const changes = readIntendedChangeRecords(projectRoot, goals);
  const goalsById = new Map(goals.records.map((goal) => [goal.goalId, goal]));
  const changesById = new Map(changes.records.map((change) => [change.changeId, change]));
  const recordsById = new Map(collection.records.map((record) => [record.planId, record]));
  const issuesByChange = new Map<string, string[]>();
  const issue = (changeId: string, message: string): void => {
    const items = issuesByChange.get(changeId) ?? [];
    items.push(message);
    issuesByChange.set(changeId, items);
  };

  for (const record of collection.records) {
    const goal = goalsById.get(record.goalId);
    const change = changesById.get(record.changeId);
    if (!goal) issue(record.changeId, `${record.planId} references missing or incompatible goal ${record.goalId}`);
    if (!change)
      issue(record.changeId, `${record.planId} references missing or incompatible change ${record.changeId}`);
    if (goal && goal.collaborationDomainId !== record.collaborationDomainId) {
      issue(record.changeId, `${record.planId} and goal ${record.goalId} belong to different collaboration domains`);
    }
    if (change && (change.collaborationDomainId !== record.collaborationDomainId || change.goalId !== record.goalId)) {
      issue(record.changeId, `${record.planId} does not match the collaboration domain and goal of ${record.changeId}`);
    }
    if (record.predecessorPlanId) {
      const predecessor = recordsById.get(record.predecessorPlanId);
      if (!predecessor) {
        issue(record.changeId, `${record.planId} references missing predecessor ${record.predecessorPlanId}`);
      } else if (
        predecessor.changeId !== record.changeId ||
        predecessor.goalId !== record.goalId ||
        predecessor.collaborationDomainId !== record.collaborationDomainId
      ) {
        issue(record.changeId, `${record.planId} predecessor does not govern the same goal and change`);
      }
    }
  }

  const byChange = groupBy(collection.records, (record) => record.changeId);
  const currentRecords: PlanContractRecordV1[] = [];
  for (const [changeId, records] of byChange) {
    const successors = groupBy(
      records.filter((record) => record.predecessorPlanId !== undefined),
      (record) => record.predecessorPlanId!,
    );
    for (const [predecessorId, children] of successors) {
      if (children.length > 1) {
        issue(
          changeId,
          `plan revision fork after ${predecessorId}: ${children
            .map((record) => record.planId)
            .sort()
            .join(', ')}`,
        );
      }
    }
    const roots = records.filter((record) => !record.predecessorPlanId);
    if (roots.length > 1) {
      issue(
        changeId,
        `plan revision fork has multiple roots: ${roots
          .map((record) => record.planId)
          .sort()
          .join(', ')}`,
      );
    }
    const tips = records.filter((record) => !successors.has(record.planId));
    if (tips.length !== 1) {
      issue(changeId, `plan revision chain must have exactly one current tip; found ${tips.length}`);
    }
    if ((issuesByChange.get(changeId)?.length ?? 0) === 0 && tips[0]) currentRecords.push(tips[0]);
  }

  const integrityIssues = [...issuesByChange.values()].flat().sort();
  return {
    records: collection.records,
    currentRecords: currentRecords.sort((left, right) => left.changeId.localeCompare(right.changeId)),
    compatibility: collection.compatibility,
    warnings: collection.warnings,
    integrityIssues,
  };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const group = result.get(value) ?? [];
    group.push(item);
    result.set(value, group);
  }
  return result;
}
