import { decodeObservationReceipt, type ObservationReceiptV2 } from './observation-receipt.js';
import {
  PROTECTED_ARTIFACT_CLASSES,
  type ProtectedArtifactAuthority,
  type ProtectedArtifactClass,
  type ProtectedArtifactSetSnapshot,
} from './completion-protection.js';
import { matchesPathGlob } from './path-glob.js';
import { isRecordObject, isValidRecordTimestamp } from './record-validation.js';
import { stableJson } from './stable-json.js';
import {
  assertWorkRecordInput,
  decodeWorkRecordEnvelope,
  hashIdentity,
  isGoalId,
  isIntendedChangeId,
  matchesWorkStateIdentity,
  normalizedBoundedLine,
  withoutWorkStateIdempotencyKey,
  type WorkStateDecodeResult,
  type WorkStateRequestDecodeResult,
  type WorkStateWriter,
} from './autonomous-work-state.js';
import {
  decodeWorkEventIdempotency,
  workEventIdempotency,
  workEventKeyDigest,
  type WorkEventIdempotency,
} from './autonomous-work-ledger.js';

export const COMPLETION_EVALUATION_RECORD_KIND = 'scip-query-completion-evaluation' as const;
export const COMPLETION_EVALUATION_SCHEMA_VERSION = 1 as const;
export const COMPLETION_TRANSITION_RECORD_KIND = 'scip-query-completion-transition' as const;
export const COMPLETION_TRANSITION_SCHEMA_VERSION = 1 as const;
export const COMPLETION_CONTEXT_IDENTITY_VERSION = 1 as const;
export const COMPLETION_AUTHORITY_ASSESSMENT_VERSION = 1 as const;

export const COMPLETION_PREDICATES = [
  'goal-fulfilled',
  'invariants-preserved',
  'evidence-compatible',
  'coverage-complete',
  'obligations-reconciled',
  'policy-permitted',
] as const;

export type CompletionPredicate = (typeof COMPLETION_PREDICATES)[number];
export type CompletionPredicateState = 'established' | 'disproven' | 'unknown';

const COMPLETION_EVALUATION_ID_PATTERN = /^SQE-[A-F0-9]{32}$/u;
const COMPLETION_TRANSITION_ID_PATTERN = /^SQCT-[A-F0-9]{32}$/u;
const COMPLETION_CONTEXT_ID_PATTERN = /^SQX-[A-F0-9]{32}$/u;
const COMPLETION_AUTHORITY_ASSESSMENT_ID_PATTERN = /^SQA-[A-F0-9]{32}$/u;
const TRANSITION_RULE_ID_PATTERN = /^SQTR-[A-F0-9]{32}$/u;
const MAX_PREDICATE_REASONS = 16;
const MAX_REASON_CHARACTERS = 500;
const MAX_EVIDENCE_RECEIPTS_PER_PREDICATE = 8;
const MAX_POLICY_ID_CHARACTERS = 200;
const MAX_EVALUATOR_ID_CHARACTERS = 200;
const MAX_VERSION_CHARACTERS = 200;
const MAX_PROTECTED_CHANGED_PATHS = 10_000;
const MAX_AUTHORITY_REFERENT_CHARACTERS = 500;

export interface CompletionPredicateJudgment {
  predicate: CompletionPredicate;
  state: CompletionPredicateState;
  reasons: readonly string[];
  evidenceReceipts: readonly ObservationReceiptV2[];
}

export interface CompletionEvaluationContextRequest {
  policyId: string;
  policyVersion: number;
  evaluatorId: string;
  evaluatorVersion: string;
  targetObservation: ObservationReceiptV2;
}

export interface CompletionEvaluationContext extends CompletionEvaluationContextRequest {
  contextId: string;
}

export interface AuthorizedSuccessor {
  transitionRuleId: string;
  successorGoalId: string;
}

export type CompletionAuthorityPredecessor =
  | { kind: 'git-tree'; treeOid: string }
  | { kind: 'unavailable'; reason: 'no-fixed-predecessor' };

export interface CandidateControlledAuthorityEvidence {
  class: ProtectedArtifactClass;
  authority: ProtectedArtifactAuthority;
  paths: readonly string[];
}

export interface FixedOrAuthorizedAuthorityEvidence {
  class: ProtectedArtifactClass;
  authority: ProtectedArtifactAuthority;
  referent: string;
}

export interface ReflexiveAuthorityViolation {
  class: ProtectedArtifactClass;
  predicates: readonly CompletionPredicate[];
  reason: string;
}

/**
 * A completion-authority assessment partitions the artifacts that can define
 * success into candidate edits and sources fixed outside those edits. A
 * violation names the exact predicate whose only authority would otherwise be
 * an artifact changed by the candidate it is judging.
 */
export interface CompletionAuthorityAssessment {
  version: typeof COMPLETION_AUTHORITY_ASSESSMENT_VERSION;
  assessmentId: string;
  predecessor: CompletionAuthorityPredecessor;
  candidateControlled: readonly CandidateControlledAuthorityEvidence[];
  fixedOrAuthorized: readonly FixedOrAuthorizedAuthorityEvidence[];
  violations: readonly ReflexiveAuthorityViolation[];
}

export interface CompletionAuthorityReliance {
  class: ProtectedArtifactClass;
  predicates: readonly CompletionPredicate[];
  reason: string;
}

export interface CompletionEvaluationRequest {
  changeId: string;
  goalId: string;
  idempotencyKey: string;
  context: CompletionEvaluationContextRequest;
  predicates: readonly CompletionPredicateJudgment[];
  authority?: CompletionAuthorityAssessment;
  authorizedSuccessor?: AuthorizedSuccessor;
}

export type CompletionTerminalDecision =
  | {
      state: 'blocked';
      blockedPredicates: readonly CompletionPredicate[];
      unknownPredicates: readonly CompletionPredicate[];
    }
  | { state: 'complete' }
  | {
      state: 'superseded';
      transitionRuleId: string;
      successorGoalId: string;
    };

/**
 * A completion process is one goal-relative judgment moving from work that has
 * not yet been judged, through a fixed evaluation, to a terminal repository
 * meaning. Each variant carries only the facts valid for that state.
 */
