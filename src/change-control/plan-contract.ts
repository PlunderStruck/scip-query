import type { ObligationAdmissionRequest, ObligationCategory } from '../domain/autonomous-work-obligations.js';
import {
  assertWorkRecordInput,
  decodeGoalCreateRequest,
  decodeIntendedChangeCreateRequest,
  decodeWorkRecordEnvelope,
  hashIdentity,
  isIntendedChangeId,
  isGoalId,
  isSha256,
  matchesWorkStateIdentity,
  normalizedBoundedLine,
  type GoalCreateRequest,
  type IntendedChangeCreateRequest,
  type WorkStateDecodeResult,
  type WorkStateWriter,
} from '../domain/autonomous-work-state.js';
import { decodeObservationReceipt, type ObservationReceiptV2 } from '../domain/observation-receipt.js';
import { isRecordObject } from '../domain/record-validation.js';
import { stableJson } from '../domain/stable-json.js';

export const PLAN_CONTRACT_RECORD_KIND = 'scip-query-plan-contract' as const;
export const PLAN_CONTRACT_SCHEMA_VERSION = 1 as const;
export const PLAN_CONTRACT_CANONICALIZATION_VERSION = 1 as const;

const PLAN_ID_PATTERN = /^SQP-[A-F0-9]{32}$/u;
const MAX_ITEMS = 64;
const MAX_ID = 120;
const MAX_REFERENT = 1_000;
const MAX_TEXT = 1_000;
const MAX_COMMAND = 1_000;
const MAX_SOURCE_PATH = 1_000;
const CONTRACT_FENCE = /```scip-query-plan[ \t]*\r?\n([\s\S]*?)\r?\n```/gu;
const PLACEHOLDER_GOAL_ID = 'SQG-00000000000000000000000000000000';
const PLACEHOLDER_CHANGE_ID = 'SQC-00000000000000000000000000000000';

export type PlanWorkflowClass = 'relational' | 'sustained';
export type PlanReferentKind =
  | 'symbol'
  | 'file'
  | 'identity'
  | 'responsibility'
  | 'configuration'
  | 'test'
  | 'documentation'
  | 'architecture';
export type SurvivorAuthority = 'goal' | 'repository-policy' | 'delegated-decision';

export interface PlanAffectedSeed {
  id: string;
  kind: PlanReferentKind;
  referent: string;
  role: string;
}

export interface PlanCondition {
  id: string;
  condition: string;
  evidenceIds: readonly string[];
}

export interface PlanArchitectureCondition extends PlanCondition {
  predicate: 'configured-policy-clean';
}

export interface PlanRetirementTarget extends PlanCondition {
  kind: PlanReferentKind;
  referent: string;
  responsibility: string;
}

export interface PlanAllowedSurvivor {
  id: string;
  referent: string;
  authority: SurvivorAuthority;
  authorityReferent: string;
  currentRole: string;
  evidenceIds: readonly string[];
  removalCondition?: string;
}

/**
 * A reuse authority is an existing repository symbol selected to remain the
 * single owner of one responsibility while named affected consumers delegate
 * that responsibility to it.
 */
export interface PlanReuseAuthority extends PlanCondition {
  referent: string;
  responsibility: string;
  consumerSeedIds: readonly string[];
}

export interface PlanCompletionEvidence {
  id: string;
  description: string;
  command?: string;
}

export interface PlanSlice {
  id: string;
  outcome: string;
  evidenceIds: readonly string[];
  dependsOn: readonly string[];
}

export interface PlanContractRequest {
  schemaVersion: typeof PLAN_CONTRACT_SCHEMA_VERSION;
  goalId: string;
  changeId: string;
  workflowClass: PlanWorkflowClass;
  predecessorPlanId?: string;
  affectedSeeds: readonly PlanAffectedSeed[];
  preserve: readonly PlanCondition[];
  retirements: readonly PlanRetirementTarget[];
  allowedSurvivors: readonly PlanAllowedSurvivor[];
  reuseAuthorities: readonly PlanReuseAuthority[];
  architecture: readonly PlanArchitectureCondition[];
  completionEvidence: readonly PlanCompletionEvidence[];
  slices: readonly PlanSlice[];
}

export type PlanInitialChangeRequest = Omit<IntendedChangeCreateRequest, 'goalId'>;

export type PlanContractInput = Omit<PlanContractRequest, 'goalId' | 'changeId'> &
  (
    | { goalId: string; changeId: string; goal?: never; change?: never }
    | {
        goal: GoalCreateRequest;
        change: PlanInitialChangeRequest;
        goalId?: never;
        changeId?: never;
      }
  );

export interface PlanContractSource {
  path: string;
  sha256: string;
}

