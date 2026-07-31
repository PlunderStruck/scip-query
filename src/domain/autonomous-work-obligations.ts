import {
  createObservationIdentity,
  type ObservationIdentity,
  type ObservationReceiptV2,
} from './observation-receipt.js';
import { isRecordObject, isValidRecordTimestamp } from './record-validation.js';
import { stableJson } from './stable-json.js';
import {
  decodeWorkEvidenceReceipts,
  decodeWorkEventIdempotency,
  workEventIdempotency,
  workEventKeyDigest,
  type WorkEventIdempotency,
} from './autonomous-work-ledger.js';
import {
  decodeWorkRecordEnvelope,
  hashIdentity,
  isCollaborationDomainId,
  isIntendedChangeId,
  matchesWorkStateIdentity,
  normalizedBoundedLine,
  type WorkStateDecodeResult,
  type WorkStateWriter,
} from './autonomous-work-state.js';

export const OBLIGATION_ADMISSION_RECORD_KIND = 'scip-query-obligation-admission' as const;
export const OBLIGATION_ADMISSION_SCHEMA_VERSION = 1 as const;
export const OBLIGATION_TRANSITION_RECORD_KIND = 'scip-query-obligation-transition' as const;
export const OBLIGATION_TRANSITION_SCHEMA_VERSION = 1 as const;

const OBLIGATION_ID_PATTERN = /^SQO-[A-F0-9]{32}$/u;
const OBLIGATION_TRANSITION_ID_PATTERN = /^SQT-[A-F0-9]{32}$/u;
const ATTEMPT_ID_PATTERN = /^SQA-[A-F0-9]{32}$/u;
const MAX_BASIS_ATTEMPTS = 32;
const MAX_TITLE_CHARACTERS = 240;
const MAX_CONDITION_CHARACTERS = 1_000;
const MAX_REFERENT_CHARACTERS = 1_000;
const MAX_RATIONALE_CHARACTERS = 1_000;

export type ObligationCategory =
  | 'test'
  | 'documentation'
  | 'residue'
  | 'architecture'
  | 'migration'
  | 'verification'
  | 'other';

export type ObligationSource =
  | { kind: 'detector-finding'; check: string; findingId: string }
  | { kind: 'agent-discovery'; referent: string }
  | { kind: 'policy'; referent: string };

export type ObligationTerminalState = 'fulfilled' | 'invalidated' | 'carried-forward';
export type ObligationTransitionReason =
  | 'condition-established'
  | 'premise-disproven'
  | 'superseded-duplicate'
  | 'successor-change-authorized';

export interface ObligationAdmissionRequest {
  changeId: string;
  idempotencyKey: string;
  category: ObligationCategory;
  title: string;
  requiredCondition: string;
  source: ObligationSource;
  basisAttemptIds: readonly string[];
  evidenceReceipts: readonly ObservationReceiptV2[];
}

export interface ObligationAdmissionRecordV1 {
  kind: typeof OBLIGATION_ADMISSION_RECORD_KIND;
  schemaVersion: typeof OBLIGATION_ADMISSION_SCHEMA_VERSION;
  obligationId: string;
  collaborationDomainId: string;
  changeId: string;
  category: ObligationCategory;
  title: string;
  requiredCondition: string;
  source: ObligationSource;
  basisAttemptIds: readonly string[];
  evidenceReceipts: readonly ObservationReceiptV2[];
  idempotency: WorkEventIdempotency;
  createdAt: string;
  writer: WorkStateWriter;
}

export interface SuccessorObligationRequest {
  changeId: string;
  category: ObligationCategory;
  title: string;
  requiredCondition: string;
  source: ObligationSource;
  basisAttemptIds: readonly string[];
  evidenceReceipts: readonly ObservationReceiptV2[];
}

export interface SuccessorObligation extends SuccessorObligationRequest {
  obligationId: string;
}

export interface ObligationTransitionRequest {
  changeId: string;
  obligationId: string;
  idempotencyKey: string;
  to: ObligationTerminalState;
  reason: ObligationTransitionReason;
  basisAttemptIds: readonly string[];
  evidenceReceipts: readonly ObservationReceiptV2[];
  rationale: string;
  successor?: SuccessorObligationRequest;
}

export interface ObligationTransitionRecordV1 {
  kind: typeof OBLIGATION_TRANSITION_RECORD_KIND;
  schemaVersion: typeof OBLIGATION_TRANSITION_SCHEMA_VERSION;
  transitionId: string;
  collaborationDomainId: string;
  changeId: string;
  obligationId: string;
  from: 'live';
  to: ObligationTerminalState;
  reason: ObligationTransitionReason;
  basisAttemptIds: readonly string[];
  evidenceReceipts: readonly ObservationReceiptV2[];
  rationale: string;
  successor?: SuccessorObligation;
  idempotency: WorkEventIdempotency;
  createdAt: string;
  writer: WorkStateWriter;
}

