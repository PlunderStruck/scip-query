import { createHash } from 'node:crypto';

import type { RecordCompatibilityState } from './record-compatibility.js';
import { isNonEmptyString, isNonNegativeInteger, isRecordObject, isValidRecordTimestamp } from './record-validation.js';
import { stableJson } from './stable-json.js';

export const GOAL_RECORD_KIND = 'scip-query-goal' as const;
export const GOAL_RECORD_SCHEMA_VERSION = 1 as const;
export const INTENDED_CHANGE_RECORD_KIND = 'scip-query-intended-change' as const;
export const INTENDED_CHANGE_RECORD_SCHEMA_VERSION = 1 as const;
export const WORK_STATE_IDENTITY_ALGORITHM = 'sha256' as const;
export const GOAL_CANONICALIZATION_VERSION = 1 as const;
export const INTENDED_CHANGE_IDEMPOTENCY_VERSION = 1 as const;

const COLLABORATION_DOMAIN_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const GOAL_ID_PATTERN = /^SQG-[A-F0-9]{32}$/u;
const INTENDED_CHANGE_ID_PATTERN = /^SQC-[A-F0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_FEATURE_CHARACTERS = 500;
const MAX_RULE_CHARACTERS = 300;
const MAX_SCENARIO_NAME_CHARACTERS = 200;
const MAX_STEP_CHARACTERS = 300;
const MAX_GOAL_RULES = 16;
const MAX_GOAL_SCENARIOS = 16;
const MAX_SCENARIO_STEPS = 8;
const MAX_TITLE_CHARACTERS = 200;
const MAX_INTENDED_OUTCOME_CHARACTERS = 1_000;

export interface WorkStateWriter {
  tool: 'scip-query';
  version: string;
}

export interface RepositoryGoalAuthorization {
  kind: 'repository-delegation';
  principal: string;
  source: string;
}

/**
 * One acceptance scenario names an externally observable situation and the
 * conditions, event, and result that make it evidence for the goal.
 */
export interface GoalAcceptanceScenario {
  name: string;
  given: readonly string[];
  when: readonly string[];
  then: readonly string[];
}

/**
 * Structured Gherkin meaning for one immutable goal version. The feature
 * names the desired repository capability, rules state what must remain true,
 * and scenarios state observable acceptance cases without prescribing code.
 */
export interface GoalGherkin {
  language: 'gherkin';
  feature: string;
  invariants: readonly string[];
  acceptanceScenarios: readonly GoalAcceptanceScenario[];
}

export interface GoalSemanticIdentity {
  algorithm: typeof WORK_STATE_IDENTITY_ALGORITHM;
  canonicalizationVersion: typeof GOAL_CANONICALIZATION_VERSION;
  digest: string;
}

/**
 * One goal record is one immutable semantic version of an authorized
 * repository objective. Semantic revision creates a successor record; writer,
 * time, formatting, branch, and workspace metadata do not define its identity.
 */
export interface GoalRecordV1 {
  kind: typeof GOAL_RECORD_KIND;
  schemaVersion: typeof GOAL_RECORD_SCHEMA_VERSION;
  goalId: string;
  collaborationDomainId: string;
  gherkin: GoalGherkin;
  semanticIdentity: GoalSemanticIdentity;
  predecessorGoalId?: string;
  authorization: RepositoryGoalAuthorization;
  createdAt: string;
  writer: WorkStateWriter;
}

export interface GoalCreateRequest {
  feature: string;
  invariants: readonly string[];
  acceptanceScenarios: readonly GoalAcceptanceScenario[];
  authorization: RepositoryGoalAuthorization;
  predecessorGoalId?: string;
}

export interface IntendedChangeCreateRequest {
  goalId: string;
  idempotencyKey: string;
  title: string;
  intendedOutcome: string;
}

/**
 * One intended-change record identifies a mergeable body of repository work.
 * Its opaque identity follows a caller-originated retry key rather than a
 * branch, process, path, title, or mutable plan name.
 */
export interface IntendedChangeRecordV1 {
  kind: typeof INTENDED_CHANGE_RECORD_KIND;
  schemaVersion: typeof INTENDED_CHANGE_RECORD_SCHEMA_VERSION;
  changeId: string;
  collaborationDomainId: string;
  goalId: string;
  title: string;
  intendedOutcome: string;
  idempotency: {
    version: typeof INTENDED_CHANGE_IDEMPOTENCY_VERSION;
    algorithm: typeof WORK_STATE_IDENTITY_ALGORITHM;
    keyDigest: string;
    requestDigest: string;
  };
  createdAt: string;
  writer: WorkStateWriter;
}

export type WorkStateDecodeResult<RecordType> =
  | { state: 'current'; record: RecordType }
  | {
      state: Exclude<RecordCompatibilityState, 'legacy' | 'current'>;
      error: string;
    };

export type WorkStateRequestDecodeResult<RequestType> =
  | { ok: true; request: RequestType }
  | { ok: false; error: string };

/**
 * A work-record envelope is the common framing around one immutable
 * repository-work fact. Its kind and schema select the decoder, while its
 * collaboration domain and provenance make the fact mergeable and auditable
 * without defining the fact's specialized meaning.
 */
export interface WorkRecordEnvelope {
  value: Readonly<Record<string, unknown>>;
  collaborationDomainId: string;
  createdAt: string;
  writer: WorkStateWriter;
}

export interface WorkRecordEnvelopeSpec {
  recordKind: string;
  schemaVersion: number;
  label: string;
}

export interface CreateGoalRecordInput {
  collaborationDomainId: string;
  request: GoalCreateRequest;
  createdAt: string;
  toolVersion: string;
}

export interface CreateIntendedChangeRecordInput {
  collaborationDomainId: string;
  request: IntendedChangeCreateRequest;
  createdAt: string;
  toolVersion: string;
}

export function decodeGoalCreateRequest(value: unknown): WorkStateRequestDecodeResult<GoalCreateRequest> {
  if (!isRecordObject(value)) return { ok: false, error: 'goal create request must be an object' };
  const gherkin = normalizeGoalGherkin({
    language: 'gherkin',
    feature: value['feature'],
    invariants: value['invariants'],
    acceptanceScenarios: value['acceptanceScenarios'],
  });
  if (!gherkin.ok) return gherkin;
  const authorization = decodeAuthorization(value['authorization']);
  if (!authorization.ok) return authorization;
  const predecessorGoalId = value['predecessorGoalId'];
  if (predecessorGoalId !== undefined && !isGoalId(predecessorGoalId)) {
    return { ok: false, error: 'predecessorGoalId must be a goal identity' };
  }
  return {
    ok: true,
    request: {
      feature: gherkin.value.feature,
      invariants: gherkin.value.invariants,
      acceptanceScenarios: gherkin.value.acceptanceScenarios,
      authorization: authorization.value,
      ...(typeof predecessorGoalId === 'string' ? { predecessorGoalId } : {}),
    },
  };
}

export function decodeIntendedChangeCreateRequest(
  value: unknown,
): WorkStateRequestDecodeResult<IntendedChangeCreateRequest> {
  if (!isRecordObject(value)) return { ok: false, error: 'intended-change create request must be an object' };
  if (!isGoalId(value['goalId'])) return { ok: false, error: 'goalId must be a goal identity' };
  const idempotencyKey = normalizedBoundedLine(value['idempotencyKey'], 256);
  if (!idempotencyKey) return { ok: false, error: 'idempotencyKey must be a non-empty line of at most 256 characters' };
  const title = normalizedBoundedLine(value['title'], MAX_TITLE_CHARACTERS);
  if (!title)
    return { ok: false, error: `title must be a non-empty line of at most ${MAX_TITLE_CHARACTERS} characters` };
  const intendedOutcome = normalizedBoundedLine(value['intendedOutcome'], MAX_INTENDED_OUTCOME_CHARACTERS);
  if (!intendedOutcome) {
    return {
      ok: false,
      error: `intendedOutcome must be a non-empty line of at most ${MAX_INTENDED_OUTCOME_CHARACTERS} characters`,
    };
  }
  return {
    ok: true,
    request: {
      goalId: value['goalId'],
      idempotencyKey,
      title,
      intendedOutcome,
    },
  };
}

export function createGoalRecord(input: CreateGoalRecordInput): GoalRecordV1 {
  assertCollaborationDomain(input.collaborationDomainId);
  const decoded = decodeGoalCreateRequest(input.request);
  if (!decoded.ok) throw new Error(decoded.error);
  if (!isValidRecordTimestamp(input.createdAt)) throw new Error('createdAt must be a valid timestamp');
  if (!isNonEmptyString(input.toolVersion)) throw new Error('toolVersion must be non-empty');
  const gherkin: GoalGherkin = {
    language: 'gherkin',
    feature: decoded.request.feature,
    invariants: decoded.request.invariants,
    acceptanceScenarios: decoded.request.acceptanceScenarios,
  };
  const semanticIdentity = goalSemanticIdentity(input.collaborationDomainId, gherkin);
  const goalId = goalIdFromDigest(semanticIdentity.digest);
  if (decoded.request.predecessorGoalId === goalId) {
    throw new Error('a semantic goal revision cannot name itself as predecessor');
  }
  return {
    kind: GOAL_RECORD_KIND,
    schemaVersion: GOAL_RECORD_SCHEMA_VERSION,
    goalId,
    collaborationDomainId: input.collaborationDomainId,
    gherkin,
    semanticIdentity,
    ...(decoded.request.predecessorGoalId ? { predecessorGoalId: decoded.request.predecessorGoalId } : {}),
    authorization: decoded.request.authorization,
    createdAt: input.createdAt,
    writer: { tool: 'scip-query', version: input.toolVersion },
  };
}

export function createIntendedChangeRecord(input: CreateIntendedChangeRecordInput): IntendedChangeRecordV1 {
  assertCollaborationDomain(input.collaborationDomainId);
  const decoded = decodeIntendedChangeCreateRequest(input.request);
  if (!decoded.ok) throw new Error(decoded.error);
  if (!isValidRecordTimestamp(input.createdAt)) throw new Error('createdAt must be a valid timestamp');
  if (!isNonEmptyString(input.toolVersion)) throw new Error('toolVersion must be non-empty');
  const keyDigest = hashIdentity({
    version: INTENDED_CHANGE_IDEMPOTENCY_VERSION,
    collaborationDomainId: input.collaborationDomainId,
    idempotencyKey: decoded.request.idempotencyKey,
  });
  const requestDigest = intendedChangeRequestDigest(input.collaborationDomainId, decoded.request);
  return {
    kind: INTENDED_CHANGE_RECORD_KIND,
    schemaVersion: INTENDED_CHANGE_RECORD_SCHEMA_VERSION,
    changeId: intendedChangeIdFromDigest(keyDigest),
    collaborationDomainId: input.collaborationDomainId,
    goalId: decoded.request.goalId,
    title: decoded.request.title,
    intendedOutcome: decoded.request.intendedOutcome,
    idempotency: {
      version: INTENDED_CHANGE_IDEMPOTENCY_VERSION,
      algorithm: WORK_STATE_IDENTITY_ALGORITHM,
      keyDigest,
      requestDigest,
    },
    createdAt: input.createdAt,
    writer: { tool: 'scip-query', version: input.toolVersion },
  };
}

export function decodeGoalRecord(value: unknown): WorkStateDecodeResult<GoalRecordV1> {
  const envelope = decodeWorkRecordEnvelope(value, {
    recordKind: GOAL_RECORD_KIND,
    schemaVersion: GOAL_RECORD_SCHEMA_VERSION,
    label: 'goal',
  });
  if (!envelope.ok) return envelope.result;
  const fields = envelope.envelope.value;
  if (!isGoalId(fields['goalId'])) return { state: 'malformed', error: 'goalId must be a goal identity' };
  const gherkin = normalizeGoalGherkin(fields['gherkin']);
  if (!gherkin.ok) return { state: 'malformed', error: gherkin.error };
  if (!isCanonicalGherkin(fields['gherkin'], gherkin.value)) {
    return { state: 'malformed', error: 'goal Gherkin fields must use canonical whitespace' };
  }
  const expectedIdentity = goalSemanticIdentity(envelope.envelope.collaborationDomainId, gherkin.value);
  if (!isGoalSemanticIdentity(fields['semanticIdentity'], expectedIdentity)) {
    return { state: 'malformed', error: 'semanticIdentity does not match collaboration domain and Gherkin meaning' };
  }
  if (fields['goalId'] !== goalIdFromDigest(expectedIdentity.digest)) {
    return { state: 'malformed', error: 'goalId does not match semanticIdentity' };
  }
  if (fields['predecessorGoalId'] !== undefined && !isGoalId(fields['predecessorGoalId'])) {
    return { state: 'malformed', error: 'predecessorGoalId must be a goal identity' };
  }
  if (fields['predecessorGoalId'] === fields['goalId']) {
    return { state: 'malformed', error: 'goal cannot name itself as predecessor' };
  }
  const authorization = decodeAuthorization(fields['authorization']);
  if (!authorization.ok) return { state: 'malformed', error: authorization.error };
  return {
    state: 'current',
    record: {
      kind: GOAL_RECORD_KIND,
      schemaVersion: GOAL_RECORD_SCHEMA_VERSION,
      goalId: fields['goalId'],
      collaborationDomainId: envelope.envelope.collaborationDomainId,
      gherkin: gherkin.value,
      semanticIdentity: expectedIdentity,
      ...(typeof fields['predecessorGoalId'] === 'string' ? { predecessorGoalId: fields['predecessorGoalId'] } : {}),
      authorization: authorization.value,
      createdAt: envelope.envelope.createdAt,
      writer: envelope.envelope.writer,
    },
  };
}

export function decodeIntendedChangeRecord(value: unknown): WorkStateDecodeResult<IntendedChangeRecordV1> {
  const envelope = decodeWorkRecordEnvelope(value, {
    recordKind: INTENDED_CHANGE_RECORD_KIND,
    schemaVersion: INTENDED_CHANGE_RECORD_SCHEMA_VERSION,
    label: 'intended-change',
  });
  if (!envelope.ok) return envelope.result;
  const fields = envelope.envelope.value;
  if (!isIntendedChangeId(fields['changeId'])) {
    return { state: 'malformed', error: 'changeId must be an intended-change identity' };
  }
  if (!isGoalId(fields['goalId'])) return { state: 'malformed', error: 'goalId must be a goal identity' };
  const title = normalizedBoundedLine(fields['title'], MAX_TITLE_CHARACTERS);
  const intendedOutcome = normalizedBoundedLine(fields['intendedOutcome'], MAX_INTENDED_OUTCOME_CHARACTERS);
  if (!title || title !== fields['title'])
    return { state: 'malformed', error: 'title must use canonical bounded text' };
  if (!intendedOutcome || intendedOutcome !== fields['intendedOutcome']) {
    return { state: 'malformed', error: 'intendedOutcome must use canonical bounded text' };
  }
  if (!isRecordObject(fields['idempotency'])) return { state: 'malformed', error: 'missing idempotency metadata' };
  const idempotency = fields['idempotency'];
  if (
    idempotency['version'] !== INTENDED_CHANGE_IDEMPOTENCY_VERSION ||
    idempotency['algorithm'] !== WORK_STATE_IDENTITY_ALGORITHM ||
    !isSha256(idempotency['keyDigest']) ||
    !isSha256(idempotency['requestDigest'])
  ) {
    return { state: 'malformed', error: 'invalid intended-change idempotency metadata' };
  }
  if (fields['changeId'] !== intendedChangeIdFromDigest(idempotency['keyDigest'])) {
    return { state: 'malformed', error: 'changeId does not match the idempotency key digest' };
  }
  const expectedRequestDigest = intendedChangeRequestDigest(envelope.envelope.collaborationDomainId, {
    goalId: fields['goalId'],
    title,
    intendedOutcome,
  });
  if (idempotency['requestDigest'] !== expectedRequestDigest) {
    return { state: 'malformed', error: 'requestDigest does not match the intended-change meaning' };
  }
  return {
    state: 'current',
    record: {
      kind: INTENDED_CHANGE_RECORD_KIND,
      schemaVersion: INTENDED_CHANGE_RECORD_SCHEMA_VERSION,
      changeId: fields['changeId'],
      collaborationDomainId: envelope.envelope.collaborationDomainId,
      goalId: fields['goalId'],
      title,
      intendedOutcome,
      idempotency: {
        version: INTENDED_CHANGE_IDEMPOTENCY_VERSION,
        algorithm: WORK_STATE_IDENTITY_ALGORITHM,
        keyDigest: idempotency['keyDigest'],
        requestDigest: idempotency['requestDigest'],
      },
      createdAt: envelope.envelope.createdAt,
      writer: envelope.envelope.writer,
    },
  };
}

export function goalRequestMatchesRecord(
  collaborationDomainId: string,
  request: GoalCreateRequest,
  record: GoalRecordV1,
): boolean {
  const candidate = createGoalRecord({
    collaborationDomainId,
    request,
    createdAt: record.createdAt,
    toolVersion: record.writer.version,
  });
  return (
    candidate.goalId === record.goalId &&
    stableJson(candidate.gherkin) === stableJson(record.gherkin) &&
    stableJson(candidate.authorization) === stableJson(record.authorization) &&
    candidate.predecessorGoalId === record.predecessorGoalId
  );
}

export function intendedChangeRequestMatchesRecord(
  collaborationDomainId: string,
  request: IntendedChangeCreateRequest,
  record: IntendedChangeRecordV1,
): boolean {
  const decoded = decodeIntendedChangeCreateRequest(request);
  if (!decoded.ok) return false;
  return (
    record.collaborationDomainId === collaborationDomainId &&
    record.goalId === decoded.request.goalId &&
    record.title === decoded.request.title &&
    record.intendedOutcome === decoded.request.intendedOutcome &&
    record.idempotency.requestDigest === intendedChangeRequestDigest(collaborationDomainId, decoded.request)
  );
}

export function renderGoalGherkin(goal: GoalGherkin): string {
  const lines = [`Feature: ${goal.feature}`];
  for (const invariant of goal.invariants) lines.push('', `  Rule: ${invariant}`);
  for (const scenario of goal.acceptanceScenarios) {
    lines.push('', `  Scenario: ${scenario.name}`);
    for (const step of scenario.given) lines.push(`    Given ${step}`);
    for (const step of scenario.when) lines.push(`    When ${step}`);
    for (const step of scenario.then) lines.push(`    Then ${step}`);
  }
  return `${lines.join('\n')}\n`;
}

export function isGoalId(value: unknown): value is string {
  return matchesWorkStateIdentity(value, GOAL_ID_PATTERN);
}

export function isIntendedChangeId(value: unknown): value is string {
  return matchesWorkStateIdentity(value, INTENDED_CHANGE_ID_PATTERN);
}

export function isCollaborationDomainId(value: unknown): value is string {
  return matchesWorkStateIdentity(value, COLLABORATION_DOMAIN_PATTERN);
}

export function matchesWorkStateIdentity(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function normalizeGoalGherkin(value: unknown): { ok: true; value: GoalGherkin } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'goal Gherkin must be an object' };
  if (value['language'] !== 'gherkin') return { ok: false, error: 'goal language must be gherkin' };
  const feature = normalizedBoundedLine(value['feature'], MAX_FEATURE_CHARACTERS);
  if (!feature) {
    return { ok: false, error: `feature must be a non-empty line of at most ${MAX_FEATURE_CHARACTERS} characters` };
  }
  const invariants = normalizeLines(value['invariants'], MAX_GOAL_RULES, MAX_RULE_CHARACTERS);
  if (!invariants.ok) return { ok: false, error: `invariants ${invariants.error}` };
  const scenarios = normalizeScenarios(value['acceptanceScenarios']);
  if (!scenarios.ok) return scenarios;
  return {
    ok: true,
    value: {
      language: 'gherkin',
      feature,
      invariants: invariants.values,
      acceptanceScenarios: scenarios.values,
    },
  };
}