export interface PlanContractRecordV1 extends Omit<PlanContractRequest, 'schemaVersion'> {
  kind: typeof PLAN_CONTRACT_RECORD_KIND;
  schemaVersion: typeof PLAN_CONTRACT_SCHEMA_VERSION;
  planId: string;
  collaborationDomainId: string;
  source: PlanContractSource;
  compiledAgainst: ObservationReceiptV2;
  semanticIdentity: {
    algorithm: 'sha256';
    canonicalizationVersion: typeof PLAN_CONTRACT_CANONICALIZATION_VERSION;
    digest: string;
  };
  createdAt: string;
  writer: WorkStateWriter;
}

export interface CreatePlanContractRecordInput {
  collaborationDomainId: string;
  request: PlanContractRequest;
  source: PlanContractSource;
  compiledAgainst: ObservationReceiptV2;
  createdAt: string;
  toolVersion: string;
}

export type PlanContractDecodeResult<T> = { ok: true; request: T } | { ok: false; error: string };

/**
 * A change contract connects an authorized goal to concrete repository
 * consequences without prescribing implementation steps. Direct work is
 * deliberately excluded: requiring a durable contract for a proven local
 * edit would add state without changing a later decision.
 */
export function decodePlanContractRequest(value: unknown): PlanContractDecodeResult<PlanContractRequest> {
  if (!isRecordObject(value)) return failure('plan contract must be an object');
  const headerErrors: string[] = [];
  if (value['schemaVersion'] !== PLAN_CONTRACT_SCHEMA_VERSION)
    headerErrors.push(`schemaVersion: must be ${PLAN_CONTRACT_SCHEMA_VERSION}`);
  const goalId = value['goalId'];
  const changeId = value['changeId'];
  if (!isGoalId(goalId)) headerErrors.push('goalId: must be a goal identity');
  if (!isIntendedChangeId(changeId)) headerErrors.push('changeId: must be an intended-change identity');
  const workflowClass = value['workflowClass'];
  if (workflowClass !== 'relational' && workflowClass !== 'sustained') {
    headerErrors.push('workflowClass: must be relational or sustained; direct work does not need a plan contract');
  }
  const predecessorPlanId = value['predecessorPlanId'];
  if (predecessorPlanId !== undefined && !isPlanContractId(predecessorPlanId)) {
    headerErrors.push('predecessorPlanId: must be a plan identity');
  }

  const affectedSeeds = decodeItems(value['affectedSeeds'], 'affectedSeeds', decodeAffectedSeed);
  const preserve = decodeItems(value['preserve'], 'preserve', decodeCondition);
  const retirements = decodeItems(value['retirements'], 'retirements', decodeRetirement);
  const allowedSurvivors = decodeItems(value['allowedSurvivors'], 'allowedSurvivors', decodeSurvivor);
  const reuseAuthorities = decodeItems(value['reuseAuthorities'], 'reuseAuthorities', decodeReuseAuthority);
  const architecture = decodeItems(value['architecture'], 'architecture', decodeArchitectureCondition);
  const completionEvidence = decodeItems(value['completionEvidence'], 'completionEvidence', decodeCompletionEvidence);
  const slices = decodeItems(value['slices'], 'slices', decodeSlice, { preserveOrder: true });
  const workflowShapeErrors: string[] = [];
  const rawSlices = value['slices'];
  if (workflowClass === 'sustained' && Array.isArray(rawSlices) && rawSlices.length === 0) {
    workflowShapeErrors.push('slices: sustained plan contracts require at least one resumable slice');
  }
  if (workflowClass === 'relational' && Array.isArray(rawSlices) && rawSlices.length > 0) {
    workflowShapeErrors.push(
      'slices: relational plan contracts keep one coherent slice; use sustained when ordered slices are required',
    );
  }
  const sectionErrors = [
    affectedSeeds,
    preserve,
    retirements,
    allowedSurvivors,
    reuseAuthorities,
    architecture,
    completionEvidence,
    slices,
  ].flatMap((result) => (result.ok ? [] : [result.error]));
  if (
    headerErrors.length > 0 ||
    !affectedSeeds.ok ||
    !preserve.ok ||
    !retirements.ok ||
    !allowedSurvivors.ok ||
    !reuseAuthorities.ok ||
    !architecture.ok ||
    !completionEvidence.ok ||
    !slices.ok
  ) {
    return validationFailure([...headerErrors, ...sectionErrors, ...workflowShapeErrors]);
  }
  if (
    !isGoalId(goalId) ||
    !isIntendedChangeId(changeId) ||
    (workflowClass !== 'relational' && workflowClass !== 'sustained')
  ) {
    return validationFailure(headerErrors);
  }

  const evidenceIds = new Set(completionEvidence.items.map((item) => item.id));
  const relationshipErrors: string[] = [];
  for (const item of [
    ...preserve.items,
    ...retirements.items,
    ...allowedSurvivors.items,
    ...reuseAuthorities.items,
    ...architecture.items,
  ]) {
    const missing = item.evidenceIds.filter((id) => !evidenceIds.has(id));
    if (missing.length > 0)
      relationshipErrors.push(`${item.id}: references missing completion evidence: ${missing.join(', ')}`);
  }
  const affectedSeedIds = new Set(affectedSeeds.items.map((item) => item.id));
  for (const authority of reuseAuthorities.items) {
    const missing = authority.consumerSeedIds.filter((id) => !affectedSeedIds.has(id));
    if (missing.length > 0)
      relationshipErrors.push(`${authority.id}: references missing affected seeds: ${missing.join(', ')}`);
  }
  for (const slice of slices.items) {
    const missing = slice.evidenceIds.filter((id) => !evidenceIds.has(id));
    if (missing.length > 0)
      relationshipErrors.push(`${slice.id}: references missing completion evidence: ${missing.join(', ')}`);
  }
  const sliceIds = new Set(slices.items.map((item) => item.id));
  for (const slice of slices.items) {
    const missing = slice.dependsOn.filter((id) => !sliceIds.has(id));
    if (missing.length > 0) relationshipErrors.push(`${slice.id}: depends on missing slices: ${missing.join(', ')}`);
    if (slice.dependsOn.includes(slice.id)) relationshipErrors.push(`${slice.id}: cannot depend on itself`);
  }
  relationshipErrors.push(...workflowShapeErrors);
  if (relationshipErrors.length > 0) return validationFailure(relationshipErrors);

  return {
    ok: true,
    request: {
      schemaVersion: PLAN_CONTRACT_SCHEMA_VERSION,
      goalId,
      changeId,
      workflowClass,
      ...(typeof predecessorPlanId === 'string' ? { predecessorPlanId } : {}),
      affectedSeeds: affectedSeeds.items,
      preserve: preserve.items,
      retirements: retirements.items,
      allowedSurvivors: allowedSurvivors.items,
      reuseAuthorities: reuseAuthorities.items,
      architecture: architecture.items,
      completionEvidence: completionEvidence.items,
      slices: slices.items,
    },
  };
}

