import { decodeObservationReceipt, type ObservationReceiptV2 } from './observation-receipt.js';
import { isRecordObject, isValidRecordTimestamp } from './record-validation.js';
import { stableJson } from './stable-json.js';
import {
  hashIdentity,
  isGoalId,
  isIntendedChangeId,
  matchesWorkStateIdentity,
  normalizedBoundedLine,
  type WorkStateDecodeResult,
  type WorkStateWriter,
} from './autonomous-work-state.js';
import {
  isProtectedWorkAuthorizationId,
  type ProtectedEvaluatorAuthorization,
  type ProtectedWorkAuthorizationV1,
} from './protected-work-authorization.js';

export const PROTECTED_GOAL_EVIDENCE_KIND = 'scip-query-protected-goal-evidence' as const;
export const PROTECTED_GOAL_EVIDENCE_SCHEMA_VERSION = 1 as const;

const EVIDENCE_ID_PATTERN = /^SQGE-[A-F0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_FINDINGS_PER_CLASS = 256;
const MAX_FINDING_CHARACTERS = 1_000;

export type ProtectedGoalEvidenceState = 'established' | 'disproven' | 'unknown';

export interface ProtectedGoalEvaluatorResult {
  goalSatisfied: boolean | null;
  invariantsPreserved: boolean | null;
  affectedSurfaceReconciled: boolean | null;
  missedAffectedArtifacts: readonly string[];
  residueDefects: readonly string[];
  reintroducedBehaviors: readonly string[];
  architectureViolations: readonly string[];
}

export interface ProtectedGoalEvidenceJudgments {
  goalFulfilled: ProtectedGoalEvidenceState;
  invariantsPreserved: ProtectedGoalEvidenceState;
  affectedSurfaceReconciled: ProtectedGoalEvidenceState;
}

/**
 * Protected goal evidence is one immutable evaluator judgment stored outside
 * the candidate worktree. It is distinguished from an ordinary test result by
 * binding the pre-authorized evaluator, exact goal/change records, and exact
 * whole-repository content that the evaluator inspected.
 */
export interface ProtectedGoalEvidenceV1 {
  kind: typeof PROTECTED_GOAL_EVIDENCE_KIND;
  schemaVersion: typeof PROTECTED_GOAL_EVIDENCE_SCHEMA_VERSION;
  evidenceId: string;
  collaborationDomainId: string;
  authorizationId: string;
  authorizationRecordSha256: string;
  goalId: string;
  goalRecordDigest: string;
  changeId: string;
  changeRecordDigest: string;
  evaluator: ProtectedEvaluatorAuthorization;
  targetObservation: ObservationReceiptV2;
  result: ProtectedGoalEvaluatorResult;
  judgments: ProtectedGoalEvidenceJudgments;
  createdAt: string;
  writer: WorkStateWriter;
}

export function decodeProtectedGoalEvaluatorResult(
  value: unknown,
): { ok: true; result: ProtectedGoalEvaluatorResult } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'protected evaluator output must be an object' };
  const goalSatisfied = decodeOutcome(value['goalSatisfied'], 'goalSatisfied');
  if (!goalSatisfied.ok) return goalSatisfied;
  const invariantsPreserved = decodeOutcome(value['invariantsPreserved'], 'invariantsPreserved');
  if (!invariantsPreserved.ok) return invariantsPreserved;
  const affectedSurfaceReconciled = decodeOutcome(value['affectedSurfaceReconciled'], 'affectedSurfaceReconciled');
  if (!affectedSurfaceReconciled.ok) return affectedSurfaceReconciled;
  const missedAffectedArtifacts = boundedFindingLines(value['missedAffectedArtifacts'], 'missedAffectedArtifacts');
  if (!missedAffectedArtifacts.ok) return missedAffectedArtifacts;
  const residueDefects = boundedFindingLines(value['residueDefects'], 'residueDefects');
  if (!residueDefects.ok) return residueDefects;
  const reintroducedBehaviors = boundedFindingLines(value['reintroducedBehaviors'], 'reintroducedBehaviors');
  if (!reintroducedBehaviors.ok) return reintroducedBehaviors;
  const architectureViolations = boundedFindingLines(value['architectureViolations'], 'architectureViolations');
  if (!architectureViolations.ok) return architectureViolations;
  return {
    ok: true,
    result: {
      goalSatisfied: goalSatisfied.value,
      invariantsPreserved: invariantsPreserved.value,
      affectedSurfaceReconciled: affectedSurfaceReconciled.value,
      missedAffectedArtifacts: missedAffectedArtifacts.value,
      residueDefects: residueDefects.value,
      reintroducedBehaviors: reintroducedBehaviors.value,
      architectureViolations: architectureViolations.value,
    },
  };
}

