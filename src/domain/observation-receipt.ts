import { createHash } from 'node:crypto';
import { isBoundedRecordString, isPositiveInteger, isRecordObject, isSha256Hex } from './record-validation.js';

export const LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION = 1 as const;
export const OBSERVATION_RECEIPT_SCHEMA_VERSION = 2 as const;
export const OBSERVATION_IDENTITY_SCHEMA_VERSION = 1 as const;
export const OBSERVATION_IDENTITY_CANONICALIZATION_VERSION = 1 as const;
export const OBSERVATION_IDENTITY_HASH_ALGORITHM = 'sha256' as const;
export const OBSERVATION_STATE_AUTHORITY_POLICY_VERSION = 1 as const;

export type ObservationAuthorityKind = 'index-worktree' | 'index-only' | 'worktree-only' | 'process-local';

/**
 * A version-1 receipt identifies the local index/worktree evidence emitted by
 * scip-query before state identity was split into independent facts. Its
 * project and worktree values are retained as historical facts, but their
 * combined path/state meanings cannot prove v2 collaboration, workspace, or
 * content relationships.
 */
export interface ObservationReceiptV1 {
  schemaVersion: typeof LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION;
  authorityKind: ObservationAuthorityKind;
  observedAt: string;
  projectIdentity: string;
  index?: {
    generationIdentity: string;
    source: 'immutable' | 'legacy';
    alignment: 'not-certified' | 'leased';
  };
  worktree?: {
    identity: string;
    clean: boolean;
    headCommit?: string;
    treeOid?: string;
  };
}

/**
 * An observation identity is a content-derived identifier whose projection
 * says which real inputs were selected and whose digest says what values that
 * projection observed. Including every version in the hash preimage prevents
 * equal-looking digests from silently crossing incompatible identity rules.
 */
export interface ObservationIdentity {
  schemaVersion: typeof OBSERVATION_IDENTITY_SCHEMA_VERSION;
  canonicalizationVersion: typeof OBSERVATION_IDENTITY_CANONICALIZATION_VERSION;
  hashAlgorithm: typeof OBSERVATION_IDENTITY_HASH_ALGORITHM;
  projection: {
    name: string;
    version: number;
  };
  digest: string;
}

export interface RelevantInputIdentity {
  /** The result or claim family whose answer can be changed by this projection. */
  subject: string;
  identity: ObservationIdentity;
}

export type ObservationSourceKind = 'index-generation' | 'repository-snapshot' | 'live-workspace' | 'process';

/**
 * An observed source is one state-bearing input an operation actually read.
 * It names the referent only; whether that referent stayed fixed is a separate
 * stability fact.
 */
export interface ObservationSourceFact {
  kind: ObservationSourceKind;
  identity?: ObservationIdentity;
}

export type ObservationStabilityProofKind =
  | 'immutable'
  | 'fixed-snapshot'
  | 'bracketed'
  | 'not-established'
  | 'invalidated';

/**
 * A stability proof records how one observed source was prevented from
 * changing during the observation interval. Immutable and fixed-snapshot
 * proofs establish fixed input; bracketed equality is weaker because an
 * intermediate change can return to the same endpoint.
 */
export interface ObservationStabilityProof {
  source: ObservationSourceKind;
  kind: ObservationStabilityProofKind;
}

export interface ObservationReceiptV2 {
  schemaVersion: typeof OBSERVATION_RECEIPT_SCHEMA_VERSION;
  observedAt: string;
  facts: {
    collaborationDomain?: ObservationIdentity;
    repositoryLineage?: ObservationIdentity;
    workspaceInstance?: ObservationIdentity;
    wholeContent?: ObservationIdentity;
    relevantInputs?: readonly RelevantInputIdentity[];
    index?: {
      generation: ObservationIdentity;
      /** Inputs persisted with the immutable generation when known. */
      inputs?: ObservationIdentity;
      source: 'immutable' | 'legacy';
    };
  };
  observedSources: readonly ObservationSourceFact[];
  stabilityProofs: readonly ObservationStabilityProof[];
  /** Human-useful state facts that are not compatibility identities. */
  diagnostics?: {
    clean?: boolean;
    headCommit?: string;
    treeOid?: string;
  };
}

export type ObservationReceipt = ObservationReceiptV1 | ObservationReceiptV2;