export function decodePlanContractInput(value: unknown): PlanContractDecodeResult<PlanContractInput> {
  if (!isRecordObject(value)) return failure('plan contract must be an object');
  if (value['form'] === 'compact') return decodeCompactPlanContractInput(value);
  const existingReferences = value['goalId'] !== undefined || value['changeId'] !== undefined;
  const inlineReferences = value['goal'] !== undefined || value['change'] !== undefined;
  if (existingReferences && inlineReferences) {
    return failure('plan contract cannot mix goalId/changeId with inline goal/change objects');
  }
  if (existingReferences) {
    const decoded = decodePlanContractRequest(value);
    if (!decoded.ok) return decoded;
    return { ok: true, request: decoded.request };
  }
  if (!inlineReferences || value['goal'] === undefined || value['change'] === undefined) {
    return failure('plan contract must name either existing goalId/changeId values or inline goal/change objects');
  }

  const goal = decodeGoalCreateRequest(value['goal']);
  if (!goal.ok) return failure(`goal: ${goal.error}`);
  if (!isRecordObject(value['change'])) return failure('change must be an object');
  const change = decodeIntendedChangeCreateRequest({
    ...value['change'],
    goalId: PLACEHOLDER_GOAL_ID,
  });
  if (!change.ok) return failure(`change: ${change.error}`);
  const resolved = decodePlanContractRequest({
    ...value,
    goalId: PLACEHOLDER_GOAL_ID,
    changeId: PLACEHOLDER_CHANGE_ID,
  });
  if (!resolved.ok) return resolved;
  const { goalId: _goalId, changeId: _changeId, ...body } = resolved.request;
  return {
    ok: true,
    request: {
      ...body,
      goal: goal.request,
      change: {
        idempotencyKey: change.request.idempotencyKey,
        title: change.request.title,
        intendedOutcome: change.request.intendedOutcome,
      },
    },
  };
}

/**
 * The compact form is an authoring convenience, not a second durable schema.
 * It removes generated identities and repeated field names, then immediately
 * expands into the strict v1 input that every existing validator and record
 * writer already owns.
 */
