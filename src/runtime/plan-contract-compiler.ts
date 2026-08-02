import { createHash } from 'node:crypto';

import {
  createPlanContractRecord,
  extractPlanContractInput,
  planContractRequestMatchesRecord,
  planContractObligationRequests,
  type PlanContractInput,
  type PlanContractRequest,
} from '../change-control/plan-contract.js';
import {
  createGoalRecord,
  createIntendedChangeRecord,
  type GoalCreateRequest,
  type IntendedChangeCreateRequest,
} from '../domain/autonomous-work-state.js';
import type { ObligationAdmissionRecordV1 } from '../domain/autonomous-work-obligations.js';
import type { ObservationReceiptV2 } from '../domain/observation-receipt.js';
import { normalizeSafeProjectRelativePath } from '../domain/path-normalization.js';
import { readProjectFileText } from '../platform/project-files.js';
import { createObligationAdmissionFile } from '../storage/autonomous-work-obligations.js';
import {
  createGoalRecordFile,
  createIntendedChangeRecordFile,
  readGoalRecordFile,
  readIntendedChangeRecordFile,
  type WorkStateCreateResult,
  type WorkStateCreateOptions,
} from '../storage/autonomous-work-state.js';
import { createPlanContractRecordFile, readPlanContractRecordFile } from '../storage/plan-contract.js';

export interface ApplyPlanContractOptions {
  collaborationDomainId: string;
  toolVersion: string;
  captureObservation: () => ObservationReceiptV2;
  now?: () => string;
  createOptions?: Pick<WorkStateCreateOptions, 'atomicRuntime'>;
}

/**
 * Compile one readable plan into durable work state. Validation and reference
 * checks finish before publication. Derived obligations publish before the
 * plan tip, so a crash can leave conservative work but never a current plan
 * whose required obligations were not attempted; retry is idempotent.
 */
export function applyPlanContract(projectRoot: string, planPath: string, options: ApplyPlanContractOptions) {
  const relativePath = normalizeSafeProjectRelativePath(planPath);
  const markdown = readProjectFileText(projectRoot, relativePath);
  const decoded = extractPlanContractInput(markdown);
  if (!decoded.ok) throw new Error(decoded.error);

  const source = {
    path: relativePath,
    sha256: createHash('sha256').update(markdown).digest('hex'),
  };
  const compiledAgainst = options.captureObservation();
  const createdAt = (options.now ?? (() => new Date().toISOString()))();
  const createOptions: WorkStateCreateOptions = {
    toolVersion: options.toolVersion,
    now: () => createdAt,
    ...(options.createOptions?.atomicRuntime ? { atomicRuntime: options.createOptions.atomicRuntime } : {}),
  };
  const resolved = resolvePlanContractInput(
    projectRoot,
    options.collaborationDomainId,
    decoded.request,
    createdAt,
    options.toolVersion,
  );
  const preview = createPlanContractRecord({
    collaborationDomainId: options.collaborationDomainId,
    request: resolved.request,
    source,
    compiledAgainst,
    createdAt,
    toolVersion: options.toolVersion,
  });
  const previous = readPlanContractRecordFile(projectRoot, preview.planId);
  const obligationSource =
    previous.state === 'current' &&
    planContractRequestMatchesRecord(
      options.collaborationDomainId,
      resolved.request,
      source,
      compiledAgainst,
      previous.record,
    )
      ? previous.record
      : preview;
  const obligations: WorkStateCreateResult<ObligationAdmissionRecordV1>[] = [];
  const goal = resolved.initial
    ? createGoalRecordFile(projectRoot, options.collaborationDomainId, resolved.initial.goal, createOptions)
    : undefined;
  const change = resolved.initial
    ? createIntendedChangeRecordFile(projectRoot, options.collaborationDomainId, resolved.initial.change, createOptions)
    : undefined;
  for (const request of planContractObligationRequests(obligationSource)) {
    obligations.push(createObligationAdmissionFile(projectRoot, options.collaborationDomainId, request, createOptions));
  }
  const plan = createPlanContractRecordFile(
    projectRoot,
    options.collaborationDomainId,
    resolved.request,
    source,
    obligationSource.compiledAgainst,
    createOptions,
  );
  return { ...(goal ? { goal } : {}), ...(change ? { change } : {}), plan, obligations };
}

function resolvePlanContractInput(
  projectRoot: string,
  collaborationDomainId: string,
  input: PlanContractInput,
  createdAt: string,
  toolVersion: string,
): {
  request: PlanContractRequest;
  initial?: { goal: GoalCreateRequest; change: IntendedChangeCreateRequest };
} {
  if (typeof input.goalId === 'string' && typeof input.changeId === 'string') {
    assertReferences(projectRoot, collaborationDomainId, input);
    return { request: input };
  }
  const goal = createGoalRecord({
    collaborationDomainId,
    request: input.goal,
    createdAt,
    toolVersion,
  });
  const changeRequest: IntendedChangeCreateRequest = {
    goalId: goal.goalId,
    idempotencyKey: input.change.idempotencyKey,
    title: input.change.title,
    intendedOutcome: input.change.intendedOutcome,
  };
  const change = createIntendedChangeRecord({
    collaborationDomainId,
    request: changeRequest,
    createdAt,
    toolVersion,
  });
  const { goal: _goal, change: _change, ...body } = input;
  const request: PlanContractRequest = {
    ...body,
    goalId: goal.goalId,
    changeId: change.changeId,
  };
  assertPredecessorReference(projectRoot, collaborationDomainId, request);
  return { request, initial: { goal: input.goal, change: changeRequest } };
}

function assertReferences(projectRoot: string, collaborationDomainId: string, request: PlanContractRequest): void {
  const goal = readGoalRecordFile(projectRoot, request.goalId);
  if (goal.state !== 'current') throw new Error(`goal ${request.goalId} is not a readable current record`);
  const change = readIntendedChangeRecordFile(projectRoot, request.changeId);
  if (change.state !== 'current')
    throw new Error(`intended change ${request.changeId} is not a readable current record`);
  if (
    goal.record.collaborationDomainId !== collaborationDomainId ||
    change.record.collaborationDomainId !== collaborationDomainId
  ) {
    throw new Error('plan goal or intended change belongs to another collaboration domain');
  }
  if (change.record.goalId !== request.goalId) {
    throw new Error(`plan goal ${request.goalId} does not govern intended change ${request.changeId}`);
  }
  assertPredecessorReference(projectRoot, collaborationDomainId, request);
}

function assertPredecessorReference(
  projectRoot: string,
  collaborationDomainId: string,
  request: PlanContractRequest,
): void {
  if (!request.predecessorPlanId) return;
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
