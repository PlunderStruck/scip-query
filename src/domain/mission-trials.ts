import {
  isBoundedRecordString,
  isNonNegativeFiniteNumber,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecordObject,
  isValidRecordTimestamp,
} from './record-validation.js';
import { hashIdentity, isSha256 } from './autonomous-work-state.js';

export const MISSION_TRIAL_PROGRAM_KIND = 'scip-query-mission-trial-program' as const;
export const MISSION_TRIAL_PROGRAM_SCHEMA_VERSION = 1 as const;
export const MISSION_TRIAL_RUN_KIND = 'scip-query-mission-trial-run' as const;
export const MISSION_TRIAL_RUN_SCHEMA_VERSION = 2 as const;
export const MISSION_TRIAL_DECISION_RULE_VERSION = 1 as const;

const GIT_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u;
const PROGRAM_ID_PATTERN = /^SQTP-[A-F0-9]{32}$/u;
const RUN_ID_PATTERN = /^SQTR-[A-F0-9]{32}$/u;
const MAX_GOAL_CHARACTERS = 12_000;
const MAX_LIST_ENTRIES = 256;

export type MissionTrialTreatment = 'control' | 'workflow';
export type MissionTrialRunStatus = 'completed' | 'timed-out' | 'crashed' | 'interrupted';
export type MissionTrialFailureOrigin =
  | 'detector-miss'
  | 'controller-miss'
  | 'agent-failure'
  | 'apparatus-failure'
  | null;

export interface MissionTrialArtifactRef {
  relativePath: string;
  sha256: string;
}

export interface MissionTrialFixture {
  fixtureId: string;
  description: string;
  authorizedGoal: string;
  repositoryArchive: MissionTrialArtifactRef;
  protectedEvaluator: MissionTrialArtifactRef;
  affectedSurface: readonly string[];
}

export interface MissionTrialAgentConfiguration {
  provider: string;
  model: string;
  runtime: string;
  parametersSha256: string;
}

export interface MissionTrialBudgets {
  maxElapsedMs: number;
  maxModelTokens: number;
  maxToolCalls: number;
  maxAttempts: number;
}

export interface MissionTrialDecisionThresholds {
  version: typeof MISSION_TRIAL_DECISION_RULE_VERSION;
  minimumPairs: number;
  minimumFullCompletionRateDelta: number;
  maximumTreatmentFalseBlockingRate: number;
  maximumArchitectureRegressionRate: number;
  maximumElapsedRegressionRatio: number;
  maximumTokenRegressionRatio: number;
  confidenceLevel: number;
  requireEfficiencyImprovement: 'elapsed-or-tokens';
}

export interface MissionTrialProgramRequest {
  title: string;
  fixedPredecessorCommit: string;
  fixtures: readonly MissionTrialFixture[];
  agent: MissionTrialAgentConfiguration;
  budgets: MissionTrialBudgets;
  maximumRerunsPerCondition: number;
  decisionThresholds: MissionTrialDecisionThresholds;
}

export interface MissionTrialProgramV1 extends MissionTrialProgramRequest {
  kind: typeof MISSION_TRIAL_PROGRAM_KIND;
  schemaVersion: typeof MISSION_TRIAL_PROGRAM_SCHEMA_VERSION;
  programId: string;
  semanticDigest: string;
  conditions: {
    control: { workflow: 'disabled' };
    treatment: { workflow: 'autonomous-completion-v1' };
  };
  createdAt: string;
  writer: { tool: 'scip-query'; version: string };
}

export interface MissionTrialTelemetry {
  elapsedMs: number | null;
  modelTokens: number | null;
  toolCalls: number | null;
  failedAttempts: number | null;
  reworkEdits: number | null;
  metadataCommands: number | null;
  repeatedContextTokens: number | null;
}

export interface MissionTrialEvaluation {
  goalSatisfied: boolean | null;
  invariantsPreserved: boolean | null;
  affectedSurfaceReconciled: boolean | null;
  missedAffectedArtifacts: readonly string[] | null;
  residueDefects: readonly string[] | null;
  reintroducedBehaviors: readonly string[] | null;
  architectureViolations: readonly string[] | null;
  controllerBlocked: boolean | null;
  blockerWasValid: boolean | null;
}

