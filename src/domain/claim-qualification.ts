import {
  deriveObservationStateAuthority,
  type DerivedObservationStateAuthority,
  type ObservationReceipt,
  type ObservationSourceKind,
} from './observation-receipt.js';
import { isNonEmptyString, isNonNegativeInteger, isRecordObject } from './record-validation.js';

export const CLAIM_QUALIFICATION_SCHEMA_VERSION = 1 as const;
export const CLAIM_ACTION_POLICY_VERSION = 1 as const;

export const CLAIM_ORIGINS = [
  'compiler-graph',
  'semantic-analysis',
  'repository-source',
  'change-history',
  'runtime-measurement',
  'heuristic',
  'mixed',
  'unknown',
] as const;
export type ClaimOrigin = (typeof CLAIM_ORIGINS)[number];

export const CLAIM_COVERAGE_STATES = ['complete', 'partial', 'unknown'] as const;
export type ClaimCoverageState = (typeof CLAIM_COVERAGE_STATES)[number];

export const PRODUCER_VALIDATION_STATUSES = ['validated', 'failed', 'not-evaluated', 'not-applicable'] as const;
export type ProducerValidationStatus = (typeof PRODUCER_VALIDATION_STATUSES)[number];

export const CLAIM_ACTION_PERMISSIONS = [
  'observe',
  'advise',
  'require-adjudication',
  'block',
  'not-established',
] as const;
export type ClaimActionPermission = (typeof CLAIM_ACTION_PERMISSIONS)[number];

/**
 * A producer validation reports how one evidence-producing method performed
 * against a named, versioned corpus. A successful status without that
 * referent would be an assertion about the producer rather than checkable
 * validation evidence.
 */
export type ProducerValidation =
  | {
      status: 'validated' | 'failed';
      certification: {
        id: string;
        version: number;
        corpus: string;
      };
    }
  | {
      status: 'not-evaluated' | 'not-applicable';
      certification?: never;
    };

/**
 * One result family is a stable set of result values that share an evidence
 * origin. A fixed binding applies one origin to the selected family. A
 * result-field binding maps the producer's existing per-row provenance field
 * into the public origin vocabulary without copying or flattening the rows.
 */
export type ClaimFamilyOriginBinding =
  | { kind: 'fixed'; origin: Exclude<ClaimOrigin, 'mixed'> }
  | {
      kind: 'result-field';
      field: string;
      values: Readonly<Record<string, Exclude<ClaimOrigin, 'mixed'>>>;
    };

export interface ClaimFamilyContract {
  id: string;
  /** Repository-relative JSON path rooted at the command-owned result. */
  selector: string;
  origin: ClaimFamilyOriginBinding;
}

/**
 * The descriptor-owned facts about a command's evidence producer. These facts
 * identify production and input sources; they do not grant state authority or
 * repository-policy permission.
 */
export interface CommandClaimContract {
  origin: ClaimOrigin;
  observedSources: readonly ObservationSourceKind[];
  producerValidation: ProducerValidation;
  families?: readonly ClaimFamilyContract[];
}

export interface ClaimCoverage {
  state: ClaimCoverageState;
  returned: number;
  totalKnown: boolean;
  total?: number;
  omitted?: number;
}

export interface RepositoryPolicyAction {
  policyId: string;
  policyVersion: typeof CLAIM_ACTION_POLICY_VERSION;
  permission: ClaimActionPermission;
  reasons: readonly string[];
}

/**
 * A claim qualification is a set of independent facts that determine what one
 * command result can support. Its real referents are the result's production
 * method, enumeration extent, producer validation, observed repository state,
 * and policy-permitted response. Keeping them independent is what prevents a
 * strong fact in one dimension from silently strengthening another.
 */
export interface ClaimQualificationV1 {
  schemaVersion: typeof CLAIM_QUALIFICATION_SCHEMA_VERSION;
  origin: ClaimOrigin;
  coverage: ClaimCoverage;
  producerValidation: ProducerValidation;
  stateAuthority: DerivedObservationStateAuthority;
  repositoryPolicy: RepositoryPolicyAction;
  families?: readonly ClaimFamilyContract[];
}

export interface ClaimCoverageInput {
  complete: boolean | null;
  totalKnown: boolean;
  returned: number;
  total?: number;
  omitted?: number;
}