function decodeCompactPlanContractInput(value: Record<string, unknown>): PlanContractDecodeResult<PlanContractInput> {
  const existingReferences = value['goalId'] !== undefined || value['changeId'] !== undefined;
  const inlineReferences = value['goal'] !== undefined || value['change'] !== undefined;
  if (existingReferences && inlineReferences) {
    return failure('compact plan contract cannot mix goalId/changeId with inline goal/change objects');
  }

  const goal = existingReferences ? undefined : compactGoal(value['goal']);
  const change = existingReferences ? undefined : compactChange(value['change'], goal);
  const workReferences = existingReferences
    ? { goalId: value['goalId'], changeId: value['changeId'] }
    : { goal, change };
  const expanded = {
    schemaVersion: value['schemaVersion'],
    ...workReferences,
    workflowClass: value['class'] ?? value['workflowClass'],
    ...(value['predecessorPlanId'] !== undefined ? { predecessorPlanId: value['predecessorPlanId'] } : {}),
    affectedSeeds: compactItems(value['seeds'] ?? value['affectedSeeds'] ?? [], (item, index) => ({
      ...item,
      id: compactItemId(item, 'seed', index),
    })),
    preserve: compactItems(value['preserve'] ?? [], (item, index) => ({
      ...item,
      id: compactItemId(item, 'preserve', index),
      evidenceIds: item['evidenceIds'] ?? item['evidence'],
    })),
    retirements: compactItems(value['retire'] ?? value['retirements'] ?? [], (item, index) => ({
      ...item,
      id: compactItemId(item, 'retire', index),
      evidenceIds: item['evidenceIds'] ?? item['evidence'],
    })),
    allowedSurvivors: compactItems(value['survivors'] ?? value['allowedSurvivors'] ?? [], (item, index) => ({
      ...item,
      id: compactItemId(item, 'survivor', index),
      evidenceIds: item['evidenceIds'] ?? item['evidence'],
    })),
    reuseAuthorities: compactItems(value['reuse'] ?? value['reuseAuthorities'] ?? [], (item, index) => ({
      ...item,
      id: compactItemId(item, 'reuse', index),
      consumerSeedIds: item['consumerSeedIds'] ?? item['consumers'],
      evidenceIds: item['evidenceIds'] ?? item['evidence'],
    })),
    architecture: compactItems(value['architecture'] ?? [], (item, index) => ({
      ...item,
      id: compactItemId(item, 'architecture', index),
      predicate: item['predicate'] ?? 'configured-policy-clean',
      evidenceIds: item['evidenceIds'] ?? item['evidence'],
    })),
    completionEvidence: compactCompletionEvidence(value['evidence'] ?? value['completionEvidence']),
    slices: compactItems(value['slices'] ?? [], (item, index) => ({
      ...item,
      id: compactItemId(item, 'slice', index),
      evidenceIds: item['evidenceIds'] ?? item['evidence'],
      dependsOn: item['dependsOn'] ?? [],
    })),
  };
  return decodePlanContractInput(expanded);
}

function compactGoal(value: unknown): unknown {
  if (!isRecordObject(value)) return value;
  const scenario = value['scenario'];
  const acceptanceScenarios =
    value['acceptanceScenarios'] ??
    (isRecordObject(scenario)
      ? [
          {
            name: scenario['name'],
            given: compactTextList(scenario['given']),
            when: compactTextList(scenario['when']),
            then: compactTextList(scenario['then']),
          },
        ]
      : scenario);
  return {
    feature: value['feature'],
    invariants: value['invariants'],
    acceptanceScenarios,
    authorization:
      value['authorization'] ??
      ({
        kind: 'repository-delegation',
        principal: 'repository-owner',
        source: 'authorized user request',
      } as const),
  };
}

function compactChange(value: unknown, goal: unknown): unknown {
  if (!isRecordObject(value)) return value;
  return {
    idempotencyKey: value['key'] ?? value['idempotencyKey'],
    title:
      value['title'] ?? (isRecordObject(goal) && typeof goal['feature'] === 'string' ? goal['feature'] : undefined),
    intendedOutcome: value['outcome'] ?? value['intendedOutcome'],
  };
}

function compactItems(
  value: unknown,
  transform: (item: Record<string, unknown>, index: number) => Record<string, unknown>,
): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item, index) => (isRecordObject(item) ? transform(item, index) : item));
}

function compactCompletionEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (!isRecordObject(value)) return value;
  return Object.entries(value).map(([id, item]) => {
    if (typeof item === 'string') return { id, description: item };
    if (!isRecordObject(item)) return item;
    return { id, description: item['description'], ...(item['command'] ? { command: item['command'] } : {}) };
  });
}

function compactItemId(item: Record<string, unknown>, prefix: string, index: number): unknown {
  return item['id'] ?? `${prefix}-${index + 1}`;
}

// scip-query: ignore-similar — compact plan text normalization and numeric
// source-position validation operate on different facts and must evolve separately.
function compactTextList(value: unknown): unknown {
  return typeof value === 'string' ? [value] : value;
}

export function extractPlanContractRequest(markdown: string): PlanContractDecodeResult<PlanContractRequest> {
  const parsed = extractPlanContractValue(markdown);
  return parsed.ok ? decodePlanContractRequest(parsed.request) : parsed;
}

export function extractPlanContractInput(markdown: string): PlanContractDecodeResult<PlanContractInput> {
  const parsed = extractPlanContractValue(markdown);
  return parsed.ok ? decodePlanContractInput(parsed.request) : parsed;
}