export type CompletionProcessState =
  | {
      state: 'pending';
      changeId: string;
      goalId: string;
    }
  | {
      state: 'evaluating';
      changeId: string;
      goalId: string;
      contextId: string;
      startedAt: string;
    }
  | ({
      evaluationId: string;
      changeId: string;
      goalId: string;
      contextId: string;
    } & CompletionTerminalDecision);

/**
 * A completion evaluation is the immutable result of applying one evaluator
 * and policy version to one goal, intended change, fixed target observation,
 * and complete required-predicate set.
 */
export interface CompletionEvaluationRecordV1 {
  kind: typeof COMPLETION_EVALUATION_RECORD_KIND;
  schemaVersion: typeof COMPLETION_EVALUATION_SCHEMA_VERSION;
  evaluationId: string;
  collaborationDomainId: string;
  changeId: string;
  goalId: string;
  context: CompletionEvaluationContext;
  predicates: readonly CompletionPredicateJudgment[];
  authority?: CompletionAuthorityAssessment;
  decision: CompletionTerminalDecision;
  idempotency: WorkEventIdempotency;
  createdAt: string;
  writer: WorkStateWriter;
}

/**
 * A completion transition is an immutable witness that one controller-produced
 * complete evaluation changed the intended change's semantic state. Its
 * identity is derived from the evaluation, so retry cannot manufacture a
 * second transition for the same judgment.
 */
export interface CompletionTransitionRecordV1 {
  kind: typeof COMPLETION_TRANSITION_RECORD_KIND;
  schemaVersion: typeof COMPLETION_TRANSITION_SCHEMA_VERSION;
  transitionId: string;
  collaborationDomainId: string;
  changeId: string;
  goalId: string;
  evaluationId: string;
  contextId: string;
  to: 'complete';
  createdAt: string;
  writer: WorkStateWriter;
}

export interface CreateCompletionEvaluationInput {
  collaborationDomainId: string;
  request: CompletionEvaluationRequest;
  createdAt: string;
  toolVersion: string;
}

export type FoldedCompletionState =
  | {
      state: 'pending';
      changeId: string;
      goalId: string;
    }
  | {
      state: 'blocked';
      changeId: string;
      goalId: string;
      evaluationId: string;
      contextId: string;
      blockedPredicates: readonly CompletionPredicate[];
      unknownPredicates: readonly CompletionPredicate[];
    }
  | {
      state: 'complete';
      changeId: string;
      goalId: string;
      evaluationIds: readonly string[];
      transitionIds: readonly string[];
    }
  | {
      state: 'superseded';
      changeId: string;
      goalId: string;
      evaluationId: string;
      contextId: string;
      transitionRuleId: string;
      successorGoalId: string;
    }
  | {
      state: 'conflicted';
      changeId: string;
      goalId: string;
      reasons: readonly string[];
    };

export interface CompletionHistorySummary {
  evaluations: readonly CompletionEvaluationRecordV1[];
  transitions: readonly CompletionTransitionRecordV1[];
  states: readonly FoldedCompletionState[];
  conflicts: readonly string[];
  orphanTransitionIds: readonly string[];
}

export function createCompletionAuthorityAssessment(input: {
  predecessor: CompletionAuthorityPredecessor;
  changedPaths: readonly string[];
  protectedArtifacts: ProtectedArtifactSetSnapshot;
  reliances: readonly CompletionAuthorityReliance[];
  fixedReferents?: Partial<Record<ProtectedArtifactClass, string>>;
  authorizedReferents?: Partial<Record<ProtectedArtifactClass, string>>;
}): CompletionAuthorityAssessment {
  const predecessor = decodeAuthorityPredecessor(input.predecessor);
  if (!predecessor.ok) throw new Error(predecessor.error);
  const changedPaths = canonicalProtectedPaths(input.changedPaths);
  const reliances = canonicalAuthorityReliances(input.reliances);
  const relianceByClass = new Map(reliances.map((reliance) => [reliance.class, reliance]));
  const candidateControlled: CandidateControlledAuthorityEvidence[] = [];
  const fixedOrAuthorized: FixedOrAuthorizedAuthorityEvidence[] = [];
  const violations: ReflexiveAuthorityViolation[] = [];

  for (const rule of input.protectedArtifacts.rules) {
    const paths = changedPaths.filter((path) => rule.selectors.some((selector) => matchesPathGlob(selector, path)));
    if (paths.length > 0) {
      candidateControlled.push({ class: rule.class, authority: rule.authority, paths });
    }
    const reliance = relianceByClass.get(rule.class);
    if (!reliance) continue;

    const authorizedReferent = canonicalAuthorityReferent(input.authorizedReferents?.[rule.class]);
    if (paths.length > 0 && authorizedReferent) {
      fixedOrAuthorized.push({
        class: rule.class,
        authority: rule.authority,
        referent: authorizedReferent,
      });
      continue;
    }
    if (paths.length > 0) {
      violations.push({
        class: rule.class,
        predicates: reliance.predicates,
        reason: reliance.reason,
      });
      continue;
    }

    const fixedReferent = canonicalAuthorityReferent(input.fixedReferents?.[rule.class]);
    if (fixedReferent) {
      fixedOrAuthorized.push({ class: rule.class, authority: rule.authority, referent: fixedReferent });
    } else if (predecessor.value.kind === 'git-tree') {
      fixedOrAuthorized.push({
        class: rule.class,
        authority: rule.authority,
        referent: `git-tree:${predecessor.value.treeOid}#${rule.class}`,
      });
    } else {
      violations.push({
        class: rule.class,
        predicates: reliance.predicates,
        reason: `No fixed predecessor or bootstrap authority establishes the ${rule.class} evidence used by this evaluation.`,
      });
    }
  }

  const meaning = {
    version: COMPLETION_AUTHORITY_ASSESSMENT_VERSION,
    predecessor: predecessor.value,
    candidateControlled,
    fixedOrAuthorized,
    violations,
  };
  return {
    ...meaning,
    assessmentId: authorityAssessmentId(meaning),
  };
}