export interface CreateObligationAdmissionInput {
  collaborationDomainId: string;
  request: ObligationAdmissionRequest;
  createdAt: string;
  toolVersion: string;
}

export interface CreateObligationTransitionInput {
  collaborationDomainId: string;
  request: ObligationTransitionRequest;
  createdAt: string;
  toolVersion: string;
}

export interface Obligation {
  obligationId: string;
  collaborationDomainId: string;
  changeId: string;
  category: ObligationCategory;
  title: string;
  requiredCondition: string;
  source: ObligationSource;
  basisAttemptIds: readonly string[];
  evidenceReceipts: readonly ObservationReceiptV2[];
  admittedAt: string;
  origin: 'admission' | 'carried-forward';
  introducingTransitionId?: string;
}

export type FoldedObligationState =
  | { state: 'live'; obligation: Obligation }
  | {
      state: ObligationTerminalState;
      obligation: Obligation;
      transition: ObligationTransitionRecordV1;
    }
  | {
      state: 'conflicted';
      obligation: Obligation;
      transitions: readonly ObligationTransitionRecordV1[];
    };

export interface ObligationLifecycleSummary {
  admissions: readonly ObligationAdmissionRecordV1[];
  transitions: readonly ObligationTransitionRecordV1[];
  obligations: readonly FoldedObligationState[];
  liveObligationIds: readonly string[];
  fulfilledObligationIds: readonly string[];
  invalidatedObligationIds: readonly string[];
  carriedForwardObligationIds: readonly string[];
  conflictedObligationIds: readonly string[];
  conflicts: readonly string[];
  orphanTransitionIds: readonly string[];
}

export type ObligationRequestDecodeResult<RequestType> =
  | { ok: true; request: RequestType }
  | { ok: false; error: string };

export function decodeObligationAdmissionRequest(
  value: unknown,
): ObligationRequestDecodeResult<ObligationAdmissionRequest> {
  if (!isRecordObject(value)) return { ok: false, error: 'obligation admission request must be an object' };
  return decodeAdmissionMeaning(value, true);
}

export function decodeObligationTransitionRequest(
  value: unknown,
): ObligationRequestDecodeResult<ObligationTransitionRequest> {
  if (!isRecordObject(value)) return { ok: false, error: 'obligation transition request must be an object' };
  if (!isIntendedChangeId(value['changeId'])) {
    return { ok: false, error: 'changeId must be an intended-change identity' };
  }
  if (!isObligationId(value['obligationId'])) {
    return { ok: false, error: 'obligationId must be an obligation identity' };
  }
  const idempotencyKey = normalizedBoundedLine(value['idempotencyKey'], 256);
  if (!idempotencyKey) {
    return { ok: false, error: 'idempotencyKey must be a non-empty line of at most 256 characters' };
  }
  const to = value['to'];
  if (!isObligationTerminalState(to)) {
    return { ok: false, error: 'to must be fulfilled, invalidated, or carried-forward' };
  }
  const reason = value['reason'];
  if (!reasonMatchesState(to, reason)) {
    return { ok: false, error: `reason is not valid for the ${to} transition` };
  }
  const basisAttemptIds = decodeBasisAttemptIds(value['basisAttemptIds']);
  if (!basisAttemptIds.ok) return basisAttemptIds;
  const evidenceReceipts = decodeWorkEvidenceReceipts(value['evidenceReceipts']);
  if (!evidenceReceipts.ok) return evidenceReceipts;
  if (evidenceReceipts.receipts.length === 0) {
    return { ok: false, error: 'terminal obligation transitions require current observation evidence' };
  }
  const rationale = normalizedBoundedLine(value['rationale'], MAX_RATIONALE_CHARACTERS);
  if (!rationale) return { ok: false, error: 'rationale must be canonical bounded text' };
  const successorValue = value['successor'];
  if (to === 'carried-forward') {
    if (!isRecordObject(successorValue)) {
      return { ok: false, error: 'carried-forward transitions require an embedded successor obligation' };
    }
    const successor = decodeAdmissionMeaning(successorValue, false);
    if (!successor.ok) return successor;
    return {
      ok: true,
      request: {
        changeId: value['changeId'],
        obligationId: value['obligationId'],
        idempotencyKey,
        to,
        reason,
        basisAttemptIds: basisAttemptIds.attemptIds,
        evidenceReceipts: evidenceReceipts.receipts,
        rationale,
        successor: successor.request,
      },
    };
  }
  if (successorValue !== undefined) {
    return { ok: false, error: 'only carried-forward transitions may embed a successor obligation' };
  }
  return {
    ok: true,
    request: {
      changeId: value['changeId'],
      obligationId: value['obligationId'],
      idempotencyKey,
      to,
      reason,
      basisAttemptIds: basisAttemptIds.attemptIds,
      evidenceReceipts: evidenceReceipts.receipts,
      rationale,
    },
  };
}

