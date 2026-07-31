import {
  COMPLETION_PREDICATES,
  type CompletionEvaluationRecordV1,
  type CompletionPredicate,
} from './autonomous-completion.js';
import { PROTECTED_ARTIFACT_CLASSES, type ProtectedArtifactClass } from './completion-protection.js';
import {
  createGoalRecord,
  createIntendedChangeRecord,
  decodeGoalCreateRequest,
  decodeGoalRecord,
  decodeIntendedChangeCreateRequest,
  decodeIntendedChangeRecord,
  hashIdentity,
  isGoalId,
  normalizedBoundedLine,
  type GoalCreateRequest,
  type GoalRecordV1,
  type IntendedChangeCreateRequest,
  type IntendedChangeRecordV1,
  type WorkStateDecodeResult,
  type WorkStateRequestDecodeResult,
  type WorkStateWriter,
} from './autonomous-work-state.js';
import type { ObservationSourceKind } from './observation-receipt.js';
import { normalizeSafeProjectRelativePath } from './path-normalization.js';
import { isRecordObject, isValidRecordTimestamp } from './record-validation.js';
import { stableJson } from './stable-json.js';

export const COMPLETION_TRANSITION_RULE_RECORD_KIND = 'scip-query-completion-transition-rule' as const;
export const COMPLETION_TRANSITION_RULE_SCHEMA_VERSION = 1 as const;

export const GOAL_TRANSITION_FIELDS = ['feature', 'invariants', 'acceptance-scenarios'] as const;
export type GoalTransitionField = (typeof GOAL_TRANSITION_FIELDS)[number];

