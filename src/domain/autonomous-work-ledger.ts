import { decodeObservationReceipt, type ObservationReceiptV2 } from './observation-receipt.js';
import { isRecordObject, isValidRecordTimestamp } from './record-validation.js';
import { stableJson } from './stable-json.js';
import {
  hashIdentity,
  isCollaborationDomainId,
  isIntendedChangeId,
  isSha256,
  isWorkStateWriter,
  normalizedBoundedLine,
  recordVersion,
  unsupportedVersion,
  WORK_STATE_IDENTITY_ALGORITHM,
  type WorkStateDecodeResult,
  type WorkStateWriter,
} from './autonomous-work-state.js';

export const ATTEMPT_RECORD_KIND = 'scip-query-attempt' as const;
export const ATTEMPT_RECORD_SCHEMA_VERSION = 1 as const;
export const DECISION_RECORD_KIND = 'scip-query-decision' as const;
export const DECISION_RECORD_SCHEMA_VERSION = 1 as const;
export const WORK_EVENT_IDEMPOTENCY_VERSION = 1 as const;

const ATTEMPT_ID_PATTERN = /^SQA-[A-F0-9]{32}$/u;
const DECISION_ID_PATTERN = /^SQD-[A-F0-9]{32}$/u;
const MAX_EVIDENCE_RECEIPTS = 16;
const MAX_BASIS_ATTEMPTS = 32;
const MAX_CONDITION_CHARACTERS = 1_000;
const MAX_ACTION_FAMILY_CHARACTERS = 120;
const MAX_ACTION_SUMMARY_CHARACTERS = 1_000;
const MAX_EFFECT_CHARACTERS = 1_000;
const MAX_RATIONALE_CHARACTERS = 1_000;
const MAX_NEXT_ACTION_CHARACTERS = 1_000;

export type AttemptOutcome = 'succeeded' | 'failed' | 'unknown';
export type ActionEffectClass = 'read-only' | 'idempotent-write' | 'non-idempotent-write';
export type DecisionDisposition =
  | 'continue'
  | 'retry-safe'
  | 'change-strategy'
  | 'reconcile-unknown'
  | 'completion-candidate'
  | 'abandon';

export interface AttemptAction {
  family: string;
  summary: string;
  effectClass: ActionEffectClass;
}

export interface WorkEventIdempotency {
  version: typeof WORK_EVENT_IDEMPOTENCY_VERSION;
  algorithm: typeof WORK_STATE_IDENTITY_ALGORITHM;
  keyDigest: string;
  requestDigest: string;
}

/**
 * One attempt record preserves one purposeful action and the effect observed
 * after it. A reconciliation attempt observes an earlier unknown effect; it
 * does not rewrite or silently reinterpret the original attempt.
 */
export interface AttemptRecordV1 {
  kind: typeof ATTEMPT_RECORD_KIND;
  schemaVersion: typeof ATTEMPT_RECORD_SCHEMA_VERSION;
  attemptId: string;
  collaborationDomainId: string;
  changeId: string;
  intendedCondition: string;
  action: AttemptAction;
  evidenceReceipts: readonly ObservationReceiptV2[];
  observedEffect: string;
  outcome: AttemptOutcome;
  reconcilesAttemptId?: string;
  idempotency: WorkEventIdempotency;
  createdAt: string;
  writer: WorkStateWriter;
}

export interface AttemptCreateRequest {
  changeId: string;
  idempotencyKey: string;
  intendedCondition: string;
  action: AttemptAction;
  evidenceReceipts: readonly ObservationReceiptV2[];
  observedEffect: string;
  outcome: AttemptOutcome;
  reconcilesAttemptId?: string;
}

/**
 * One decision record preserves the conclusion that follows from a set of
 * attempts and evidence. It names the next action without mutating the
 * attempts that supplied its basis.
 */
