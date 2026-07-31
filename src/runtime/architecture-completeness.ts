import type { ArchitectureConfig } from '../domain/config-types.js';
import {
  CLAIM_ACTION_POLICY_VERSION,
  deriveClaimQualification,
  type ClaimOrigin,
} from '../domain/claim-qualification.js';
import {
  COMPLETENESS_ADMISSION_POLICY_VERSION,
  evaluateCompletenessAdmission,
  type CompletenessAdmissionDecision,
  type CompletenessAdmissionObservation,
  type CompletenessObligationPolicy,
} from '../domain/completeness-obligation-admission.js';
import { hashIdentity } from '../domain/autonomous-work-state.js';
import type { ObservationReceiptV2 } from '../domain/observation-receipt.js';
import { hasEnforceableArchitecturePolicy } from '../queries/graph/architecture.js';
import type { DiffGateFinding, DiffGateResult } from '../queries/impact/diff-gate.js';
import { completenessFindingCandidate } from './completeness-finding.js';

export const ARCHITECTURE_COMPLETENESS_POLICY_PROJECTION_VERSION = 1 as const;

export interface ArchitectureCompletenessInput {
  changeId: string;
  architecture: ArchitectureConfig | undefined;
  diffGate: Pick<DiffGateResult, 'changedFiles' | 'checksRun' | 'findings'>;
  receipt: ObservationReceiptV2;
}

/**
 * Convert the existing architecture report into completion decisions.
 *
 * The diff gate remains the producer of graph and repository-policy facts.
 * This adapter only supplies the admission policy, fixed receipt, and
 * change-relative relevance needed to decide whether each fact becomes work.
 */
export function evaluateArchitectureCompleteness(
  input: ArchitectureCompletenessInput,
): CompletenessAdmissionDecision[] {
  const policy = architectureCompletenessPolicy(input.architecture);
  const architectureFindings = input.diffGate.findings.filter((finding) => finding.check === 'architecture');
  const producerComplete = input.diffGate.checksRun.includes('architecture');
  return architectureFindings.map((finding) =>
    evaluateCompletenessAdmission(
      architectureAdmissionObservation({
        changeId: input.changeId,
        policy,
        finding,
        changedFiles: input.diffGate.changedFiles,
        architectureFindingCount: architectureFindings.length,
        producerComplete,
        receipt: input.receipt,
      }),
    ),
  );
}

export function architectureCompletenessPolicy(
  architecture: ArchitectureConfig | undefined,
): CompletenessObligationPolicy {
  const policyId = `scip-query:architecture:${hashIdentity({
    projectionVersion: ARCHITECTURE_COMPLETENESS_POLICY_PROJECTION_VERSION,
    architecture: architecture ?? null,
  }).slice(0, 32)}`;
  return {
    policyId,
    policyVersion: COMPLETENESS_ADMISSION_POLICY_VERSION,
    rules: hasEnforceableArchitecturePolicy(architecture)
      ? [
          {
            ruleId: 'declared-architecture',
            checks: ['architecture'],
            category: 'architecture',
            admissibleActionTiers: ['direct'],
            minimumConfidence: 1,
            allowProducerAdvisory: false,
            qualification: {
              origins: ['compiler-graph', 'mixed', 'repository-source'],
              coverage: ['complete'],
              producerValidation: ['not-applicable'],
            },
          },
        ]
      : [],
  };
}

function architectureAdmissionObservation(input: {
  changeId: string;
  policy: CompletenessObligationPolicy;
  finding: DiffGateFinding;
  changedFiles: readonly string[];
  architectureFindingCount: number;
  producerComplete: boolean;
  receipt: ObservationReceiptV2;
}): CompletenessAdmissionObservation {
  const candidate = completenessFindingCandidate(input.finding);
  const paths = [...new Set([...(candidate.file ? [candidate.file] : []), ...candidate.relatedFiles])].sort();
  const changed = new Set(input.changedFiles);
  const relevantPaths = paths.filter((path) => changed.has(path));
  const relevance: CompletenessAdmissionObservation['relevance'] =
    relevantPaths.length > 0
      ? {
          state: 'in-scope',
          basis: 'candidate-diff',
          paths: relevantPaths,
          reasons: ['Current architecture evidence intersects the candidate diff.'],
        }
      : {
          state: 'unknown',
          basis: 'not-established',
          paths,
          reasons: ['The architecture finding has no current file referent in the candidate diff.'],
        };
  const permission = input.policy.rules.length > 0 ? 'block' : 'advise';
  return {
    changeId: input.changeId,
    policy: input.policy,
    candidate,
    relevance,
    qualification: deriveClaimQualification({
      contract: {
        origin: architectureClaimOrigin(input.finding),
        observedSources: ['index-generation', 'repository-snapshot'],
        producerValidation: { status: 'not-applicable' },
      },
      receipt: input.receipt,
      coverage: {
        complete: input.producerComplete,
        totalKnown: input.producerComplete,
        returned: input.architectureFindingCount,
        ...(input.producerComplete ? { total: input.architectureFindingCount, omitted: 0 } : {}),
      },
      repositoryPolicy: {
        policyId: input.policy.policyId,
        policyVersion: CLAIM_ACTION_POLICY_VERSION,
        permission,
        reasons:
          permission === 'block'
            ? ['The finding violates an explicit architecture rule absent from the committed baseline.']
            : ['No enforceable architecture policy is configured for this result.'],
      },
    }),
    evidenceReceipts: [input.receipt],
  };
}

function architectureClaimOrigin(finding: DiffGateFinding): ClaimOrigin {
  const kind = finding.rootCauseKey?.split(':', 1)[0];
  if (kind === 'test-boundary' || kind === 'unmapped-file' || kind === 'ambiguous-file') {
    return 'repository-source';
  }
  if (kind === 'missing-policy-row' || kind === 'stale-allowance' || kind === 'boundary-limit') {
    return 'mixed';
  }
  return 'compiler-graph';
}