function extractPlanContractValue(markdown: string): PlanContractDecodeResult<unknown> {
  const matches = [...markdown.matchAll(CONTRACT_FENCE)];
  if (matches.length !== 1) {
    return failure(
      matches.length === 0
        ? 'plan must contain one ```scip-query-plan JSON fence'
        : 'plan must contain exactly one ```scip-query-plan JSON fence',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0]![1]!);
  } catch (error) {
    return failure(
      `scip-query-plan fence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { ok: true, request: parsed };
}

export function createPlanContractRecord(input: CreatePlanContractRecordInput): PlanContractRecordV1 {
  assertWorkRecordInput(input.collaborationDomainId, input.createdAt, input.toolVersion);
  const decoded = decodePlanContractRequest(input.request);
  if (!decoded.ok) throw new Error(decoded.error);
  const source = decodeSource(input.source);
  if (!source.ok) throw new Error(source.error);
  const receipt = decodeObservationReceipt(input.compiledAgainst);
  if (receipt.kind !== 'supported' || receipt.schemaVersion !== 2) {
    throw new Error('compiledAgainst must be a supported observation receipt v2');
  }
  const semanticMeaning = planSemanticMeaning(decoded.request, source.source, receipt.receipt);
  const digest = hashIdentity(semanticMeaning);
  return {
    kind: PLAN_CONTRACT_RECORD_KIND,
    schemaVersion: PLAN_CONTRACT_SCHEMA_VERSION,
    planId: planIdFromDigest(digest),
    collaborationDomainId: input.collaborationDomainId,
    goalId: decoded.request.goalId,
    changeId: decoded.request.changeId,
    workflowClass: decoded.request.workflowClass,
    ...(decoded.request.predecessorPlanId ? { predecessorPlanId: decoded.request.predecessorPlanId } : {}),
    affectedSeeds: decoded.request.affectedSeeds,
    preserve: decoded.request.preserve,
    retirements: decoded.request.retirements,
    allowedSurvivors: decoded.request.allowedSurvivors,
    reuseAuthorities: decoded.request.reuseAuthorities,
    architecture: decoded.request.architecture,
    completionEvidence: decoded.request.completionEvidence,
    slices: decoded.request.slices,
    source: source.source,
    compiledAgainst: receipt.receipt,
    semanticIdentity: {
      algorithm: 'sha256',
      canonicalizationVersion: PLAN_CONTRACT_CANONICALIZATION_VERSION,
      digest,
    },
    createdAt: input.createdAt,
    writer: { tool: 'scip-query', version: input.toolVersion },
  };
}

// scip-query: ignore-similar — record decoders share the work-state envelope,
// while this decoder owns plan-specific canonical fields and identity checks.
export function decodePlanContractRecord(value: unknown): WorkStateDecodeResult<PlanContractRecordV1> {
  const envelope = decodeWorkRecordEnvelope(value, {
    recordKind: PLAN_CONTRACT_RECORD_KIND,
    schemaVersion: PLAN_CONTRACT_SCHEMA_VERSION,
    label: 'plan contract',
  });
  if (!envelope.ok) return envelope.result;
  const fields = envelope.envelope.value;
  const request = decodePlanContractRequest({
    schemaVersion: PLAN_CONTRACT_SCHEMA_VERSION,
    goalId: fields['goalId'],
    changeId: fields['changeId'],
    workflowClass: fields['workflowClass'],
    predecessorPlanId: fields['predecessorPlanId'],
    affectedSeeds: fields['affectedSeeds'],
    preserve: fields['preserve'],
    retirements: fields['retirements'],
    allowedSurvivors: fields['allowedSurvivors'],
    reuseAuthorities: fields['reuseAuthorities'],
    architecture: fields['architecture'],
    completionEvidence: fields['completionEvidence'],
    slices: fields['slices'],
  });
  if (!request.ok) return { state: 'malformed', error: request.error };
  const source = decodeSource(fields['source']);
  if (!source.ok) return { state: 'malformed', error: source.error };
  const receipt = decodeObservationReceipt(fields['compiledAgainst']);
  if (receipt.kind !== 'supported' || receipt.schemaVersion !== 2) {
    return { state: 'malformed', error: 'compiledAgainst must be a supported observation receipt v2' };
  }
  const expected = createPlanContractRecord({
    collaborationDomainId: envelope.envelope.collaborationDomainId,
    request: request.request,
    source: source.source,
    compiledAgainst: receipt.receipt,
    createdAt: envelope.envelope.createdAt,
    toolVersion: envelope.envelope.writer.version,
  });
  if (stableJson(fields) !== stableJson(expected)) {
    return { state: 'malformed', error: 'plan contract fields are not canonical or do not match their identity' };
  }
  return { state: 'current', record: expected };
}

export function planContractRequestMatchesRecord(
  collaborationDomainId: string,
  request: PlanContractRequest,
  source: PlanContractSource,
  compiledAgainst: ObservationReceiptV2,
  record: PlanContractRecordV1,
): boolean {
  try {
    const candidate = createPlanContractRecord({
      collaborationDomainId,
      request,
      source,
      compiledAgainst,
      createdAt: record.createdAt,
      toolVersion: record.writer.version,
    });
    return candidate.planId === record.planId && candidate.semanticIdentity.digest === record.semanticIdentity.digest;
  } catch {
    return false;
  }
}

/** Derive live completion conditions without creating metadata-only evidence obligations. */
export function planContractObligationRequests(record: PlanContractRecordV1): ObligationAdmissionRequest[] {
  const entries: Array<{ id: string; category: ObligationCategory; title: string; condition: string }> = [
    ...record.architecture.map((item) => ({
      id: `architecture:${item.id}`,
      category: 'architecture' as const,
      title: `Preserve architecture: ${item.id}`,
      condition: item.condition,
    })),
    ...record.retirements.map((item) => ({
      id: `retire:${item.id}`,
      category: 'residue' as const,
      title: `Retire ${item.referent}`,
      condition: item.condition,
    })),
    ...record.reuseAuthorities.map((item) => ({
      id: `reuse:${item.id}`,
      category: 'verification' as const,
      title: `Reuse ${item.referent}`,
      condition: item.condition,
    })),
  ];
  return entries.map((entry) => ({
    changeId: record.changeId,
    idempotencyKey: `plan-contract:${record.planId}:${entry.id}`,
    category: entry.category,
    title: entry.title,
    requiredCondition: entry.condition,
    source: { kind: 'agent-discovery', referent: `${record.planId}#${entry.id}` },
    basisAttemptIds: [],
    evidenceReceipts: [record.compiledAgainst],
  }));
}