export interface MissionTrialObservedArtifact {
  expectedSha256: string;
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface MissionTrialRunRequest {
  programId: string;
  pairId: string;
  fixtureId: string;
  treatment: MissionTrialTreatment;
  rerunOrdinal: number;
  startedAt: string;
  completedAt: string;
  programDigest: string;
  conditionDigest: string;
  fixtureArchive: MissionTrialObservedArtifact;
  protectedEvaluator: MissionTrialObservedArtifact;
  status: MissionTrialRunStatus;
  exclusionReasons: readonly string[];
  telemetry: MissionTrialTelemetry;
  evaluation: MissionTrialEvaluation;
  failureOrigin: MissionTrialFailureOrigin;
  artifacts: readonly ({ kind: string } & MissionTrialArtifactRef)[];
}

export interface MissionTrialRunV1 extends MissionTrialRunRequest {
  kind: typeof MISSION_TRIAL_RUN_KIND;
  schemaVersion: typeof MISSION_TRIAL_RUN_SCHEMA_VERSION;
  runId: string;
  recordedAt: string;
  writer: { tool: 'scip-query'; version: string };
}

export type MissionTrialDecodeResult<RecordType> =
  | { state: 'current'; record: RecordType }
  | { state: 'unsupported-older' | 'unsupported-future' | 'malformed'; error: string };

export interface MissionTrialCreateOptions {
  now: () => string;
  toolVersion: string;
}

export function createMissionTrialProgram(
  request: MissionTrialProgramRequest,
  options: MissionTrialCreateOptions,
): MissionTrialProgramV1 {
  const createdAt = options.now();
  const candidate = {
    kind: MISSION_TRIAL_PROGRAM_KIND,
    schemaVersion: MISSION_TRIAL_PROGRAM_SCHEMA_VERSION,
    ...request,
    conditions: missionTrialConditions(),
    createdAt,
    writer: { tool: 'scip-query', version: options.toolVersion },
  };
  const normalized = normalizeMissionTrialProgram(candidate);
  if (!normalized.ok) throw new Error(normalized.error);
  const semanticDigest = missionTrialProgramDigest(normalized.value);
  return {
    ...normalized.value,
    programId: missionTrialProgramId(semanticDigest),
    semanticDigest,
  };
}

export function decodeMissionTrialProgram(value: unknown): MissionTrialDecodeResult<MissionTrialProgramV1> {
  if (!isRecordObject(value)) return { state: 'malformed', error: 'mission trial program must be an object' };
  if (value['kind'] !== MISSION_TRIAL_PROGRAM_KIND) {
    return { state: 'malformed', error: `kind must be ${MISSION_TRIAL_PROGRAM_KIND}` };
  }
  const version = value['schemaVersion'];
  if (!isNonNegativeInteger(version)) return { state: 'malformed', error: 'schemaVersion must be an integer' };
  if (version < MISSION_TRIAL_PROGRAM_SCHEMA_VERSION) {
    return { state: 'unsupported-older', error: `mission trial program schema ${version} requires migration` };
  }
  if (version > MISSION_TRIAL_PROGRAM_SCHEMA_VERSION) {
    return { state: 'unsupported-future', error: `mission trial program schema ${version} is newer than supported` };
  }
  const normalized = normalizeMissionTrialProgram(value);
  if (!normalized.ok) return { state: 'malformed', error: normalized.error };
  if (!isSha256(value['semanticDigest'])) {
    return { state: 'malformed', error: 'semanticDigest must be a SHA-256 digest' };
  }
  const digest = missionTrialProgramDigest(normalized.value);
  if (value['semanticDigest'] !== digest) {
    return { state: 'malformed', error: 'semanticDigest does not match the trial program meaning' };
  }
  if (
    typeof value['programId'] !== 'string' ||
    !PROGRAM_ID_PATTERN.test(value['programId']) ||
    value['programId'] !== missionTrialProgramId(digest)
  ) {
    return { state: 'malformed', error: 'programId does not match semanticDigest' };
  }
  return {
    state: 'current',
    record: {
      ...normalized.value,
      programId: value['programId'],
      semanticDigest: digest,
    },
  };
}

export function createMissionTrialRun(
  request: MissionTrialRunRequest,
  options: MissionTrialCreateOptions,
): MissionTrialRunV1 {
  const recordedAt = options.now();
  const candidate = {
    kind: MISSION_TRIAL_RUN_KIND,
    schemaVersion: MISSION_TRIAL_RUN_SCHEMA_VERSION,
    ...request,
    recordedAt,
    writer: { tool: 'scip-query', version: options.toolVersion },
  };
  const normalized = normalizeMissionTrialRun(candidate);
  if (!normalized.ok) throw new Error(normalized.error);
  return {
    ...normalized.value,
    runId: missionTrialRunId(normalized.value),
  };
}

export function decodeMissionTrialRun(value: unknown): MissionTrialDecodeResult<MissionTrialRunV1> {
  if (!isRecordObject(value)) return { state: 'malformed', error: 'mission trial run must be an object' };
  if (value['kind'] !== MISSION_TRIAL_RUN_KIND) {
    return { state: 'malformed', error: `kind must be ${MISSION_TRIAL_RUN_KIND}` };
  }
  const version = value['schemaVersion'];
  if (!isNonNegativeInteger(version)) return { state: 'malformed', error: 'schemaVersion must be an integer' };
  if (version < 1) {
    return { state: 'unsupported-older', error: `mission trial run schema ${version} requires migration` };
  }
  if (version > MISSION_TRIAL_RUN_SCHEMA_VERSION) {
    return { state: 'unsupported-future', error: `mission trial run schema ${version} is newer than supported` };
  }
  const normalized = normalizeMissionTrialRun(version === 1 ? migrateMissionTrialRunV1(value) : value);
  if (!normalized.ok) return { state: 'malformed', error: normalized.error };
  const runId = missionTrialRunId(normalized.value);
  if (typeof value['runId'] !== 'string' || !RUN_ID_PATTERN.test(value['runId']) || value['runId'] !== runId) {
    return { state: 'malformed', error: 'runId does not match the immutable run coordinates' };
  }
  return { state: 'current', record: { ...normalized.value, runId } };
}

function migrateMissionTrialRunV1(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!isRecordObject(value['evaluation'])) return value;
  return {
    ...value,
    schemaVersion: MISSION_TRIAL_RUN_SCHEMA_VERSION,
    evaluation: {
      ...value['evaluation'],
      missedAffectedArtifacts: null,
    },
  };
}