export type DecodedObservationReceipt =
  | { kind: 'legacy'; schemaVersion: 1; receipt: ObservationReceiptV1 }
  | { kind: 'supported'; schemaVersion: 2; receipt: ObservationReceiptV2 }
  | { kind: 'unsupported'; schemaVersion: number; direction: 'older' | 'future' }
  | { kind: 'malformed'; reason: string };

export type ObservationRelationshipState = 'established' | 'disproven' | 'unknown';

export type ObservationComparisonReason =
  | 'identities-equal'
  | 'identities-different'
  | 'left-fact-missing'
  | 'right-fact-missing'
  | 'both-facts-missing'
  | 'identity-projections-not-comparable'
  | 'legacy-fact-not-comparable'
  | 'all-observed-sources-fixed'
  | 'left-observation-has-no-repository-source'
  | 'right-observation-has-no-repository-source'
  | 'left-observation-not-fixed'
  | 'right-observation-not-fixed'
  | 'left-observation-invalidated'
  | 'right-observation-invalidated';

export type ObservationComparedFact =
  | { kind: 'identity'; identity: ObservationIdentity }
  | { kind: 'legacy-index-generation'; value: string }
  | { kind: 'stability'; proof: ObservationStabilityProof };

export interface ObservationRelationshipJudgment {
  state: ObservationRelationshipState;
  reasons: readonly ObservationComparisonReason[];
  facts: {
    left: readonly ObservationComparedFact[];
    right: readonly ObservationComparedFact[];
  };
}

export interface RelevantInputRelationshipJudgment {
  subject: string;
  projection: string;
  judgment: ObservationRelationshipJudgment;
}

/**
 * A receipt comparison is a set of independent relationship judgments. Each
 * field answers one real question; no field is a total "strength" score and
 * no established relationship silently upgrades another.
 */
export interface ObservationReceiptComparison {
  collaborationDomain: ObservationRelationshipJudgment;
  repositoryLineage: ObservationRelationshipJudgment;
  workspaceInstance: ObservationRelationshipJudgment;
  wholeContent: ObservationRelationshipJudgment;
  relevantInputs: readonly RelevantInputRelationshipJudgment[];
  indexInput: ObservationRelationshipJudgment;
  indexGeneration: ObservationRelationshipJudgment;
  observationStability: ObservationRelationshipJudgment;
}

export type ObservationStateAuthority = 'completion' | 'advisory' | 'none';

/**
 * A derived state-authority judgment is product policy applied to receipt
 * facts at use time. It is not serialized into the producer's receipt, so a
 * producer cannot grant itself completion authority by asserting a label.
 */
export interface DerivedObservationStateAuthority {
  policyVersion: typeof OBSERVATION_STATE_AUTHORITY_POLICY_VERSION;
  authority: ObservationStateAuthority;
  requiredRelationships: readonly ['collaborationDomain', 'wholeContent', 'observationStability'];
  reasons: readonly string[];
}

export function createObservationIdentity(
  projectionName: string,
  projectionVersion: number,
  canonicalValue: string,
): ObservationIdentity {
  if (!isBoundedRecordString(projectionName) || !isPositiveInteger(projectionVersion)) {
    throw new Error('Observation identity requires a bounded projection name and positive projection version.');
  }
  return {
    schemaVersion: OBSERVATION_IDENTITY_SCHEMA_VERSION,
    canonicalizationVersion: OBSERVATION_IDENTITY_CANONICALIZATION_VERSION,
    hashAlgorithm: OBSERVATION_IDENTITY_HASH_ALGORITHM,
    projection: {
      name: projectionName,
      version: projectionVersion,
    },
    digest: createHash(OBSERVATION_IDENTITY_HASH_ALGORITHM)
      .update(canonicalObservationIdentityPreimage(projectionName, projectionVersion, canonicalValue))
      .digest('hex'),
  };
}

function canonicalObservationIdentityPreimage(
  projectionName: string,
  projectionVersion: number,
  canonicalValue: string,
): string {
  return (
    `{"canonicalizationVersion":${OBSERVATION_IDENTITY_CANONICALIZATION_VERSION},` +
    `"projection":${JSON.stringify(projectionName)},` +
    `"projectionVersion":${projectionVersion},` +
    `"value":${JSON.stringify(canonicalValue)}}`
  );
}