// scip-query: ignore-similar — type-specific ID guards deliberately delegate
// the common validation rule to matchesWorkStateIdentity.
export function isPlanContractId(value: unknown): value is string {
  return matchesWorkStateIdentity(value, PLAN_ID_PATTERN);
}

function decodeAffectedSeed(value: unknown): PlanContractDecodeResult<PlanAffectedSeed> {
  if (!isRecordObject(value)) return failure('affected seed must be an object');
  const base = decodeReferent(value);
  if (!base.ok) return base;
  const role = line(value['role'], MAX_TEXT, 'affected seed role');
  if (!role.ok) return role;
  return { ok: true, request: { ...base.request, role: role.value } };
}

function decodeCondition(value: unknown): PlanContractDecodeResult<PlanCondition> {
  if (!isRecordObject(value)) return failure('plan condition must be an object');
  const id = itemId(value['id']);
  if (!id.ok) return id;
  const condition = line(value['condition'], MAX_TEXT, `${id.value} condition`);
  if (!condition.ok) return condition;
  const evidenceIds = stringIds(value['evidenceIds'], `${id.value} evidenceIds`);
  if (!evidenceIds.ok) return evidenceIds;
  if (evidenceIds.values.length === 0) return failure(`${id.value} must name at least one evidenceIds entry`);
  return { ok: true, request: { id: id.value, condition: condition.value, evidenceIds: evidenceIds.values } };
}

function decodeArchitectureCondition(value: unknown): PlanContractDecodeResult<PlanArchitectureCondition> {
  const condition = decodeCondition(value);
  if (!condition.ok) return condition;
  if (!isRecordObject(value) || value['predicate'] !== 'configured-policy-clean') {
    return failure(`${condition.request.id} architecture predicate must be configured-policy-clean`);
  }
  return { ok: true, request: { ...condition.request, predicate: 'configured-policy-clean' } };
}

function decodeRetirement(value: unknown): PlanContractDecodeResult<PlanRetirementTarget> {
  if (!isRecordObject(value)) return failure('retirement target must be an object');
  const base = decodeReferent(value);
  if (!base.ok) return base;
  const condition = decodeCondition(value);
  if (!condition.ok) return condition;
  const responsibility = line(value['responsibility'], MAX_TEXT, `${base.request.id} responsibility`);
  if (!responsibility.ok) return responsibility;
  return {
    ok: true,
    request: {
      ...condition.request,
      kind: base.request.kind,
      referent: base.request.referent,
      responsibility: responsibility.value,
    },
  };
}