export function missionTrialConditionDigest(program: MissionTrialProgramV1, treatment: MissionTrialTreatment): string {
  return hashIdentity({
    programId: program.programId,
    agent: program.agent,
    budgets: program.budgets,
    maximumRerunsPerCondition: program.maximumRerunsPerCondition,
    condition: treatment === 'control' ? program.conditions.control : program.conditions.treatment,
  });
}

export function missionTrialRunExclusionReasons(
  program: MissionTrialProgramV1,
  request: Pick<
    MissionTrialRunRequest,
    | 'programId'
    | 'fixtureId'
    | 'treatment'
    | 'programDigest'
    | 'conditionDigest'
    | 'fixtureArchive'
    | 'protectedEvaluator'
    | 'exclusionReasons'
  >,
): string[] {
  const reasons = new Set(request.exclusionReasons);
  const fixture = program.fixtures.find((candidate) => candidate.fixtureId === request.fixtureId);
  if (request.programId !== program.programId || request.programDigest !== program.semanticDigest) {
    reasons.add('trial program identity drifted');
  }
  if (request.conditionDigest !== missionTrialConditionDigest(program, request.treatment)) {
    reasons.add('agent, budget, or treatment condition drifted');
  }
  if (!fixture) {
    reasons.add(`fixture ${request.fixtureId} is not registered`);
  } else {
    addArtifactDriftReason(reasons, 'fixture archive', fixture.repositoryArchive.sha256, request.fixtureArchive);
    addArtifactDriftReason(
      reasons,
      'protected evaluator',
      fixture.protectedEvaluator.sha256,
      request.protectedEvaluator,
    );
  }
  return [...reasons].sort();
}

