import {
  CLAIM_ACTION_PERMISSIONS,
  CLAIM_COVERAGE_STATES,
  CLAIM_ORIGINS,
  PRODUCER_VALIDATION_STATUSES,
  evaluateClaimQualification,
  isClaimQualificationV1,
  type ClaimQualificationRequirements,
  type ClaimQualificationV1,
} from './claim-qualification.js';
import { decodeWorkEvidenceReceipts } from './autonomous-work-ledger.js';
import {
  isObligationId,
  type ObligationAdmissionRequest,
  type ObligationCategory,
} from './autonomous-work-obligations.js';
import {
  assertWorkRecordInput,
  decodeWorkRecordEnvelope,
  hashIdentity,
  isIntendedChangeId,
  type WorkStateDecodeResult,
  type WorkStateWriter,
} from './autonomous-work-state.js';
import type { ObservationReceiptV2 } from './observation-receipt.js';
import { isRecordObject } from './record-validation.js';
import { stableJson } from './stable-json.js';

export const COMPLETENESS_ADMISSION_POLICY_VERSION = 1 as const;
export const COMPLETENESS_ADMISSION_RECORD_KIND = 'scip-query-completeness-admission' as const;
export const COMPLETENESS_ADMISSION_SCHEMA_VERSION = 1 as const;

const COMPLETENESS_ADMISSION_ID_PATTERN = /^SQCA-[A-F0-9]{32}$/u;
const MAX_POLICY_ID_CHARACTERS = 240;
const MAX_RULE_ID_CHARACTERS = 240;
const MAX_CHECK_CHARACTERS = 240;
const MAX_FINDING_ID_CHARACTERS = 1_000;
const MAX_PATH_CHARACTERS = 1_000;
const MAX_TEXT_CHARACTERS = 4_000;
const MAX_OBLIGATION_CONDITION_CHARACTERS = 1_000;

export type CompletenessAdmissionDisposition = 'admit' | 'advisory' | 'insufficient-evidence' | 'out-of-scope';

export type CompletenessFindingEvidence = 'graph-fact' | 'semantic' | 'heuristic' | 'change-graph' | 'baseline';
export type CompletenessFindingActionTier = 'direct' | 'signal' | 'support';

export interface CompletenessFindingCandidate {
  findingId: string;
  check: string;
  evidence: CompletenessFindingEvidence;
  actionTier: CompletenessFindingActionTier;
  confidence: number;
  advisory: boolean;
  file?: string;
  relatedFiles: readonly string[];
  message: string;
  remediation: string;
}

export interface CompletenessFindingRelevance {
  state: 'in-scope' | 'out-of-scope' | 'unknown';
  basis: 'candidate-diff' | 'affected-surface' | 'unrelated' | 'not-established';
  paths: readonly string[];
  reasons: readonly string[];
}

export interface CompletenessObligationRule {
  ruleId: string;
  checks: readonly string[];
  category: ObligationCategory;
  admissibleActionTiers: readonly CompletenessFindingActionTier[];
  minimumConfidence: number;
  allowProducerAdvisory: boolean;
  qualification: ClaimQualificationRequirements;
}

export interface CompletenessObligationPolicy {
  policyId: string;
  policyVersion: typeof COMPLETENESS_ADMISSION_POLICY_VERSION;
  rules: readonly CompletenessObligationRule[];
}

export interface CompletenessAdmissionObservation {
  changeId: string;
  policy: CompletenessObligationPolicy;
  candidate: CompletenessFindingCandidate;
  relevance: CompletenessFindingRelevance;
  qualification: ClaimQualificationV1;
  evidenceReceipts: readonly [ObservationReceiptV2];
}

export type CompletenessAdmissionDecision =
  | {
      disposition: 'admit';
      reasons: readonly string[];
      rule: CompletenessObligationRule;
      observation: CompletenessAdmissionObservation;
      obligationRequest: ObligationAdmissionRequest;
    }
  | {
      disposition: Exclude<CompletenessAdmissionDisposition, 'admit'>;
      reasons: readonly string[];
      observation: CompletenessAdmissionObservation;
    };