function decodeSurvivor(value: unknown): PlanContractDecodeResult<PlanAllowedSurvivor> {
  if (!isRecordObject(value)) return failure('allowed survivor must be an object');
  const id = itemId(value['id']);
  if (!id.ok) return id;
  const referent = line(value['referent'], MAX_REFERENT, `${id.value} referent`);
  if (!referent.ok) return referent;
  if (!isSurvivorAuthority(value['authority'])) {
    return failure(
      `${id.value} authority must be goal, repository-policy, or delegated-decision; the plan cannot authorize itself`,
    );
  }
  const authorityReferent = line(value['authorityReferent'], MAX_REFERENT, `${id.value} authorityReferent`);
  if (!authorityReferent.ok) return authorityReferent;
  const currentRole = line(value['currentRole'], MAX_TEXT, `${id.value} currentRole`);
  if (!currentRole.ok) return currentRole;
  const evidenceIds = stringIds(value['evidenceIds'], `${id.value} evidenceIds`);
  if (!evidenceIds.ok || evidenceIds.values.length === 0) {
    return failure(`${id.value} must name at least one evidenceIds entry`);
  }
  const removalCondition = value['removalCondition'];
  const normalizedRemoval =
    removalCondition === undefined ? undefined : (normalizedBoundedLine(removalCondition, MAX_TEXT) ?? null);
  if (normalizedRemoval === null) return failure(`${id.value} removalCondition must be a bounded line when present`);
  return {
    ok: true,
    request: {
      id: id.value,
      referent: referent.value,
      authority: value['authority'],
      authorityReferent: authorityReferent.value,
      currentRole: currentRole.value,
      evidenceIds: evidenceIds.values,
      ...(normalizedRemoval ? { removalCondition: normalizedRemoval } : {}),
    },
  };
}

function decodeReuseAuthority(value: unknown): PlanContractDecodeResult<PlanReuseAuthority> {
  if (!isRecordObject(value)) return failure('reuse authority must be an object');
  const id = itemId(value['id']);
  const label = id.ok ? id.value : 'reuse authority';
  const condition = line(value['condition'], MAX_TEXT, `${label} condition`);
  const evidenceIds = stringIds(value['evidenceIds'], `${label} evidenceIds`);
  const referent = line(value['referent'], MAX_REFERENT, `${label} referent`);
  const responsibility = line(value['responsibility'], MAX_TEXT, `${label} responsibility`);
  const consumerSeedIds = stringIds(value['consumerSeedIds'], `${label} consumerSeedIds`);
  const errors = [
    ...(id.ok ? [] : [id.error]),
    ...(condition.ok ? [] : [condition.error]),
    ...(evidenceIds.ok
      ? evidenceIds.values.length > 0
        ? []
        : [`${label} must name at least one evidenceIds entry`]
      : [evidenceIds.error]),
    ...(referent.ok ? [] : [referent.error]),
    ...(responsibility.ok ? [] : [responsibility.error]),
    ...(consumerSeedIds.ok
      ? consumerSeedIds.values.length >= 2
        ? []
        : [`${label} must name at least two affected consumer seed ids`]
      : [consumerSeedIds.error]),
  ];
  if (
    errors.length > 0 ||
    !id.ok ||
    !condition.ok ||
    !evidenceIds.ok ||
    !referent.ok ||
    !responsibility.ok ||
    !consumerSeedIds.ok
  ) {
    return validationFailure(errors);
  }
  return {
    ok: true,
    request: {
      id: id.value,
      condition: condition.value,
      evidenceIds: evidenceIds.values,
      referent: referent.value,
      responsibility: responsibility.value,
      consumerSeedIds: consumerSeedIds.values,
    },
  };
}

function decodeCompletionEvidence(value: unknown): PlanContractDecodeResult<PlanCompletionEvidence> {
  if (!isRecordObject(value)) return failure('completion evidence must be an object');
  const id = itemId(value['id']);
  if (!id.ok) return id;
  const description = line(value['description'], MAX_TEXT, `${id.value} evidence description`);
  if (!description.ok) return description;
  const command = value['command'];
  const normalizedCommand = command === undefined ? undefined : (normalizedBoundedLine(command, MAX_COMMAND) ?? null);
  if (normalizedCommand === null) return failure(`${id.value} command must be a bounded line when present`);
  return {
    ok: true,
    request: {
      id: id.value,
      description: description.value,
      ...(normalizedCommand ? { command: normalizedCommand } : {}),
    },
  };
}

function decodeSlice(value: unknown): PlanContractDecodeResult<PlanSlice> {
  if (!isRecordObject(value)) return failure('plan slice must be an object');
  const id = itemId(value['id']);
  if (!id.ok) return id;
  const outcome = line(value['outcome'], MAX_TEXT, `${id.value} outcome`);
  if (!outcome.ok) return outcome;
  const evidenceIds = stringIds(value['evidenceIds'], `${id.value} evidenceIds`);
  if (!evidenceIds.ok || evidenceIds.values.length === 0) {
    return failure(`${id.value} must name at least one evidenceIds entry`);
  }
  const dependsOn = stringIds(value['dependsOn'] ?? [], `${id.value} dependsOn`);
  if (!dependsOn.ok) return dependsOn;
  return {
    ok: true,
    request: { id: id.value, outcome: outcome.value, evidenceIds: evidenceIds.values, dependsOn: dependsOn.values },
  };
}