export function missionTrialProgramDigest(
  program: Omit<MissionTrialProgramV1, 'programId' | 'semanticDigest'>,
): string {
  return hashIdentity({
    identityVersion: 1,
    fixedPredecessorCommit: program.fixedPredecessorCommit,
    fixtures: program.fixtures,
    agent: program.agent,
    budgets: program.budgets,
    maximumRerunsPerCondition: program.maximumRerunsPerCondition,
    decisionThresholds: program.decisionThresholds,
    conditions: program.conditions,
  });
}

function normalizeMissionTrialProgram(
  value: Readonly<Record<string, unknown>>,
): { ok: true; value: Omit<MissionTrialProgramV1, 'programId' | 'semanticDigest'> } | { ok: false; error: string } {
  const title = bounded(value['title']);
  if (!title) return { ok: false, error: 'title must be a non-empty bounded line' };
  if (!isCommit(value['fixedPredecessorCommit'])) {
    return { ok: false, error: 'fixedPredecessorCommit must be a 40-64 character Git object identity' };
  }
  const fixtures = normalizeFixtures(value['fixtures']);
  if (!fixtures.ok) return fixtures;
  const agent = normalizeAgent(value['agent']);
  if (!agent.ok) return agent;
  const budgets = normalizeBudgets(value['budgets']);
  if (!budgets.ok) return budgets;
  if (!isPositiveInteger(value['maximumRerunsPerCondition']) || value['maximumRerunsPerCondition'] > 20) {
    return { ok: false, error: 'maximumRerunsPerCondition must be an integer from 1 through 20' };
  }
  const thresholds = normalizeDecisionThresholds(value['decisionThresholds']);
  if (!thresholds.ok) return thresholds;
  if (!isMissionTrialConditions(value['conditions'])) {
    return { ok: false, error: 'conditions must differ only by disabled vs autonomous-completion-v1 workflow' };
  }
  if (!isValidRecordTimestamp(value['createdAt'])) {
    return { ok: false, error: 'createdAt must be a valid timestamp' };
  }
  const writer = normalizeWriter(value['writer']);
  if (!writer.ok) return writer;
  return {
    ok: true,
    value: {
      kind: MISSION_TRIAL_PROGRAM_KIND,
      schemaVersion: MISSION_TRIAL_PROGRAM_SCHEMA_VERSION,
      title,
      fixedPredecessorCommit: value['fixedPredecessorCommit'],
      fixtures: fixtures.value,
      agent: agent.value,
      budgets: budgets.value,
      maximumRerunsPerCondition: value['maximumRerunsPerCondition'],
      decisionThresholds: thresholds.value,
      conditions: missionTrialConditions(),
      createdAt: value['createdAt'],
      writer: writer.value,
    },
  };
}