export function decodeCompletionAuthorityAssessment(
  value: unknown,
): { ok: true; value: CompletionAuthorityAssessment } | { ok: false; error: string } {
  if (
    !isRecordObject(value) ||
    value['version'] !== COMPLETION_AUTHORITY_ASSESSMENT_VERSION ||
    typeof value['assessmentId'] !== 'string' ||
    !COMPLETION_AUTHORITY_ASSESSMENT_ID_PATTERN.test(value['assessmentId'])
  ) {
    return { ok: false, error: 'authority assessment must have a current version and SQA identity' };
  }
  const predecessor = decodeAuthorityPredecessor(value['predecessor']);
  if (!predecessor.ok) return predecessor;
  const candidateControlled = decodeCandidateControlledEvidence(value['candidateControlled']);
  if (!candidateControlled.ok) return candidateControlled;
  const fixedOrAuthorized = decodeFixedAuthorityEvidence(value['fixedOrAuthorized']);
  if (!fixedOrAuthorized.ok) return fixedOrAuthorized;
  const violations = decodeAuthorityViolations(value['violations']);
  if (!violations.ok) return violations;
  const meaning = {
    version: COMPLETION_AUTHORITY_ASSESSMENT_VERSION,
    predecessor: predecessor.value,
    candidateControlled: candidateControlled.value,
    fixedOrAuthorized: fixedOrAuthorized.value,
    violations: violations.value,
  };
  if (authorityAssessmentId(meaning) !== value['assessmentId']) {
    return { ok: false, error: 'authority assessment identity does not match its evidence partition' };
  }
  return {
    ok: true,
    value: {
      ...meaning,
      assessmentId: value['assessmentId'],
    },
  };
}

export function applyCompletionAuthorityFirewall(
  predicates: readonly CompletionPredicateJudgment[],
  assessment: CompletionAuthorityAssessment,
): CompletionPredicateJudgment[] {
  const decodedAssessment = decodeCompletionAuthorityAssessment(assessment);
  if (!decodedAssessment.ok) throw new Error(decodedAssessment.error);
  const violationsByPredicate = new Map<CompletionPredicate, ReflexiveAuthorityViolation[]>();
  for (const violation of decodedAssessment.value.violations) {
    for (const predicate of violation.predicates) {
      const current = violationsByPredicate.get(predicate) ?? [];
      current.push(violation);
      violationsByPredicate.set(predicate, current);
    }
  }
  return predicates.map((predicate) => {
    const violations = violationsByPredicate.get(predicate.predicate);
    if (!violations || violations.length === 0) return predicate;
    const reasons = [
      ...predicate.reasons,
      ...violations.map((violation) => violation.reason),
      `Reflexive-authority assessment ${assessment.assessmentId} blocks candidate-controlled evidence from approving itself.`,
    ];
    return {
      ...predicate,
      state: predicate.state === 'disproven' ? 'disproven' : ('unknown' as const),
      reasons: [...new Set(reasons)].sort(),
    };
  });
}

export function decodeCompletionEvaluationRequest(
  value: unknown,
): WorkStateRequestDecodeResult<CompletionEvaluationRequest> {
  if (!isRecordObject(value)) {
    return { ok: false, error: 'completion evaluation request must be an object' };
  }
  if (!isIntendedChangeId(value['changeId'])) {
    return { ok: false, error: 'changeId must be an intended-change identity' };
  }
  if (!isGoalId(value['goalId'])) {
    return { ok: false, error: 'goalId must be a goal identity' };
  }
  const idempotencyKey = normalizedBoundedLine(value['idempotencyKey'], 256);
  if (!idempotencyKey) {
    return { ok: false, error: 'idempotencyKey must be a non-empty line of at most 256 characters' };
  }
  const context = decodeCompletionContextRequest(value['context']);
  if (!context.ok) return context;
  const predicates = decodeCompletionPredicates(value['predicates']);
  if (!predicates.ok) return predicates;
  const authority =
    value['authority'] === undefined ? undefined : decodeCompletionAuthorityAssessment(value['authority']);
  if (authority && !authority.ok) return authority;
  const authorizedSuccessor =
    value['authorizedSuccessor'] === undefined ? undefined : decodeAuthorizedSuccessor(value['authorizedSuccessor']);
  if (authorizedSuccessor && !authorizedSuccessor.ok) return authorizedSuccessor;
  return {
    ok: true,
    request: {
      changeId: value['changeId'],
      goalId: value['goalId'],
      idempotencyKey,
      context: context.value,
      predicates: predicates.value,
      ...(authority?.ok ? { authority: authority.value } : {}),
      ...(authorizedSuccessor?.ok ? { authorizedSuccessor: authorizedSuccessor.value } : {}),
    },
  };
}

export function createCompletionEvaluationRecord(input: CreateCompletionEvaluationInput): CompletionEvaluationRecordV1 {
  assertWorkRecordInput(input.collaborationDomainId, input.createdAt, input.toolVersion);
  const decoded = decodeCompletionEvaluationRequest(input.request);
  if (!decoded.ok) throw new Error(decoded.error);
  const keyDigest = workEventKeyDigest(
    input.collaborationDomainId,
    decoded.request.changeId,
    decoded.request.idempotencyKey,
    COMPLETION_EVALUATION_RECORD_KIND,
  );
  return {
    kind: COMPLETION_EVALUATION_RECORD_KIND,
    schemaVersion: COMPLETION_EVALUATION_SCHEMA_VERSION,
    evaluationId: evaluationIdFromDigest(keyDigest),
    collaborationDomainId: input.collaborationDomainId,
    changeId: decoded.request.changeId,
    goalId: decoded.request.goalId,
    context: completionEvaluationContext(decoded.request),
    predicates: decoded.request.predicates,
    ...(decoded.request.authority ? { authority: decoded.request.authority } : {}),
    decision: decideCompletion(decoded.request.predicates, decoded.request.authorizedSuccessor),
    idempotency: workEventIdempotency(
      keyDigest,
      completionEvaluationRequestDigest(input.collaborationDomainId, decoded.request),
    ),
    createdAt: input.createdAt,
    writer: { tool: 'scip-query', version: input.toolVersion },
  };
}

export function createCompletionTransitionRecord(
  evaluation: CompletionEvaluationRecordV1,
): CompletionTransitionRecordV1 {
  if (evaluation.decision.state !== 'complete') {
    throw new Error('a completion transition requires a complete evaluation');
  }
  return {
    kind: COMPLETION_TRANSITION_RECORD_KIND,
    schemaVersion: COMPLETION_TRANSITION_SCHEMA_VERSION,
    transitionId: completionTransitionId(evaluation),
    collaborationDomainId: evaluation.collaborationDomainId,
    changeId: evaluation.changeId,
    goalId: evaluation.goalId,
    evaluationId: evaluation.evaluationId,
    contextId: evaluation.context.contextId,
    to: 'complete',
    createdAt: evaluation.createdAt,
    writer: evaluation.writer,
  };
}

