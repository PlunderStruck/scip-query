import { decodeObservationReceipt, type ObservationReceiptV2 } from './observation-receipt.js';
import {
  PROTECTED_ARTIFACT_CLASSES,
  type ProtectedArtifactClass,
  type ProtectedArtifactRule,
  type ProtectedArtifactSetSnapshot,
} from './completion-protection.js';
import { isRecordObject, isValidRecordTimestamp } from './record-validation.js';
import { stableJson } from './stable-json.js';
import {
  assertWorkRecordInput,
  decodeWorkRecordEnvelope,
  hashIdentity,
  isGoalId,
  isIntendedChangeId,
  normalizedBoundedLine,
  type GoalRecordV1,
  type IntendedChangeRecordV1,
  type WorkStateDecodeResult,
  type WorkStateWriter,
} from './autonomous-work-state.js';
import { COMPLETION_PREDICATES, type CompletionPredicate } from './autonomous-completion.js';

export const COMPLETION_CONTEXT_RECORD_KIND = 'scip-query-completion-context' as const;
export const COMPLETION_CONTEXT_RECORD_SCHEMA_VERSION = 1 as const;
export const COMPLETION_CONTEXT_CANONICALIZATION_VERSION = 1 as const;

const COMPLETION_CONTEXT_SNAPSHOT_ID_PATTERN = /^SQCX-[A-F0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_POLICY_ID_CHARACTERS = 200;
const MAX_EVALUATOR_ID_CHARACTERS = 200;
const MAX_VERSION_CHARACTERS = 200;
const MAX_REGISTRY_ENTRIES = 64;
const MAX_REGISTRY_ENTRY_CHARACTERS = 200;
const MAX_PROTECTED_CLASSES = 16;
const MAX_SELECTORS_PER_CLASS = 16;
const MAX_SELECTOR_CHARACTERS = 300;

export {
  PROTECTED_ARTIFACT_CLASSES,
  type ProtectedArtifactAuthority,
  type ProtectedArtifactClass,
  type ProtectedArtifactRule,
  type ProtectedArtifactSetSnapshot,
} from './completion-protection.js';

export interface CompletionPolicySnapshot {
  policyId: string;
  policyVersion: number;
  stopMode: 'warn' | 'feedback' | 'block';
  requiredPredicates: readonly CompletionPredicate[];
}

export interface CompletionEvaluatorSnapshot {
  evaluatorId: string;
  evaluatorVersion: string;
  buildIdentity: string;
}

export interface CompletionCommandRegistrySnapshot {
  registryIdentity: string;
  entries: readonly string[];
}

export interface CompletionContextSnapshotRequest {
  goal: GoalRecordV1;
  change: IntendedChangeRecordV1;
  policy: CompletionPolicySnapshot;
  evaluator: CompletionEvaluatorSnapshot;
  commandRegistry: CompletionCommandRegistrySnapshot;
  protectedArtifacts: ProtectedArtifactSetSnapshot;
  targetObservation: ObservationReceiptV2;
}

/**
 * A completion context snapshot is one immutable bundle of every input that
 * can change the meaning of a completion judgment. It differs from a target
 * receipt by also fixing the authorized goal, policy, evaluator build, check
 * registry, and the classes of candidate-editable artifacts that require
 * predecessor authority.
 */
export interface CompletionContextSnapshotRecordV1 {
  kind: typeof COMPLETION_CONTEXT_RECORD_KIND;
  schemaVersion: typeof COMPLETION_CONTEXT_RECORD_SCHEMA_VERSION;
  contextSnapshotId: string;
  collaborationDomainId: string;
  changeId: string;
  goalId: string;
  goalRecordDigest: string;
  policy: CompletionPolicySnapshot;
  evaluator: CompletionEvaluatorSnapshot;
  commandRegistry: CompletionCommandRegistrySnapshot;
  protectedArtifacts: ProtectedArtifactSetSnapshot;
  targetObservation: ObservationReceiptV2;
  capturedAt: string;
  createdAt: string;
  writer: WorkStateWriter;
}

export interface CreateCompletionContextSnapshotInput {
  collaborationDomainId: string;
  request: CompletionContextSnapshotRequest;
  capturedAt: string;
  toolVersion: string;
}

export function createCompletionContextSnapshotRecord(
  input: CreateCompletionContextSnapshotInput,
): CompletionContextSnapshotRecordV1 {
  assertWorkRecordInput(input.collaborationDomainId, input.capturedAt, input.toolVersion);
  assertCompletionContextRequest(input.collaborationDomainId, input.request);
  const meaning = completionContextMeaning(input.collaborationDomainId, input.request);
  return {
    kind: COMPLETION_CONTEXT_RECORD_KIND,
    schemaVersion: COMPLETION_CONTEXT_RECORD_SCHEMA_VERSION,
    contextSnapshotId: contextSnapshotId(meaning),
    collaborationDomainId: input.collaborationDomainId,
    changeId: input.request.change.changeId,
    goalId: input.request.goal.goalId,
    goalRecordDigest: hashIdentity(stableJson(input.request.goal)),
    policy: input.request.policy,
    evaluator: input.request.evaluator,
    commandRegistry: input.request.commandRegistry,
    protectedArtifacts: input.request.protectedArtifacts,
    targetObservation: input.request.targetObservation,
    capturedAt: input.capturedAt,
    createdAt: input.capturedAt,
    writer: { tool: 'scip-query', version: input.toolVersion },
  };
}

export function decodeCompletionContextSnapshotRecord(
  value: unknown,
): WorkStateDecodeResult<CompletionContextSnapshotRecordV1> {
  if (
    isRecordObject(value) &&
    value['kind'] === COMPLETION_CONTEXT_RECORD_KIND &&
    typeof value['schemaVersion'] === 'number' &&
    value['schemaVersion'] > COMPLETION_CONTEXT_RECORD_SCHEMA_VERSION
  ) {
    return {
      state: 'unsupported-future',
      error: `completion context schema ${value['schemaVersion']} is newer than supported version ${COMPLETION_CONTEXT_RECORD_SCHEMA_VERSION}`,
    };
  }
  const envelope = decodeWorkRecordEnvelope(value, {
    recordKind: COMPLETION_CONTEXT_RECORD_KIND,
    schemaVersion: COMPLETION_CONTEXT_RECORD_SCHEMA_VERSION,
    label: 'completion-context',
  });
  if (!envelope.ok) return envelope.result;
  const record = envelope.envelope.value;
  if (!isCompletionContextSnapshotId(record['contextSnapshotId'])) {
    return { state: 'malformed', error: 'contextSnapshotId must be a completion-context identity' };
  }
  if (!isGoalId(record['goalId']) || !isIntendedChangeId(record['changeId'])) {
    return { state: 'malformed', error: 'completion context must name a valid goal and intended change' };
  }
  if (typeof record['goalRecordDigest'] !== 'string' || !SHA256_PATTERN.test(record['goalRecordDigest'])) {
    return { state: 'malformed', error: 'goalRecordDigest must be a lowercase SHA-256 digest' };
  }
  const policy = decodePolicy(record['policy']);
  if (!policy.ok) return { state: 'malformed', error: policy.error };
  const evaluator = decodeEvaluator(record['evaluator']);
  if (!evaluator.ok) return { state: 'malformed', error: evaluator.error };
  const commandRegistry = decodeCommandRegistry(record['commandRegistry']);
  if (!commandRegistry.ok) return { state: 'malformed', error: commandRegistry.error };
  const protectedArtifacts = decodeProtectedArtifacts(record['protectedArtifacts']);
  if (!protectedArtifacts.ok) return { state: 'malformed', error: protectedArtifacts.error };
  const target = decodeObservationReceipt(record['targetObservation']);
  if (target.kind !== 'supported') {
    return {
      state: 'malformed',
      error: `targetObservation is not a current observation receipt: ${
        target.kind === 'malformed' ? target.reason : target.kind
      }`,
    };
  }
  if (!isValidRecordTimestamp(record['capturedAt'])) {
    return { state: 'malformed', error: 'capturedAt must be a canonical UTC timestamp' };
  }
  if (record['capturedAt'] !== envelope.envelope.createdAt) {
    return { state: 'malformed', error: 'capturedAt and createdAt must identify the same context capture' };
  }
  const decoded: CompletionContextSnapshotRecordV1 = {
    kind: COMPLETION_CONTEXT_RECORD_KIND,
    schemaVersion: COMPLETION_CONTEXT_RECORD_SCHEMA_VERSION,
    contextSnapshotId: record['contextSnapshotId'],
    collaborationDomainId: envelope.envelope.collaborationDomainId,
    changeId: record['changeId'],
    goalId: record['goalId'],
    goalRecordDigest: record['goalRecordDigest'],
    policy: policy.value,
    evaluator: evaluator.value,
    commandRegistry: commandRegistry.value,
    protectedArtifacts: protectedArtifacts.value,
    targetObservation: target.receipt,
    capturedAt: record['capturedAt'],
    createdAt: envelope.envelope.createdAt,
    writer: envelope.envelope.writer,
  };
  if (contextSnapshotId(completionRecordMeaning(decoded)) !== decoded.contextSnapshotId) {
    return { state: 'malformed', error: 'contextSnapshotId does not match completion-context meaning' };
  }
  return { state: 'current', record: decoded };
}

export function isCompletionContextSnapshotId(value: unknown): value is string {
  return typeof value === 'string' && COMPLETION_CONTEXT_SNAPSHOT_ID_PATTERN.test(value);
}

export function completionContextRequestMatchesRecord(
  collaborationDomainId: string,
  request: CompletionContextSnapshotRequest,
  record: CompletionContextSnapshotRecordV1,
): boolean {
  try {
    assertCompletionContextRequest(collaborationDomainId, request);
  } catch {
    return false;
  }
  return (
    record.collaborationDomainId === collaborationDomainId &&
    stableJson(completionContextMeaning(collaborationDomainId, request)) === stableJson(completionRecordMeaning(record))
  );
}

export function completionCommandRegistry(entries: readonly string[]): CompletionCommandRegistrySnapshot {
  const normalized = normalizedUniqueLines(entries, MAX_REGISTRY_ENTRIES, MAX_REGISTRY_ENTRY_CHARACTERS, 'registry');
  return {
    registryIdentity: hashIdentity(
      stableJson({
        kind: 'scip-query-completion-command-registry',
        version: 1,
        entries: normalized,
      }),
    ),
    entries: normalized,
  };
}

export function completionProtectedArtifactSet(rules: readonly ProtectedArtifactRule[]): ProtectedArtifactSetSnapshot {
  const decoded = decodeProtectedRules(rules);
  if (!decoded.ok) throw new Error(decoded.error);
  return {
    setIdentity: hashIdentity(
      stableJson({
        kind: 'scip-query-protected-artifact-set',
        version: 1,
        rules: decoded.value,
      }),
    ),
    rules: decoded.value,
  };
}

function assertCompletionContextRequest(
  collaborationDomainId: string,
  request: CompletionContextSnapshotRequest,
): void {
  if (request.goal.collaborationDomainId !== collaborationDomainId) {
    throw new Error(`goal ${request.goal.goalId} belongs to another collaboration domain`);
  }
  if (request.change.collaborationDomainId !== collaborationDomainId) {
    throw new Error(`intended change ${request.change.changeId} belongs to another collaboration domain`);
  }
  if (request.change.goalId !== request.goal.goalId) {
    throw new Error(`intended change ${request.change.changeId} is not governed by goal ${request.goal.goalId}`);
  }
  const policy = decodePolicy(request.policy);
  if (!policy.ok) throw new Error(policy.error);
  const evaluator = decodeEvaluator(request.evaluator);
  if (!evaluator.ok) throw new Error(evaluator.error);
  const registry = decodeCommandRegistry(request.commandRegistry);
  if (!registry.ok) throw new Error(registry.error);
  const protectedArtifacts = decodeProtectedArtifacts(request.protectedArtifacts);
  if (!protectedArtifacts.ok) throw new Error(protectedArtifacts.error);
  const target = decodeObservationReceipt(request.targetObservation);
  if (target.kind !== 'supported') {
    throw new Error(`target observation is not current: ${target.kind === 'malformed' ? target.reason : target.kind}`);
  }
}

function completionContextMeaning(
  collaborationDomainId: string,
  request: CompletionContextSnapshotRequest,
): Record<string, unknown> {
  return {
    canonicalizationVersion: COMPLETION_CONTEXT_CANONICALIZATION_VERSION,
    collaborationDomainId,
    changeId: request.change.changeId,
    goalId: request.goal.goalId,
    goalRecordDigest: hashIdentity(stableJson(request.goal)),
    policy: request.policy,
    evaluator: request.evaluator,
    commandRegistry: request.commandRegistry,
    protectedArtifacts: request.protectedArtifacts,
    targetObservation: targetObservationMeaning(request.targetObservation),
  };
}

function completionRecordMeaning(record: CompletionContextSnapshotRecordV1): Record<string, unknown> {
  return {
    canonicalizationVersion: COMPLETION_CONTEXT_CANONICALIZATION_VERSION,
    collaborationDomainId: record.collaborationDomainId,
    changeId: record.changeId,
    goalId: record.goalId,
    goalRecordDigest: record.goalRecordDigest,
    policy: record.policy,
    evaluator: record.evaluator,
    commandRegistry: record.commandRegistry,
    protectedArtifacts: record.protectedArtifacts,
    targetObservation: targetObservationMeaning(record.targetObservation),
  };
}

function targetObservationMeaning(receipt: ObservationReceiptV2): Omit<ObservationReceiptV2, 'observedAt'> {
  const { observedAt: _observedAt, ...meaning } = receipt;
  return meaning;
}

function contextSnapshotId(meaning: Record<string, unknown>): string {
  return `SQCX-${hashIdentity(stableJson(meaning)).slice(0, 32).toUpperCase()}`;
}

function decodePolicy(value: unknown): { ok: true; value: CompletionPolicySnapshot } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'policy must be an object' };
  const policyId = normalizedBoundedLine(value['policyId'], MAX_POLICY_ID_CHARACTERS);
  if (!policyId) return { ok: false, error: 'policyId must be a bounded non-empty line' };
  if (!Number.isSafeInteger(value['policyVersion']) || (value['policyVersion'] as number) < 1) {
    return { ok: false, error: 'policyVersion must be a positive integer' };
  }
  if (value['stopMode'] !== 'warn' && value['stopMode'] !== 'feedback' && value['stopMode'] !== 'block') {
    return { ok: false, error: 'stopMode must be warn, feedback, or block' };
  }
  if (
    !Array.isArray(value['requiredPredicates']) ||
    value['requiredPredicates'].length !== COMPLETION_PREDICATES.length ||
    value['requiredPredicates'].some((predicate, index) => predicate !== COMPLETION_PREDICATES[index])
  ) {
    return { ok: false, error: 'requiredPredicates must contain the canonical completion predicate set' };
  }
  return {
    ok: true,
    value: {
      policyId,
      policyVersion: value['policyVersion'] as number,
      stopMode: value['stopMode'],
      requiredPredicates: COMPLETION_PREDICATES,
    },
  };
}