function normalizeMissionTrialRun(
  value: Readonly<Record<string, unknown>>,
): { ok: true; value: Omit<MissionTrialRunV1, 'runId'> } | { ok: false; error: string } {
  if (typeof value['programId'] !== 'string' || !PROGRAM_ID_PATTERN.test(value['programId']))
    return { ok: false, error: 'programId must be a mission trial program identity' };
  const pairId = bounded(value['pairId']);
  const fixtureId = bounded(value['fixtureId']);
  if (!pairId || !fixtureId) return { ok: false, error: 'pairId and fixtureId must be bounded lines' };
  if (value['treatment'] !== 'control' && value['treatment'] !== 'workflow') {
    return { ok: false, error: 'treatment must be control or workflow' };
  }
  if (!isNonNegativeInteger(value['rerunOrdinal'])) {
    return { ok: false, error: 'rerunOrdinal must be a non-negative integer' };
  }
  if (!isValidRecordTimestamp(value['startedAt']) || !isValidRecordTimestamp(value['completedAt'])) {
    return { ok: false, error: 'startedAt and completedAt must be valid timestamps' };
  }
  if (Date.parse(value['completedAt']) < Date.parse(value['startedAt'])) {
    return { ok: false, error: 'completedAt cannot precede startedAt' };
  }
  if (!isSha256(value['programDigest']) || !isSha256(value['conditionDigest'])) {
    return { ok: false, error: 'programDigest and conditionDigest must be SHA-256 digests' };
  }
  const fixtureArchive = normalizeObservedArtifact(value['fixtureArchive']);
  if (!fixtureArchive.ok) return fixtureArchive;
  const protectedEvaluator = normalizeObservedArtifact(value['protectedEvaluator']);
  if (!protectedEvaluator.ok) return protectedEvaluator;
  if (!isRunStatus(value['status'])) return { ok: false, error: 'status is not a supported trial outcome' };
  const exclusionReasons = boundedStringList(value['exclusionReasons'], 'exclusionReasons');
  if (!exclusionReasons.ok) return exclusionReasons;
  const telemetry = normalizeTelemetry(value['telemetry']);
  if (!telemetry.ok) return telemetry;
  const evaluation = normalizeEvaluation(value['evaluation']);
  if (!evaluation.ok) return evaluation;
  if (!isFailureOrigin(value['failureOrigin'])) {
    return { ok: false, error: 'failureOrigin must be a supported origin or null' };
  }
  const artifacts = normalizeRunArtifacts(value['artifacts']);
  if (!artifacts.ok) return artifacts;
  if (!isValidRecordTimestamp(value['recordedAt'])) return { ok: false, error: 'recordedAt must be a valid timestamp' };
  const writer = normalizeWriter(value['writer']);
  if (!writer.ok) return writer;
  return {
    ok: true,
    value: {
      kind: MISSION_TRIAL_RUN_KIND,
      schemaVersion: MISSION_TRIAL_RUN_SCHEMA_VERSION,
      programId: value['programId'],
      pairId,
      fixtureId,
      treatment: value['treatment'],
      rerunOrdinal: value['rerunOrdinal'],
      startedAt: value['startedAt'],
      completedAt: value['completedAt'],
      programDigest: value['programDigest'],
      conditionDigest: value['conditionDigest'],
      fixtureArchive: fixtureArchive.value,
      protectedEvaluator: protectedEvaluator.value,
      status: value['status'],
      exclusionReasons: exclusionReasons.value,
      telemetry: telemetry.value,
      evaluation: evaluation.value,
      failureOrigin: value['failureOrigin'],
      artifacts: artifacts.value,
      recordedAt: value['recordedAt'],
      writer: writer.value,
    },
  };
}

function normalizeFixtures(value: unknown): { ok: true; value: MissionTrialFixture[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ENTRIES) {
    return { ok: false, error: 'fixtures must be a non-empty bounded array' };
  }
  const fixtures: MissionTrialFixture[] = [];
  const identities = new Set<string>();
  for (const candidate of value) {
    if (!isRecordObject(candidate)) return { ok: false, error: 'each fixture must be an object' };
    const fixtureId = bounded(candidate['fixtureId']);
    const description = bounded(candidate['description']);
    const authorizedGoal =
      typeof candidate['authorizedGoal'] === 'string' &&
      candidate['authorizedGoal'].trim().length > 0 &&
      candidate['authorizedGoal'].length <= MAX_GOAL_CHARACTERS
        ? candidate['authorizedGoal']
        : undefined;
    if (!fixtureId || !description || !authorizedGoal) {
      return { ok: false, error: 'fixture identity, description, and authorized goal must be bounded text' };
    }
    if (identities.has(fixtureId)) return { ok: false, error: `duplicate fixture identity: ${fixtureId}` };
    identities.add(fixtureId);
    const repositoryArchive = normalizeArtifactRef(candidate['repositoryArchive']);
    if (!repositoryArchive.ok) return repositoryArchive;
    const protectedEvaluator = normalizeArtifactRef(candidate['protectedEvaluator']);
    if (!protectedEvaluator.ok) return protectedEvaluator;
    const affectedSurface = boundedStringList(candidate['affectedSurface'], 'affectedSurface');
    if (!affectedSurface.ok || affectedSurface.value.length === 0) {
      return { ok: false, error: 'affectedSurface must name at least one protected artifact' };
    }
    fixtures.push({
      fixtureId,
      description,
      authorizedGoal,
      repositoryArchive: repositoryArchive.value,
      protectedEvaluator: protectedEvaluator.value,
      affectedSurface: affectedSurface.value,
    });
  }
  return { ok: true, value: fixtures };
}