export function decodeCompletionEvaluationRecord(value: unknown): WorkStateDecodeResult<CompletionEvaluationRecordV1> {
  const envelope = decodeWorkRecordEnvelope(value, {
    recordKind: COMPLETION_EVALUATION_RECORD_KIND,
    schemaVersion: COMPLETION_EVALUATION_SCHEMA_VERSION,
    label: 'completion evaluation',
  });
  if (!envelope.ok) return envelope.result;
  const fields = envelope.envelope.value;
  const decoded = decodeCompletionEvaluationRequest({
    changeId: fields['changeId'],
    goalId: fields['goalId'],
    idempotencyKey: 'record-key-placeholder',
    context: contextRequestFromRecord(fields['context']),
    predicates: fields['predicates'],
    ...(fields['authority'] === undefined ? {} : { authority: fields['authority'] }),
    ...(isRecordObject(fields['decision']) && fields['decision']['state'] === 'superseded'
      ? {
          authorizedSuccessor: {
            transitionRuleId: fields['decision']['transitionRuleId'],
            successorGoalId: fields['decision']['successorGoalId'],
          },
        }
      : {}),
  });
  if (!decoded.ok) return { state: 'malformed', error: decoded.error };
  if (!isCompletionEvaluationId(fields['evaluationId'])) {
    return { state: 'malformed', error: 'evaluationId must be a completion-evaluation identity' };
  }
  const idempotency = decodeWorkEventIdempotency(fields['idempotency']);
  if (!idempotency.ok) return { state: 'malformed', error: idempotency.error };
  if (fields['evaluationId'] !== evaluationIdFromDigest(idempotency.value.keyDigest)) {
    return { state: 'malformed', error: 'evaluationId does not match the idempotency key digest' };
  }
  const expectedRequestDigest = completionEvaluationRequestDigest(
    envelope.envelope.collaborationDomainId,
    decoded.request,
  );
  if (idempotency.value.requestDigest !== expectedRequestDigest) {
    return { state: 'malformed', error: 'requestDigest does not match the completion evaluation meaning' };
  }
  const context = completionEvaluationContext(decoded.request);
  if (
    !isRecordObject(fields['context']) ||
    fields['context']['contextId'] !== context.contextId ||
    stableJson(fields['context']) !== stableJson(context)
  ) {
    return { state: 'malformed', error: 'completion context identity or fields are not canonical' };
  }
  if (stableJson(fields['predicates']) !== stableJson(decoded.request.predicates)) {
    return { state: 'malformed', error: 'completion predicates must use canonical order and evidence' };
  }
  if (
    decoded.request.authority
      ? stableJson(fields['authority']) !== stableJson(decoded.request.authority)
      : fields['authority'] !== undefined
  ) {
    return { state: 'malformed', error: 'completion authority assessment must be canonical' };
  }
  const decision = decideCompletion(decoded.request.predicates, decoded.request.authorizedSuccessor);
  if (stableJson(fields['decision']) !== stableJson(decision)) {
    return { state: 'malformed', error: 'completion decision does not follow from its predicates' };
  }
  return {
    state: 'current',
    record: {
      kind: COMPLETION_EVALUATION_RECORD_KIND,
      schemaVersion: COMPLETION_EVALUATION_SCHEMA_VERSION,
      evaluationId: fields['evaluationId'],
      collaborationDomainId: envelope.envelope.collaborationDomainId,
      changeId: decoded.request.changeId,
      goalId: decoded.request.goalId,
      context,
      predicates: decoded.request.predicates,
      ...(decoded.request.authority ? { authority: decoded.request.authority } : {}),
      decision,
      idempotency: idempotency.value,
      createdAt: envelope.envelope.createdAt,
      writer: envelope.envelope.writer,
    },
  };
}

export function decodeCompletionTransitionRecord(value: unknown): WorkStateDecodeResult<CompletionTransitionRecordV1> {
  const envelope = decodeWorkRecordEnvelope(value, {
    recordKind: COMPLETION_TRANSITION_RECORD_KIND,
    schemaVersion: COMPLETION_TRANSITION_SCHEMA_VERSION,
    label: 'completion transition',
  });
  if (!envelope.ok) return envelope.result;
  const fields = envelope.envelope.value;
  if (!isCompletionTransitionId(fields['transitionId'])) {
    return { state: 'malformed', error: 'transitionId must be a completion-transition identity' };
  }
  if (!isIntendedChangeId(fields['changeId'])) {
    return { state: 'malformed', error: 'changeId must be an intended-change identity' };
  }
  if (!isGoalId(fields['goalId'])) {
    return { state: 'malformed', error: 'goalId must be a goal identity' };
  }
  if (!isCompletionEvaluationId(fields['evaluationId'])) {
    return { state: 'malformed', error: 'evaluationId must be a completion-evaluation identity' };
  }
  if (!isCompletionContextId(fields['contextId'])) {
    return { state: 'malformed', error: 'contextId must be a completion-context identity' };
  }
  if (fields['to'] !== 'complete') {
    return { state: 'malformed', error: 'completion transition target must be complete' };
  }
  const record: CompletionTransitionRecordV1 = {
    kind: COMPLETION_TRANSITION_RECORD_KIND,
    schemaVersion: COMPLETION_TRANSITION_SCHEMA_VERSION,
    transitionId: fields['transitionId'],
    collaborationDomainId: envelope.envelope.collaborationDomainId,
    changeId: fields['changeId'],
    goalId: fields['goalId'],
    evaluationId: fields['evaluationId'],
    contextId: fields['contextId'],
    to: 'complete',
    createdAt: envelope.envelope.createdAt,
    writer: envelope.envelope.writer,
  };
  if (record.transitionId !== completionTransitionId(record)) {
    return { state: 'malformed', error: 'transitionId does not match the completion transition meaning' };
  }
  return { state: 'current', record };
}

export function decodeCompletionRecord(
  value: unknown,
): WorkStateDecodeResult<CompletionEvaluationRecordV1 | CompletionTransitionRecordV1> {
  if (!isRecordObject(value)) return { state: 'malformed', error: 'completion record must be an object' };
  if (value['kind'] === COMPLETION_EVALUATION_RECORD_KIND) return decodeCompletionEvaluationRecord(value);
  if (value['kind'] === COMPLETION_TRANSITION_RECORD_KIND) return decodeCompletionTransitionRecord(value);
  return { state: 'malformed', error: 'unrecognized completion record kind' };
}