export interface CompletenessAdmissionRecordV1 {
  kind: typeof COMPLETENESS_ADMISSION_RECORD_KIND;
  schemaVersion: typeof COMPLETENESS_ADMISSION_SCHEMA_VERSION;
  admissionRecordId: string;
  collaborationDomainId: string;
  changeId: string;
  policy: CompletenessObligationPolicy;
  candidate: CompletenessFindingCandidate;
  relevance: CompletenessFindingRelevance;
  qualification: ClaimQualificationV1;
  evidenceReceipts: readonly [ObservationReceiptV2];
  disposition: CompletenessAdmissionDisposition;
  reasons: readonly string[];
  obligationId?: string;
  createdAt: string;
  writer: WorkStateWriter;
}

export interface CreateCompletenessAdmissionRecordInput {
  collaborationDomainId: string;
  decision: CompletenessAdmissionDecision;
  obligationId?: string;
  createdAt: string;
  toolVersion: string;
}

/**
 * Admission separates a finding's factual payload from the repository policy
 * that can turn it into required work. A positive detector result is admitted
 * only when it is change-relevant, selected by one rule, and independently
 * qualified for completion authority and blocking action.
 */
export function evaluateCompletenessAdmission(
  observationInput: CompletenessAdmissionObservation,
): CompletenessAdmissionDecision {
  const observation = canonicalObservation(observationInput);
  const policyIssue = completenessObligationPolicyIssue(observation.policy);
  if (policyIssue) return nonAdmission('insufficient-evidence', observation, [policyIssue]);
  if (!isClaimQualificationV1(observation.qualification)) {
    return nonAdmission('insufficient-evidence', observation, ['The finding claim qualification is malformed.']);
  }
  if (observation.relevance.state === 'out-of-scope') {
    return nonAdmission('out-of-scope', observation, observation.relevance.reasons);
  }
  if (observation.relevance.state !== 'in-scope') {
    return nonAdmission('insufficient-evidence', observation, [
      'The finding has not been tied to this intended change.',
      ...observation.relevance.reasons,
    ]);
  }

  const rules = observation.policy.rules.filter((rule) => rule.checks.includes(observation.candidate.check));
  if (rules.length === 0) {
    return nonAdmission('advisory', observation, [
      `Policy ${observation.policy.policyId} has no obligation rule for ${observation.candidate.check}.`,
    ]);
  }
  if (rules.length > 1) {
    return nonAdmission('insufficient-evidence', observation, [
      `Policy ${observation.policy.policyId} has conflicting rules for ${observation.candidate.check}: ${rules
        .map((rule) => rule.ruleId)
        .join(', ')}.`,
    ]);
  }
  const rule = rules[0]!;
  if (observation.candidate.advisory && !rule.allowProducerAdvisory) {
    return nonAdmission('advisory', observation, [
      `Rule ${rule.ruleId} does not promote findings the producer classifies as advisory.`,
    ]);
  }
  if (!rule.admissibleActionTiers.includes(observation.candidate.actionTier)) {
    return nonAdmission('advisory', observation, [
      `Rule ${rule.ruleId} does not admit ${observation.candidate.actionTier} action-tier findings.`,
    ]);
  }
  if (observation.candidate.confidence < rule.minimumConfidence) {
    return nonAdmission('insufficient-evidence', observation, [
      `Finding confidence ${observation.candidate.confidence} is below rule ${rule.ruleId}'s ${rule.minimumConfidence} threshold.`,
    ]);
  }
  if (observation.qualification.repositoryPolicy.policyId !== observation.policy.policyId) {
    return nonAdmission('insufficient-evidence', observation, [
      'The finding qualification names a different repository policy.',
    ]);
  }
  const qualification = evaluateClaimQualification(observation.qualification, {
    ...rule.qualification,
    stateAuthority: ['completion'],
    actionPermission: ['block'],
  });
  if (!qualification.satisfied) {
    return nonAdmission(
      'insufficient-evidence',
      observation,
      qualification.predicates
        .filter((predicate) => !predicate.satisfied)
        .map(
          (predicate) => `${predicate.predicate} is ${predicate.actual}; required ${predicate.required.join(' or ')}.`,
        ),
    );
  }
  if (observation.candidate.remediation.length > MAX_OBLIGATION_CONDITION_CHARACTERS) {
    return nonAdmission('insufficient-evidence', observation, [
      'The detector remediation is too large to become one actionable obligation.',
    ]);
  }
  const reasons = [
    `Rule ${rule.ruleId} admits this change-relevant ${observation.candidate.check} finding.`,
    ...observation.relevance.reasons,
  ];
  return {
    disposition: 'admit',
    reasons,
    rule,
    observation,
    obligationRequest: {
      changeId: observation.changeId,
      idempotencyKey: admissionIdempotencyKey(observation, rule),
      category: rule.category,
      title: obligationTitle(rule.category, observation.candidate),
      requiredCondition: observation.candidate.remediation,
      source: {
        kind: 'detector-finding',
        check: observation.candidate.check,
        findingId: observation.candidate.findingId,
      },
      basisAttemptIds: [],
      evidenceReceipts: observation.evidenceReceipts,
    },
  };
}