export function decodeObservationReceipt(value: unknown): DecodedObservationReceipt {
  if (!isRecordObject(value)) return { kind: 'malformed', reason: 'observation receipt must be an object' };
  const version = value['schemaVersion'];
  if (!Number.isInteger(version)) {
    return { kind: 'malformed', reason: 'observation receipt schemaVersion must be an integer' };
  }
  if (version === LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION) {
    return isObservationReceiptV1(value)
      ? { kind: 'legacy', schemaVersion: LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION, receipt: value }
      : { kind: 'malformed', reason: 'observation receipt v1 fields are malformed or contradictory' };
  }
  if (version === OBSERVATION_RECEIPT_SCHEMA_VERSION) {
    return isObservationReceiptV2(value)
      ? { kind: 'supported', schemaVersion: OBSERVATION_RECEIPT_SCHEMA_VERSION, receipt: value }
      : { kind: 'malformed', reason: 'observation receipt v2 facts are malformed or contradictory' };
  }
  const numericVersion = version as number;
  return {
    kind: 'unsupported',
    schemaVersion: numericVersion,
    direction: numericVersion < LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION ? 'older' : 'future',
  };
}

export function isObservationReceipt(value: unknown): value is ObservationReceipt {
  const decoded = decodeObservationReceipt(value);
  return decoded.kind === 'legacy' || decoded.kind === 'supported';
}

export function compareObservationReceipts(
  left: ObservationReceipt,
  right: ObservationReceipt,
): ObservationReceiptComparison {
  return {
    collaborationDomain: compareV2Identity(
      v2Identity(left, (receipt) => receipt.facts.collaborationDomain),
      v2Identity(right, (receipt) => receipt.facts.collaborationDomain),
    ),
    repositoryLineage: compareV2Identity(
      v2Identity(left, (receipt) => receipt.facts.repositoryLineage),
      v2Identity(right, (receipt) => receipt.facts.repositoryLineage),
    ),
    workspaceInstance: compareV2Identity(
      v2Identity(left, (receipt) => receipt.facts.workspaceInstance),
      v2Identity(right, (receipt) => receipt.facts.workspaceInstance),
    ),
    wholeContent: compareV2Identity(
      v2Identity(left, (receipt) => receipt.facts.wholeContent),
      v2Identity(right, (receipt) => receipt.facts.wholeContent),
    ),
    relevantInputs: compareRelevantInputs(left, right),
    indexInput: compareV2Identity(
      v2Identity(left, (receipt) => receipt.facts.index?.inputs),
      v2Identity(right, (receipt) => receipt.facts.index?.inputs),
    ),
    indexGeneration: compareIndexGenerations(left, right),
    observationStability: compareObservationStability(left, right),
  };
}

export function deriveObservationStateAuthority(
  left: ObservationReceipt,
  right: ObservationReceipt,
  comparison: ObservationReceiptComparison = compareObservationReceipts(left, right),
): DerivedObservationStateAuthority {
  const required = [
    ['collaborationDomain', comparison.collaborationDomain],
    ['wholeContent', comparison.wholeContent],
    ['observationStability', comparison.observationStability],
  ] as const;
  const reasons: string[] = [];
  for (const [name, judgment] of required) {
    if (judgment.state !== 'established') reasons.push(`${name}:${judgment.state}`);
  }
  for (const [side, receipt] of [
    ['left', left],
    ['right', right],
  ] as const) {
    const alignment = receiptIndexAlignment(receipt);
    if (alignment !== 'not-applicable' && alignment !== 'established') {
      reasons.push(`${side}IndexAlignment:${alignment}`);
    }
  }
  const hasDisproof =
    required.some(([, judgment]) => judgment.state === 'disproven') ||
    reasons.some((reason) => reason.endsWith(':disproven'));
  return {
    policyVersion: OBSERVATION_STATE_AUTHORITY_POLICY_VERSION,
    authority: reasons.length === 0 ? 'completion' : hasDisproof ? 'none' : 'advisory',
    requiredRelationships: ['collaborationDomain', 'wholeContent', 'observationStability'],
    reasons,
  };
}

export function observationReceiptGenerationIdentity(receipt: ObservationReceipt): string | undefined {
  return receipt.schemaVersion === LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION
    ? receipt.index?.generationIdentity
    : receipt.facts.index?.generation.digest;
}