export interface DecisionRecordV1 {
  kind: typeof DECISION_RECORD_KIND;
  schemaVersion: typeof DECISION_RECORD_SCHEMA_VERSION;
  decisionId: string;
  collaborationDomainId: string;
  changeId: string;
  basisAttemptIds: readonly string[];
  evidenceReceipts: readonly ObservationReceiptV2[];
  disposition: DecisionDisposition;
  rationale: string;
  nextAction?: string;
  idempotency: WorkEventIdempotency;
  createdAt: string;
  writer: WorkStateWriter;
}

export interface DecisionCreateRequest {
  changeId: string;
  idempotencyKey: string;
  basisAttemptIds: readonly string[];
  evidenceReceipts: readonly ObservationReceiptV2[];
  disposition: DecisionDisposition;
  rationale: string;
  nextAction?: string;
}

export interface CreateAttemptRecordInput {
  collaborationDomainId: string;
  request: AttemptCreateRequest;
  createdAt: string;
  toolVersion: string;
}

export interface CreateDecisionRecordInput {
  collaborationDomainId: string;
  request: DecisionCreateRequest;
  createdAt: string;
  toolVersion: string;
}

export interface AttemptReconciliation {
  attemptId: string;
  reconciliationAttemptId: string;
  outcome: Exclude<AttemptOutcome, 'unknown'>;
}

/**
 * The current work summary is a deterministic projection of immutable
 * records. Unknown non-idempotent effects stay unsafe to repeat until a later
 * observation-backed attempt reconciles them.
 */
export interface WorkHistorySummary {
  attempts: readonly AttemptRecordV1[];
  decisions: readonly DecisionRecordV1[];
  reconciliations: readonly AttemptReconciliation[];
  unresolvedUnknownAttemptIds: readonly string[];
  unsafeToRepeatAttemptIds: readonly string[];
  reconciliationConflicts: readonly string[];
  latestDecision?: DecisionRecordV1;
}

export type WorkLedgerRequestDecodeResult<RequestType> =
  | { ok: true; request: RequestType }
  | { ok: false; error: string };

export function decodeAttemptCreateRequest(value: unknown): WorkLedgerRequestDecodeResult<AttemptCreateRequest> {
  if (!isRecordObject(value)) return { ok: false, error: 'attempt create request must be an object' };
  if (!isIntendedChangeId(value['changeId'])) {
    return { ok: false, error: 'changeId must be an intended-change identity' };
  }
  const idempotencyKey = normalizedBoundedLine(value['idempotencyKey'], 256);
  if (!idempotencyKey) {
    return { ok: false, error: 'idempotencyKey must be a non-empty line of at most 256 characters' };
  }
  const intendedCondition = normalizedBoundedLine(value['intendedCondition'], MAX_CONDITION_CHARACTERS);
  if (!intendedCondition) return { ok: false, error: 'intendedCondition must be canonical bounded text' };
  const action = decodeAttemptAction(value['action']);
  if (!action.ok) return action;
  const evidenceReceipts = decodeEvidenceReceipts(value['evidenceReceipts']);
  if (!evidenceReceipts.ok) return evidenceReceipts;
  const observedEffect = normalizedBoundedLine(value['observedEffect'], MAX_EFFECT_CHARACTERS);
  if (!observedEffect) return { ok: false, error: 'observedEffect must be canonical bounded text' };
  if (!isAttemptOutcome(value['outcome'])) {
    return { ok: false, error: 'outcome must be succeeded, failed, or unknown' };
  }
  const reconcilesAttemptId = value['reconcilesAttemptId'];
  if (reconcilesAttemptId !== undefined && !isAttemptId(reconcilesAttemptId)) {
    return { ok: false, error: 'reconcilesAttemptId must be an attempt identity' };
  }
  if (reconcilesAttemptId !== undefined && value['outcome'] === 'unknown') {
    return { ok: false, error: 'a reconciliation attempt must establish succeeded or failed' };
  }
  if (reconcilesAttemptId !== undefined && evidenceReceipts.receipts.length === 0) {
    return { ok: false, error: 'a reconciliation attempt requires a supported observation receipt' };
  }
  return {
    ok: true,
    request: {
      changeId: value['changeId'],
      idempotencyKey,
      intendedCondition,
      action: action.action,
      evidenceReceipts: evidenceReceipts.receipts,
      observedEffect,
      outcome: value['outcome'],
      ...(typeof reconcilesAttemptId === 'string' ? { reconcilesAttemptId } : {}),
    },
  };
}