export function createCompletenessAdmissionRecord(
  input: CreateCompletenessAdmissionRecordInput,
): CompletenessAdmissionRecordV1 {
  assertWorkRecordInput(input.collaborationDomainId, input.createdAt, input.toolVersion);
  const observation = canonicalObservation(input.decision.observation);
  if (input.decision.disposition === 'admit' && !isObligationId(input.obligationId)) {
    throw new Error('an admitted completeness observation must name its obligation');
  }
  if (input.decision.disposition !== 'admit' && input.obligationId !== undefined) {
    throw new Error('a non-admitted completeness observation cannot name an obligation');
  }
  const meaning = completenessAdmissionMeaning(
    input.collaborationDomainId,
    observation,
    input.decision.disposition,
    input.decision.reasons,
    input.obligationId,
  );
  return {
    kind: COMPLETENESS_ADMISSION_RECORD_KIND,
    schemaVersion: COMPLETENESS_ADMISSION_SCHEMA_VERSION,
    admissionRecordId: completenessAdmissionId(meaning),
    ...meaning,
    createdAt: input.createdAt,
    writer: { tool: 'scip-query', version: input.toolVersion },
  };
}

export function decodeCompletenessAdmissionRecord(
  value: unknown,
): WorkStateDecodeResult<CompletenessAdmissionRecordV1> {
  const envelope = decodeWorkRecordEnvelope(value, {
    recordKind: COMPLETENESS_ADMISSION_RECORD_KIND,
    schemaVersion: COMPLETENESS_ADMISSION_SCHEMA_VERSION,
    label: 'completeness admission',
  });
  if (!envelope.ok) return envelope.result;
  const fields = envelope.envelope.value;
  const observation = decodeCompletenessAdmissionObservation(fields);
  if (!observation.ok) return { state: 'malformed', error: observation.error };
  if (!isCompletenessAdmissionDisposition(fields['disposition'])) {
    return { state: 'malformed', error: 'completeness admission disposition is invalid' };
  }
  const reasons = canonicalTextArray(fields['reasons'], MAX_TEXT_CHARACTERS);
  if (!reasons.ok) return { state: 'malformed', error: reasons.error };
  const obligationId = fields['obligationId'];
  if (
    (fields['disposition'] === 'admit' && !isObligationId(obligationId)) ||
    (fields['disposition'] !== 'admit' && obligationId !== undefined)
  ) {
    return { state: 'malformed', error: 'completeness admission obligation link is invalid' };
  }
  const meaning = completenessAdmissionMeaning(
    envelope.envelope.collaborationDomainId,
    observation.observation,
    fields['disposition'],
    reasons.values,
    typeof obligationId === 'string' ? obligationId : undefined,
  );
  const expected: CompletenessAdmissionRecordV1 = {
    kind: COMPLETENESS_ADMISSION_RECORD_KIND,
    schemaVersion: COMPLETENESS_ADMISSION_SCHEMA_VERSION,
    admissionRecordId: completenessAdmissionId(meaning),
    ...meaning,
    createdAt: envelope.envelope.createdAt,
    writer: envelope.envelope.writer,
  };
  if (!isCompletenessAdmissionId(fields['admissionRecordId'])) {
    return { state: 'malformed', error: 'admissionRecordId must be a completeness-admission identity' };
  }
  if (stableJson(value) !== stableJson(expected)) {
    return { state: 'malformed', error: 'completeness admission fields or identity are not canonical' };
  }
  return { state: 'current', record: expected };
}