export function observationReceiptWorkspaceIdentity(receipt: ObservationReceipt): string | undefined {
  return receipt.schemaVersion === LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION
    ? undefined
    : receipt.facts.workspaceInstance?.digest;
}

export function observationReceiptStabilityLabel(receipt: ObservationReceipt): string {
  if (receipt.schemaVersion === LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION) {
    return receipt.index?.alignment ?? 'not-established';
  }
  const repositoryProofs = receipt.stabilityProofs.filter((proof) => proof.source !== 'process');
  if (repositoryProofs.some((proof) => proof.kind === 'invalidated')) return 'invalidated';
  if (
    repositoryProofs.length > 0 &&
    repositoryProofs.every((proof) => proof.kind === 'immutable' || proof.kind === 'fixed-snapshot')
  ) {
    return 'fixed';
  }
  if (repositoryProofs.some((proof) => proof.kind === 'bracketed')) return 'bracketed';
  return 'not-established';
}

function compareRelevantInputs(
  left: ObservationReceipt,
  right: ObservationReceipt,
): RelevantInputRelationshipJudgment[] {
  const leftInputs = relevantInputMap(left);
  const rightInputs = relevantInputMap(right);
  const keys = [...new Set([...leftInputs.keys(), ...rightInputs.keys()])].sort();
  return keys.map((key) => {
    const leftFact = leftInputs.get(key);
    const rightFact = rightInputs.get(key);
    const subject = leftFact?.subject ?? rightFact?.subject ?? key;
    const projection = leftFact?.identity.projection.name ?? rightFact?.identity.projection.name ?? key;
    return {
      subject,
      projection,
      judgment: compareV2Identity(leftFact?.identity, rightFact?.identity),
    };
  });
}

function relevantInputMap(receipt: ObservationReceipt): Map<string, RelevantInputIdentity> {
  if (receipt.schemaVersion !== OBSERVATION_RECEIPT_SCHEMA_VERSION) return new Map();
  return new Map(
    (receipt.facts.relevantInputs ?? []).map((entry) => [`${entry.subject}\0${entry.identity.projection.name}`, entry]),
  );
}

function compareIndexGenerations(left: ObservationReceipt, right: ObservationReceipt): ObservationRelationshipJudgment {
  if (
    left.schemaVersion === LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION &&
    right.schemaVersion === LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION
  ) {
    return compareLegacyValues(left.index?.generationIdentity, right.index?.generationIdentity);
  }
  if (
    left.schemaVersion === LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION ||
    right.schemaVersion === LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION
  ) {
    return judgment('unknown', ['legacy-fact-not-comparable'], legacyIndexFacts(left), legacyIndexFacts(right));
  }
  return compareV2Identity(left.facts.index?.generation, right.facts.index?.generation);
}

function compareLegacyValues(left: string | undefined, right: string | undefined): ObservationRelationshipJudgment {
  const leftFacts: ObservationComparedFact[] = left ? [{ kind: 'legacy-index-generation', value: left }] : [];
  const rightFacts: ObservationComparedFact[] = right ? [{ kind: 'legacy-index-generation', value: right }] : [];
  if (left === undefined || right === undefined) {
    return missingJudgment(leftFacts, rightFacts);
  }
  return judgment(
    left === right ? 'established' : 'disproven',
    [left === right ? 'identities-equal' : 'identities-different'],
    leftFacts,
    rightFacts,
  );
}

function compareV2Identity(
  left: ObservationIdentity | undefined,
  right: ObservationIdentity | undefined,
): ObservationRelationshipJudgment {
  const leftFacts: ObservationComparedFact[] = left ? [{ kind: 'identity', identity: left }] : [];
  const rightFacts: ObservationComparedFact[] = right ? [{ kind: 'identity', identity: right }] : [];
  if (!left || !right) return missingJudgment(leftFacts, rightFacts);
  if (!sameIdentityProjection(left, right)) {
    return judgment('unknown', ['identity-projections-not-comparable'], leftFacts, rightFacts);
  }
  return judgment(
    left.digest === right.digest ? 'established' : 'disproven',
    [left.digest === right.digest ? 'identities-equal' : 'identities-different'],
    leftFacts,
    rightFacts,
  );
}