export function createProtectedGoalEvidence(input: {
  collaborationDomainId: string;
  authorization: ProtectedWorkAuthorizationV1;
  authorizationRecordSha256: string;
  targetObservation: ObservationReceiptV2;
  evaluatorResult: ProtectedGoalEvaluatorResult;
  createdAt: string;
  toolVersion: string;
}): ProtectedGoalEvidenceV1 {
  const evaluator = input.authorization.protectedEvaluator;
  if (!evaluator) throw new Error('protected work authorization does not fix a protected evaluator');
  if (input.authorization.collaborationDomainId !== input.collaborationDomainId) {
    throw new Error('protected work authorization belongs to another collaboration domain');
  }
  if (!SHA256_PATTERN.test(input.authorizationRecordSha256)) {
    throw new Error('authorizationRecordSha256 must be a lowercase SHA-256 digest');
  }
  if (!isValidRecordTimestamp(input.createdAt)) throw new Error('createdAt must be a canonical record timestamp');
  const target = decodeObservationReceipt(input.targetObservation);
  if (
    target.kind !== 'supported' ||
    !target.receipt.facts.collaborationDomain ||
    !target.receipt.facts.wholeContent ||
    !target.receipt.stabilityProofs.some(
      (proof) => proof.source === 'repository-snapshot' && proof.kind === 'fixed-snapshot',
    )
  ) {
    throw new Error('protected goal evidence requires a fixed whole-repository observation');
  }
  const decodedResult = decodeProtectedGoalEvaluatorResult(input.evaluatorResult);
  if (!decodedResult.ok) throw new Error(decodedResult.error);
  const meaning = {
    collaborationDomainId: input.collaborationDomainId,
    authorizationId: input.authorization.authorizationId,
    authorizationRecordSha256: input.authorizationRecordSha256,
    goalId: input.authorization.goal.goalId,
    goalRecordDigest: hashIdentity(stableJson(input.authorization.goal)),
    changeId: input.authorization.change.changeId,
    changeRecordDigest: hashIdentity(stableJson(input.authorization.change)),
    evaluator,
    targetObservation: target.receipt,
    result: decodedResult.result,
    judgments: judgmentsFor(decodedResult.result),
  };
  return {
    kind: PROTECTED_GOAL_EVIDENCE_KIND,
    schemaVersion: PROTECTED_GOAL_EVIDENCE_SCHEMA_VERSION,
    evidenceId: protectedGoalEvidenceId(meaning),
    ...meaning,
    createdAt: input.createdAt,
    writer: { tool: 'scip-query', version: input.toolVersion },
  };
}

