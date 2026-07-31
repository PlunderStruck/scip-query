import { join } from 'node:path';

import {
  createCompletenessAdmissionRecord,
  decodeCompletenessAdmissionRecord,
  isCompletenessAdmissionId,
  type CompletenessAdmissionDecision,
  type CompletenessAdmissionRecordV1,
} from '../domain/completeness-obligation-admission.js';
import {
  createObligationAdmission,
  type ObligationAdmissionRecordV1,
  type ObligationAdmissionRequest,
} from '../domain/autonomous-work-obligations.js';
import { stableJson } from '../domain/stable-json.js';
import {
  createObligationAdmissionFile,
  readObligationAdmissionRecordFile,
  readObligationLifecycle,
} from './autonomous-work-obligations.js';
import {
  parseRecordFile,
  publishWorkStateRecord,
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

export const COMPLETENESS_ADMISSIONS_DIR = join('.scipquery', 'completeness-admissions');

export interface CompletenessAdmissionCreateResult {
  observation: WorkStateCreateResult<CompletenessAdmissionRecordV1>;
  obligation?: {
    obligationId: string;
    publication: 'created' | 'existing';
  };
}

export interface CompletenessAdmissionCollectionReadResult extends WorkStateCollectionReadResult<CompletenessAdmissionRecordV1> {
  integrityIssues: string[];
}

/**
 * Persist every admission decision, including advisory evidence. An admitted
 * decision publishes or reuses its stable obligation before publishing the
 * observation, so a crash can conservatively leave required work live but
 * cannot leave an "admit" fact without the requirement it names.
 */
export function recordCompletenessAdmissionDecision(
  projectRoot: string,
  collaborationDomainId: string,
  decision: CompletenessAdmissionDecision,
  options: WorkStateCreateOptions,
): CompletenessAdmissionCreateResult {
  requireIntendedChangeRecord(projectRoot, collaborationDomainId, decision.observation.changeId);
  const createdAt = (options.now ?? workStateNow)();
  const fixedOptions = { ...options, now: () => createdAt };
  const obligation =
    decision.disposition === 'admit'
      ? ensureCompletenessObligation(
          projectRoot,
          collaborationDomainId,
          decision.obligationRequest,
          createdAt,
          fixedOptions,
        )
      : undefined;
  const record = createCompletenessAdmissionRecord({
    collaborationDomainId,
    decision,
    ...(obligation ? { obligationId: obligation.obligationId } : {}),
    createdAt,
    toolVersion: options.toolVersion,
  });
  const observation = publishWorkStateRecord(
    projectRoot,
    {
      relativeDirectory: COMPLETENESS_ADMISSIONS_DIR,
      identity: record.admissionRecordId,
      record,
      readExisting: () => readCompletenessAdmissionRecordFile(projectRoot, record.admissionRecordId),
      matchesExisting: (existing) => existing.admissionRecordId === record.admissionRecordId,
      collisionMessage: (relativePath) =>
        `completeness admission identity collision at ${relativePath}: the same identity names different evidence`,
    },
    fixedOptions,
  );
  return { observation, ...(obligation ? { obligation } : {}) };
}

export function readCompletenessAdmissionRecordFile(
  projectRoot: string,
  admissionRecordId: string,
): WorkStateRecordReadResult<CompletenessAdmissionRecordV1> {
  if (!isCompletenessAdmissionId(admissionRecordId)) {
    throw new Error(`invalid completeness-admission identity: ${admissionRecordId}`);
  }
  return readRecordFile(
    projectRoot,
    join(COMPLETENESS_ADMISSIONS_DIR, `${admissionRecordId}.json`),
    decodeCompletenessAdmissionRecord,
  );
}

export function readCompletenessAdmissionRecordPath(path: string) {
  return parseRecordFile(path, 'completeness admission record', decodeCompletenessAdmissionRecord);
}

export function readCompletenessAdmissionRecords(projectRoot: string): CompletenessAdmissionCollectionReadResult {
  const result = readRecordDirectory(
    projectRoot,
    COMPLETENESS_ADMISSIONS_DIR,
    'completeness admission record',
    decodeCompletenessAdmissionRecord,
    (record) => record.admissionRecordId,
  );
  const changes = readIntendedChangeRecords(projectRoot);
  const changesById = new Map(changes.records.map((change) => [change.changeId, change]));
  const lifecycle = readObligationLifecycle(projectRoot);
  const obligationsById = new Map(
    lifecycle.summary.obligations.map((state) => [state.obligation.obligationId, state.obligation]),
  );
  const integrityIssues = result.records.flatMap((record) => {
    const issues: string[] = [];
    const change = changesById.get(record.changeId);
    if (!change) {
      issues.push(`${record.admissionRecordId} references missing intended change ${record.changeId}`);
    } else if (change.collaborationDomainId !== record.collaborationDomainId) {
      issues.push(`${record.admissionRecordId} belongs to another collaboration domain than its change`);
    }
    if (record.disposition !== 'admit') return issues;
    const obligation = record.obligationId ? obligationsById.get(record.obligationId) : undefined;
    if (!obligation) {
      issues.push(`${record.admissionRecordId} references missing obligation ${String(record.obligationId)}`);
      return issues;
    }
    if (obligation.collaborationDomainId !== record.collaborationDomainId || obligation.changeId !== record.changeId) {
      issues.push(`${record.admissionRecordId} does not match its obligation's collaboration domain and change`);
    }
    if (
      obligation.source.kind !== 'detector-finding' ||
      obligation.source.check !== record.candidate.check ||
      obligation.source.findingId !== record.candidate.findingId
    ) {
      issues.push(`${record.admissionRecordId} does not match its obligation's detector source`);
    }
    return issues;
  });
  return {
    ...result,
    integrityIssues: [
      ...new Set([...changes.integrityIssues, ...lifecycle.integrityIssues, ...integrityIssues]),
    ].sort(),
  };
}

function ensureCompletenessObligation(
  projectRoot: string,
  collaborationDomainId: string,
  request: ObligationAdmissionRequest,
  createdAt: string,
  options: WorkStateCreateOptions,
): NonNullable<CompletenessAdmissionCreateResult['obligation']> {
  const candidate = createObligationAdmission({
    collaborationDomainId,
    request,
    createdAt,
    toolVersion: options.toolVersion,
  });
  const existing = readObligationAdmissionRecordFile(projectRoot, candidate.obligationId);
  if (existing.state === 'current') {
    if (!sameObligationRequirement(existing.record, candidate)) {
      throw new Error(
        `completeness policy collision at ${existing.path}: stable finding identity now names a different requirement`,
      );
    }
    return { obligationId: existing.record.obligationId, publication: 'existing' };
  }
  if (existing.state !== 'missing') {
    throw new Error(`cannot reuse unreadable completeness obligation at ${existing.path}: ${existing.error}`);
  }
  const created = createObligationAdmissionFile(projectRoot, collaborationDomainId, request, options);
  return { obligationId: created.record.obligationId, publication: created.publication };
}

function sameObligationRequirement(left: ObligationAdmissionRecordV1, right: ObligationAdmissionRecordV1): boolean {
  return (
    left.collaborationDomainId === right.collaborationDomainId &&
    left.changeId === right.changeId &&
    left.idempotency.keyDigest === right.idempotency.keyDigest &&
    stableJson({
      category: left.category,
      title: left.title,
      requiredCondition: left.requiredCondition,
      source: left.source,
      basisAttemptIds: left.basisAttemptIds,
    }) ===
      stableJson({
        category: right.category,
        title: right.title,
        requiredCondition: right.requiredCondition,
        source: right.source,
        basisAttemptIds: right.basisAttemptIds,
      })
  );
}