function compareObservationStability(
  left: ObservationReceipt,
  right: ObservationReceipt,
): ObservationRelationshipJudgment {
  if (
    left.schemaVersion === LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION ||
    right.schemaVersion === LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION
  ) {
    return judgment('unknown', ['legacy-fact-not-comparable'], [], []);
  }
  const leftFacts = stabilityFacts(left);
  const rightFacts = stabilityFacts(right);
  const leftState = fixedObservationState(left);
  const rightState = fixedObservationState(right);
  if (leftState === 'invalidated' || rightState === 'invalidated') {
    return judgment(
      'disproven',
      [
        ...(leftState === 'invalidated' ? (['left-observation-invalidated'] as const) : []),
        ...(rightState === 'invalidated' ? (['right-observation-invalidated'] as const) : []),
      ],
      leftFacts,
      rightFacts,
    );
  }
  if (leftState !== 'fixed' || rightState !== 'fixed') {
    return judgment(
      'unknown',
      [
        ...(leftState === 'no-repository-source'
          ? (['left-observation-has-no-repository-source'] as const)
          : leftState !== 'fixed'
            ? (['left-observation-not-fixed'] as const)
            : []),
        ...(rightState === 'no-repository-source'
          ? (['right-observation-has-no-repository-source'] as const)
          : rightState !== 'fixed'
            ? (['right-observation-not-fixed'] as const)
            : []),
      ],
      leftFacts,
      rightFacts,
    );
  }
  return judgment('established', ['all-observed-sources-fixed'], leftFacts, rightFacts);
}

function fixedObservationState(
  receipt: ObservationReceiptV2,
): 'fixed' | 'unknown' | 'invalidated' | 'no-repository-source' {
  const sources = receipt.observedSources.filter((source) => source.kind !== 'process');
  if (sources.length === 0) return 'no-repository-source';
  const proofs = new Map(receipt.stabilityProofs.map((proof) => [proof.source, proof.kind]));
  if (sources.some((source) => proofs.get(source.kind) === 'invalidated')) return 'invalidated';
  return sources.every((source) => {
    const proof = proofs.get(source.kind);
    return proof === 'immutable' || proof === 'fixed-snapshot';
  })
    ? 'fixed'
    : 'unknown';
}

function receiptIndexAlignment(
  receipt: ObservationReceipt,
): 'established' | 'disproven' | 'unknown' | 'not-applicable' {
  if (receipt.schemaVersion !== OBSERVATION_RECEIPT_SCHEMA_VERSION) {
    return receipt.index ? 'unknown' : 'not-applicable';
  }
  if (!receipt.observedSources.some((source) => source.kind === 'index-generation')) return 'not-applicable';
  const generationInput = receipt.facts.index?.inputs;
  if (!generationInput) return 'unknown';
  const repositoryInput = (receipt.facts.relevantInputs ?? []).find((entry) =>
    sameIdentityProjection(entry.identity, generationInput),
  )?.identity;
  if (!repositoryInput) return 'unknown';
  return repositoryInput.digest === generationInput.digest ? 'established' : 'disproven';
}

function v2Identity(
  receipt: ObservationReceipt,
  select: (receipt: ObservationReceiptV2) => ObservationIdentity | undefined,
): ObservationIdentity | undefined {
  return receipt.schemaVersion === OBSERVATION_RECEIPT_SCHEMA_VERSION ? select(receipt) : undefined;
}

function legacyIndexFacts(receipt: ObservationReceipt): ObservationComparedFact[] {
  return receipt.schemaVersion === LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION && receipt.index
    ? [{ kind: 'legacy-index-generation', value: receipt.index.generationIdentity }]
    : receipt.schemaVersion === OBSERVATION_RECEIPT_SCHEMA_VERSION && receipt.facts.index
      ? [{ kind: 'identity', identity: receipt.facts.index.generation }]
      : [];
}

function stabilityFacts(receipt: ObservationReceiptV2): ObservationComparedFact[] {
  return receipt.stabilityProofs.map((proof) => ({ kind: 'stability', proof }));
}

function missingJudgment(
  leftFacts: readonly ObservationComparedFact[],
  rightFacts: readonly ObservationComparedFact[],
): ObservationRelationshipJudgment {
  const reason =
    leftFacts.length === 0 && rightFacts.length === 0
      ? 'both-facts-missing'
      : leftFacts.length === 0
        ? 'left-fact-missing'
        : 'right-fact-missing';
  return judgment('unknown', [reason], leftFacts, rightFacts);
}