function decodeReferent(value: Record<string, unknown>): PlanContractDecodeResult<{
  id: string;
  kind: PlanReferentKind;
  referent: string;
}> {
  const id = itemId(value['id']);
  if (!id.ok) return id;
  if (!isReferentKind(value['kind'])) return failure(`${id.value} kind is not a supported repository referent kind`);
  const referent = line(value['referent'], MAX_REFERENT, `${id.value} referent`);
  if (!referent.ok) return referent;
  return { ok: true, request: { id: id.value, kind: value['kind'], referent: referent.value } };
}

function decodeItems<T>(
  value: unknown,
  label: string,
  decode: (value: unknown) => PlanContractDecodeResult<T>,
  options: { preserveOrder?: boolean } = {},
): { ok: true; items: T[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > MAX_ITEMS)
    return failure(`${label} must be an array of at most ${MAX_ITEMS} items`);
  const items: T[] = [];
  const ids = new Set<string>();
  const errors: string[] = [];
  for (const [index, raw] of value.entries()) {
    const decoded = decode(raw);
    if (!decoded.ok) {
      errors.push(`${label}[${index}]: ${decoded.error}`);
      continue;
    }
    const id = (decoded.request as { id?: unknown }).id;
    if (typeof id === 'string') {
      if (ids.has(id)) {
        errors.push(`${label}[${index}]: duplicate id ${id}`);
        continue;
      }
      ids.add(id);
    }
    items.push(decoded.request);
  }
  if (errors.length > 0) return validationFailure(errors);
  if (!options.preserveOrder) items.sort((left, right) => itemIdentity(left).localeCompare(itemIdentity(right)));
  return { ok: true, items };
}

function decodeSource(value: unknown): { ok: true; source: PlanContractSource } | { ok: false; error: string } {
  if (!isRecordObject(value)) return failure('plan source must be an object');
  const path = normalizedBoundedLine(value['path'], MAX_SOURCE_PATH);
  if (!path || path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    return failure('plan source path must be a safe project-relative path');
  }
  if (!isSha256(value['sha256'])) return failure('plan source sha256 must be a lowercase SHA-256 digest');
  return { ok: true, source: { path, sha256: value['sha256'] } };
}

function stringIds(value: unknown, label: string): { ok: true; values: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return failure(`${label} must be an array of item ids`);
  const values: string[] = [];
  for (const raw of value) {
    const decoded = itemId(raw);
    if (!decoded.ok) return failure(`${label}: ${decoded.error}`);
    values.push(decoded.value);
  }
  return { ok: true, values: [...new Set(values)].sort() };
}

function itemId(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const id = normalizedBoundedLine(value, MAX_ID);
  return id && /^[a-z0-9][a-z0-9._-]*$/u.test(id)
    ? { ok: true, value: id }
    : failure('item id must use lowercase letters, digits, dots, underscores, or hyphens');
}

function line(value: unknown, max: number, label: string): { ok: true; value: string } | { ok: false; error: string } {
  const normalized = normalizedBoundedLine(value, max);
  return normalized ? { ok: true, value: normalized } : failure(`${label} must be a non-empty bounded line`);
}

function planSemanticMeaning(
  request: PlanContractRequest,
  source: PlanContractSource,
  compiledAgainst: ObservationReceiptV2,
): unknown {
  const { observedAt: _observedAt, ...fixedObservationMeaning } = compiledAgainst;
  return {
    canonicalizationVersion: PLAN_CONTRACT_CANONICALIZATION_VERSION,
    request,
    source,
    compiledAgainst: fixedObservationMeaning,
  };
}

function planIdFromDigest(digest: string): string {
  return `SQP-${digest.slice(0, 32).toUpperCase()}`;
}

function isReferentKind(value: unknown): value is PlanReferentKind {
  return (
    value === 'symbol' ||
    value === 'file' ||
    value === 'identity' ||
    value === 'responsibility' ||
    value === 'configuration' ||
    value === 'test' ||
    value === 'documentation' ||
    value === 'architecture'
  );
}

function isSurvivorAuthority(value: unknown): value is SurvivorAuthority {
  return value === 'goal' || value === 'repository-policy' || value === 'delegated-decision';
}

function itemIdentity(value: unknown): string {
  return isRecordObject(value) && typeof value['id'] === 'string' ? value['id'] : stableJson(value);
}

function failure(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function validationFailure(errors: readonly string[]): { ok: false; error: string } {
  const unique = [...new Set(errors.filter(Boolean))];
  if (unique.length <= 1) return failure(unique[0] ?? 'plan contract validation failed');
  return failure(`plan contract has ${unique.length} validation errors:\n- ${unique.join('\n- ')}`);
}