export function createObligationAdmission(input: CreateObligationAdmissionInput): ObligationAdmissionRecordV1 {
  assertRecordInput(input.collaborationDomainId, input.createdAt, input.toolVersion);
  const decoded = decodeObligationAdmissionRequest(input.request);
  if (!decoded.ok) throw new Error(decoded.error);
  const keyDigest = workEventKeyDigest(
    input.collaborationDomainId,
    decoded.request.changeId,
    decoded.request.idempotencyKey,
    'obligation-admission',
  );
  return {
    kind: OBLIGATION_ADMISSION_RECORD_KIND,
    schemaVersion: OBLIGATION_ADMISSION_SCHEMA_VERSION,
    obligationId: obligationIdFromDigest(keyDigest),
    collaborationDomainId: input.collaborationDomainId,
    changeId: decoded.request.changeId,
    category: decoded.request.category,
    title: decoded.request.title,
    requiredCondition: decoded.request.requiredCondition,
    source: decoded.request.source,
    basisAttemptIds: decoded.request.basisAttemptIds,
    evidenceReceipts: decoded.request.evidenceReceipts,
    idempotency: workEventIdempotency(keyDigest, admissionRequestDigest(input.collaborationDomainId, decoded.request)),
    createdAt: input.createdAt,
    writer: { tool: 'scip-query', version: input.toolVersion },
  };
}

export function createObligationTransition(input: CreateObligationTransitionInput): ObligationTransitionRecordV1 {
  assertRecordInput(input.collaborationDomainId, input.createdAt, input.toolVersion);
  const decoded = decodeObligationTransitionRequest(input.request);
  if (!decoded.ok) throw new Error(decoded.error);
  const keyDigest = workEventKeyDigest(
    input.collaborationDomainId,
    decoded.request.changeId,
    decoded.request.idempotencyKey,
    'obligation-transition',
  );
  const transitionId = transitionIdFromDigest(keyDigest);
  return {
    kind: OBLIGATION_TRANSITION_RECORD_KIND,
    schemaVersion: OBLIGATION_TRANSITION_SCHEMA_VERSION,
    transitionId,
    collaborationDomainId: input.collaborationDomainId,
    changeId: decoded.request.changeId,
    obligationId: decoded.request.obligationId,
    from: 'live',
    to: decoded.request.to,
    reason: decoded.request.reason,
    basisAttemptIds: decoded.request.basisAttemptIds,
    evidenceReceipts: decoded.request.evidenceReceipts,
    rationale: decoded.request.rationale,
    ...(decoded.request.successor
      ? {
          successor: {
            obligationId: successorIdFromTransitionDigest(keyDigest),
            ...decoded.request.successor,
          },
        }
      : {}),
    idempotency: workEventIdempotency(keyDigest, transitionRequestDigest(input.collaborationDomainId, decoded.request)),
    createdAt: input.createdAt,
    writer: { tool: 'scip-query', version: input.toolVersion },
  };
}