export function decodeProtectedGoalEvidence(value: unknown): WorkStateDecodeResult<ProtectedGoalEvidenceV1> {
  if (!isRecordObject(value)) return { state: 'malformed', error: 'protected goal evidence must be an object' };
  if (value['kind'] !== PROTECTED_GOAL_EVIDENCE_KIND) {
    return { state: 'malformed', error: `protected goal evidence kind must be ${PROTECTED_GOAL_EVIDENCE_KIND}` };
  }
  if (value['schemaVersion'] !== PROTECTED_GOAL_EVIDENCE_SCHEMA_VERSION) {
    return Number.isInteger(value['schemaVersion']) &&
      (value['schemaVersion'] as number) > PROTECTED_GOAL_EVIDENCE_SCHEMA_VERSION
      ? { state: 'unsupported-future', error: 'protected goal evidence schema is newer than this tool' }
      : { state: 'unsupported-older', error: 'protected goal evidence schema is older than this tool' };
  }
  if (!isProtectedGoalEvidenceId(value['evidenceId'])) {
    return { state: 'malformed', error: 'evidenceId must be a protected goal evidence identity' };
  }
  if (
    typeof value['collaborationDomainId'] !== 'string' ||
    !isProtectedWorkAuthorizationId(value['authorizationId']) ||
    typeof value['authorizationRecordSha256'] !== 'string' ||
    !SHA256_PATTERN.test(value['authorizationRecordSha256']) ||
    !isGoalId(value['goalId']) ||
    typeof value['goalRecordDigest'] !== 'string' ||
    !SHA256_PATTERN.test(value['goalRecordDigest']) ||
    !isIntendedChangeId(value['changeId']) ||
    typeof value['changeRecordDigest'] !== 'string' ||
    !SHA256_PATTERN.test(value['changeRecordDigest']) ||
    !isValidRecordTimestamp(value['createdAt']) ||
    !isRecordObject(value['writer']) ||
    value['writer']['tool'] !== 'scip-query' ||
    !normalizedBoundedLine(value['writer']['version'], 200)
  ) {
    return { state: 'malformed', error: 'protected goal evidence envelope fields are invalid' };
  }
  const target = decodeObservationReceipt(value['targetObservation']);
  if (target.kind !== 'supported') {
    return { state: 'malformed', error: 'protected goal evidence targetObservation is not current' };
  }
  const evaluator = decodeEvaluator(value['evaluator']);
  if (!evaluator.ok) return { state: 'malformed', error: evaluator.error };
  const result = decodeProtectedGoalEvaluatorResult(value['result']);
  if (!result.ok) return { state: 'malformed', error: result.error };
  const judgments = judgmentsFor(result.result);
  if (stableJson(value['judgments']) !== stableJson(judgments)) {
    return { state: 'malformed', error: 'protected goal evidence judgments do not match evaluator results' };
  }
  const meaning = {
    collaborationDomainId: value['collaborationDomainId'],
    authorizationId: value['authorizationId'],
    authorizationRecordSha256: value['authorizationRecordSha256'],
    goalId: value['goalId'],
    goalRecordDigest: value['goalRecordDigest'],
    changeId: value['changeId'],
    changeRecordDigest: value['changeRecordDigest'],
    evaluator: evaluator.value,
    targetObservation: target.receipt,
    result: result.result,
    judgments,
  };
  const decoded: ProtectedGoalEvidenceV1 = {
    kind: PROTECTED_GOAL_EVIDENCE_KIND,
    schemaVersion: PROTECTED_GOAL_EVIDENCE_SCHEMA_VERSION,
    evidenceId: value['evidenceId'],
    ...meaning,
    createdAt: value['createdAt'],
    writer: { tool: 'scip-query', version: value['writer']['version'] as string },
  };
  if (protectedGoalEvidenceId(meaning) !== decoded.evidenceId || stableJson(decoded) !== stableJson(value)) {
    return { state: 'malformed', error: 'protected goal evidence fields or identity are not canonical' };
  }
  return { state: 'current', record: decoded };
}

export function isProtectedGoalEvidenceId(value: unknown): value is string {
  return matchesWorkStateIdentity(value, EVIDENCE_ID_PATTERN);
}

function judgmentsFor(result: ProtectedGoalEvaluatorResult): ProtectedGoalEvidenceJudgments {
  return {
    goalFulfilled: stateFor(result.goalSatisfied),
    invariantsPreserved: stateFor(result.invariantsPreserved),
    affectedSurfaceReconciled: stateFor(result.affectedSurfaceReconciled),
  };
}

function stateFor(value: boolean | null): ProtectedGoalEvidenceState {
  return value === true ? 'established' : value === false ? 'disproven' : 'unknown';
}

function protectedGoalEvidenceId(meaning: Record<string, unknown>): string {
  return `SQGE-${hashIdentity(
    stableJson({ kind: PROTECTED_GOAL_EVIDENCE_KIND, version: PROTECTED_GOAL_EVIDENCE_SCHEMA_VERSION, ...meaning }),
  )
    .slice(0, 32)
    .toUpperCase()}`;
}

function decodeOutcome(
  value: unknown,
  label: string,
): { ok: true; value: boolean | null } | { ok: false; error: string } {
  return value === true || value === false || value === null
    ? { ok: true, value }
    : { ok: false, error: `${label} must be true, false, or null` };
}

function boundedFindingLines(
  value: unknown,
  label: string,
): { ok: true; value: readonly string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS_PER_CLASS) {
    return { ok: false, error: `${label} must be a bounded array` };
  }
  const lines = value.map((candidate) => normalizedBoundedLine(candidate, MAX_FINDING_CHARACTERS));
  if (lines.some((line) => line === undefined)) {
    return { ok: false, error: `${label} entries must be bounded non-empty lines` };
  }
  return { ok: true, value: [...new Set(lines as string[])].sort() };
}

function decodeEvaluator(
  value: unknown,
): { ok: true; value: ProtectedEvaluatorAuthorization } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'protected evaluator identity must be an object' };
  const evaluatorId = normalizedBoundedLine(value['evaluatorId'], 256);
  if (
    !evaluatorId ||
    !Number.isSafeInteger(value['contractVersion']) ||
    (value['contractVersion'] as number) < 1 ||
    typeof value['artifactSha256'] !== 'string' ||
    !SHA256_PATTERN.test(value['artifactSha256'])
  ) {
    return { ok: false, error: 'protected evaluator identity is invalid' };
  }
  return {
    ok: true,
    value: {
      evaluatorId,
      contractVersion: value['contractVersion'] as number,
      artifactSha256: value['artifactSha256'],
    },
  };
}