function normalizeAgent(
  value: unknown,
): { ok: true; value: MissionTrialAgentConfiguration } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'agent must be an object' };
  const provider = bounded(value['provider']);
  const model = bounded(value['model']);
  const runtime = bounded(value['runtime']);
  if (!provider || !model || !runtime || !isSha256(value['parametersSha256'])) {
    return { ok: false, error: 'agent must name bounded provider/model/runtime values and parametersSha256' };
  }
  return { ok: true, value: { provider, model, runtime, parametersSha256: value['parametersSha256'] } };
}

function normalizeBudgets(value: unknown): { ok: true; value: MissionTrialBudgets } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'budgets must be an object' };
  const fields = ['maxElapsedMs', 'maxModelTokens', 'maxToolCalls', 'maxAttempts'] as const;
  if (!fields.every((field) => isPositiveInteger(value[field]))) {
    return { ok: false, error: 'every trial budget must be a positive integer' };
  }
  return {
    ok: true,
    value: {
      maxElapsedMs: value['maxElapsedMs'] as number,
      maxModelTokens: value['maxModelTokens'] as number,
      maxToolCalls: value['maxToolCalls'] as number,
      maxAttempts: value['maxAttempts'] as number,
    },
  };
}

function normalizeDecisionThresholds(
  value: unknown,
): { ok: true; value: MissionTrialDecisionThresholds } | { ok: false; error: string } {
  if (!isRecordObject(value) || value['version'] !== MISSION_TRIAL_DECISION_RULE_VERSION) {
    return { ok: false, error: `decisionThresholds.version must be ${MISSION_TRIAL_DECISION_RULE_VERSION}` };
  }
  if (!isPositiveInteger(value['minimumPairs'])) return { ok: false, error: 'minimumPairs must be positive' };
  const rates = [
    value['minimumFullCompletionRateDelta'],
    value['maximumTreatmentFalseBlockingRate'],
    value['maximumArchitectureRegressionRate'],
    value['confidenceLevel'],
  ];
  if (!rates.every(isUnitInterval))
    return { ok: false, error: 'decision rates and confidence must be between 0 and 1' };
  if (
    !isNonNegativeFiniteNumber(value['maximumElapsedRegressionRatio']) ||
    value['maximumElapsedRegressionRatio'] < 1 ||
    !isNonNegativeFiniteNumber(value['maximumTokenRegressionRatio']) ||
    value['maximumTokenRegressionRatio'] < 1
  ) {
    return { ok: false, error: 'efficiency regression ratios must be finite values at or above 1' };
  }
  if (value['requireEfficiencyImprovement'] !== 'elapsed-or-tokens') {
    return { ok: false, error: 'requireEfficiencyImprovement must be elapsed-or-tokens' };
  }
  return {
    ok: true,
    value: {
      version: MISSION_TRIAL_DECISION_RULE_VERSION,
      minimumPairs: value['minimumPairs'],
      minimumFullCompletionRateDelta: value['minimumFullCompletionRateDelta'] as number,
      maximumTreatmentFalseBlockingRate: value['maximumTreatmentFalseBlockingRate'] as number,
      maximumArchitectureRegressionRate: value['maximumArchitectureRegressionRate'] as number,
      maximumElapsedRegressionRatio: value['maximumElapsedRegressionRatio'],
      maximumTokenRegressionRatio: value['maximumTokenRegressionRatio'],
      confidenceLevel: value['confidenceLevel'] as number,
      requireEfficiencyImprovement: 'elapsed-or-tokens',
    },
  };
}