export function decodeObligationAdmissionRecord(value: unknown): WorkStateDecodeResult<ObligationAdmissionRecordV1> {
  const envelope = decodeWorkRecordEnvelope(value, {
    recordKind: OBLIGATION_ADMISSION_RECORD_KIND,
    schemaVersion: OBLIGATION_ADMISSION_SCHEMA_VERSION,
    label: 'obligation admission',
  });
  if (!envelope.ok) return envelope.result;
  const fields = envelope.envelope.value;
  const decoded = decodeObligationAdmissionRequest({
    changeId: fields['changeId'],
    idempotencyKey: 'record-key-placeholder',
    category: fields['category'],
    title: fields['title'],
    requiredCondition: fields['requiredCondition'],
    source: fields['source'],
    basisAttemptIds: fields['basisAttemptIds'],
    evidenceReceipts: fields['evidenceReceipts'],
  });
  if (!decoded.ok) return { state: 'malformed', error: decoded.error };
  if (!admissionFieldsAreCanonical(fields, decoded.request)) {
    return { state: 'malformed', error: 'obligation admission fields must use canonical values and ordering' };
  }
  if (!isObligationId(fields['obligationId'])) {
    return { state: 'malformed', error: 'obligationId must be an obligation identity' };
  }
  const idempotency = decodeWorkEventIdempotency(fields['idempotency']);
  if (!idempotency.ok) return { state: 'malformed', error: idempotency.error };
  if (fields['obligationId'] !== obligationIdFromDigest(idempotency.value.keyDigest)) {
    return { state: 'malformed', error: 'obligationId does not match the idempotency key digest' };
  }
  if (
    idempotency.value.requestDigest !== admissionRequestDigest(envelope.envelope.collaborationDomainId, decoded.request)
  ) {
    return { state: 'malformed', error: 'requestDigest does not match the obligation admission meaning' };
  }
  return {
    state: 'current',
    record: {
      kind: OBLIGATION_ADMISSION_RECORD_KIND,
      schemaVersion: OBLIGATION_ADMISSION_SCHEMA_VERSION,
      obligationId: fields['obligationId'],
      collaborationDomainId: envelope.envelope.collaborationDomainId,
      changeId: decoded.request.changeId,
      category: decoded.request.category,
      title: decoded.request.title,
      requiredCondition: decoded.request.requiredCondition,
      source: decoded.request.source,
      basisAttemptIds: decoded.request.basisAttemptIds,
      evidenceReceipts: decoded.request.evidenceReceipts,
      idempotency: idempotency.value,
      createdAt: envelope.envelope.createdAt,
      writer: envelope.envelope.writer,
    },
  };
}

export function decodeObligationTransitionRecord(value: unknown): WorkStateDecodeResult<ObligationTransitionRecordV1> {
  const envelope = decodeWorkRecordEnvelope(value, {
    recordKind: OBLIGATION_TRANSITION_RECORD_KIND,
    schemaVersion: OBLIGATION_TRANSITION_SCHEMA_VERSION,
    label: 'obligation transition',
  });
  if (!envelope.ok) return envelope.result;
  const fields = envelope.envelope.value;
  const successorValue = isRecordObject(fields['successor'])
    ? {
        changeId: fields['successor']['changeId'],
        category: fields['successor']['category'],
        title: fields['successor']['title'],
        requiredCondition: fields['successor']['requiredCondition'],
        source: fields['successor']['source'],
        basisAttemptIds: fields['successor']['basisAttemptIds'],
        evidenceReceipts: fields['successor']['evidenceReceipts'],
      }
    : fields['successor'];
  const decoded = decodeObligationTransitionRequest({
    changeId: fields['changeId'],
    obligationId: fields['obligationId'],
    idempotencyKey: 'record-key-placeholder',
    to: fields['to'],
    reason: fields['reason'],
    basisAttemptIds: fields['basisAttemptIds'],
    evidenceReceipts: fields['evidenceReceipts'],
    rationale: fields['rationale'],
    ...(fields['successor'] !== undefined ? { successor: successorValue } : {}),
  });
  if (!decoded.ok) return { state: 'malformed', error: decoded.error };
  if (!transitionFieldsAreCanonical(fields, decoded.request)) {
    return { state: 'malformed', error: 'obligation transition fields must use canonical values and ordering' };
  }
  if (fields['from'] !== 'live') return { state: 'malformed', error: 'obligation transitions must start from live' };
  if (!isObligationTransitionId(fields['transitionId'])) {
    return { state: 'malformed', error: 'transitionId must be an obligation-transition identity' };
  }
  const idempotency = decodeWorkEventIdempotency(fields['idempotency']);
  if (!idempotency.ok) return { state: 'malformed', error: idempotency.error };
  if (fields['transitionId'] !== transitionIdFromDigest(idempotency.value.keyDigest)) {
    return { state: 'malformed', error: 'transitionId does not match the idempotency key digest' };
  }
  if (
    idempotency.value.requestDigest !==
    transitionRequestDigest(envelope.envelope.collaborationDomainId, decoded.request)
  ) {
    return { state: 'malformed', error: 'requestDigest does not match the obligation transition meaning' };
  }
  const successor =
    fields['successor'] === undefined
      ? undefined
      : decodeSuccessor(fields['successor'], decoded.request.successor, idempotency.value.keyDigest);
  if (successor && !successor.ok) return { state: 'malformed', error: successor.error };
  return {
    state: 'current',
    record: {
      kind: OBLIGATION_TRANSITION_RECORD_KIND,
      schemaVersion: OBLIGATION_TRANSITION_SCHEMA_VERSION,
      transitionId: fields['transitionId'],
      collaborationDomainId: envelope.envelope.collaborationDomainId,
      changeId: decoded.request.changeId,
      obligationId: decoded.request.obligationId,
      from: 'live',
      to: decoded.request.to,
      reason: decoded.request.reason,
      basisAttemptIds: decoded.request.basisAttemptIds,
      evidenceReceipts: decoded.request.evidenceReceipts,
      rationale: decoded.request.rationale,
      ...(successor?.ok ? { successor: successor.successor } : {}),
      idempotency: idempotency.value,
      createdAt: envelope.envelope.createdAt,
      writer: envelope.envelope.writer,
    },
  };
}