export function isCompletenessAdmissionId(value: unknown): value is string {
  return typeof value === 'string' && COMPLETENESS_ADMISSION_ID_PATTERN.test(value);
}

export function completenessObligationPolicyIssue(policy: CompletenessObligationPolicy): string | undefined {
  if (
    boundedLine(policy.policyId, MAX_POLICY_ID_CHARACTERS) === undefined ||
    policy.policyVersion !== COMPLETENESS_ADMISSION_POLICY_VERSION ||
    !Array.isArray(policy.rules)
  ) {
    return 'Completeness obligation policy identity or version is invalid.';
  }
  const ruleIds = new Set<string>();
  const checks = new Set<string>();
  for (const rule of policy.rules) {
    if (
      boundedLine(rule.ruleId, MAX_RULE_ID_CHARACTERS) === undefined ||
      ruleIds.has(rule.ruleId) ||
      !isObligationCategory(rule.category) ||
      !Number.isFinite(rule.minimumConfidence) ||
      rule.minimumConfidence < 0 ||
      rule.minimumConfidence > 1 ||
      typeof rule.allowProducerAdvisory !== 'boolean' ||
      !canonicalEnumArray(rule.admissibleActionTiers, FINDING_ACTION_TIERS).ok ||
      !decodeQualificationRequirements(rule.qualification).ok
    ) {
      return `Completeness obligation rule ${String(rule.ruleId)} is invalid.`;
    }
    ruleIds.add(rule.ruleId);
    const canonicalChecks = canonicalTextArray(rule.checks, MAX_CHECK_CHARACTERS);
    if (!canonicalChecks.ok || canonicalChecks.values.length === 0) {
      return `Completeness obligation rule ${rule.ruleId} has invalid checks.`;
    }
    for (const check of canonicalChecks.values) {
      if (checks.has(check)) return `Completeness obligation check ${check} is governed by more than one rule.`;
      checks.add(check);
    }
  }
  return undefined;
}

function decodeCompletenessAdmissionObservation(
  value: Record<string, unknown>,
): { ok: true; observation: CompletenessAdmissionObservation } | { ok: false; error: string } {
  if (!isIntendedChangeId(value['changeId'])) {
    return { ok: false, error: 'completeness admission changeId is invalid' };
  }
  const policy = decodePolicy(value['policy']);
  if (!policy.ok) return policy;
  const candidate = decodeCandidate(value['candidate']);
  if (!candidate.ok) return candidate;
  const relevance = decodeRelevance(value['relevance']);
  if (!relevance.ok) return relevance;
  if (!isClaimQualificationV1(value['qualification'])) {
    return { ok: false, error: 'completeness admission qualification is malformed' };
  }
  const evidenceReceipts = decodeWorkEvidenceReceipts(value['evidenceReceipts']);
  if (!evidenceReceipts.ok || evidenceReceipts.receipts.length !== 1) {
    return { ok: false, error: 'completeness admission requires exactly one evidence receipt' };
  }
  return {
    ok: true,
    observation: canonicalObservation({
      changeId: value['changeId'],
      policy: policy.policy,
      candidate: candidate.candidate,
      relevance: relevance.relevance,
      qualification: value['qualification'],
      evidenceReceipts: [evidenceReceipts.receipts[0]!],
    }),
  };
}