export function completionEvaluationRequestMatchesRecord(
  collaborationDomainId: string,
  request: CompletionEvaluationRequest,
  record: CompletionEvaluationRecordV1,
): boolean {
  const decoded = decodeCompletionEvaluationRequest(request);
  return (
    decoded.ok &&
    record.collaborationDomainId === collaborationDomainId &&
    record.idempotency.requestDigest === completionEvaluationRequestDigest(collaborationDomainId, decoded.request)
  );
}

export function completionTransitionMatchesEvaluation(
  transition: CompletionTransitionRecordV1,
  evaluation: CompletionEvaluationRecordV1,
): boolean {
  return (
    evaluation.decision.state === 'complete' &&
    transition.transitionId === completionTransitionId(evaluation) &&
    transition.collaborationDomainId === evaluation.collaborationDomainId &&
    transition.changeId === evaluation.changeId &&
    transition.goalId === evaluation.goalId &&
    transition.evaluationId === evaluation.evaluationId &&
    transition.contextId === evaluation.context.contextId &&
    transition.createdAt === evaluation.createdAt &&
    stableJson(transition.writer) === stableJson(evaluation.writer)
  );
}

export function beginCompletionEvaluation(
  changeId: string,
  goalId: string,
  contextId: string,
  startedAt: string,
): Extract<CompletionProcessState, { state: 'evaluating' }> {
  if (!isIntendedChangeId(changeId)) throw new Error('changeId must be an intended-change identity');
  if (!isGoalId(goalId)) throw new Error('goalId must be a goal identity');
  if (!isCompletionContextId(contextId)) throw new Error('contextId must be a completion-context identity');
  if (!isValidRecordTimestamp(startedAt)) throw new Error('startedAt must be a valid timestamp');
  return { state: 'evaluating', changeId, goalId, contextId, startedAt };
}

export function foldCompletionHistory(
  changes: readonly { changeId: string; goalId: string }[],
  evaluationsInput: readonly CompletionEvaluationRecordV1[],
  transitionsInput: readonly CompletionTransitionRecordV1[],
): CompletionHistorySummary {
  const conflicts: string[] = [];
  const evaluations = uniqueRecords(
    evaluationsInput,
    (evaluation) => evaluation.evaluationId,
    'completion evaluation',
    conflicts,
  ).sort(compareEvaluations);
  const transitions = uniqueRecords(
    transitionsInput,
    (transition) => transition.transitionId,
    'completion transition',
    conflicts,
  ).sort(compareTransitions);
  const changesById = new Map(changes.map((change) => [change.changeId, change]));
  const evaluationsById = new Map(evaluations.map((evaluation) => [evaluation.evaluationId, evaluation]));
  const orphanTransitionIds: string[] = [];
  const transitionsByChange = new Map<string, CompletionTransitionRecordV1[]>();
  for (const transition of transitions) {
    const evaluation = evaluationsById.get(transition.evaluationId);
    if (!evaluation || !completionTransitionMatchesEvaluation(transition, evaluation)) {
      orphanTransitionIds.push(transition.transitionId);
      continue;
    }
    const group = transitionsByChange.get(transition.changeId) ?? [];
    group.push(transition);
    transitionsByChange.set(transition.changeId, group);
  }
  const states = changes.map((change) => {
    const changeEvaluations = evaluations.filter((evaluation) => evaluation.changeId === change.changeId);
    const changeTransitions = transitionsByChange.get(change.changeId) ?? [];
    return foldCompletionChangeState(change, changeEvaluations, changeTransitions, conflicts);
  });
  for (const evaluation of evaluations) {
    const change = changesById.get(evaluation.changeId);
    if (!change) conflicts.push(`${evaluation.evaluationId} references missing change ${evaluation.changeId}`);
    else if (change.goalId !== evaluation.goalId) {
      conflicts.push(`${evaluation.evaluationId} evaluates goal ${evaluation.goalId} instead of ${change.goalId}`);
    }
  }
  return {
    evaluations,
    transitions,
    states,
    conflicts: [...new Set(conflicts)].sort(),
    orphanTransitionIds: [...new Set(orphanTransitionIds)].sort(),
  };
}

function uniqueRecords<RecordType>(
  records: readonly RecordType[],
  identity: (record: RecordType) => string,
  label: string,
  conflicts: string[],
): RecordType[] {
  const byId = new Map<string, RecordType>();
  for (const record of records) {
    const id = identity(record);
    const existing = byId.get(id);
    if (existing && stableJson(existing) !== stableJson(record)) {
      conflicts.push(`${label} ${id} has conflicting meanings`);
      continue;
    }
    byId.set(id, record);
  }
  return [...byId.values()];
}

export function isCompletionEvaluationId(value: unknown): value is string {
  return matchesWorkStateIdentity(value, COMPLETION_EVALUATION_ID_PATTERN);
}

export function isCompletionTransitionId(value: unknown): value is string {
  return matchesWorkStateIdentity(value, COMPLETION_TRANSITION_ID_PATTERN);
}

export function isCompletionContextId(value: unknown): value is string {
  return matchesWorkStateIdentity(value, COMPLETION_CONTEXT_ID_PATTERN);
}

function foldCompletionChangeState(
  change: { changeId: string; goalId: string },
  evaluations: readonly CompletionEvaluationRecordV1[],
  transitions: readonly CompletionTransitionRecordV1[],
  conflicts: string[],
): FoldedCompletionState {
  const changeIdentity = { changeId: change.changeId, goalId: change.goalId };
  if (transitions.length > 0) {
    const goalIds = new Set(transitions.map((transition) => transition.goalId));
    if (goalIds.size !== 1 || !goalIds.has(change.goalId)) {
      const reason = `${change.changeId} has completion transitions for conflicting goals`;
      conflicts.push(reason);
      return { state: 'conflicted', ...changeIdentity, reasons: [reason] };
    }
    return {
      state: 'complete',
      ...changeIdentity,
      evaluationIds: [...new Set(transitions.map((transition) => transition.evaluationId))].sort(),
      transitionIds: [...new Set(transitions.map((transition) => transition.transitionId))].sort(),
    };
  }
  const latest = evaluations.at(-1);
  if (!latest) return { state: 'pending', ...changeIdentity };
  if (latest.decision.state === 'superseded') {
    return {
      state: 'superseded',
      ...changeIdentity,
      evaluationId: latest.evaluationId,
      contextId: latest.context.contextId,
      transitionRuleId: latest.decision.transitionRuleId,
      successorGoalId: latest.decision.successorGoalId,
    };
  }
  if (latest.decision.state === 'complete') {
    const reason = `${latest.evaluationId} is complete but its transition is missing`;
    conflicts.push(reason);
    return { state: 'conflicted', ...changeIdentity, reasons: [reason] };
  }
  return {
    state: 'blocked',
    ...changeIdentity,
    evaluationId: latest.evaluationId,
    contextId: latest.context.contextId,
    blockedPredicates: latest.decision.blockedPredicates,
    unknownPredicates: latest.decision.unknownPredicates,
  };
}