function judgment(
  state: ObservationRelationshipState,
  reasons: readonly ObservationComparisonReason[],
  left: readonly ObservationComparedFact[],
  right: readonly ObservationComparedFact[],
): ObservationRelationshipJudgment {
  return { state, reasons, facts: { left, right } };
}

function sameIdentityProjection(left: ObservationIdentity, right: ObservationIdentity): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.canonicalizationVersion === right.canonicalizationVersion &&
    left.hashAlgorithm === right.hashAlgorithm &&
    left.projection.name === right.projection.name &&
    left.projection.version === right.projection.version
  );
}

function isObservationReceiptV1(value: unknown): value is ObservationReceiptV1 {
  if (!isRecordObject(value)) return false;
  const index = value['index'];
  const worktree = value['worktree'];
  return (
    isTimestamp(value['observedAt']) &&
    isBoundedRecordString(value['projectIdentity']) &&
    isLegacyAuthorityKind(value['authorityKind']) &&
    (index === undefined ||
      (isRecordObject(index) &&
        isBoundedRecordString(index['generationIdentity']) &&
        (index['source'] === 'immutable' || index['source'] === 'legacy') &&
        (index['alignment'] === 'not-certified' || index['alignment'] === 'leased'))) &&
    (worktree === undefined ||
      (isRecordObject(worktree) &&
        isBoundedRecordString(worktree['identity']) &&
        typeof worktree['clean'] === 'boolean' &&
        (worktree['headCommit'] === undefined || isBoundedRecordString(worktree['headCommit'])) &&
        (worktree['treeOid'] === undefined || isBoundedRecordString(worktree['treeOid'])))) &&
    legacyAuthorityFieldsAgree(value['authorityKind'], index, worktree)
  );
}

function isObservationReceiptV2(value: unknown): value is ObservationReceiptV2 {
  if (!isRecordObject(value)) return false;
  const facts = value['facts'];
  const sources = value['observedSources'];
  const proofs = value['stabilityProofs'];
  if (
    !isTimestamp(value['observedAt']) ||
    !isRecordObject(facts) ||
    !Array.isArray(sources) ||
    sources.length === 0 ||
    !sources.every(isObservationSourceFact) ||
    !uniqueBy(sources, (source) => source.kind) ||
    !Array.isArray(proofs) ||
    !proofs.every(isObservationStabilityProof) ||
    !uniqueBy(proofs, (proof) => proof.source) ||
    proofs.some((proof) => !sources.some((source) => source.kind === proof.source)) ||
    !proofs.every((proof) => stabilityProofCanDescribeSource(proof, facts))
  ) {
    return false;
  }
  const identityFields = ['collaborationDomain', 'repositoryLineage', 'workspaceInstance', 'wholeContent'] as const;
  if (identityFields.some((field) => facts[field] !== undefined && !isObservationIdentity(facts[field]))) return false;
  const relevantInputs = facts['relevantInputs'];
  if (
    relevantInputs !== undefined &&
    (!Array.isArray(relevantInputs) ||
      !relevantInputs.every(isRelevantInputIdentity) ||
      !uniqueBy(relevantInputs, (entry) => `${entry.subject}\0${entry.identity.projection.name}`))
  ) {
    return false;
  }
  const index = facts['index'];
  if (
    index !== undefined &&
    (!isRecordObject(index) ||
      !isObservationIdentity(index['generation']) ||
      (index['inputs'] !== undefined && !isObservationIdentity(index['inputs'])) ||
      (index['source'] !== 'immutable' && index['source'] !== 'legacy'))
  ) {
    return false;
  }
  const diagnostics = value['diagnostics'];
  return (
    (diagnostics === undefined ||
      (isRecordObject(diagnostics) &&
        (diagnostics['clean'] === undefined || typeof diagnostics['clean'] === 'boolean') &&
        (diagnostics['headCommit'] === undefined || isBoundedRecordString(diagnostics['headCommit'])) &&
        (diagnostics['treeOid'] === undefined || isBoundedRecordString(diagnostics['treeOid'])))) &&
    v2SourceFactsAgree(facts, sources)
  );
}

