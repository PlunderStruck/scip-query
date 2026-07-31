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
  type CompletenessFindingCandidate,
  type CompletenessObligationPolicy,
} from '../domain/completeness-obligation-admission.js';
import { hashIdentity } from '../domain/autonomous-work-state.js';
import type { ObservationReceiptV2 } from '../domain/observation-receipt.js';
import type { ResidueEvaluation, ResidueEvidenceCoverage } from '../domain/residue.js';
import type { DiffGateFinding, DiffGateResult } from '../queries/impact/diff-gate.js';
import type { NewlyUnreferencedResidueResult } from '../queries/impact/newly-unreferenced-residue.js';
import { completenessFindingCandidate } from './completeness-finding.js';

export const RESIDUE_COMPLETENESS_POLICY_PROJECTION_VERSION = 1 as const;

const RESIDUE_DIFF_GATE_CHECKS = new Set(['echo', 'incomplete-migration', 'twin-partner', 'doc-reference', 'new-dead']);

export interface ResidueCompletenessInput {
  changeId: string;
  residue?: NewlyUnreferencedResidueResult;
  diffGate: Pick<DiffGateResult, 'changedFiles' | 'checksRun' | 'findings'>;
  receipt: ObservationReceiptV2;
}

export interface ResidueCompletenessResult {
  policy: CompletenessObligationPolicy;
  evidenceCoverage?: ResidueEvidenceCoverage;
  currentRoleProofs: ResidueEvaluation[];
  decisions: CompletenessAdmissionDecision[];
}

/**
 * Convert cleanup evidence into completion decisions without treating every
 * useful signal as mandatory work. A residue candidate names a current
 * callable whose route into behavior was removed by this change; this adapter
 * grants blocking authority only to direct, change-relevant evidence observed
 * against one fixed repository state. Current-role proofs remain visible but
 * produce no obligation.
 */
export function evaluateResidueCompleteness(input: ResidueCompletenessInput): ResidueCompletenessResult {
  const policy = residueCompletenessPolicy();
  const currentRoleProofs = (input.residue?.evaluations ?? []).filter(
    (evaluation) => evaluation.disposition === 'current-role-proven',
  );
  const residueDecisions = (input.residue?.evaluations ?? [])
    .filter((evaluation) => evaluation.disposition !== 'current-role-proven')
    .map((evaluation) =>
      evaluateCompletenessAdmission(
        residueAdmissionObservation({
          changeId: input.changeId,
          policy,
          evaluation,
          coverage: input.residue!.coverage,
          receipt: input.receipt,
        }),
      ),
    );
  const diffFindings = input.diffGate.findings.filter((finding) => RESIDUE_DIFF_GATE_CHECKS.has(finding.check));
  const diffDecisions = diffFindings.map((finding) =>
    evaluateCompletenessAdmission(
      diffFindingAdmissionObservation({
        changeId: input.changeId,
        policy,
        finding,
        changedFiles: input.diffGate.changedFiles,
        producerComplete: input.diffGate.checksRun.includes(finding.check),
        findingCount: diffFindings.filter((candidate) => candidate.check === finding.check).length,
        receipt: input.receipt,
      }),
    ),
  );
  return {
    policy,
    ...(input.residue ? { evidenceCoverage: input.residue.coverage } : {}),
    currentRoleProofs,
    decisions: [...residueDecisions, ...diffDecisions],
  };
}

export function residueCompletenessPolicy(): CompletenessObligationPolicy {
  const rules: CompletenessObligationPolicy['rules'] = [
    {
      ruleId: 'newly-unreferenced-implementation',
      checks: ['newly-unreferenced'],
      category: 'residue',
      admissibleActionTiers: ['direct'],
      minimumConfidence: 0.9,
      allowProducerAdvisory: false,
      qualification: {
        origins: ['mixed'],
        coverage: ['complete'],
        producerValidation: ['not-applicable'],
      },
    },
    {
      ruleId: 'new-dead-implementation',
      checks: ['new-dead'],
      category: 'residue',
      admissibleActionTiers: ['direct'],
      minimumConfidence: 0.9,
      allowProducerAdvisory: false,
      qualification: {
        origins: ['compiler-graph', 'mixed'],
        coverage: ['complete'],
        producerValidation: ['not-applicable'],
      },
    },
    {
      ruleId: 'incomplete-migration',
      checks: ['incomplete-migration'],
      category: 'migration',
      admissibleActionTiers: ['direct'],
      minimumConfidence: 0.8,
      allowProducerAdvisory: false,
      qualification: {
        origins: ['mixed'],
        coverage: ['complete'],
        producerValidation: ['not-applicable'],
      },
    },
    {
      ruleId: 'surviving-alternative',
      checks: ['echo'],
      category: 'residue',
      admissibleActionTiers: ['direct'],
      minimumConfidence: 0.95,
      allowProducerAdvisory: false,
      qualification: {
        origins: ['mixed'],
        coverage: ['complete'],
        producerValidation: ['not-applicable'],
      },
    },
  ];
  return {
    policyId: `scip-query:residue:${hashIdentity({
      projectionVersion: RESIDUE_COMPLETENESS_POLICY_PROJECTION_VERSION,
      rules,
    }).slice(0, 32)}`,
    policyVersion: COMPLETENESS_ADMISSION_POLICY_VERSION,
    rules,
  };
}