export function decodeDecisionCreateRequest(value: unknown): WorkLedgerRequestDecodeResult<DecisionCreateRequest> {
  if (!isRecordObject(value)) return { ok: false, error: 'decision create request must be an object' };
  if (!isIntendedChangeId(value['changeId'])) {
    return { ok: false, error: 'changeId must be an intended-change identity' };
  }
  const idempotencyKey = normalizedBoundedLine(value['idempotencyKey'], 256);
  if (!idempotencyKey) {
    return { ok: false, error: 'idempotencyKey must be a non-empty line of at most 256 characters' };
  }
  const basisAttemptIds = decodeAttemptIds(value['basisAttemptIds']);
  if (!basisAttemptIds.ok) return basisAttemptIds;
  const evidenceReceipts = decodeEvidenceReceipts(value['evidenceReceipts']);
  if (!evidenceReceipts.ok) return evidenceReceipts;
  if (!isDecisionDisposition(value['disposition'])) {
    return { ok: false, error: 'disposition is not a supported autonomous decision' };
  }
  const rationale = normalizedBoundedLine(value['rationale'], MAX_RATIONALE_CHARACTERS);
  if (!rationale) return { ok: false, error: 'rationale must be canonical bounded text' };
  const nextActionValue = value['nextAction'];
  const nextAction =
    nextActionValue === undefined ? undefined : normalizedBoundedLine(nextActionValue, MAX_NEXT_ACTION_CHARACTERS);
  if (nextActionValue !== undefined && !nextAction) {
    return { ok: false, error: 'nextAction must be canonical bounded text when present' };
  }
  return {
    ok: true,
    request: {
      changeId: value['changeId'],
      idempotencyKey,
      basisAttemptIds: basisAttemptIds.attemptIds,
      evidenceReceipts: evidenceReceipts.receipts,
      disposition: value['disposition'],
      rationale,
      ...(nextAction ? { nextAction } : {}),
    },
  };
}

export function createAttemptRecord(input: CreateAttemptRecordInput): AttemptRecordV1 {
  assertRecordInput(input.collaborationDomainId, input.createdAt, input.toolVersion);
  const decoded = decodeAttemptCreateRequest(input.request);
  if (!decoded.ok) throw new Error(decoded.error);
  const keyDigest = workEventKeyDigest(
    input.collaborationDomainId,
    decoded.request.changeId,
    decoded.request.idempotencyKey,
    'attempt',
  );
  const requestDigest = attemptRequestDigest(input.collaborationDomainId, decoded.request);
  const attemptId = attemptIdFromDigest(keyDigest);
  if (decoded.request.reconcilesAttemptId === attemptId) {
    throw new Error('an attempt cannot reconcile itself');
  }
  return {
    kind: ATTEMPT_RECORD_KIND,
    schemaVersion: ATTEMPT_RECORD_SCHEMA_VERSION,
    attemptId,
    collaborationDomainId: input.collaborationDomainId,
    changeId: decoded.request.changeId,
    intendedCondition: decoded.request.intendedCondition,
    action: decoded.request.action,
    evidenceReceipts: decoded.request.evidenceReceipts,
    observedEffect: decoded.request.observedEffect,
    outcome: decoded.request.outcome,
    ...(decoded.request.reconcilesAttemptId ? { reconcilesAttemptId: decoded.request.reconcilesAttemptId } : {}),
    idempotency: workEventIdempotency(keyDigest, requestDigest),
    createdAt: input.createdAt,
    writer: { tool: 'scip-query', version: input.toolVersion },
  };
}