function normalizeScenarios(
  value: unknown,
): { ok: true; values: GoalAcceptanceScenario[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GOAL_SCENARIOS) {
    return { ok: false, error: `acceptanceScenarios must contain 1-${MAX_GOAL_SCENARIOS} scenarios` };
  }
  const scenarios: GoalAcceptanceScenario[] = [];
  for (const [index, candidate] of value.entries()) {
    if (!isRecordObject(candidate)) return { ok: false, error: `acceptanceScenarios[${index}] must be an object` };
    const name = normalizedBoundedLine(candidate['name'], MAX_SCENARIO_NAME_CHARACTERS);
    if (!name) return { ok: false, error: `acceptanceScenarios[${index}].name is invalid` };
    const given = normalizeLines(candidate['given'], MAX_SCENARIO_STEPS, MAX_STEP_CHARACTERS);
    const when = normalizeLines(candidate['when'], MAX_SCENARIO_STEPS, MAX_STEP_CHARACTERS);
    const then = normalizeLines(candidate['then'], MAX_SCENARIO_STEPS, MAX_STEP_CHARACTERS);
    if (!given.ok || !when.ok || !then.ok) {
      return {
        ok: false,
        error: `acceptanceScenarios[${index}] requires 1-${MAX_SCENARIO_STEPS} bounded steps per phase`,
      };
    }
    scenarios.push({ name, given: given.values, when: when.values, then: then.values });
  }
  if (new Set(scenarios.map((scenario) => scenario.name)).size !== scenarios.length) {
    return { ok: false, error: 'acceptanceScenarios names must be unique after normalization' };
  }
  return { ok: true, values: scenarios };
}