function decodePolicy(
  value: unknown,
): { ok: true; policy: CompletenessObligationPolicy } | { ok: false; error: string } {
  const policyId = isRecordObject(value) ? boundedLine(value['policyId'], MAX_POLICY_ID_CHARACTERS) : undefined;
  if (
    !isRecordObject(value) ||
    policyId === undefined ||
    value['policyVersion'] !== COMPLETENESS_ADMISSION_POLICY_VERSION ||
    !Array.isArray(value['rules'])
  ) {
    return { ok: false, error: 'completeness obligation policy is malformed' };
  }
  const rules: CompletenessObligationRule[] = [];
  for (const candidate of value['rules']) {
    if (!isRecordObject(candidate)) return { ok: false, error: 'completeness obligation rule is malformed' };
    const ruleId = boundedLine(candidate['ruleId'], MAX_RULE_ID_CHARACTERS);
    const checks = canonicalTextArray(candidate['checks'], MAX_CHECK_CHARACTERS);
    const tiers = canonicalEnumArray(candidate['admissibleActionTiers'], FINDING_ACTION_TIERS);
    const qualification = decodeQualificationRequirements(candidate['qualification']);
    if (
      ruleId === undefined ||
      !checks.ok ||
      checks.values.length === 0 ||
      !isObligationCategory(candidate['category']) ||
      !tiers.ok ||
      typeof candidate['minimumConfidence'] !== 'number' ||
      !Number.isFinite(candidate['minimumConfidence']) ||
      typeof candidate['allowProducerAdvisory'] !== 'boolean' ||
      !qualification.ok
    ) {
      return { ok: false, error: 'completeness obligation rule is malformed' };
    }
    rules.push({
      ruleId,
      checks: checks.values,
      category: candidate['category'],
      admissibleActionTiers: tiers.values,
      minimumConfidence: candidate['minimumConfidence'],
      allowProducerAdvisory: candidate['allowProducerAdvisory'],
      qualification: qualification.requirements,
    });
  }
  const policy = canonicalPolicy({
    policyId,
    policyVersion: COMPLETENESS_ADMISSION_POLICY_VERSION,
    rules,
  });
  const issue = completenessObligationPolicyIssue(policy);
  return issue ? { ok: false, error: issue } : { ok: true, policy };
}

function decodeCandidate(
  value: unknown,
): { ok: true; candidate: CompletenessFindingCandidate } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: 'completeness finding candidate is malformed' };
  const findingId = boundedLine(value['findingId'], MAX_FINDING_ID_CHARACTERS);
  const check = boundedLine(value['check'], MAX_CHECK_CHARACTERS);
  const relatedFiles = canonicalTextArray(value['relatedFiles'], MAX_PATH_CHARACTERS);
  const message = boundedText(value['message'], MAX_TEXT_CHARACTERS);
  const remediation = boundedText(value['remediation'], MAX_TEXT_CHARACTERS);
  if (
    findingId === undefined ||
    check === undefined ||
    !isCompletenessFindingEvidence(value['evidence']) ||
    !isCompletenessFindingActionTier(value['actionTier']) ||
    typeof value['confidence'] !== 'number' ||
    !Number.isFinite(value['confidence']) ||
    value['confidence'] < 0 ||
    value['confidence'] > 1 ||
    typeof value['advisory'] !== 'boolean' ||
    (value['file'] !== undefined && boundedLine(value['file'], MAX_PATH_CHARACTERS) === undefined) ||
    !relatedFiles.ok ||
    message === undefined ||
    remediation === undefined
  ) {
    return { ok: false, error: 'completeness finding candidate is malformed' };
  }
  return {
    ok: true,
    candidate: {
      findingId,
      check,
      evidence: value['evidence'],
      actionTier: value['actionTier'],
      confidence: value['confidence'],
      advisory: value['advisory'],
      ...(typeof value['file'] === 'string' ? { file: value['file'] } : {}),
      relatedFiles: relatedFiles.values,
      message,
      remediation,
    },
  };
}

function decodeRelevance(
  value: unknown,
): { ok: true; relevance: CompletenessFindingRelevance } | { ok: false; error: string } {
  if (
    !isRecordObject(value) ||
    !RELEVANCE_STATES.includes(value['state'] as never) ||
    !RELEVANCE_BASES.includes(value['basis'] as never)
  ) {
    return { ok: false, error: 'completeness finding relevance is malformed' };
  }
  const paths = canonicalTextArray(value['paths'], MAX_PATH_CHARACTERS);
  const reasons = canonicalTextArray(value['reasons'], MAX_TEXT_CHARACTERS);
  if (!paths.ok || !reasons.ok || reasons.values.length === 0) {
    return { ok: false, error: 'completeness finding relevance paths or reasons are malformed' };
  }
  return {
    ok: true,
    relevance: {
      state: value['state'] as CompletenessFindingRelevance['state'],
      basis: value['basis'] as CompletenessFindingRelevance['basis'],
      paths: paths.values,
      reasons: reasons.values,
    },
  };
}

