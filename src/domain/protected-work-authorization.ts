import {
  createGoalRecord,
  createIntendedChangeRecord,
  decodeGoalCreateRequest,
  decodeGoalRecord,
  decodeIntendedChangeCreateRequest,
  decodeIntendedChangeRecord,
  decodeWorkRecordEnvelope,
  hashIdentity,
  matchesWorkStateIdentity,
  normalizedBoundedLine,
  type GoalAcceptanceScenario,
  type GoalRecordV1,
  type IntendedChangeRecordV1,
  type WorkStateDecodeResult,
  type WorkStateRequestDecodeResult,
  type WorkStateWriter,
} from './autonomous-work-state.js';
import { decodeProtectedArtifactTransitions, type ProtectedArtifactTransition } from './completion-transition-rule.js';
import { isRecordObject } from './record-validation.js';
import { stableJson } from './stable-json.js';

export const PROTECTED_WORK_AUTHORIZATION_KIND = 'scip-query-protected-work-authorization' as const;
export const PROTECTED_WORK_AUTHORIZATION_SCHEMA_VERSION = 1 as const;

const AUTHORIZATION_ID_PATTERN = /^SQWA-[A-F0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_PRINCIPAL_CHARACTERS = 256;

export interface ProtectedWorkAuthorizationRequest {
  principal: string;
  promptSha256: string;
  goal: {
    feature: string;
    invariants: readonly string[];
    acceptanceScenarios: readonly GoalAcceptanceScenario[];
  };
  change: {
    idempotencyKey: string;
    title: string;
    intendedOutcome: string;
  };
  artifactTransitions: readonly ProtectedArtifactTransition[];
}

/**
 * A protected work authorization is an immutable execution envelope fixed by
 * a principal-controlled stage outside the candidate worktree. Its exact goal,
 * change, and artifact bytes constrain what later candidate work may activate;
 * the candidate cannot broaden the grant by rewriting repository records.
 */
export interface ProtectedWorkAuthorizationV1 {
  kind: typeof PROTECTED_WORK_AUTHORIZATION_KIND;
  schemaVersion: typeof PROTECTED_WORK_AUTHORIZATION_SCHEMA_VERSION;
  authorizationId: string;
  collaborationDomainId: string;
  principal: string;
  promptSha256: string;
  intentDigest: string;
  goal: GoalRecordV1;
  changeRequest: ProtectedWorkAuthorizationRequest['change'];
  change: IntendedChangeRecordV1;
  artifactTransitions: readonly ProtectedArtifactTransition[];
  createdAt: string;
  writer: WorkStateWriter;
}

export interface CreateProtectedWorkAuthorizationInput {
  collaborationDomainId: string;
  request: ProtectedWorkAuthorizationRequest;
  createdAt: string;
  toolVersion: string;
}

export function decodeProtectedWorkAuthorizationRequest(
  value: unknown,
): WorkStateRequestDecodeResult<ProtectedWorkAuthorizationRequest> {
  if (!isRecordObject(value)) return { ok: false, error: 'protected work authorization request must be an object' };
  const principal = normalizedBoundedLine(value['principal'], MAX_PRINCIPAL_CHARACTERS);
  if (!principal) return { ok: false, error: 'principal must be a bounded non-empty line' };
  if (typeof value['promptSha256'] !== 'string' || !SHA256_PATTERN.test(value['promptSha256'])) {
    return { ok: false, error: 'promptSha256 must be a lowercase SHA-256 digest' };
  }
  if (!isRecordObject(value['goal'])) return { ok: false, error: 'goal must be an object' };
  const goal = decodeGoalCreateRequest({
    ...value['goal'],
    authorization: {
      kind: 'repository-delegation',
      principal,
      source: `protected-work-intent:${value['promptSha256']}`,
    },
  });
  if (!goal.ok) return goal;
  if (goal.request.predecessorGoalId) {
    return { ok: false, error: 'protected initial work authorization cannot revise an existing goal' };
  }
  if (!isRecordObject(value['change'])) return { ok: false, error: 'change must be an object' };
  const change = decodeIntendedChangeCreateRequest({
    ...value['change'],
    goalId: 'SQG-00000000000000000000000000000000',
  });
  if (!change.ok) return change;
  const artifactTransitions = decodeProtectedArtifactTransitions(value['artifactTransitions']);
  if (!artifactTransitions.ok) return artifactTransitions;
  return {
    ok: true,
    request: {
      principal,
      promptSha256: value['promptSha256'],
      goal: {
        feature: goal.request.feature,
        invariants: goal.request.invariants,
        acceptanceScenarios: goal.request.acceptanceScenarios,
      },
      change: {
        idempotencyKey: change.request.idempotencyKey,
        title: change.request.title,
        intendedOutcome: change.request.intendedOutcome,
      },
      artifactTransitions: artifactTransitions.value,
    },
  };
}

export function createProtectedWorkAuthorization(
  input: CreateProtectedWorkAuthorizationInput,
): ProtectedWorkAuthorizationV1 {
  const decoded = decodeProtectedWorkAuthorizationRequest(input.request);
  if (!decoded.ok) throw new Error(decoded.error);
  const request = decoded.request;
  const intentDigest = hashIdentity({
    version: PROTECTED_WORK_AUTHORIZATION_SCHEMA_VERSION,
    collaborationDomainId: input.collaborationDomainId,
    principal: request.principal,
    promptSha256: request.promptSha256,
  });
  const goal = createGoalRecord({
    collaborationDomainId: input.collaborationDomainId,
    request: {
      ...request.goal,
      authorization: {
        kind: 'repository-delegation',
        principal: request.principal,
        source: `protected-work-intent:${intentDigest}`,
      },
    },
    createdAt: input.createdAt,
    toolVersion: input.toolVersion,
  });
  const change = createIntendedChangeRecord({
    collaborationDomainId: input.collaborationDomainId,
    request: { ...request.change, goalId: goal.goalId },
    createdAt: input.createdAt,
    toolVersion: input.toolVersion,
  });
  const meaning = {
    collaborationDomainId: input.collaborationDomainId,
    principal: request.principal,
    promptSha256: request.promptSha256,
    intentDigest,
    goal,
    changeRequest: request.change,
    change,
    artifactTransitions: request.artifactTransitions,
  };
  return {
    kind: PROTECTED_WORK_AUTHORIZATION_KIND,
    schemaVersion: PROTECTED_WORK_AUTHORIZATION_SCHEMA_VERSION,
    authorizationId: authorizationId(meaning),
    ...meaning,
    createdAt: input.createdAt,
    writer: { tool: 'scip-query', version: input.toolVersion },
  };
}

export function decodeProtectedWorkAuthorization(value: unknown): WorkStateDecodeResult<ProtectedWorkAuthorizationV1> {
  const envelope = decodeWorkRecordEnvelope(value, {
    recordKind: PROTECTED_WORK_AUTHORIZATION_KIND,
    schemaVersion: PROTECTED_WORK_AUTHORIZATION_SCHEMA_VERSION,
    label: 'protected-work-authorization',
  });
  if (!envelope.ok) return envelope.result;
  const fields = envelope.envelope.value;
  if (!isProtectedWorkAuthorizationId(fields['authorizationId'])) {
    return { state: 'malformed', error: 'authorizationId must be a protected work authorization identity' };
  }
  if (typeof fields['promptSha256'] !== 'string' || !SHA256_PATTERN.test(fields['promptSha256'])) {
    return { state: 'malformed', error: 'promptSha256 must be a lowercase SHA-256 digest' };
  }
  if (typeof fields['intentDigest'] !== 'string' || !SHA256_PATTERN.test(fields['intentDigest'])) {
    return { state: 'malformed', error: 'intentDigest must be a lowercase SHA-256 digest' };
  }
  const principal = normalizedBoundedLine(fields['principal'], MAX_PRINCIPAL_CHARACTERS);
  if (!principal || principal !== fields['principal']) {
    return { state: 'malformed', error: 'principal must use canonical bounded text' };
  }
  const goal = decodeGoalRecord(fields['goal']);
  if (goal.state !== 'current') return { state: 'malformed', error: `authorized goal is ${goal.state}: ${goal.error}` };
  if (!isRecordObject(fields['changeRequest'])) {
    return { state: 'malformed', error: 'changeRequest must be an object' };
  }
  const changeRequest = decodeIntendedChangeCreateRequest({
    ...fields['changeRequest'],
    goalId: goal.record.goalId,
  });
  if (!changeRequest.ok) return { state: 'malformed', error: changeRequest.error };
  const change = decodeIntendedChangeRecord(fields['change']);
  if (change.state !== 'current') {
    return { state: 'malformed', error: `authorized intended change is ${change.state}: ${change.error}` };
  }
  const artifactTransitions = decodeProtectedArtifactTransitions(fields['artifactTransitions']);
  if (!artifactTransitions.ok) return { state: 'malformed', error: artifactTransitions.error };
  const request: ProtectedWorkAuthorizationRequest = {
    principal,
    promptSha256: fields['promptSha256'],
    goal: {
      feature: goal.record.gherkin.feature,
      invariants: goal.record.gherkin.invariants,
      acceptanceScenarios: goal.record.gherkin.acceptanceScenarios,
    },
    change: {
      idempotencyKey: changeRequest.request.idempotencyKey,
      title: changeRequest.request.title,
      intendedOutcome: changeRequest.request.intendedOutcome,
    },
    artifactTransitions: artifactTransitions.value,
  };
  let expected: ProtectedWorkAuthorizationV1;
  try {
    expected = createProtectedWorkAuthorization({
      collaborationDomainId: envelope.envelope.collaborationDomainId,
      request,
      createdAt: envelope.envelope.createdAt,
      toolVersion: envelope.envelope.writer.version,
    });
  } catch (error) {
    return { state: 'malformed', error: error instanceof Error ? error.message : String(error) };
  }
  if (stableJson(expected) !== stableJson(value)) {
    return { state: 'malformed', error: 'protected work authorization fields or identity are not canonical' };
  }
  return { state: 'current', record: expected };
}

export function protectedWorkAuthorizationMatchesRecords(
  authorization: ProtectedWorkAuthorizationV1,
  goal: GoalRecordV1,
  change: IntendedChangeRecordV1,
): boolean {
  return stableJson(authorization.goal) === stableJson(goal) && stableJson(authorization.change) === stableJson(change);
}

export function isProtectedWorkAuthorizationId(value: unknown): value is string {
  return matchesWorkStateIdentity(value, AUTHORIZATION_ID_PATTERN);
}

function authorizationId(
  meaning: Omit<ProtectedWorkAuthorizationV1, 'kind' | 'schemaVersion' | 'authorizationId' | 'createdAt' | 'writer'>,
): string {
  const digest = hashIdentity({
    version: PROTECTED_WORK_AUTHORIZATION_SCHEMA_VERSION,
    kind: PROTECTED_WORK_AUTHORIZATION_KIND,
    meaning,
  });
  return `SQWA-${digest.slice(0, 32).toUpperCase()}`;
}