function normalizeLines(
  value: unknown,
  maximumCount: number,
  maximumCharacters: number,
): { ok: true; values: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumCount) {
    return { ok: false, error: `must contain 1-${maximumCount} entries` };
  }
  const values = value.map((entry) => normalizedBoundedLine(entry, maximumCharacters));
  if (values.some((entry) => entry === null)) {
    return { ok: false, error: `entries must be non-empty lines of at most ${maximumCharacters} characters` };
  }
  const normalized = values as string[];
  if (new Set(normalized).size !== normalized.length) return { ok: false, error: 'entries must be unique' };
  return { ok: true, values: normalized };
}

function decodeAuthorization(
  value: unknown,
): { ok: true; value: RepositoryGoalAuthorization } | { ok: false; error: string } {
  if (!isRecordObject(value) || value['kind'] !== 'repository-delegation') {
    return { ok: false, error: 'authorization must be a repository-delegation object' };
  }
  const principal = normalizedBoundedLine(value['principal'], 256);
  const source = normalizedBoundedLine(value['source'], 256);
  if (!principal || !source) return { ok: false, error: 'authorization principal and source must be bounded lines' };
  return { ok: true, value: { kind: 'repository-delegation', principal, source } };
}

function goalSemanticIdentity(collaborationDomainId: string, gherkin: GoalGherkin): GoalSemanticIdentity {
  return {
    algorithm: WORK_STATE_IDENTITY_ALGORITHM,
    canonicalizationVersion: GOAL_CANONICALIZATION_VERSION,
    digest: hashIdentity({
      canonicalizationVersion: GOAL_CANONICALIZATION_VERSION,
      collaborationDomainId,
      gherkin,
    }),
  };
}