export function createDecisionRecord(input: CreateDecisionRecordInput): DecisionRecordV1 {
  assertRecordInput(input.collaborationDomainId, input.createdAt, input.toolVersion);
  const decoded = decodeDecisionCreateRequest(input.request);
  if (!decoded.ok) throw new Error(decoded.error);
  const keyDigest = workEventKeyDigest(
    input.collaborationDomainId,
    decoded.request.changeId,
    decoded.request.idempotencyKey,
    'decision',
  );
  return {
    kind: DECISION_RECORD_KIND,
    schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    decisionId: decisionIdFromDigest(keyDigest),
    collaborationDomainId: input.collaborationDomainId,
    changeId: decoded.request.changeId,
    basisAttemptIds: decoded.request.basisAttemptIds,
    evidenceReceipts: decoded.request.evidenceReceipts,
    disposition: decoded.request.disposition,
    rationale: decoded.request.rationale,
    ...(decoded.request.nextAction ? { nextAction: decoded.request.nextAction } : {}),
    idempotency: workEventIdempotency(keyDigest, decisionRequestDigest(input.collaborationDomainId, decoded.request)),
    createdAt: input.createdAt,
    writer: { tool: 'scip-query', version: input.toolVersion },
  };
}

export function decodeAttemptRecord(value: unknown): WorkStateDecodeResult<AttemptRecordV1> {
  const version = recordVersion(value, ATTEMPT_RECORD_KIND);
  if (!version.ok) return version.result;
  if (version.version !== ATTEMPT_RECORD_SCHEMA_VERSION) {
    return unsupportedVersion(version.version, ATTEMPT_RECORD_SCHEMA_VERSION, 'attempt');
  }
  if (!isRecordObject(value)) return { state: 'malformed', error: 'attempt record must be an object' };
  const decoded = decodeAttemptCreateRequest({
    changeId: value['changeId'],
    idempotencyKey: 'record-key-placeholder',
    intendedCondition: value['intendedCondition'],
    action: value['action'],
    evidenceReceipts: value['evidenceReceipts'],
    observedEffect: value['observedEffect'],
    outcome: value['outcome'],
    ...(value['reconcilesAttemptId'] !== undefined ? { reconcilesAttemptId: value['reconcilesAttemptId'] } : {}),
  });
  if (!decoded.ok) return { state: 'malformed', error: decoded.error };
  if (!attemptFieldsAreCanonical(value, decoded.request)) {
    return { state: 'malformed', error: 'attempt fields must use canonical bounded values and ordering' };
  }
  if (!isAttemptId(value['attemptId'])) return { state: 'malformed', error: 'attemptId must be an attempt identity' };
  if (!isCollaborationDomainId(value['collaborationDomainId'])) {
    return { state: 'malformed', error: 'collaborationDomainId must be a version-4 UUID' };
  }
  const idempotency = decodeIdempotency(value['idempotency']);
  if (!idempotency.ok) return { state: 'malformed', error: idempotency.error };
  if (value['attemptId'] !== attemptIdFromDigest(idempotency.value.keyDigest)) {
    return { state: 'malformed', error: 'attemptId does not match the idempotency key digest' };
  }
  const expectedDigest = attemptRequestDigest(value['collaborationDomainId'], decoded.request);
  if (idempotency.value.requestDigest !== expectedDigest) {
    return { state: 'malformed', error: 'requestDigest does not match the attempt meaning' };
  }
  const metadata = decodeRecordMetadata(value);
  if (!metadata.ok) return metadata.result;
  const record: AttemptRecordV1 = {
    kind: ATTEMPT_RECORD_KIND,
    schemaVersion: ATTEMPT_RECORD_SCHEMA_VERSION,
    attemptId: value['attemptId'],
    collaborationDomainId: value['collaborationDomainId'],
    changeId: decoded.request.changeId,
    intendedCondition: decoded.request.intendedCondition,
    action: decoded.request.action,
    evidenceReceipts: decoded.request.evidenceReceipts,
    observedEffect: decoded.request.observedEffect,
    outcome: decoded.request.outcome,
    ...(decoded.request.reconcilesAttemptId ? { reconcilesAttemptId: decoded.request.reconcilesAttemptId } : {}),
    idempotency: idempotency.value,
    createdAt: metadata.createdAt,
    writer: metadata.writer,
  };
  if (record.reconcilesAttemptId === record.attemptId) {
    return { state: 'malformed', error: 'attempt cannot reconcile itself' };
  }
  return { state: 'current', record };
}