function decodeCompletionContextRequest(
  value: unknown,
): { ok: true; value: CompletionEvaluationContextRequest } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'context must be an object' };
  const policyId = normalizedBoundedLine(value['policyId'], MAX_POLICY_ID_CHARACTERS);
  const evaluatorId = normalizedBoundedLine(value['evaluatorId'], MAX_EVALUATOR_ID_CHARACTERS);
  const evaluatorVersion = normalizedBoundedLine(value['evaluatorVersion'], MAX_VERSION_CHARACTERS);
  if (!policyId || !evaluatorId || !evaluatorVersion) {
    return { ok: false, error: 'context policy and evaluator identities must be canonical bounded text' };
  }
  if (!Number.isSafeInteger(value['policyVersion']) || Number(value['policyVersion']) <= 0) {
    return { ok: false, error: 'context policyVersion must be a positive safe integer' };
  }
  const targetObservation = decodeObservationReceipt(value['targetObservation']);
  if (targetObservation.kind !== 'supported') {
    return {
      ok: false,
      error: `context targetObservation must be a supported version-2 receipt (${targetObservation.kind})`,
    };
  }
  return {
    ok: true,
    value: {
      policyId,
      policyVersion: Number(value['policyVersion']),
      evaluatorId,
      evaluatorVersion,
      targetObservation: targetObservation.receipt,
    },
  };
}

function contextRequestFromRecord(value: unknown): unknown {
  if (!isRecordObject(value)) return value;
  return {
    policyId: value['policyId'],
    policyVersion: value['policyVersion'],
    evaluatorId: value['evaluatorId'],
    evaluatorVersion: value['evaluatorVersion'],
    targetObservation: value['targetObservation'],
  };
}

function decodeCompletionPredicates(
  value: unknown,
): { ok: true; value: CompletionPredicateJudgment[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length !== COMPLETION_PREDICATES.length) {
    return {
      ok: false,
      error: `predicates must contain exactly ${COMPLETION_PREDICATES.length} required judgments`,
    };
  }
  const byPredicate = new Map<CompletionPredicate, CompletionPredicateJudgment>();
  for (const candidate of value) {
    const decoded = decodeCompletionPredicate(candidate);
    if (!decoded.ok) return decoded;
    if (byPredicate.has(decoded.value.predicate)) {
      return { ok: false, error: `predicate ${decoded.value.predicate} must appear exactly once` };
    }
    byPredicate.set(decoded.value.predicate, decoded.value);
  }
  const missing = COMPLETION_PREDICATES.filter((predicate) => !byPredicate.has(predicate));
  if (missing.length > 0) {
    return { ok: false, error: `missing required completion predicates: ${missing.join(', ')}` };
  }
  return { ok: true, value: COMPLETION_PREDICATES.map((predicate) => byPredicate.get(predicate)!) };
}

function decodeCompletionPredicate(
  value: unknown,
): { ok: true; value: CompletionPredicateJudgment } | { ok: false; error: string } {
  if (!isRecordObject(value) || !isCompletionPredicate(value['predicate'])) {
    return { ok: false, error: 'each predicate judgment must name a required completion predicate' };
  }
  if (!isCompletionPredicateState(value['state'])) {
    return { ok: false, error: `predicate ${value['predicate']} has an invalid state` };
  }
  const reasons = decodeCanonicalLines(value['reasons'], MAX_PREDICATE_REASONS, MAX_REASON_CHARACTERS);
  if (!reasons.ok) return { ok: false, error: `predicate ${value['predicate']}: ${reasons.error}` };
  const evidence = decodePredicateEvidence(value['evidenceReceipts']);
  if (!evidence.ok) return { ok: false, error: `predicate ${value['predicate']}: ${evidence.error}` };
  return {
    ok: true,
    value: {
      predicate: value['predicate'],
      state: value['state'],
      reasons: reasons.value,
      evidenceReceipts: evidence.value,
    },
  };
}

function decodePredicateEvidence(
  value: unknown,
): { ok: true; value: ObservationReceiptV2[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_RECEIPTS_PER_PREDICATE) {
    return {
      ok: false,
      error: `evidenceReceipts must contain at most ${MAX_EVIDENCE_RECEIPTS_PER_PREDICATE} receipts`,
    };
  }
  const receipts: ObservationReceiptV2[] = [];
  for (const candidate of value) {
    const decoded = decodeObservationReceipt(candidate);
    if (decoded.kind !== 'supported') {
      return { ok: false, error: `evidence receipt must be a supported version-2 receipt (${decoded.kind})` };
    }
    receipts.push(decoded.receipt);
  }
  const byMeaning = new Map(receipts.map((receipt) => [stableJson(receipt), receipt]));
  return {
    ok: true,
    value: [...byMeaning].sort(([left], [right]) => left.localeCompare(right)).map(([, receipt]) => receipt),
  };
}

function decodeCanonicalLines(
  value: unknown,
  maximumEntries: number,
  maximumCharacters: number,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumEntries) {
    return { ok: false, error: `reasons must contain 1-${maximumEntries} entries` };
  }
  const normalized = value.map((entry) => normalizedBoundedLine(entry, maximumCharacters));
  if (normalized.some((entry) => entry === null)) {
    return { ok: false, error: `reasons must be canonical text of at most ${maximumCharacters} characters` };
  }
  const unique = [...new Set(normalized as string[])].sort();
  if (unique.length !== normalized.length) return { ok: false, error: 'reasons must be unique' };
  return { ok: true, value: unique };
}