const TRANSITION_RULE_ID_PATTERN = /^SQTR-[A-F0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OBSERVATION_SOURCE_KINDS = [
  'index-generation',
  'repository-snapshot',
  'live-workspace',
  'process',
] as const satisfies readonly ObservationSourceKind[];
const MAX_ARTIFACT_TRANSITIONS = 32;
const MAX_EVIDENCE_RECEIPTS = 8;

export interface TransitionEvidenceQualification {
  predicate: CompletionPredicate;
  minimumReceipts: number;
  requiredSources: readonly ObservationSourceKind[];
}

/**
 * One artifact transition names the exact predecessor and successor bytes of
 * a protected judgment input. A null digest means the path must be absent.
 */
export interface ProtectedArtifactTransition {
  class: Exclude<ProtectedArtifactClass, 'goal' | 'transition-rule'>;
  path: string;
  predecessorDigest: string | null;
  successorDigest: string | null;
}

export interface CompletionTransitionRuleRequest {
  predecessorGoalId: string;
  successorGoal: Omit<GoalCreateRequest, 'predecessorGoalId'>;
  successorChange: Omit<IntendedChangeCreateRequest, 'goalId'>;
  permittedGoalFields: readonly GoalTransitionField[];
  preservedInvariants: readonly string[];
  artifactTransitions: readonly ProtectedArtifactTransition[];
  requiredEvidence: readonly TransitionEvidenceQualification[];
}

/**
 * A completion transition rule is repository-owned authority fixed before the
 * candidate judgment. It embeds the exact successor goal and intended change,
 * so one later superseding evaluation can activate their complete meaning
 * without a split-brain publication protocol.
 */
export interface CompletionTransitionRuleRecordV1 {
  kind: typeof COMPLETION_TRANSITION_RULE_RECORD_KIND;
  schemaVersion: typeof COMPLETION_TRANSITION_RULE_SCHEMA_VERSION;
  transitionRuleId: string;
  collaborationDomainId: string;
  predecessorGoal: GoalRecordV1;
  successorGoal: GoalRecordV1;
  successorChangeRequest: Omit<IntendedChangeCreateRequest, 'goalId'>;
  successorChange: IntendedChangeRecordV1;
  permittedGoalFields: readonly GoalTransitionField[];
  preservedInvariants: readonly string[];
  artifactTransitions: readonly ProtectedArtifactTransition[];
  requiredEvidence: readonly TransitionEvidenceQualification[];
  createdAt: string;
  writer: WorkStateWriter;
}

export interface CreateCompletionTransitionRuleInput {
  collaborationDomainId: string;
  predecessorGoal: GoalRecordV1;
  request: CompletionTransitionRuleRequest;
  createdAt: string;
  toolVersion: string;
}

export interface TransitionRuleEvaluation {
  state: 'applicable' | 'unsatisfied';
  reasons: readonly string[];
}

export function decodeCompletionTransitionRuleRequest(
  value: unknown,
): WorkStateRequestDecodeResult<CompletionTransitionRuleRequest> {
  if (!isRecordObject(value)) {
    return { ok: false, error: 'completion transition-rule request must be an object' };
  }
  if (!isGoalId(value['predecessorGoalId'])) {
    return { ok: false, error: 'predecessorGoalId must be a goal identity' };
  }
  if (!isRecordObject(value['successorGoal'])) {
    return { ok: false, error: 'successorGoal must be a goal request' };
  }
  const successorGoal = decodeGoalCreateRequest({
    ...value['successorGoal'],
    predecessorGoalId: value['predecessorGoalId'],
  });
  if (!successorGoal.ok) return successorGoal;
  if (!isRecordObject(value['successorChange'])) {
    return { ok: false, error: 'successorChange must be an intended-change request without goalId' };
  }
  const successorChange = decodeIntendedChangeCreateRequest({
    ...value['successorChange'],
    goalId: 'SQG-00000000000000000000000000000000',
  });
  if (!successorChange.ok) return successorChange;
  const permittedGoalFields = decodeGoalTransitionFields(value['permittedGoalFields']);
  if (!permittedGoalFields.ok) return permittedGoalFields;
  const preservedInvariants = decodeCanonicalLines(value['preservedInvariants'], 'preservedInvariants');
  if (!preservedInvariants.ok) return preservedInvariants;
  const artifactTransitions = decodeArtifactTransitions(value['artifactTransitions']);
  if (!artifactTransitions.ok) return artifactTransitions;
  const requiredEvidence = decodeRequiredEvidence(value['requiredEvidence']);
  if (!requiredEvidence.ok) return requiredEvidence;
  const { predecessorGoalId: _predecessorGoalId, ...successorGoalRequest } = successorGoal.request;
  const { goalId: _goalId, ...successorChangeRequest } = successorChange.request;
  return {
    ok: true,
    request: {
      predecessorGoalId: value['predecessorGoalId'],
      successorGoal: successorGoalRequest,
      successorChange: successorChangeRequest,
      permittedGoalFields: permittedGoalFields.value,
      preservedInvariants: preservedInvariants.value,
      artifactTransitions: artifactTransitions.value,
      requiredEvidence: requiredEvidence.value,
    },
  };
}

export function createCompletionTransitionRuleRecord(
  input: CreateCompletionTransitionRuleInput,
): CompletionTransitionRuleRecordV1 {
  const decoded = decodeCompletionTransitionRuleRequest(input.request);
  if (!decoded.ok) throw new Error(decoded.error);
  if (input.predecessorGoal.collaborationDomainId !== input.collaborationDomainId) {
    throw new Error('transition-rule predecessor belongs to another collaboration domain');
  }
  if (input.predecessorGoal.goalId !== decoded.request.predecessorGoalId) {
    throw new Error('transition-rule request names a different predecessor goal');
  }
  const successorGoal = createGoalRecord({
    collaborationDomainId: input.collaborationDomainId,
    request: {
      ...decoded.request.successorGoal,
      predecessorGoalId: input.predecessorGoal.goalId,
    },
    createdAt: input.createdAt,
    toolVersion: input.toolVersion,
  });
  const successorChange = createIntendedChangeRecord({
    collaborationDomainId: input.collaborationDomainId,
    request: {
      ...decoded.request.successorChange,
      goalId: successorGoal.goalId,
    },
    createdAt: input.createdAt,
    toolVersion: input.toolVersion,
  });
  validateGoalTransition(
    input.predecessorGoal,
    successorGoal,
    decoded.request.permittedGoalFields,
    decoded.request.preservedInvariants,
  );
  const meaning = transitionRuleMeaning({
    collaborationDomainId: input.collaborationDomainId,
    predecessorGoal: input.predecessorGoal,
    successorGoal,
    successorChangeRequest: decoded.request.successorChange,
    successorChange,
    permittedGoalFields: decoded.request.permittedGoalFields,
    preservedInvariants: decoded.request.preservedInvariants,
    artifactTransitions: decoded.request.artifactTransitions,
    requiredEvidence: decoded.request.requiredEvidence,
  });
  return {
    kind: COMPLETION_TRANSITION_RULE_RECORD_KIND,
    schemaVersion: COMPLETION_TRANSITION_RULE_SCHEMA_VERSION,
    transitionRuleId: transitionRuleId(meaning),
    ...meaning,
    createdAt: input.createdAt,
    writer: { tool: 'scip-query', version: input.toolVersion },
  };
}

export function decodeCompletionTransitionRuleRecord(
  value: unknown,
): WorkStateDecodeResult<CompletionTransitionRuleRecordV1> {
  if (
    isRecordObject(value) &&
    value['kind'] === COMPLETION_TRANSITION_RULE_RECORD_KIND &&
    typeof value['schemaVersion'] === 'number' &&
    value['schemaVersion'] > COMPLETION_TRANSITION_RULE_SCHEMA_VERSION
  ) {
    return {
      state: 'unsupported-future',
      error:
        `completion transition-rule schema ${value['schemaVersion']} is newer than supported version ` +
        COMPLETION_TRANSITION_RULE_SCHEMA_VERSION,
    };
  }
  if (
    !isRecordObject(value) ||
    value['kind'] !== COMPLETION_TRANSITION_RULE_RECORD_KIND ||
    value['schemaVersion'] !== COMPLETION_TRANSITION_RULE_SCHEMA_VERSION ||
    typeof value['collaborationDomainId'] !== 'string' ||
    !isValidRecordTimestamp(value['createdAt']) ||
    !isRecordObject(value['writer']) ||
    value['writer']['tool'] !== 'scip-query' ||
    typeof value['writer']['version'] !== 'string'
  ) {
    return { state: 'malformed', error: 'completion transition-rule envelope is malformed' };
  }
  const predecessorGoal = decodeGoalRecord(value['predecessorGoal']);
  if (predecessorGoal.state !== 'current') {
    return { state: 'malformed', error: `transition-rule predecessor goal is ${predecessorGoal.state}` };
  }
  const successorGoal = decodeGoalRecord(value['successorGoal']);
  if (successorGoal.state !== 'current') {
    return { state: 'malformed', error: `transition-rule successor goal is ${successorGoal.state}` };
  }
  const successorChange = decodeIntendedChangeRecord(value['successorChange']);
  if (successorChange.state !== 'current') {
    return { state: 'malformed', error: `transition-rule successor change is ${successorChange.state}` };
  }
  if (
    successorGoal.record.createdAt !== value['createdAt'] ||
    successorChange.record.createdAt !== value['createdAt'] ||
    successorGoal.record.writer.version !== value['writer']['version'] ||
    successorChange.record.writer.version !== value['writer']['version']
  ) {
    return {
      state: 'malformed',
      error: 'transition-rule successor records must share the rule publication time and writer version',
    };
  }
  const permittedGoalFields = decodeGoalTransitionFields(value['permittedGoalFields']);
  if (!permittedGoalFields.ok) return { state: 'malformed', error: permittedGoalFields.error };
  const preservedInvariants = decodeCanonicalLines(value['preservedInvariants'], 'preservedInvariants');
  if (!preservedInvariants.ok) return { state: 'malformed', error: preservedInvariants.error };
  const artifactTransitions = decodeArtifactTransitions(value['artifactTransitions']);
  if (!artifactTransitions.ok) return { state: 'malformed', error: artifactTransitions.error };
  const requiredEvidence = decodeRequiredEvidence(value['requiredEvidence']);
  if (!requiredEvidence.ok) return { state: 'malformed', error: requiredEvidence.error };
  const successorChangeRequest = decodeIntendedChangeCreateRequest({
    ...(isRecordObject(value['successorChangeRequest']) ? value['successorChangeRequest'] : {}),
    goalId: successorGoal.record.goalId,
  });
  if (!successorChangeRequest.ok) {
    return { state: 'malformed', error: `successorChangeRequest: ${successorChangeRequest.error}` };
  }
  const { goalId: _goalId, ...canonicalSuccessorChangeRequest } = successorChangeRequest.request;
  try {
    validateDecodedTransitionRelationships(
      value['collaborationDomainId'],
      predecessorGoal.record,
      successorGoal.record,
      successorChange.record,
      canonicalSuccessorChangeRequest,
      permittedGoalFields.value,
      preservedInvariants.value,
    );
  } catch (error) {
    return {
      state: 'malformed',
      error: error instanceof Error ? error.message : 'completion transition-rule meaning is invalid',
    };
  }
  const meaning = transitionRuleMeaning({
    collaborationDomainId: value['collaborationDomainId'],
    predecessorGoal: predecessorGoal.record,
    successorGoal: successorGoal.record,
    successorChangeRequest: canonicalSuccessorChangeRequest,
    successorChange: successorChange.record,
    permittedGoalFields: permittedGoalFields.value,
    preservedInvariants: preservedInvariants.value,
    artifactTransitions: artifactTransitions.value,
    requiredEvidence: requiredEvidence.value,
  });
  const expected: CompletionTransitionRuleRecordV1 = {
    kind: COMPLETION_TRANSITION_RULE_RECORD_KIND,
    schemaVersion: COMPLETION_TRANSITION_RULE_SCHEMA_VERSION,
    transitionRuleId: transitionRuleId(meaning),
    ...meaning,
    createdAt: value['createdAt'],
    writer: {
      tool: 'scip-query',
      version: value['writer']['version'],
    },
  };
  if (!isCompletionTransitionRuleId(value['transitionRuleId'])) {
    return { state: 'malformed', error: 'transitionRuleId must be a completion transition-rule identity' };
  }
  if (stableJson(value) !== stableJson(expected)) {
    return { state: 'malformed', error: 'completion transition-rule fields or identity are not canonical' };
  }
  return { state: 'current', record: expected };
}

export function completionTransitionRuleRequestMatchesRecord(
  collaborationDomainId: string,
  predecessorGoal: GoalRecordV1,
  request: CompletionTransitionRuleRequest,
  record: CompletionTransitionRuleRecordV1,
): boolean {
  try {
    const candidate = createCompletionTransitionRuleRecord({
      collaborationDomainId,
      predecessorGoal,
      request,
      createdAt: record.createdAt,
      toolVersion: record.writer.version,
    });
    return stableJson(candidate) === stableJson(record);
  } catch {
    return false;
  }
}

export function evaluateCompletionTransitionRule(
  rule: CompletionTransitionRuleRecordV1,
  evaluation: Pick<CompletionEvaluationRecordV1, 'goalId' | 'predicates'>,
  artifactMatches: ReadonlyMap<string, boolean>,
): TransitionRuleEvaluation {
  const reasons: string[] = [];
  if (evaluation.goalId !== rule.predecessorGoal.goalId) {
    reasons.push(`evaluation goal ${evaluation.goalId} does not match predecessor ${rule.predecessorGoal.goalId}`);
  }
  const predicates = new Map(evaluation.predicates.map((judgment) => [judgment.predicate, judgment]));
  for (const qualification of rule.requiredEvidence) {
    const judgment = predicates.get(qualification.predicate);
    if (!judgment || judgment.state !== 'established') {
      reasons.push(`${qualification.predicate} is not established`);
      continue;
    }
    if (judgment.evidenceReceipts.length < qualification.minimumReceipts) {
      reasons.push(
        `${qualification.predicate} has ${judgment.evidenceReceipts.length} evidence receipt(s); ` +
          `${qualification.minimumReceipts} required`,
      );
    }
    for (const source of qualification.requiredSources) {
      if (!judgment.evidenceReceipts.some((receipt) => receipt.observedSources.some((fact) => fact.kind === source))) {
        reasons.push(`${qualification.predicate} lacks required ${source} evidence`);
      }
    }
  }
  for (const transition of rule.artifactTransitions) {
    if (artifactMatches.get(transition.path) !== true) {
      reasons.push(`${transition.path} does not match its authorized predecessor/successor artifact versions`);
    }
  }
  return reasons.length === 0
    ? { state: 'applicable', reasons: [] }
    : { state: 'unsatisfied', reasons: [...new Set(reasons)].sort() };
}

export function transitionRuleAuthorizedReferents(
  rule: CompletionTransitionRuleRecordV1,
): Partial<Record<ProtectedArtifactClass, string>> {
  const classes = new Set<ProtectedArtifactClass>([
    'goal',
    ...rule.artifactTransitions.map((transition) => transition.class),
  ]);
  return Object.fromEntries(
    [...classes].map((artifactClass) => [artifactClass, `transition-rule:${rule.transitionRuleId}#${artifactClass}`]),
  );
}

export function isCompletionTransitionRuleId(value: unknown): value is string {
  return typeof value === 'string' && TRANSITION_RULE_ID_PATTERN.test(value);
}

function validateGoalTransition(
  predecessor: GoalRecordV1,
  successor: GoalRecordV1,
  permittedFields: readonly GoalTransitionField[],
  preservedInvariants: readonly string[],
): void {
  const changedFields: GoalTransitionField[] = [];
  if (predecessor.gherkin.feature !== successor.gherkin.feature) changedFields.push('feature');
  if (stableJson(predecessor.gherkin.invariants) !== stableJson(successor.gherkin.invariants)) {
    changedFields.push('invariants');
  }
  if (stableJson(predecessor.gherkin.acceptanceScenarios) !== stableJson(successor.gherkin.acceptanceScenarios)) {
    changedFields.push('acceptance-scenarios');
  }
  if (changedFields.length === 0) {
    throw new Error('a completion transition rule must produce a semantically distinct successor goal');
  }
  if (stableJson(changedFields) !== stableJson(permittedFields)) {
    throw new Error(`permittedGoalFields must name exactly the changed goal fields: ${changedFields.join(', ')}`);
  }
  const actuallyPreserved = predecessor.gherkin.invariants.filter((invariant) =>
    successor.gherkin.invariants.includes(invariant),
  );
  if (stableJson(actuallyPreserved) !== stableJson(preservedInvariants)) {
    throw new Error('preservedInvariants must name every predecessor invariant retained by the successor');
  }
}

function validateDecodedTransitionRelationships(
  collaborationDomainId: string,
  predecessor: GoalRecordV1,
  successor: GoalRecordV1,
  successorChange: IntendedChangeRecordV1,
  successorChangeRequest: Omit<IntendedChangeCreateRequest, 'goalId'>,
  permittedFields: readonly GoalTransitionField[],
  preservedInvariants: readonly string[],
): void {
  if (
    predecessor.collaborationDomainId !== collaborationDomainId ||
    successor.collaborationDomainId !== collaborationDomainId ||
    successorChange.collaborationDomainId !== collaborationDomainId
  ) {
    throw new Error('transition-rule embedded records must belong to its collaboration domain');
  }
  if (successor.predecessorGoalId !== predecessor.goalId) {
    throw new Error('transition-rule successor goal must name the embedded predecessor');
  }
  if (successorChange.goalId !== successor.goalId) {
    throw new Error('transition-rule successor change must be governed by the embedded successor goal');
  }
  const decodedChangeRequest = decodeIntendedChangeCreateRequest({
    ...successorChangeRequest,
    goalId: successor.goalId,
  });
  if (!decodedChangeRequest.ok) {
    throw new Error('transition-rule successor change request is malformed');
  }
  const expectedChange = createIntendedChangeRecord({
    collaborationDomainId,
    request: decodedChangeRequest.request,
    createdAt: successorChange.createdAt,
    toolVersion: successorChange.writer.version,
  });
  if (stableJson(expectedChange) !== stableJson(successorChange)) {
    throw new Error('transition-rule successor change request does not produce the embedded successor change');
  }
  validateGoalTransition(predecessor, successor, permittedFields, preservedInvariants);
}

function transitionRuleMeaning(input: {
  collaborationDomainId: string;
  predecessorGoal: GoalRecordV1;
  successorGoal: GoalRecordV1;
  successorChangeRequest: Omit<IntendedChangeCreateRequest, 'goalId'>;
  successorChange: IntendedChangeRecordV1;
  permittedGoalFields: readonly GoalTransitionField[];
  preservedInvariants: readonly string[];
  artifactTransitions: readonly ProtectedArtifactTransition[];
  requiredEvidence: readonly TransitionEvidenceQualification[];
}) {
  return {
    collaborationDomainId: input.collaborationDomainId,
    predecessorGoal: input.predecessorGoal,
    successorGoal: input.successorGoal,
    successorChangeRequest: input.successorChangeRequest,
    successorChange: input.successorChange,
    permittedGoalFields: input.permittedGoalFields,
    preservedInvariants: input.preservedInvariants,
    artifactTransitions: input.artifactTransitions,
    requiredEvidence: input.requiredEvidence,
  };
}

function transitionRuleId(meaning: ReturnType<typeof transitionRuleMeaning>): string {
  return `SQTR-${hashIdentity({
    version: COMPLETION_TRANSITION_RULE_SCHEMA_VERSION,
    recordKind: COMPLETION_TRANSITION_RULE_RECORD_KIND,
    meaning,
  })
    .slice(0, 32)
    .toUpperCase()}`;
}

function decodeGoalTransitionFields(
  value: unknown,
): { ok: true; value: GoalTransitionField[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: 'permittedGoalFields must name at least one goal field' };
  }
  if (
    !value.every((field): field is GoalTransitionField => GOAL_TRANSITION_FIELDS.includes(field as GoalTransitionField))
  ) {
    return { ok: false, error: 'permittedGoalFields contains an unknown goal field' };
  }
  const canonical = GOAL_TRANSITION_FIELDS.filter((field) => value.includes(field));
  if (stableJson(value) !== stableJson(canonical)) {
    return { ok: false, error: 'permittedGoalFields must be unique and canonically ordered' };
  }
  return { ok: true, value: canonical };
}