export function decodeDecisionRecord(value: unknown): WorkStateDecodeResult<DecisionRecordV1> {
  const version = recordVersion(value, DECISION_RECORD_KIND);
  if (!version.ok) return version.result;
  if (version.version !== DECISION_RECORD_SCHEMA_VERSION) {
    return unsupportedVersion(version.version, DECISION_RECORD_SCHEMA_VERSION, 'decision');
  }
  if (!isRecordObject(value)) return { state: 'malformed', error: 'decision record must be an object' };
  const decoded = decodeDecisionCreateRequest({
    changeId: value['changeId'],
    idempotencyKey: 'record-key-placeholder',
    basisAttemptIds: value['basisAttemptIds'],
    evidenceReceipts: value['evidenceReceipts'],
    disposition: value['disposition'],
    rationale: value['rationale'],
    ...(value['nextAction'] !== undefined ? { nextAction: value['nextAction'] } : {}),
  });
  if (!decoded.ok) return { state: 'malformed', error: decoded.error };
  if (!decisionFieldsAreCanonical(value, decoded.request)) {
    return { state: 'malformed', error: 'decision fields must use canonical bounded values and ordering' };
  }
  if (!isDecisionId(value['decisionId'])) {
    return { state: 'malformed', error: 'decisionId must be a decision identity' };
  }
  if (!isCollaborationDomainId(value['collaborationDomainId'])) {
    return { state: 'malformed', error: 'collaborationDomainId must be a version-4 UUID' };
  }
  const idempotency = decodeIdempotency(value['idempotency']);
  if (!idempotency.ok) return { state: 'malformed', error: idempotency.error };
  if (value['decisionId'] !== decisionIdFromDigest(idempotency.value.keyDigest)) {
    return { state: 'malformed', error: 'decisionId does not match the idempotency key digest' };
  }
  const expectedDigest = decisionRequestDigest(value['collaborationDomainId'], decoded.request);
  if (idempotency.value.requestDigest !== expectedDigest) {
    return { state: 'malformed', error: 'requestDigest does not match the decision meaning' };
  }
  const metadata = decodeRecordMetadata(value);
  if (!metadata.ok) return metadata.result;
  return {
    state: 'current',
    record: {
      kind: DECISION_RECORD_KIND,
      schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
      decisionId: value['decisionId'],
      collaborationDomainId: value['collaborationDomainId'],
      changeId: decoded.request.changeId,
      basisAttemptIds: decoded.request.basisAttemptIds,
      evidenceReceipts: decoded.request.evidenceReceipts,
      disposition: decoded.request.disposition,
      rationale: decoded.request.rationale,
      ...(decoded.request.nextAction ? { nextAction: decoded.request.nextAction } : {}),
      idempotency: idempotency.value,
      createdAt: metadata.createdAt,
      writer: metadata.writer,
    },
  };
}