function decodeEvaluator(
  value: unknown,
): { ok: true; value: CompletionEvaluatorSnapshot } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'evaluator must be an object' };
  const evaluatorId = normalizedBoundedLine(value['evaluatorId'], MAX_EVALUATOR_ID_CHARACTERS);
  const evaluatorVersion = normalizedBoundedLine(value['evaluatorVersion'], MAX_VERSION_CHARACTERS);
  if (!evaluatorId || !evaluatorVersion) {
    return { ok: false, error: 'evaluator identity and version must be bounded non-empty lines' };
  }
  if (typeof value['buildIdentity'] !== 'string' || !SHA256_PATTERN.test(value['buildIdentity'])) {
    return { ok: false, error: 'evaluator buildIdentity must be a lowercase SHA-256 digest' };
  }
  return { ok: true, value: { evaluatorId, evaluatorVersion, buildIdentity: value['buildIdentity'] } };
}

function decodeCommandRegistry(
  value: unknown,
): { ok: true; value: CompletionCommandRegistrySnapshot } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'commandRegistry must be an object' };
  if (typeof value['registryIdentity'] !== 'string' || !SHA256_PATTERN.test(value['registryIdentity'])) {
    return { ok: false, error: 'command registry identity must be a lowercase SHA-256 digest' };
  }
  let entries: readonly string[];
  try {
    entries = normalizedUniqueLines(value['entries'], MAX_REGISTRY_ENTRIES, MAX_REGISTRY_ENTRY_CHARACTERS, 'registry');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const expected = completionCommandRegistry(entries);
  if (expected.registryIdentity !== value['registryIdentity']) {
    return { ok: false, error: 'command registry identity does not match its entries' };
  }
  return { ok: true, value: expected };
}