export function decodeObligationRecord(
  value: unknown,
): WorkStateDecodeResult<ObligationAdmissionRecordV1 | ObligationTransitionRecordV1> {
  if (!isRecordObject(value)) return { state: 'malformed', error: 'obligation record must be an object' };
  if (value['kind'] === OBLIGATION_ADMISSION_RECORD_KIND) return decodeObligationAdmissionRecord(value);
  if (value['kind'] === OBLIGATION_TRANSITION_RECORD_KIND) return decodeObligationTransitionRecord(value);
  return { state: 'malformed', error: 'unrecognized obligation record kind' };
}

export function obligationAdmissionRequestMatchesRecord(
  collaborationDomainId: string,
  request: ObligationAdmissionRequest,
  record: ObligationAdmissionRecordV1,
): boolean {
  const decoded = decodeObligationAdmissionRequest(request);
  return (
    decoded.ok &&
    record.collaborationDomainId === collaborationDomainId &&
    record.idempotency.requestDigest === admissionRequestDigest(collaborationDomainId, decoded.request)
  );
}

export function obligationTransitionRequestMatchesRecord(
  collaborationDomainId: string,
  request: ObligationTransitionRequest,
  record: ObligationTransitionRecordV1,
): boolean {
  const decoded = decodeObligationTransitionRequest(request);
  return (
    decoded.ok &&
    record.collaborationDomainId === collaborationDomainId &&
    record.idempotency.requestDigest === transitionRequestDigest(collaborationDomainId, decoded.request)
  );
}

export function terminalEvidenceIsCurrent(
  obligation: Obligation,
  receipts: readonly ObservationReceiptV2[],
  observedBy?: string,
): boolean {
  if (receipts.length === 0) return false;
  const upperBound = observedBy === undefined ? Number.POSITIVE_INFINITY : Date.parse(observedBy);
  const expectedDomain = createObservationIdentity(
    'scip-query:collaboration-domain',
    1,
    obligation.collaborationDomainId,
  );
  return receipts.every(
    (receipt) =>
      Date.parse(receipt.observedAt) >= Date.parse(obligation.admittedAt) &&
      Date.parse(receipt.observedAt) <= upperBound &&
      identitiesEqual(receipt.facts.collaborationDomain, expectedDomain) &&
      receipt.facts.wholeContent !== undefined &&
      repositorySourcesAreFixed(receipt),
  );
}

/**
 * The fold is the current lifecycle view derived from immutable branch-
 * mergeable facts. Different terminal meanings remain conflicted; a
 * carried-forward successor exists only when its predecessor has one
 * unambiguous carried-forward meaning.
 */
export function foldObligationLifecycle(
  admissionsInput: readonly ObligationAdmissionRecordV1[],
  transitionsInput: readonly ObligationTransitionRecordV1[],
): ObligationLifecycleSummary {
  const admissions = [...admissionsInput].sort(compareAdmissions);
  const transitions = [...transitionsInput].sort(compareTransitions);
  const transitionGroups = new Map<string, ObligationTransitionRecordV1[]>();
  for (const transition of transitions) {
    const group = transitionGroups.get(transition.obligationId) ?? [];
    group.push(transition);
    transitionGroups.set(transition.obligationId, group);
  }
  const known = new Map<string, Obligation>();
  const states = new Map<string, FoldedObligationState>();
  const conflicts: string[] = [];
  const queue: Obligation[] = admissions.map(obligationFromAdmission);
  while (queue.length > 0) {
    const obligation = queue.shift();
    if (!obligation) break;
    const existing = known.get(obligation.obligationId);
    if (existing) {
      if (stableJson(existing) !== stableJson(obligation)) {
        conflicts.push(`${obligation.obligationId} has conflicting admission meanings`);
      }
      continue;
    }
    known.set(obligation.obligationId, obligation);
    const resolution = resolveObligationState(obligation, transitionGroups.get(obligation.obligationId) ?? []);
    states.set(obligation.obligationId, resolution.state);
    if (resolution.conflict) conflicts.push(resolution.conflict);
    if (resolution.successor) queue.push(resolution.successor);
  }
  const orphanTransitionIds = [...transitionGroups.entries()]
    .filter(([obligationId]) => !known.has(obligationId))
    .flatMap(([, records]) => records.map((record) => record.transitionId))
    .sort();
  const obligations = [...states.values()].sort((left, right) =>
    left.obligation.obligationId.localeCompare(right.obligation.obligationId),
  );
  return {
    admissions,
    transitions,
    obligations,
    liveObligationIds: stateIds(obligations, 'live'),
    fulfilledObligationIds: stateIds(obligations, 'fulfilled'),
    invalidatedObligationIds: stateIds(obligations, 'invalidated'),
    carriedForwardObligationIds: stateIds(obligations, 'carried-forward'),
    conflictedObligationIds: stateIds(obligations, 'conflicted'),
    conflicts,
    orphanTransitionIds,
  };
}