function intendedChangeRequestDigest(
  collaborationDomainId: string,
  request: Pick<IntendedChangeCreateRequest, 'goalId' | 'title' | 'intendedOutcome'>,
): string {
  return hashIdentity({
    version: INTENDED_CHANGE_IDEMPOTENCY_VERSION,
    collaborationDomainId,
    goalId: request.goalId,
    title: request.title,
    intendedOutcome: request.intendedOutcome,
  });
}

export function recordVersion(
  value: unknown,
  expectedKind: string,
): { ok: true; version: number } | { ok: false; result: WorkStateDecodeResult<never> } {
  if (!isRecordObject(value)) return { ok: false, result: { state: 'malformed', error: 'record must be an object' } };
  if (value['kind'] !== expectedKind) {
    return { ok: false, result: { state: 'malformed', error: `kind must be ${expectedKind}` } };
  }
  if (!isNonNegativeInteger(value['schemaVersion'])) {
    return { ok: false, result: { state: 'malformed', error: 'schemaVersion must be a non-negative safe integer' } };
  }
  return { ok: true, version: value['schemaVersion'] };
}

export function decodeWorkRecordEnvelope(
  value: unknown,
  spec: WorkRecordEnvelopeSpec,
): { ok: true; envelope: WorkRecordEnvelope } | { ok: false; result: WorkStateDecodeResult<never> } {
  const version = recordVersion(value, spec.recordKind);
  if (!version.ok) return version;
  if (version.version !== spec.schemaVersion) {
    return { ok: false, result: unsupportedVersion(version.version, spec.schemaVersion, spec.label) };
  }
  if (!isRecordObject(value)) {
    return { ok: false, result: { state: 'malformed', error: `${spec.label} record must be an object` } };
  }
  if (!isCollaborationDomainId(value['collaborationDomainId'])) {
    return { ok: false, result: { state: 'malformed', error: 'collaborationDomainId must be a version-4 UUID' } };
  }
  if (!isValidRecordTimestamp(value['createdAt'])) {
    return { ok: false, result: { state: 'malformed', error: 'invalid createdAt timestamp' } };
  }
  if (!isWorkStateWriter(value['writer'])) {
    return { ok: false, result: { state: 'malformed', error: 'invalid writer metadata' } };
  }
  return {
    ok: true,
    envelope: {
      value,
      collaborationDomainId: value['collaborationDomainId'],
      createdAt: value['createdAt'],
      writer: value['writer'],
    },
  };
}