function decodeProtectedArtifacts(
  value: unknown,
): { ok: true; value: ProtectedArtifactSetSnapshot } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'protectedArtifacts must be an object' };
  if (typeof value['setIdentity'] !== 'string' || !SHA256_PATTERN.test(value['setIdentity'])) {
    return { ok: false, error: 'protected artifact set identity must be a lowercase SHA-256 digest' };
  }
  const rules = decodeProtectedRules(value['rules']);
  if (!rules.ok) return rules;
  const expected = completionProtectedArtifactSet(rules.value);
  if (expected.setIdentity !== value['setIdentity']) {
    return { ok: false, error: 'protected artifact set identity does not match its rules' };
  }
  return { ok: true, value: expected };
}

function decodeProtectedRules(
  value: unknown,
): { ok: true; value: readonly ProtectedArtifactRule[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROTECTED_CLASSES) {
    return { ok: false, error: 'protected artifact rules must be a non-empty bounded array' };
  }
  const classes = new Set<string>();
  const rules: ProtectedArtifactRule[] = [];
  for (const candidate of value) {
    if (
      !isRecordObject(candidate) ||
      !PROTECTED_ARTIFACT_CLASSES.includes(candidate['class'] as ProtectedArtifactClass) ||
      (candidate['authority'] !== 'bootstrap-trust-root' && candidate['authority'] !== 'fixed-predecessor')
    ) {
      return { ok: false, error: 'protected artifact rule has an invalid class or authority' };
    }
    const artifactClass = candidate['class'] as ProtectedArtifactClass;
    if (classes.has(artifactClass))
      return { ok: false, error: `protected artifact class ${artifactClass} is duplicated` };
    classes.add(artifactClass);
    let selectors: readonly string[];
    try {
      selectors = normalizedUniqueLines(
        candidate['selectors'],
        MAX_SELECTORS_PER_CLASS,
        MAX_SELECTOR_CHARACTERS,
        `${artifactClass} selector`,
      );
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    rules.push({ class: artifactClass, selectors, authority: candidate['authority'] });
  }
  if (
    rules.length !== PROTECTED_ARTIFACT_CLASSES.length ||
    PROTECTED_ARTIFACT_CLASSES.some((artifactClass) => !classes.has(artifactClass))
  ) {
    return { ok: false, error: 'protected artifact rules must cover every canonical class exactly once' };
  }
  return {
    ok: true,
    value: [...rules].sort(
      (left, right) => PROTECTED_ARTIFACT_CLASSES.indexOf(left.class) - PROTECTED_ARTIFACT_CLASSES.indexOf(right.class),
    ),
  };
}

function normalizedUniqueLines(
  value: unknown,
  maximumItems: number,
  maximumCharacters: number,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    throw new Error(`${label} entries must be a non-empty bounded array`);
  }
  const normalized = value.map((entry) => normalizedBoundedLine(entry, maximumCharacters));
  if (normalized.some((entry) => entry === undefined)) {
    throw new Error(`${label} entries must be bounded non-empty lines`);
  }
  const entries = normalized as string[];
  if (new Set(entries).size !== entries.length) throw new Error(`${label} entries must be unique`);
  return [...entries].sort();
}