function isObservationIdentity(value: unknown): value is ObservationIdentity {
  if (!isRecordObject(value) || !isRecordObject(value['projection'])) return false;
  return (
    value['schemaVersion'] === OBSERVATION_IDENTITY_SCHEMA_VERSION &&
    value['canonicalizationVersion'] === OBSERVATION_IDENTITY_CANONICALIZATION_VERSION &&
    value['hashAlgorithm'] === OBSERVATION_IDENTITY_HASH_ALGORITHM &&
    isBoundedRecordString(value['projection']['name']) &&
    isPositiveInteger(value['projection']['version']) &&
    isSha256Hex(value['digest'])
  );
}

function isRelevantInputIdentity(value: unknown): value is RelevantInputIdentity {
  return isRecordObject(value) && isBoundedRecordString(value['subject']) && isObservationIdentity(value['identity']);
}

function isObservationSourceFact(value: unknown): value is ObservationSourceFact {
  return (
    isRecordObject(value) &&
    isObservationSourceKind(value['kind']) &&
    (value['identity'] === undefined || isObservationIdentity(value['identity']))
  );
}

function isObservationStabilityProof(value: unknown): value is ObservationStabilityProof {
  return (
    isRecordObject(value) &&
    isObservationSourceKind(value['source']) &&
    (value['kind'] === 'immutable' ||
      value['kind'] === 'fixed-snapshot' ||
      value['kind'] === 'bracketed' ||
      value['kind'] === 'not-established' ||
      value['kind'] === 'invalidated')
  );
}

function v2SourceFactsAgree(facts: Record<string, unknown>, sources: readonly ObservationSourceFact[]): boolean {
  const index = facts['index'];
  const indexSource = sources.find((source) => source.kind === 'index-generation');
  if (indexSource) {
    if (!isRecordObject(index) || !isObservationIdentity(index['generation'])) return false;
    if (indexSource.identity && !sameObservationIdentity(indexSource.identity, index['generation'])) return false;
  } else if (index !== undefined) {
    return false;
  }
  const workspace = facts['workspaceInstance'];
  const workspaceSource = sources.find((source) => source.kind === 'live-workspace');
  if (workspaceSource?.identity) {
    if (!isObservationIdentity(workspace) || !sameObservationIdentity(workspaceSource.identity, workspace)) {
      return false;
    }
  }
  const wholeContent = facts['wholeContent'];
  const snapshotSource = sources.find((source) => source.kind === 'repository-snapshot');
  if (snapshotSource?.identity) {
    if (!isObservationIdentity(wholeContent) || !sameObservationIdentity(snapshotSource.identity, wholeContent)) {
      return false;
    }
  }
  return true;
}

function stabilityProofCanDescribeSource(proof: ObservationStabilityProof, facts: Record<string, unknown>): boolean {
  if (proof.kind === 'not-established' || proof.kind === 'invalidated') return true;
  if (proof.source === 'index-generation') {
    return proof.kind === 'immutable' && isRecordObject(facts['index']) && facts['index']['source'] === 'immutable';
  }
  if (proof.source === 'repository-snapshot') return proof.kind === 'fixed-snapshot';
  if (proof.source === 'live-workspace') return proof.kind === 'bracketed';
  return false;
}

function sameObservationIdentity(left: ObservationIdentity, right: ObservationIdentity): boolean {
  return sameIdentityProjection(left, right) && left.digest === right.digest;
}

function legacyAuthorityFieldsAgree(authorityKind: unknown, index: unknown, worktree: unknown): boolean {
  if (authorityKind === 'index-worktree') return index !== undefined && worktree !== undefined;
  if (authorityKind === 'index-only') return index !== undefined && worktree === undefined;
  if (authorityKind === 'worktree-only') return index === undefined && worktree !== undefined;
  return authorityKind === 'process-local' && index === undefined && worktree === undefined;
}

function isLegacyAuthorityKind(value: unknown): value is ObservationAuthorityKind {
  return value === 'index-worktree' || value === 'index-only' || value === 'worktree-only' || value === 'process-local';
}

function isObservationSourceKind(value: unknown): value is ObservationSourceKind {
  return (
    value === 'index-generation' || value === 'repository-snapshot' || value === 'live-workspace' || value === 'process'
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): boolean {
  return new Set(values.map(key)).size === values.length;
}