function residueAdmissionObservation(input: {
  changeId: string;
  policy: CompletenessObligationPolicy;
  evaluation: ResidueEvaluation;
  coverage: ResidueEvidenceCoverage;
  receipt: ObservationReceiptV2;
}): CompletenessAdmissionObservation {
  const observation = input.evaluation.observation;
  const candidate: CompletenessFindingCandidate = {
    findingId: observation.observationId,
    check: 'newly-unreferenced',
    evidence: 'change-graph',
    actionTier: observation.changeEvidence.length > 0 ? 'direct' : 'signal',
    confidence: observation.changeEvidence.some((evidence) => evidence.kind === 'removed-call') ? 0.95 : 0.9,
    advisory: false,
    file: observation.referent.file,
    relatedFiles: [...new Set(observation.changeEvidence.map((evidence) => evidence.changedFile))].sort(),
    message: `${observation.referent.displayName} remains after this change removed its former call or reference.`,
    remediation: `Remove ${observation.referent.displayName}, wire it to a current production role, or establish a concrete current-role proof.`,
  };
  const changedEvidencePaths = [...new Set(observation.changeEvidence.map((evidence) => evidence.changedFile))].sort();
  const relevance: CompletenessAdmissionObservation['relevance'] =
    changedEvidencePaths.length > 0
      ? {
          state: 'in-scope',
          basis: 'candidate-diff',
          paths: changedEvidencePaths,
          reasons: ['The fixed-base comparison observed this call or reference being removed by the candidate diff.'],
        }
      : {
          state: 'unknown',
          basis: 'not-established',
          paths: candidatePaths(candidate),
          reasons: ['No removed call or reference ties this referent to the candidate diff.'],
        };
  return {
    changeId: input.changeId,
    policy: input.policy,
    candidate,
    relevance,
    qualification: deriveClaimQualification({
      contract: {
        origin: 'mixed',
        observedSources: ['index-generation', 'repository-snapshot'],
        producerValidation: { status: 'not-applicable' },
      },
      receipt: input.receipt,
      coverage: {
        complete: input.coverage.state === 'complete',
        totalKnown: input.coverage.state === 'complete',
        returned: input.evaluation.disposition === 'candidate' ? 1 : 0,
        ...(input.coverage.state === 'complete' ? { total: 1, omitted: 0 } : {}),
      },
      repositoryPolicy: repositoryAction(input.policy, 'newly-unreferenced'),
    }),
    evidenceReceipts: [input.receipt],
  };
}

function diffFindingAdmissionObservation(input: {
  changeId: string;
  policy: CompletenessObligationPolicy;
  finding: DiffGateFinding;
  changedFiles: readonly string[];
  producerComplete: boolean;
  findingCount: number;
  receipt: ObservationReceiptV2;
}): CompletenessAdmissionObservation {
  const candidate = completenessFindingCandidate(input.finding);
  return {
    changeId: input.changeId,
    policy: input.policy,
    candidate,
    relevance: findingRelevance(candidatePaths(candidate), input.changedFiles, [
      'The cleanup finding intersects the candidate diff.',
    ]),
    qualification: deriveClaimQualification({
      contract: {
        origin: diffFindingOrigin(input.finding),
        observedSources: ['index-generation', 'repository-snapshot'],
        producerValidation: { status: 'not-applicable' },
      },
      receipt: input.receipt,
      coverage: {
        complete: input.producerComplete,
        totalKnown: input.producerComplete,
        returned: input.findingCount,
        ...(input.producerComplete ? { total: input.findingCount, omitted: 0 } : {}),
      },
      repositoryPolicy: repositoryAction(input.policy, input.finding.check),
    }),
    evidenceReceipts: [input.receipt],
  };
}

function diffFindingOrigin(finding: DiffGateFinding): ClaimOrigin {
  if (finding.sourceAnalyzer === 'newly-unreferenced-residue') return 'mixed';
  if (finding.check === 'new-dead' && finding.evidence === 'graph-fact') return 'compiler-graph';
  if (finding.check === 'incomplete-migration' || finding.check === 'echo') return 'mixed';
  if (finding.evidence === 'semantic') return 'semantic-analysis';
  if (finding.evidence === 'change-graph') return 'change-history';
  if (finding.evidence === 'graph-fact') return 'compiler-graph';
  if (finding.evidence === 'baseline') return 'repository-source';
  return 'heuristic';
}

function repositoryAction(
  policy: CompletenessObligationPolicy,
  check: string,
): CompletenessAdmissionObservation['qualification']['repositoryPolicy'] {
  const permission = policy.rules.some((rule) => rule.checks.includes(check)) ? 'block' : 'advise';
  return {
    policyId: policy.policyId,
    policyVersion: CLAIM_ACTION_POLICY_VERSION,
    permission,
    reasons:
      permission === 'block'
        ? ['Repository completeness policy admits qualified direct evidence from this check.']
        : ['Repository completeness policy keeps this result advisory.'],
  };
}

function candidatePaths(candidate: CompletenessFindingCandidate): string[] {
  return [...new Set([...(candidate.file ? [candidate.file] : []), ...candidate.relatedFiles])].sort();
}

function findingRelevance(
  paths: readonly string[],
  changedFiles: readonly string[],
  inScopeReasons: readonly string[],
): CompletenessAdmissionObservation['relevance'] {
  const changed = new Set(changedFiles);
  const relevantPaths = paths.filter((path) => changed.has(path));
  return relevantPaths.length > 0
    ? {
        state: 'in-scope',
        basis: 'candidate-diff',
        paths: relevantPaths,
        reasons: inScopeReasons,
      }
    : {
        state: 'unknown',
        basis: 'not-established',
        paths,
        reasons: ['The finding has no current file referent in the candidate diff.'],
      };
}