function canonicalObservation(observation: CompletenessAdmissionObservation): CompletenessAdmissionObservation {
  return {
    changeId: observation.changeId,
    policy: canonicalPolicy(observation.policy),
    candidate: {
      ...observation.candidate,
      relatedFiles: canonicalStrings(observation.candidate.relatedFiles),
    },
    relevance: {
      ...observation.relevance,
      paths: canonicalStrings(observation.relevance.paths),
      reasons: canonicalStrings(observation.relevance.reasons),
    },
    qualification: observation.qualification,
    evidenceReceipts: observation.evidenceReceipts,
  };
}

function canonicalPolicy(policy: CompletenessObligationPolicy): CompletenessObligationPolicy {
  return {
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    rules: [...policy.rules]
      .map((rule) => ({
        ...rule,
        checks: canonicalStrings(rule.checks),
        admissibleActionTiers: canonicalStrings(rule.admissibleActionTiers) as CompletenessFindingActionTier[],
        qualification: canonicalQualificationRequirements(rule.qualification),
      }))
      .sort((left, right) => left.ruleId.localeCompare(right.ruleId)),
  };
}

function completenessAdmissionMeaning(
  collaborationDomainId: string,
  observation: CompletenessAdmissionObservation,
  disposition: CompletenessAdmissionDisposition,
  reasonsInput: readonly string[],
  obligationId: string | undefined,
): Omit<CompletenessAdmissionRecordV1, 'kind' | 'schemaVersion' | 'admissionRecordId' | 'createdAt' | 'writer'> {
  return {
    collaborationDomainId,
    changeId: observation.changeId,
    policy: observation.policy,
    candidate: observation.candidate,
    relevance: observation.relevance,
    qualification: observation.qualification,
    evidenceReceipts: observation.evidenceReceipts,
    disposition,
    reasons: canonicalStrings(reasonsInput),
    ...(obligationId ? { obligationId } : {}),
  };
}

function completenessAdmissionId(meaning: object): string {
  return `SQCA-${hashIdentity({
    schemaVersion: COMPLETENESS_ADMISSION_SCHEMA_VERSION,
    meaning,
  })
    .slice(0, 32)
    .toUpperCase()}`;
}

function admissionIdempotencyKey(
  observation: CompletenessAdmissionObservation,
  rule: CompletenessObligationRule,
): string {
  return `completeness-${hashIdentity({
    changeId: observation.changeId,
    policyId: observation.policy.policyId,
    policyVersion: observation.policy.policyVersion,
    ruleId: rule.ruleId,
    check: observation.candidate.check,
    findingId: observation.candidate.findingId,
  }).slice(0, 48)}`;
}

function obligationTitle(category: ObligationCategory, candidate: CompletenessFindingCandidate): string {
  const referent = candidate.file ?? candidate.findingId;
  const title = `${category}: ${candidate.check} at ${referent}`;
  return title.length <= 240 ? title : `${title.slice(0, 239)}…`;
}

function nonAdmission(
  disposition: Exclude<CompletenessAdmissionDisposition, 'admit'>,
  observation: CompletenessAdmissionObservation,
  reasons: readonly string[],
): CompletenessAdmissionDecision {
  return { disposition, reasons: canonicalStrings(reasons), observation };
}

const FINDING_ACTION_TIERS = ['direct', 'signal', 'support'] as const;
const FINDING_EVIDENCE = ['graph-fact', 'semantic', 'heuristic', 'change-graph', 'baseline'] as const;
const RELEVANCE_STATES = ['in-scope', 'out-of-scope', 'unknown'] as const;
const RELEVANCE_BASES = ['candidate-diff', 'affected-surface', 'unrelated', 'not-established'] as const;
const OBSERVATION_STATE_AUTHORITIES = ['completion', 'advisory', 'none'] as const;
const QUALIFICATION_REQUIREMENT_KEYS = [
  'origins',
  'coverage',
  'producerValidation',
  'stateAuthority',
  'actionPermission',
] as const;
const OBLIGATION_CATEGORIES: readonly ObligationCategory[] = [
  'test',
  'documentation',
  'residue',
  'architecture',
  'migration',
  'verification',
  'other',
];