export function attemptRequestMatchesRecord(
  collaborationDomainId: string,
  request: AttemptCreateRequest,
  record: AttemptRecordV1,
): boolean {
  const decoded = decodeAttemptCreateRequest(request);
  return (
    decoded.ok &&
    record.collaborationDomainId === collaborationDomainId &&
    record.idempotency.requestDigest === attemptRequestDigest(collaborationDomainId, decoded.request)
  );
}

export function decisionRequestMatchesRecord(
  collaborationDomainId: string,
  request: DecisionCreateRequest,
  record: DecisionRecordV1,
): boolean {
  const decoded = decodeDecisionCreateRequest(request);
  return (
    decoded.ok &&
    record.collaborationDomainId === collaborationDomainId &&
    record.idempotency.requestDigest === decisionRequestDigest(collaborationDomainId, decoded.request)
  );
}

export function foldWorkHistory(
  attemptsInput: readonly AttemptRecordV1[],
  decisionsInput: readonly DecisionRecordV1[],
): WorkHistorySummary {
  const attempts = [...attemptsInput].sort(compareAttemptRecords);
  const decisions = [...decisionsInput].sort(compareDecisionRecords);
  const attemptsById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  const reconciliationCandidates = new Map<string, AttemptRecordV1[]>();
  for (const attempt of attempts) {
    if (!attempt.reconcilesAttemptId) continue;
    const original = attemptsById.get(attempt.reconcilesAttemptId);
    if (
      original?.outcome !== 'unknown' ||
      attempt.outcome === 'unknown' ||
      !hasObservationAtOrAfter(attempt.evidenceReceipts, original.createdAt)
    ) {
      continue;
    }
    const candidates = reconciliationCandidates.get(original.attemptId) ?? [];
    candidates.push(attempt);
    reconciliationCandidates.set(original.attemptId, candidates);
  }
  const reconciliations: AttemptReconciliation[] = [];
  const reconciliationConflicts: string[] = [];
  for (const [attemptId, candidates] of [...reconciliationCandidates].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const outcomes = new Set(candidates.map((candidate) => candidate.outcome));
    if (outcomes.size > 1) {
      reconciliationConflicts.push(
        `${attemptId} has conflicting reconciliation outcomes from ${candidates.map((candidate) => candidate.attemptId).join(', ')}`,
      );
      continue;
    }
    const selected = [...candidates].sort(compareAttemptRecords).at(-1);
    if (!selected || selected.outcome === 'unknown') continue;
    reconciliations.push({
      attemptId,
      reconciliationAttemptId: selected.attemptId,
      outcome: selected.outcome,
    });
  }
  const resolvedIds = new Set(reconciliations.map((reconciliation) => reconciliation.attemptId));
  const unresolvedUnknown = attempts.filter(
    (attempt) => attempt.outcome === 'unknown' && !resolvedIds.has(attempt.attemptId),
  );
  return {
    attempts,
    decisions,
    reconciliations,
    unresolvedUnknownAttemptIds: unresolvedUnknown.map((attempt) => attempt.attemptId),
    unsafeToRepeatAttemptIds: unresolvedUnknown
      .filter((attempt) => attempt.action.effectClass === 'non-idempotent-write')
      .map((attempt) => attempt.attemptId),
    reconciliationConflicts,
    ...(decisions.length > 0 ? { latestDecision: decisions.at(-1) } : {}),
  };
}

export function isAttemptId(value: unknown): value is string {
  return typeof value === 'string' && ATTEMPT_ID_PATTERN.test(value);
}

export function isDecisionId(value: unknown): value is string {
  return typeof value === 'string' && DECISION_ID_PATTERN.test(value);
}

function decodeAttemptAction(value: unknown): { ok: true; action: AttemptAction } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'action must be an object' };
  const family = normalizedBoundedLine(value['family'], MAX_ACTION_FAMILY_CHARACTERS);
  const summary = normalizedBoundedLine(value['summary'], MAX_ACTION_SUMMARY_CHARACTERS);
  if (!family || !summary) return { ok: false, error: 'action family and summary must be canonical bounded text' };
  if (!isActionEffectClass(value['effectClass'])) {
    return { ok: false, error: 'action effectClass must be read-only, idempotent-write, or non-idempotent-write' };
  }
  return { ok: true, action: { family, summary, effectClass: value['effectClass'] } };
}