function decodeCanonicalLines(
  value: unknown,
  label: string,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return { ok: false, error: `${label} must be an array of canonical text lines` };
  }
  const normalized = value.map((entry) => normalizedBoundedLine(entry, 300));
  if (normalized.some((entry) => entry === undefined)) {
    return { ok: false, error: `${label} entries must be non-empty lines of at most 300 characters` };
  }
  const canonical = [...new Set(normalized as string[])];
  if (stableJson(value) !== stableJson(canonical)) {
    return { ok: false, error: `${label} must be unique and preserve predecessor order` };
  }
  return { ok: true, value: canonical };
}

function decodeArtifactTransitions(
  value: unknown,
): { ok: true; value: ProtectedArtifactTransition[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > MAX_ARTIFACT_TRANSITIONS) {
    return { ok: false, error: `artifactTransitions must contain at most ${MAX_ARTIFACT_TRANSITIONS} entries` };
  }
  const transitions: ProtectedArtifactTransition[] = [];
  for (const candidate of value) {
    if (!isRecordObject(candidate)) {
      return { ok: false, error: 'each artifact transition must be an object' };
    }
    const artifactClass = candidate['class'];
    if (
      !PROTECTED_ARTIFACT_CLASSES.includes(artifactClass as ProtectedArtifactClass) ||
      artifactClass === 'goal' ||
      artifactClass === 'transition-rule'
    ) {
      return {
        ok: false,
        error: 'artifact transition class must be evaluator, test, baseline, suppression, or configuration',
      };
    }
    let path: string;
    try {
      path = normalizeSafeProjectRelativePath(String(candidate['path'] ?? ''));
    } catch {
      return { ok: false, error: 'artifact transition path must be a safe project-relative path' };
    }
    const predecessorDigest = decodeOptionalDigest(candidate['predecessorDigest']);
    const successorDigest = decodeOptionalDigest(candidate['successorDigest']);
    if (!predecessorDigest.ok || !successorDigest.ok) {
      return { ok: false, error: 'artifact transition digests must be lowercase SHA-256 or null' };
    }
    if (predecessorDigest.value === successorDigest.value) {
      return { ok: false, error: `artifact transition ${path} does not change artifact identity` };
    }
    transitions.push({
      class: artifactClass as ProtectedArtifactTransition['class'],
      path,
      predecessorDigest: predecessorDigest.value,
      successorDigest: successorDigest.value,
    });
  }
  const canonical = [...transitions].sort(
    (left, right) =>
      PROTECTED_ARTIFACT_CLASSES.indexOf(left.class) - PROTECTED_ARTIFACT_CLASSES.indexOf(right.class) ||
      left.path.localeCompare(right.path),
  );
  if (new Set(canonical.map((transition) => transition.path)).size !== canonical.length) {
    return { ok: false, error: 'artifact transition paths must be unique' };
  }
  if (stableJson(value) !== stableJson(canonical)) {
    return { ok: false, error: 'artifactTransitions must be canonically ordered' };
  }
  return { ok: true, value: canonical };
}