export function isObligationId(value: unknown): value is string {
  return matchesWorkStateIdentity(value, OBLIGATION_ID_PATTERN);
}

export function isObligationTransitionId(value: unknown): value is string {
  return matchesWorkStateIdentity(value, OBLIGATION_TRANSITION_ID_PATTERN);
}

function decodeAdmissionMeaning(
  value: Readonly<Record<string, unknown>>,
  withIdempotencyKey: true,
): ObligationRequestDecodeResult<ObligationAdmissionRequest>;
function decodeAdmissionMeaning(
  value: Readonly<Record<string, unknown>>,
  withIdempotencyKey: false,
): ObligationRequestDecodeResult<SuccessorObligationRequest>;
function decodeAdmissionMeaning(
  value: Readonly<Record<string, unknown>>,
  withIdempotencyKey: boolean,
): ObligationRequestDecodeResult<ObligationAdmissionRequest | SuccessorObligationRequest> {
  if (!isIntendedChangeId(value['changeId'])) {
    return { ok: false, error: 'changeId must be an intended-change identity' };
  }
  const idempotencyKey = withIdempotencyKey ? normalizedBoundedLine(value['idempotencyKey'], 256) : undefined;
  if (withIdempotencyKey && !idempotencyKey) {
    return { ok: false, error: 'idempotencyKey must be a non-empty line of at most 256 characters' };
  }
  if (!isObligationCategory(value['category'])) {
    return { ok: false, error: 'category is not a supported obligation category' };
  }
  const title = normalizedBoundedLine(value['title'], MAX_TITLE_CHARACTERS);
  const requiredCondition = normalizedBoundedLine(value['requiredCondition'], MAX_CONDITION_CHARACTERS);
  if (!title || !requiredCondition) {
    return { ok: false, error: 'title and requiredCondition must be canonical bounded text' };
  }
  const source = decodeObligationSource(value['source']);
  if (!source.ok) return source;
  const basisAttemptIds = decodeBasisAttemptIds(value['basisAttemptIds']);
  if (!basisAttemptIds.ok) return basisAttemptIds;
  const evidenceReceipts = decodeWorkEvidenceReceipts(value['evidenceReceipts']);
  if (!evidenceReceipts.ok) return evidenceReceipts;
  const meaning = {
    changeId: value['changeId'],
    category: value['category'],
    title,
    requiredCondition,
    source: source.source,
    basisAttemptIds: basisAttemptIds.attemptIds,
    evidenceReceipts: evidenceReceipts.receipts,
  } satisfies SuccessorObligationRequest;
  return withIdempotencyKey
    ? { ok: true, request: { ...meaning, idempotencyKey: idempotencyKey as string } }
    : { ok: true, request: meaning };
}

function decodeObligationSource(value: unknown): { ok: true; source: ObligationSource } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'source must be an object' };
  if (value['kind'] === 'detector-finding') {
    const check = normalizedBoundedLine(value['check'], MAX_REFERENT_CHARACTERS);
    const findingId = normalizedBoundedLine(value['findingId'], MAX_REFERENT_CHARACTERS);
    return check && findingId
      ? { ok: true, source: { kind: 'detector-finding', check, findingId } }
      : { ok: false, error: 'detector-finding source requires canonical check and findingId values' };
  }
  if (value['kind'] === 'agent-discovery' || value['kind'] === 'policy') {
    const referent = normalizedBoundedLine(value['referent'], MAX_REFERENT_CHARACTERS);
    return referent
      ? { ok: true, source: { kind: value['kind'], referent } }
      : { ok: false, error: `${value['kind']} source requires a canonical referent` };
  }
  return { ok: false, error: 'source kind must be detector-finding, agent-discovery, or policy' };
}