export interface DeriveClaimQualificationInput {
  contract: CommandClaimContract;
  receipt: ObservationReceipt;
  coverage?: ClaimCoverageInput;
  repositoryPolicy?: RepositoryPolicyAction;
}

export const DEFAULT_REPOSITORY_POLICY_ACTION: RepositoryPolicyAction = {
  policyId: 'scip-query:unresolved-repository-policy',
  policyVersion: CLAIM_ACTION_POLICY_VERSION,
  permission: 'not-established',
  reasons: ['No repository action policy was supplied for this claim.'],
};

export function deriveClaimQualification(input: DeriveClaimQualificationInput): ClaimQualificationV1 {
  return {
    schemaVersion: CLAIM_QUALIFICATION_SCHEMA_VERSION,
    origin: input.contract.origin,
    coverage: deriveClaimCoverage(input.coverage),
    producerValidation: input.contract.producerValidation,
    stateAuthority: deriveObservationStateAuthority(input.receipt, input.receipt),
    repositoryPolicy: input.repositoryPolicy ?? DEFAULT_REPOSITORY_POLICY_ACTION,
    ...(input.contract.families ? { families: input.contract.families } : {}),
  };
}

export function deriveClaimCoverage(coverage: ClaimCoverageInput | undefined): ClaimCoverage {
  if (!coverage) return { state: 'unknown', returned: 0, totalKnown: false };
  if (coverage.complete === true) {
    return {
      state: 'complete',
      returned: coverage.returned,
      totalKnown: true,
      total: coverage.total ?? coverage.returned,
      omitted: 0,
    };
  }
  if (coverage.totalKnown) {
    return {
      state: 'partial',
      returned: coverage.returned,
      totalKnown: true,
      ...(coverage.total === undefined ? {} : { total: coverage.total }),
      ...(coverage.omitted === undefined ? {} : { omitted: coverage.omitted }),
    };
  }
  return { state: 'unknown', returned: coverage.returned, totalKnown: false };
}

export interface ClaimQualificationRequirements {
  origins?: readonly ClaimOrigin[];
  coverage?: readonly ClaimCoverageState[];
  producerValidation?: readonly ProducerValidationStatus[];
  stateAuthority?: readonly DerivedObservationStateAuthority['authority'][];
  actionPermission?: readonly ClaimActionPermission[];
}

export type ClaimQualificationPredicate =
  | 'origin'
  | 'coverage'
  | 'producer-validation'
  | 'state-authority'
  | 'action-permission';

export interface ClaimQualificationPredicateResult {
  predicate: ClaimQualificationPredicate;
  satisfied: boolean;
  required: readonly string[];
  actual: string;
}

export interface ClaimQualificationEvaluation {
  satisfied: boolean;
  predicates: readonly ClaimQualificationPredicateResult[];
}

/**
 * Evaluate only predicates named by the consumer. This is the consumer-side
 * contract: an omitted requirement grants nothing and a satisfied predicate
 * cannot compensate for an unsatisfied one.
 */
export function evaluateClaimQualification(
  qualification: ClaimQualificationV1,
  requirements: ClaimQualificationRequirements,
): ClaimQualificationEvaluation {
  const predicates: ClaimQualificationPredicateResult[] = [];
  addPredicate(predicates, 'origin', requirements.origins, qualification.origin);
  addPredicate(predicates, 'coverage', requirements.coverage, qualification.coverage.state);
  addPredicate(
    predicates,
    'producer-validation',
    requirements.producerValidation,
    qualification.producerValidation.status,
  );
  addPredicate(predicates, 'state-authority', requirements.stateAuthority, qualification.stateAuthority.authority);
  addPredicate(
    predicates,
    'action-permission',
    requirements.actionPermission,
    qualification.repositoryPolicy.permission,
  );
  return {
    satisfied: predicates.every((predicate) => predicate.satisfied),
    predicates,
  };
}

function addPredicate(
  predicates: ClaimQualificationPredicateResult[],
  predicate: ClaimQualificationPredicate,
  required: readonly string[] | undefined,
  actual: string,
): void {
  if (!required) return;
  predicates.push({
    predicate,
    satisfied: required.includes(actual),
    required,
    actual,
  });
}