function normalizeTelemetry(value: unknown): { ok: true; value: MissionTrialTelemetry } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'telemetry must be an object' };
  const fields = [
    'elapsedMs',
    'modelTokens',
    'toolCalls',
    'failedAttempts',
    'reworkEdits',
    'metadataCommands',
    'repeatedContextTokens',
  ] as const;
  if (!fields.every((field) => value[field] === null || isNonNegativeFiniteNumber(value[field]))) {
    return { ok: false, error: 'telemetry values must be non-negative finite numbers or null' };
  }
  return {
    ok: true,
    value: Object.fromEntries(fields.map((field) => [field, value[field]])) as unknown as MissionTrialTelemetry,
  };
}

function normalizeEvaluation(
  value: unknown,
): { ok: true; value: MissionTrialEvaluation } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'evaluation must be an object' };
  const booleans = [
    'goalSatisfied',
    'invariantsPreserved',
    'affectedSurfaceReconciled',
    'controllerBlocked',
    'blockerWasValid',
  ] as const;
  if (!booleans.every((field) => value[field] === null || typeof value[field] === 'boolean')) {
    return { ok: false, error: 'evaluation judgments must be booleans or null' };
  }
  const residueDefects = nullableBoundedStringList(value['residueDefects'], 'residueDefects');
  if (!residueDefects.ok) return residueDefects;
  const missedAffectedArtifacts = nullableBoundedStringList(
    value['missedAffectedArtifacts'],
    'missedAffectedArtifacts',
  );
  if (!missedAffectedArtifacts.ok) return missedAffectedArtifacts;
  const reintroducedBehaviors = nullableBoundedStringList(value['reintroducedBehaviors'], 'reintroducedBehaviors');
  if (!reintroducedBehaviors.ok) return reintroducedBehaviors;
  const architectureViolations = nullableBoundedStringList(value['architectureViolations'], 'architectureViolations');
  if (!architectureViolations.ok) return architectureViolations;
  return {
    ok: true,
    value: {
      goalSatisfied: value['goalSatisfied'] as boolean | null,
      invariantsPreserved: value['invariantsPreserved'] as boolean | null,
      affectedSurfaceReconciled: value['affectedSurfaceReconciled'] as boolean | null,
      missedAffectedArtifacts: missedAffectedArtifacts.value,
      residueDefects: residueDefects.value,
      reintroducedBehaviors: reintroducedBehaviors.value,
      architectureViolations: architectureViolations.value,
      controllerBlocked: value['controllerBlocked'] as boolean | null,
      blockerWasValid: value['blockerWasValid'] as boolean | null,
    },
  };
}

function normalizeArtifactRef(
  value: unknown,
): { ok: true; value: MissionTrialArtifactRef } | { ok: false; error: string } {
  if (!isRecordObject(value) || !isRelativeArtifactPath(value['relativePath']) || !isSha256(value['sha256'])) {
    return { ok: false, error: 'artifact references require a safe relative path and SHA-256 digest' };
  }
  return { ok: true, value: { relativePath: value['relativePath'], sha256: value['sha256'] } };
}

function normalizeObservedArtifact(
  value: unknown,
): { ok: true; value: MissionTrialObservedArtifact } | { ok: false; error: string } {
  if (
    !isRecordObject(value) ||
    !isSha256(value['expectedSha256']) ||
    !isSha256OrNull(value['beforeSha256']) ||
    !isSha256OrNull(value['afterSha256'])
  ) {
    return { ok: false, error: 'observed artifacts require expected, before, and after SHA-256 values or null' };
  }
  return {
    ok: true,
    value: {
      expectedSha256: value['expectedSha256'],
      beforeSha256: value['beforeSha256'],
      afterSha256: value['afterSha256'],
    },
  };
}

function normalizeRunArtifacts(
  value: unknown,
): { ok: true; value: Array<{ kind: string } & MissionTrialArtifactRef> } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
    return { ok: false, error: 'artifacts must be a bounded array' };
  }
  const artifacts: Array<{ kind: string } & MissionTrialArtifactRef> = [];
  for (const candidate of value) {
    if (!isRecordObject(candidate)) return { ok: false, error: 'each run artifact must be an object' };
    const kind = bounded(candidate['kind']);
    const artifact = normalizeArtifactRef(candidate);
    if (!kind || !artifact.ok) return { ok: false, error: 'run artifacts require kind, path, and digest' };
    artifacts.push({ kind, ...artifact.value });
  }
  return { ok: true, value: artifacts };
}