function isCompletenessAdmissionDisposition(value: unknown): value is CompletenessAdmissionDisposition {
  return ['admit', 'advisory', 'insufficient-evidence', 'out-of-scope'].includes(value as string);
}

function isCompletenessFindingEvidence(value: unknown): value is CompletenessFindingEvidence {
  return FINDING_EVIDENCE.includes(value as CompletenessFindingEvidence);
}

function isCompletenessFindingActionTier(value: unknown): value is CompletenessFindingActionTier {
  return FINDING_ACTION_TIERS.includes(value as CompletenessFindingActionTier);
}

function isObligationCategory(value: unknown): value is ObligationCategory {
  return OBLIGATION_CATEGORIES.includes(value as ObligationCategory);
}

function canonicalTextArray(
  value: unknown,
  maxCharacters: number,
): { ok: true; values: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'expected an array of bounded text values' };
  const values: string[] = [];
  for (const entry of value) {
    const text = boundedText(entry, maxCharacters);
    if (text === undefined) return { ok: false, error: 'expected an array of bounded text values' };
    values.push(text);
  }
  const canonical = canonicalStrings(values);
  return stableJson(values) === stableJson(canonical)
    ? { ok: true, values: canonical }
    : { ok: false, error: 'text values must be unique and sorted' };
}

function canonicalEnumArray<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): { ok: true; values: Value[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || !value.every((entry) => allowed.includes(entry as Value))) {
    return { ok: false, error: 'enum values are invalid' };
  }
  const values = value as Value[];
  const canonical = canonicalStrings(values) as Value[];
  return stableJson(values) === stableJson(canonical)
    ? { ok: true, values: canonical }
    : { ok: false, error: 'enum values must be unique and sorted' };
}

function decodeQualificationRequirements(
  value: unknown,
): { ok: true; requirements: ClaimQualificationRequirements } | { ok: false; error: string } {
  if (
    !isRecordObject(value) ||
    Object.keys(value).some(
      (key) => !QUALIFICATION_REQUIREMENT_KEYS.includes(key as (typeof QUALIFICATION_REQUIREMENT_KEYS)[number]),
    )
  ) {
    return { ok: false, error: 'claim qualification requirements are malformed' };
  }
  const origins = decodeOptionalRequirement(value['origins'], CLAIM_ORIGINS);
  const coverage = decodeOptionalRequirement(value['coverage'], CLAIM_COVERAGE_STATES);
  const producerValidation = decodeOptionalRequirement(value['producerValidation'], PRODUCER_VALIDATION_STATUSES);
  const stateAuthority = decodeOptionalRequirement(value['stateAuthority'], OBSERVATION_STATE_AUTHORITIES);
  const actionPermission = decodeOptionalRequirement(value['actionPermission'], CLAIM_ACTION_PERMISSIONS);
  if (!origins.ok || !coverage.ok || !producerValidation.ok || !stateAuthority.ok || !actionPermission.ok) {
    return { ok: false, error: 'claim qualification requirements are malformed' };
  }
  return {
    ok: true,
    requirements: {
      ...(origins.values ? { origins: origins.values } : {}),
      ...(coverage.values ? { coverage: coverage.values } : {}),
      ...(producerValidation.values ? { producerValidation: producerValidation.values } : {}),
      ...(stateAuthority.values ? { stateAuthority: stateAuthority.values } : {}),
      ...(actionPermission.values ? { actionPermission: actionPermission.values } : {}),
    },
  };
}

function decodeOptionalRequirement<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): { ok: true; values?: Value[] } | { ok: false } {
  if (value === undefined) return { ok: true };
  const decoded = canonicalEnumArray(value, allowed);
  return decoded.ok && decoded.values.length > 0 ? { ok: true, values: decoded.values } : { ok: false };
}

function canonicalQualificationRequirements(
  requirements: ClaimQualificationRequirements,
): ClaimQualificationRequirements {
  const decoded = decodeQualificationRequirements(requirements);
  return decoded.ok ? decoded.requirements : requirements;
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function boundedLine(value: unknown, maxCharacters: number): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxCharacters &&
    value.trim() === value &&
    !/[\r\n]/u.test(value)
    ? value
    : undefined;
}

function boundedText(value: unknown, maxCharacters: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxCharacters && value.trim() === value
    ? value
    : undefined;
}