function decodeAuthorityPredecessor(
  value: unknown,
): { ok: true; value: CompletionAuthorityPredecessor } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'authority predecessor must be an object' };
  if (
    value['kind'] === 'git-tree' &&
    typeof value['treeOid'] === 'string' &&
    /^[a-f0-9]{40,64}$/u.test(value['treeOid'])
  ) {
    return { ok: true, value: { kind: 'git-tree', treeOid: value['treeOid'] } };
  }
  if (value['kind'] === 'unavailable' && value['reason'] === 'no-fixed-predecessor') {
    return { ok: true, value: { kind: 'unavailable', reason: 'no-fixed-predecessor' } };
  }
  return { ok: false, error: 'authority predecessor must name one fixed Git tree or disclose its absence' };
}

function canonicalProtectedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PROTECTED_CHANGED_PATHS) {
    throw new Error(`changed protected paths must contain at most ${MAX_PROTECTED_CHANGED_PATHS} entries`);
  }
  const normalized = value.map((path) => canonicalProtectedPath(path));
  if (normalized.some((path) => path === null)) {
    throw new Error('changed protected paths must be canonical repository-relative paths');
  }
  return [...new Set(normalized as string[])].sort();
}

function canonicalProtectedPath(value: unknown): string | null {
  if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) return null;
  const path = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+/gu, '/');
  if (
    path.length === 0 ||
    path.length > MAX_AUTHORITY_REFERENT_CHARACTERS ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return path;
}

function canonicalAuthorityReliances(value: unknown): CompletionAuthorityReliance[] {
  if (!Array.isArray(value) || value.length > PROTECTED_ARTIFACT_CLASSES.length) {
    throw new Error('authority reliances must be a bounded array with at most one entry per protected class');
  }
  const classes = new Set<ProtectedArtifactClass>();
  const reliances = value.map((candidate) => {
    if (
      !isRecordObject(candidate) ||
      !PROTECTED_ARTIFACT_CLASSES.includes(candidate['class'] as ProtectedArtifactClass)
    ) {
      throw new Error('authority reliance must name a canonical protected artifact class');
    }
    const artifactClass = candidate['class'] as ProtectedArtifactClass;
    if (classes.has(artifactClass)) throw new Error(`authority reliance class ${artifactClass} is duplicated`);
    classes.add(artifactClass);
    const predicates = canonicalAuthorityPredicates(candidate['predicates']);
    const reason = normalizedBoundedLine(candidate['reason'], MAX_REASON_CHARACTERS);
    if (!reason) throw new Error(`authority reliance ${artifactClass} must state one bounded reason`);
    return { class: artifactClass, predicates, reason };
  });
  return reliances.sort(compareProtectedClasses);
}

function canonicalAuthorityPredicates(value: unknown): CompletionPredicate[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > COMPLETION_PREDICATES.length) {
    throw new Error('authority predicates must be a non-empty bounded array');
  }
  if (value.some((predicate) => !isCompletionPredicate(predicate))) {
    throw new Error('authority predicates must name canonical completion predicates');
  }
  const unique = [...new Set(value as CompletionPredicate[])];
  if (unique.length !== value.length) throw new Error('authority predicates must be unique');
  return COMPLETION_PREDICATES.filter((predicate) => unique.includes(predicate));
}

function canonicalAuthorityReferent(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return normalizedBoundedLine(value, MAX_AUTHORITY_REFERENT_CHARACTERS) ?? undefined;
}