function normalizeWriter(
  value: unknown,
): { ok: true; value: { tool: 'scip-query'; version: string } } | { ok: false; error: string } {
  if (!isRecordObject(value) || value['tool'] !== 'scip-query') {
    return { ok: false, error: 'writer must name scip-query and a bounded version' };
  }
  const version = bounded(value['version']);
  if (!version) return { ok: false, error: 'writer must name scip-query and a bounded version' };
  return { ok: true, value: { tool: 'scip-query', version } };
}

function missionTrialRunId(run: Omit<MissionTrialRunV1, 'runId'>): string {
  const digest = hashIdentity({
    identityVersion: 1,
    programId: run.programId,
    pairId: run.pairId,
    fixtureId: run.fixtureId,
    treatment: run.treatment,
    rerunOrdinal: run.rerunOrdinal,
  });
  return `SQTR-${digest.slice(0, 32).toUpperCase()}`;
}

function missionTrialProgramId(digest: string): string {
  return `SQTP-${digest.slice(0, 32).toUpperCase()}`;
}

function missionTrialConditions(): MissionTrialProgramV1['conditions'] {
  return {
    control: { workflow: 'disabled' },
    treatment: { workflow: 'autonomous-completion-v1' },
  };
}

function isMissionTrialConditions(value: unknown): boolean {
  if (!isRecordObject(value) || !isRecordObject(value['control']) || !isRecordObject(value['treatment'])) {
    return false;
  }
  return (
    Object.keys(value).length === 2 &&
    Object.keys(value['control']).length === 1 &&
    Object.keys(value['treatment']).length === 1 &&
    value['control']['workflow'] === 'disabled' &&
    value['treatment']['workflow'] === 'autonomous-completion-v1'
  );
}

function addArtifactDriftReason(
  reasons: Set<string>,
  label: string,
  expectedSha256: string,
  observed: MissionTrialObservedArtifact,
): void {
  if (
    observed.expectedSha256 !== expectedSha256 ||
    observed.beforeSha256 !== expectedSha256 ||
    observed.afterSha256 !== expectedSha256
  ) {
    reasons.add(`${label} was unavailable or changed before or during the trial`);
  }
}

function boundedStringList(
  value: unknown,
  label: string,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
    return { ok: false, error: `${label} must be a bounded string array` };
  }
  const normalized = value.map(bounded);
  if (normalized.some((entry) => entry === undefined)) {
    return { ok: false, error: `${label} entries must be non-empty bounded lines` };
  }
  return { ok: true, value: normalized as string[] };
}

function nullableBoundedStringList(
  value: unknown,
  label: string,
): { ok: true; value: string[] | null } | { ok: false; error: string } {
  return value === null ? { ok: true, value: null } : boundedStringList(value, label);
}

function isRelativeArtifactPath(value: unknown): value is string {
  return (
    isBoundedRecordString(value) &&
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !value.split(/[\\/]/u).includes('..')
  );
}

function isUnitInterval(value: unknown): value is number {
  return isNonNegativeFiniteNumber(value) && value <= 1;
}

function bounded(value: unknown): string | undefined {
  return isBoundedRecordString(value) ? value : undefined;
}

function isSha256OrNull(value: unknown): value is string | null {
  return value === null || isSha256(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && GIT_COMMIT_PATTERN.test(value);
}

function isRunStatus(value: unknown): value is MissionTrialRunStatus {
  return value === 'completed' || value === 'timed-out' || value === 'crashed' || value === 'interrupted';
}

function isFailureOrigin(value: unknown): value is MissionTrialFailureOrigin {
  return (
    value === null ||
    value === 'detector-miss' ||
    value === 'controller-miss' ||
    value === 'agent-failure' ||
    value === 'apparatus-failure'
  );
}