function decodeBasisAttemptIds(value: unknown): { ok: true; attemptIds: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > MAX_BASIS_ATTEMPTS) {
    return { ok: false, error: `basisAttemptIds must contain at most ${MAX_BASIS_ATTEMPTS} attempt identities` };
  }
  if (value.some((attemptId) => typeof attemptId !== 'string' || !ATTEMPT_ID_PATTERN.test(attemptId))) {
    return { ok: false, error: 'basisAttemptIds must contain only attempt identities' };
  }
  return { ok: true, attemptIds: [...new Set(value as string[])].sort() };
}

function decodeSuccessor(
  value: unknown,
  request: SuccessorObligationRequest | undefined,
  transitionKeyDigest: string,
): { ok: true; successor: SuccessorObligation } | { ok: false; error: string } {
  if (!isRecordObject(value) || !request) return { ok: false, error: 'successor obligation is malformed' };
  if (value['obligationId'] !== successorIdFromTransitionDigest(transitionKeyDigest)) {
    return { ok: false, error: 'successor obligationId does not match the transition identity' };
  }
  const successor = { obligationId: value['obligationId'], ...request };
  if (stableJson(value) !== stableJson(successor)) {
    return { ok: false, error: 'successor obligation fields must use canonical values and ordering' };
  }
  return { ok: true, successor };
}

function admissionFieldsAreCanonical(
  value: Readonly<Record<string, unknown>>,
  request: ObligationAdmissionRequest,
): boolean {
  return (
    value['changeId'] === request.changeId &&
    value['category'] === request.category &&
    value['title'] === request.title &&
    value['requiredCondition'] === request.requiredCondition &&
    stableJson(value['source']) === stableJson(request.source) &&
    stableJson(value['basisAttemptIds']) === stableJson(request.basisAttemptIds) &&
    stableJson(value['evidenceReceipts']) === stableJson(request.evidenceReceipts)
  );
}

function transitionFieldsAreCanonical(
  value: Readonly<Record<string, unknown>>,
  request: ObligationTransitionRequest,
): boolean {
  const successorValue = isRecordObject(value['successor'])
    ? {
        changeId: value['successor']['changeId'],
        category: value['successor']['category'],
        title: value['successor']['title'],
        requiredCondition: value['successor']['requiredCondition'],
        source: value['successor']['source'],
        basisAttemptIds: value['successor']['basisAttemptIds'],
        evidenceReceipts: value['successor']['evidenceReceipts'],
      }
    : value['successor'];
  return (
    value['changeId'] === request.changeId &&
    value['obligationId'] === request.obligationId &&
    value['to'] === request.to &&
    value['reason'] === request.reason &&
    stableJson(value['basisAttemptIds']) === stableJson(request.basisAttemptIds) &&
    stableJson(value['evidenceReceipts']) === stableJson(request.evidenceReceipts) &&
    value['rationale'] === request.rationale &&
    stableJson(successorValue) === stableJson(request.successor)
  );
}

function admissionRequestDigest(collaborationDomainId: string, request: ObligationAdmissionRequest): string {
  return hashIdentity({
    version: 1,
    collaborationDomainId,
    recordKind: OBLIGATION_ADMISSION_RECORD_KIND,
    request: withoutIdempotencyKey(request),
  });
}

function transitionRequestDigest(collaborationDomainId: string, request: ObligationTransitionRequest): string {
  return hashIdentity({
    version: 1,
    collaborationDomainId,
    recordKind: OBLIGATION_TRANSITION_RECORD_KIND,
    request: withoutIdempotencyKey(request),
  });
}

function withoutIdempotencyKey<Request extends { idempotencyKey?: string }>(
  request: Request,
): Omit<Request, 'idempotencyKey'> {
  const { idempotencyKey: _idempotencyKey, ...meaning } = request;
  return meaning;
}

function obligationIdFromDigest(digest: string): string {
  return `SQO-${digest.slice(0, 32).toUpperCase()}`;
}

function successorIdFromTransitionDigest(digest: string): string {
  const successorDigest = hashIdentity({ version: 1, role: 'carried-successor', transitionKeyDigest: digest });
  return obligationIdFromDigest(successorDigest);
}

function transitionIdFromDigest(digest: string): string {
  return `SQT-${digest.slice(0, 32).toUpperCase()}`;
}

function reasonMatchesState(state: ObligationTerminalState, reason: unknown): reason is ObligationTransitionReason {
  return (
    (state === 'fulfilled' && reason === 'condition-established') ||
    (state === 'invalidated' && (reason === 'premise-disproven' || reason === 'superseded-duplicate')) ||
    (state === 'carried-forward' && reason === 'successor-change-authorized')
  );
}