function decodeEvidenceReceipts(
  value: unknown,
): { ok: true; receipts: ObservationReceiptV2[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_RECEIPTS) {
    return { ok: false, error: `evidenceReceipts must contain at most ${MAX_EVIDENCE_RECEIPTS} receipts` };
  }
  const byMeaning = new Map<string, ObservationReceiptV2>();
  for (const [index, candidate] of value.entries()) {
    const decoded = decodeObservationReceipt(candidate);
    if (decoded.kind !== 'supported') {
      return { ok: false, error: `evidenceReceipts[${index}] must be a supported version-2 receipt` };
    }
    byMeaning.set(stableJson(decoded.receipt), decoded.receipt);
  }
  return {
    ok: true,
    receipts: [...byMeaning].sort(([left], [right]) => left.localeCompare(right)).map(([, receipt]) => receipt),
  };
}

function decodeAttemptIds(value: unknown): { ok: true; attemptIds: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BASIS_ATTEMPTS) {
    return { ok: false, error: `basisAttemptIds must contain 1-${MAX_BASIS_ATTEMPTS} attempt identities` };
  }
  if (value.some((attemptId) => !isAttemptId(attemptId))) {
    return { ok: false, error: 'basisAttemptIds must contain only attempt identities' };
  }
  return { ok: true, attemptIds: [...new Set(value as string[])].sort() };
}

function decodeIdempotency(value: unknown): { ok: true; value: WorkEventIdempotency } | { ok: false; error: string } {
  if (
    !isRecordObject(value) ||
    value['version'] !== WORK_EVENT_IDEMPOTENCY_VERSION ||
    value['algorithm'] !== WORK_STATE_IDENTITY_ALGORITHM ||
    !isSha256(value['keyDigest']) ||
    !isSha256(value['requestDigest'])
  ) {
    return { ok: false, error: 'invalid work-event idempotency metadata' };
  }
  return {
    ok: true,
    value: {
      version: WORK_EVENT_IDEMPOTENCY_VERSION,
      algorithm: WORK_STATE_IDENTITY_ALGORITHM,
      keyDigest: value['keyDigest'],
      requestDigest: value['requestDigest'],
    },
  };
}

function attemptFieldsAreCanonical(value: Readonly<Record<string, unknown>>, request: AttemptCreateRequest): boolean {
  return (
    value['changeId'] === request.changeId &&
    value['intendedCondition'] === request.intendedCondition &&
    stableJson(value['action']) === stableJson(request.action) &&
    stableJson(value['evidenceReceipts']) === stableJson(request.evidenceReceipts) &&
    value['observedEffect'] === request.observedEffect &&
    value['outcome'] === request.outcome &&
    value['reconcilesAttemptId'] === request.reconcilesAttemptId
  );
}

function decisionFieldsAreCanonical(value: Readonly<Record<string, unknown>>, request: DecisionCreateRequest): boolean {
  return (
    value['changeId'] === request.changeId &&
    stableJson(value['basisAttemptIds']) === stableJson(request.basisAttemptIds) &&
    stableJson(value['evidenceReceipts']) === stableJson(request.evidenceReceipts) &&
    value['disposition'] === request.disposition &&
    value['rationale'] === request.rationale &&
    value['nextAction'] === request.nextAction
  );
}

function decodeRecordMetadata(
  value: Record<string, unknown>,
): { ok: true; createdAt: string; writer: WorkStateWriter } | { ok: false; result: WorkStateDecodeResult<never> } {
  if (!isValidRecordTimestamp(value['createdAt'])) {
    return { ok: false, result: { state: 'malformed', error: 'invalid createdAt timestamp' } };
  }
  if (!isWorkStateWriter(value['writer'])) {
    return { ok: false, result: { state: 'malformed', error: 'invalid writer metadata' } };
  }
  return { ok: true, createdAt: value['createdAt'], writer: value['writer'] };
}