function decodeCandidateControlledEvidence(
  value: unknown,
): { ok: true; value: CandidateControlledAuthorityEvidence[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > PROTECTED_ARTIFACT_CLASSES.length) {
    return { ok: false, error: 'candidate-controlled authority evidence must be a bounded array' };
  }
  try {
    const classes = new Set<ProtectedArtifactClass>();
    const evidence = value.map((candidate) => {
      const header = decodeAuthorityEvidenceHeader(candidate);
      if (!header.ok) throw new Error(header.error);
      if (classes.has(header.value.class)) {
        throw new Error(`candidate-controlled class ${header.value.class} is duplicated`);
      }
      classes.add(header.value.class);
      if (!isRecordObject(candidate)) throw new Error('candidate-controlled authority evidence must be an object');
      const paths = canonicalProtectedPaths(candidate['paths']);
      if (paths.length === 0) throw new Error('candidate-controlled authority evidence must name changed paths');
      return { ...header.value, paths };
    });
    const canonical = evidence.sort(compareProtectedClasses);
    if (stableJson(value) !== stableJson(canonical)) {
      return { ok: false, error: 'candidate-controlled authority evidence must use canonical order and paths' };
    }
    return { ok: true, value: canonical };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function decodeFixedAuthorityEvidence(
  value: unknown,
): { ok: true; value: FixedOrAuthorizedAuthorityEvidence[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > PROTECTED_ARTIFACT_CLASSES.length) {
    return { ok: false, error: 'fixed authority evidence must be a bounded array' };
  }
  try {
    const classes = new Set<ProtectedArtifactClass>();
    const evidence = value.map((candidate) => {
      const header = decodeAuthorityEvidenceHeader(candidate);
      if (!header.ok) throw new Error(header.error);
      if (classes.has(header.value.class)) throw new Error(`fixed authority class ${header.value.class} is duplicated`);
      classes.add(header.value.class);
      if (!isRecordObject(candidate)) throw new Error('fixed authority evidence must be an object');
      const referent = canonicalAuthorityReferent(candidate['referent']);
      if (!referent) throw new Error('fixed authority evidence must name one bounded referent');
      return { ...header.value, referent };
    });
    const canonical = evidence.sort(compareProtectedClasses);
    if (stableJson(value) !== stableJson(canonical)) {
      return { ok: false, error: 'fixed authority evidence must use canonical order' };
    }
    return { ok: true, value: canonical };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function decodeAuthorityViolations(
  value: unknown,
): { ok: true; value: ReflexiveAuthorityViolation[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > PROTECTED_ARTIFACT_CLASSES.length) {
    return { ok: false, error: 'reflexive authority violations must be a bounded array' };
  }
  try {
    const classes = new Set<ProtectedArtifactClass>();
    const violations = value.map((candidate) => {
      if (
        !isRecordObject(candidate) ||
        !PROTECTED_ARTIFACT_CLASSES.includes(candidate['class'] as ProtectedArtifactClass)
      ) {
        throw new Error('reflexive authority violation must name a canonical protected class');
      }
      const artifactClass = candidate['class'] as ProtectedArtifactClass;
      if (classes.has(artifactClass)) throw new Error(`reflexive authority class ${artifactClass} is duplicated`);
      classes.add(artifactClass);
      const predicates = canonicalAuthorityPredicates(candidate['predicates']);
      const reason = normalizedBoundedLine(candidate['reason'], MAX_REASON_CHARACTERS);
      if (!reason) throw new Error(`reflexive authority violation ${artifactClass} must state one bounded reason`);
      return { class: artifactClass, predicates, reason };
    });
    const canonical = violations.sort(compareProtectedClasses);
    if (stableJson(value) !== stableJson(canonical)) {
      return { ok: false, error: 'reflexive authority violations must use canonical order' };
    }
    return { ok: true, value: canonical };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function decodeAuthorityEvidenceHeader(
  value: unknown,
):
  | { ok: true; value: { class: ProtectedArtifactClass; authority: ProtectedArtifactAuthority } }
  | { ok: false; error: string } {
  if (
    !isRecordObject(value) ||
    !PROTECTED_ARTIFACT_CLASSES.includes(value['class'] as ProtectedArtifactClass) ||
    (value['authority'] !== 'bootstrap-trust-root' && value['authority'] !== 'fixed-predecessor')
  ) {
    return { ok: false, error: 'authority evidence must name a canonical class and authority rule' };
  }
  return {
    ok: true,
    value: {
      class: value['class'] as ProtectedArtifactClass,
      authority: value['authority'],
    },
  };
}

function compareProtectedClasses(
  left: { class: ProtectedArtifactClass },
  right: { class: ProtectedArtifactClass },
): number {
  return PROTECTED_ARTIFACT_CLASSES.indexOf(left.class) - PROTECTED_ARTIFACT_CLASSES.indexOf(right.class);
}

function authorityAssessmentId(meaning: Omit<CompletionAuthorityAssessment, 'assessmentId'>): string {
  return `SQA-${hashIdentity(meaning).slice(0, 32).toUpperCase()}`;
}

function decodeAuthorizedSuccessor(
  value: unknown,
): { ok: true; value: AuthorizedSuccessor } | { ok: false; error: string } {
  if (
    !isRecordObject(value) ||
    typeof value['transitionRuleId'] !== 'string' ||
    !TRANSITION_RULE_ID_PATTERN.test(value['transitionRuleId']) ||
    !isGoalId(value['successorGoalId'])
  ) {
    return {
      ok: false,
      error: 'authorizedSuccessor must name a transition-rule identity and successor goal identity',
    };
  }
  return {
    ok: true,
    value: {
      transitionRuleId: value['transitionRuleId'],
      successorGoalId: value['successorGoalId'],
    },
  };
}

function completionEvaluationContext(request: CompletionEvaluationRequest): CompletionEvaluationContext {
  return {
    contextId: completionContextId(request),
    ...request.context,
  };
}

function completionContextId(request: CompletionEvaluationRequest): string {
  const digest = hashIdentity({
    version: COMPLETION_CONTEXT_IDENTITY_VERSION,
    changeId: request.changeId,
    goalId: request.goalId,
    policyId: request.context.policyId,
    policyVersion: request.context.policyVersion,
    evaluatorId: request.context.evaluatorId,
    evaluatorVersion: request.context.evaluatorVersion,
    targetObservation: request.context.targetObservation,
  });
  return `SQX-${digest.slice(0, 32).toUpperCase()}`;
}

function decideCompletion(
  predicates: readonly CompletionPredicateJudgment[],
  authorizedSuccessor: AuthorizedSuccessor | undefined,
): CompletionTerminalDecision {
  const blockedPredicates = predicates
    .filter((predicate) => predicate.state !== 'established')
    .map((predicate) => predicate.predicate);
  const unknownPredicates = predicates
    .filter((predicate) => predicate.state === 'unknown')
    .map((predicate) => predicate.predicate);
  if (blockedPredicates.length > 0) {
    return { state: 'blocked', blockedPredicates, unknownPredicates };
  }
  if (authorizedSuccessor) return { state: 'superseded', ...authorizedSuccessor };
  return { state: 'complete' };
}

function completionEvaluationRequestDigest(
  collaborationDomainId: string,
  request: CompletionEvaluationRequest,
): string {
  return hashIdentity({
    version: COMPLETION_EVALUATION_SCHEMA_VERSION,
    collaborationDomainId,
    recordKind: COMPLETION_EVALUATION_RECORD_KIND,
    request: withoutWorkStateIdempotencyKey(request),
  });
}

function evaluationIdFromDigest(digest: string): string {
  return `SQE-${digest.slice(0, 32).toUpperCase()}`;
}

function completionTransitionId(
  evaluation:
    | CompletionEvaluationRecordV1
    | Pick<
        CompletionTransitionRecordV1,
        'collaborationDomainId' | 'changeId' | 'goalId' | 'evaluationId' | 'contextId'
      >,
): string {
  const contextId = 'context' in evaluation ? evaluation.context.contextId : evaluation.contextId;
  const digest = hashIdentity({
    version: COMPLETION_TRANSITION_SCHEMA_VERSION,
    recordKind: COMPLETION_TRANSITION_RECORD_KIND,
    collaborationDomainId: evaluation.collaborationDomainId,
    changeId: evaluation.changeId,
    goalId: evaluation.goalId,
    evaluationId: evaluation.evaluationId,
    contextId,
    to: 'complete',
  });
  return `SQCT-${digest.slice(0, 32).toUpperCase()}`;
}

function isCompletionPredicate(value: unknown): value is CompletionPredicate {
  return COMPLETION_PREDICATES.includes(value as CompletionPredicate);
}

function isCompletionPredicateState(value: unknown): value is CompletionPredicateState {
  return value === 'established' || value === 'disproven' || value === 'unknown';
}

function compareEvaluations(left: CompletionEvaluationRecordV1, right: CompletionEvaluationRecordV1): number {
  return left.createdAt.localeCompare(right.createdAt) || left.evaluationId.localeCompare(right.evaluationId);
}

function compareTransitions(left: CompletionTransitionRecordV1, right: CompletionTransitionRecordV1): number {
  return left.createdAt.localeCompare(right.createdAt) || left.transitionId.localeCompare(right.transitionId);
}