function isObligationTerminalState(value: unknown): value is ObligationTerminalState {
  return value === 'fulfilled' || value === 'invalidated' || value === 'carried-forward';
}

function isObligationCategory(value: unknown): value is ObligationCategory {
  return (
    value === 'test' ||
    value === 'documentation' ||
    value === 'residue' ||
    value === 'architecture' ||
    value === 'migration' ||
    value === 'verification' ||
    value === 'other'
  );
}

function assertRecordInput(collaborationDomainId: string, createdAt: string, toolVersion: string): void {
  if (!isCollaborationDomainId(collaborationDomainId)) {
    throw new Error('collaborationDomainId must be a version-4 UUID');
  }
  if (!isValidRecordTimestamp(createdAt)) throw new Error('createdAt must be a valid timestamp');
  if (!normalizedBoundedLine(toolVersion, 256)) throw new Error('toolVersion must be non-empty and bounded');
}

function identitiesEqual(left: ObservationIdentity | undefined, right: ObservationIdentity): boolean {
  return left !== undefined && stableJson(left) === stableJson(right);
}

function repositorySourcesAreFixed(receipt: ObservationReceiptV2): boolean {
  const repositorySources = receipt.observedSources.filter((source) => source.kind !== 'process');
  if (repositorySources.length === 0) return false;
  return repositorySources.every((source) =>
    receipt.stabilityProofs.some(
      (proof) => proof.source === source.kind && (proof.kind === 'immutable' || proof.kind === 'fixed-snapshot'),
    ),
  );
}

function obligationFromAdmission(admission: ObligationAdmissionRecordV1): Obligation {
  return {
    obligationId: admission.obligationId,
    collaborationDomainId: admission.collaborationDomainId,
    changeId: admission.changeId,
    category: admission.category,
    title: admission.title,
    requiredCondition: admission.requiredCondition,
    source: admission.source,
    basisAttemptIds: admission.basisAttemptIds,
    evidenceReceipts: admission.evidenceReceipts,
    admittedAt: admission.createdAt,
    origin: 'admission',
  };
}

function obligationFromSuccessor(transition: ObligationTransitionRecordV1): Obligation {
  if (!transition.successor) throw new Error('carried-forward transition has no successor');
  return {
    ...transition.successor,
    collaborationDomainId: transition.collaborationDomainId,
    admittedAt: transition.createdAt,
    origin: 'carried-forward',
    introducingTransitionId: transition.transitionId,
  };
}

function terminalMeaning(transition: ObligationTransitionRecordV1): string {
  return stableJson({
    to: transition.to,
    reason: transition.reason,
    successor: transition.successor,
  });
}

function resolveObligationState(
  obligation: Obligation,
  transitions: readonly ObligationTransitionRecordV1[],
): { state: FoldedObligationState; successor?: Obligation; conflict?: string } {
  const candidates = transitions.filter(
    (transition) =>
      transition.collaborationDomainId === obligation.collaborationDomainId &&
      transition.changeId === obligation.changeId &&
      Date.parse(transition.createdAt) >= Date.parse(obligation.admittedAt) &&
      terminalEvidenceIsCurrent(obligation, transition.evidenceReceipts, transition.createdAt),
  );
  if (candidates.length === 0) return { state: { state: 'live', obligation } };
  const meanings = new Set(candidates.map(terminalMeaning));
  if (meanings.size > 1) {
    return {
      state: { state: 'conflicted', obligation, transitions: candidates },
      conflict: `${obligation.obligationId} has conflicting terminal transitions ${candidates
        .map((transition) => transition.transitionId)
        .join(', ')}`,
    };
  }
  const selected = candidates.at(-1);
  if (!selected) return { state: { state: 'live', obligation } };
  return {
    state: { state: selected.to, obligation, transition: selected },
    ...(selected.to === 'carried-forward' && selected.successor
      ? { successor: obligationFromSuccessor(selected) }
      : {}),
  };
}

function stateIds(obligations: readonly FoldedObligationState[], state: FoldedObligationState['state']): string[] {
  return obligations
    .filter((obligation) => obligation.state === state)
    .map((obligation) => obligation.obligation.obligationId);
}

function compareAdmissions(left: ObligationAdmissionRecordV1, right: ObligationAdmissionRecordV1): number {
  return left.createdAt.localeCompare(right.createdAt) || left.obligationId.localeCompare(right.obligationId);
}

function compareTransitions(left: ObligationTransitionRecordV1, right: ObligationTransitionRecordV1): number {
  return left.createdAt.localeCompare(right.createdAt) || left.transitionId.localeCompare(right.transitionId);
}