function attemptRequestDigest(collaborationDomainId: string, request: AttemptCreateRequest): string {
  return hashIdentity({
    version: WORK_EVENT_IDEMPOTENCY_VERSION,
    collaborationDomainId,
    recordKind: ATTEMPT_RECORD_KIND,
    request: withoutIdempotencyKey(request),
  });
}

function decisionRequestDigest(collaborationDomainId: string, request: DecisionCreateRequest): string {
  return hashIdentity({
    version: WORK_EVENT_IDEMPOTENCY_VERSION,
    collaborationDomainId,
    recordKind: DECISION_RECORD_KIND,
    request: withoutIdempotencyKey(request),
  });
}

function withoutIdempotencyKey<Request extends { idempotencyKey?: string }>(
  request: Request,
): Omit<Request, 'idempotencyKey'> {
  const { idempotencyKey: _idempotencyKey, ...meaning } = request;
  return meaning;
}

function workEventKeyDigest(
  collaborationDomainId: string,
  changeId: string,
  idempotencyKey: string,
  recordKind: 'attempt' | 'decision',
): string {
  return hashIdentity({
    version: WORK_EVENT_IDEMPOTENCY_VERSION,
    collaborationDomainId,
    changeId,
    recordKind,
    idempotencyKey,
  });
}

function workEventIdempotency(keyDigest: string, requestDigest: string): WorkEventIdempotency {
  return {
    version: WORK_EVENT_IDEMPOTENCY_VERSION,
    algorithm: WORK_STATE_IDENTITY_ALGORITHM,
    keyDigest,
    requestDigest,
  };
}

function attemptIdFromDigest(digest: string): string {
  return `SQA-${digest.slice(0, 32).toUpperCase()}`;
}

function decisionIdFromDigest(digest: string): string {
  return `SQD-${digest.slice(0, 32).toUpperCase()}`;
}

function isAttemptOutcome(value: unknown): value is AttemptOutcome {
  return value === 'succeeded' || value === 'failed' || value === 'unknown';
}

function isActionEffectClass(value: unknown): value is ActionEffectClass {
  return value === 'read-only' || value === 'idempotent-write' || value === 'non-idempotent-write';
}

function isDecisionDisposition(value: unknown): value is DecisionDisposition {
  return (
    value === 'continue' ||
    value === 'retry-safe' ||
    value === 'change-strategy' ||
    value === 'reconcile-unknown' ||
    value === 'completion-candidate' ||
    value === 'abandon'
  );
}

function assertRecordInput(collaborationDomainId: string, createdAt: string, toolVersion: string): void {
  if (!isCollaborationDomainId(collaborationDomainId)) {
    throw new Error('collaborationDomainId must be a version-4 UUID');
  }
  if (!isValidRecordTimestamp(createdAt)) throw new Error('createdAt must be a valid timestamp');
  if (!normalizedBoundedLine(toolVersion, 256)) throw new Error('toolVersion must be non-empty and bounded');
}

function hasObservationAtOrAfter(receipts: readonly ObservationReceiptV2[], timestamp: string): boolean {
  const threshold = Date.parse(timestamp);
  return receipts.some((receipt) => Date.parse(receipt.observedAt) >= threshold);
}

function compareAttemptRecords(left: AttemptRecordV1, right: AttemptRecordV1): number {
  return left.createdAt.localeCompare(right.createdAt) || left.attemptId.localeCompare(right.attemptId);
}

function compareDecisionRecords(left: DecisionRecordV1, right: DecisionRecordV1): number {
  return left.createdAt.localeCompare(right.createdAt) || left.decisionId.localeCompare(right.decisionId);
}