function decodeOptionalDigest(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  return value === null || (typeof value === 'string' && SHA256_PATTERN.test(value))
    ? { ok: true, value }
    : { ok: false, error: 'invalid digest' };
}

function decodeRequiredEvidence(
  value: unknown,
): { ok: true; value: TransitionEvidenceQualification[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length !== COMPLETION_PREDICATES.length) {
    return {
      ok: false,
      error: `requiredEvidence must qualify all ${COMPLETION_PREDICATES.length} completion predicates`,
    };
  }
  const byPredicate = new Map<CompletionPredicate, TransitionEvidenceQualification>();
  for (const candidate of value) {
    if (
      !isRecordObject(candidate) ||
      !COMPLETION_PREDICATES.includes(candidate['predicate'] as CompletionPredicate) ||
      !Number.isSafeInteger(candidate['minimumReceipts']) ||
      Number(candidate['minimumReceipts']) < 1 ||
      Number(candidate['minimumReceipts']) > MAX_EVIDENCE_RECEIPTS ||
      !Array.isArray(candidate['requiredSources']) ||
      candidate['requiredSources'].length === 0 ||
      !candidate['requiredSources'].every((source) =>
        OBSERVATION_SOURCE_KINDS.includes(source as ObservationSourceKind),
      )
    ) {
      return { ok: false, error: 'requiredEvidence contains an invalid qualification' };
    }
    const predicate = candidate['predicate'] as CompletionPredicate;
    const candidateSources = candidate['requiredSources'] as unknown[];
    const requiredSources = OBSERVATION_SOURCE_KINDS.filter((source) => candidateSources.includes(source));
    if (stableJson(candidate['requiredSources']) !== stableJson(requiredSources)) {
      return { ok: false, error: `${predicate} requiredSources must be unique and canonically ordered` };
    }
    if (byPredicate.has(predicate)) {
      return { ok: false, error: `${predicate} must have exactly one evidence qualification` };
    }
    byPredicate.set(predicate, {
      predicate,
      minimumReceipts: Number(candidate['minimumReceipts']),
      requiredSources,
    });
  }
  const canonical = COMPLETION_PREDICATES.map((predicate) => byPredicate.get(predicate));
  if (canonical.some((entry) => entry === undefined)) {
    return { ok: false, error: 'requiredEvidence omits a completion predicate' };
  }
  if (stableJson(value) !== stableJson(canonical)) {
    return { ok: false, error: 'requiredEvidence must follow canonical completion-predicate order' };
  }
  return { ok: true, value: canonical as TransitionEvidenceQualification[] };
}