export function unsupportedVersion<RecordType>(
  version: number,
  current: number,
  label: string,
): WorkStateDecodeResult<RecordType> {
  return {
    state: version < current ? 'unsupported-older' : 'unsupported-future',
    error: `unsupported ${label} schemaVersion ${version}; current version is ${current}`,
  };
}

function isGoalSemanticIdentity(value: unknown, expected: GoalSemanticIdentity): boolean {
  return (
    isRecordObject(value) &&
    value['algorithm'] === expected.algorithm &&
    value['canonicalizationVersion'] === expected.canonicalizationVersion &&
    value['digest'] === expected.digest
  );
}

export function isWorkStateWriter(value: unknown): value is WorkStateWriter {
  return (
    isRecordObject(value) &&
    value['tool'] === 'scip-query' &&
    isNonEmptyString(value['version']) &&
    value['version'].length <= 256
  );
}

function isCanonicalGherkin(value: unknown, normalized: GoalGherkin): boolean {
  return isRecordObject(value) && stableJson(value) === stableJson(normalized);
}

export function normalizedBoundedLine(value: unknown, maximumCharacters: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return normalized.length > 0 && normalized.length <= maximumCharacters && !/[\0\r\n]/u.test(normalized)
    ? normalized
    : null;
}

function goalIdFromDigest(digest: string): string {
  return `SQG-${digest.slice(0, 32).toUpperCase()}`;
}

function intendedChangeIdFromDigest(digest: string): string {
  return `SQC-${digest.slice(0, 32).toUpperCase()}`;
}

export function hashIdentity(value: unknown): string {
  return createHash(WORK_STATE_IDENTITY_ALGORITHM).update(stableJson(value)).digest('hex');
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function assertCollaborationDomain(value: string): void {
  if (!isCollaborationDomainId(value)) throw new Error('collaborationDomainId must be a version-4 UUID');
}