export function isClaimQualificationV1(value: unknown): value is ClaimQualificationV1 {
  if (!isRecordObject(value) || value['schemaVersion'] !== CLAIM_QUALIFICATION_SCHEMA_VERSION) return false;
  if (!isOneOf(value['origin'], CLAIM_ORIGINS) || !isClaimCoverage(value['coverage'])) return false;
  if (!isProducerValidation(value['producerValidation'])) return false;
  if (!isDerivedStateAuthority(value['stateAuthority'])) return false;
  if (!isRepositoryPolicyAction(value['repositoryPolicy'])) return false;
  return value['families'] === undefined || isClaimFamilies(value['families']);
}

function isClaimCoverage(value: unknown): value is ClaimCoverage {
  if (!isRecordObject(value) || !isOneOf(value['state'], CLAIM_COVERAGE_STATES)) return false;
  if (!isNonNegativeInteger(value['returned']) || typeof value['totalKnown'] !== 'boolean') return false;
  if (value['total'] !== undefined && !isNonNegativeInteger(value['total'])) return false;
  if (value['omitted'] !== undefined && !isNonNegativeInteger(value['omitted'])) return false;
  if (value['state'] === 'complete') {
    return value['totalKnown'] === true && value['total'] === value['returned'] && value['omitted'] === 0;
  }
  if (value['state'] === 'partial') {
    return (
      value['totalKnown'] === true &&
      isNonNegativeInteger(value['total']) &&
      isNonNegativeInteger(value['omitted']) &&
      value['total'] === Number(value['returned']) + Number(value['omitted'])
    );
  }
  return value['totalKnown'] === false;
}

function isProducerValidation(value: unknown): value is ProducerValidation {
  if (!isRecordObject(value) || !isOneOf(value['status'], PRODUCER_VALIDATION_STATUSES)) return false;
  const certification = value['certification'];
  if (value['status'] === 'validated' || value['status'] === 'failed') {
    return (
      isRecordObject(certification) &&
      isNonEmptyString(certification['id']) &&
      Number.isSafeInteger(certification['version']) &&
      Number(certification['version']) > 0 &&
      isNonEmptyString(certification['corpus'])
    );
  }
  return certification === undefined;
}

function isDerivedStateAuthority(value: unknown): value is DerivedObservationStateAuthority {
  return (
    isRecordObject(value) &&
    Number.isSafeInteger(value['policyVersion']) &&
    (value['authority'] === 'completion' || value['authority'] === 'advisory' || value['authority'] === 'none') &&
    Array.isArray(value['requiredRelationships']) &&
    value['requiredRelationships'].every(isNonEmptyString) &&
    Array.isArray(value['reasons']) &&
    value['reasons'].every(isNonEmptyString)
  );
}

function isRepositoryPolicyAction(value: unknown): value is RepositoryPolicyAction {
  return (
    isRecordObject(value) &&
    isNonEmptyString(value['policyId']) &&
    value['policyVersion'] === CLAIM_ACTION_POLICY_VERSION &&
    isOneOf(value['permission'], CLAIM_ACTION_PERMISSIONS) &&
    Array.isArray(value['reasons']) &&
    value['reasons'].every(isNonEmptyString)
  );
}

function isClaimFamilies(value: unknown): value is readonly ClaimFamilyContract[] {
  return (
    Array.isArray(value) &&
    value.every(
      (family) =>
        isRecordObject(family) &&
        isNonEmptyString(family['id']) &&
        isNonEmptyString(family['selector']) &&
        isFamilyOriginBinding(family['origin']),
    )
  );
}

function isFamilyOriginBinding(value: unknown): value is ClaimFamilyOriginBinding {
  if (!isRecordObject(value)) return false;
  if (value['kind'] === 'fixed') {
    return isOneOf(value['origin'], CLAIM_ORIGINS) && value['origin'] !== 'mixed';
  }
  if (value['kind'] !== 'result-field' || !isNonEmptyString(value['field']) || !isRecordObject(value['values'])) {
    return false;
  }
  return Object.values(value['values']).every((origin) => isOneOf(origin, CLAIM_ORIGINS) && origin !== 'mixed');
}

function isOneOf<const Value extends string>(value: unknown, values: readonly Value[]): value is Value {
  return typeof value === 'string' && values.includes(value as Value);
}
