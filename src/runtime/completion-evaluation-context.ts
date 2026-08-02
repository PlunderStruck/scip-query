import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  applyCompletionAuthorityFirewall,
  COMPLETION_PREDICATES,
  createCompletionAuthorityAssessment,
  type CompletionAuthorityPredecessor,
  type CompletionAuthorityReliance,
  type CompletionEvaluationRequest,
  type CompletionPredicateJudgment,
} from '../domain/autonomous-completion.js';
import { isMonotonicArchitecturePolicyTightening } from '../change-control/architecture-policy-authority.js';
import {
  completionCommandRegistry,
  completionProtectedArtifactSet,
  createCompletionContextSnapshotRecord,
  type CompletionContextSnapshotRecordV1,
  type CompletionContextSnapshotRequest,
  type CompletionEvaluatorSnapshot,
  type CompletionPolicySnapshot,
  type ProtectedGoalEvidenceSnapshot,
  type ProtectedWorkAuthorizationSnapshot,
  type ProtectedArtifactRule,
} from '../domain/autonomous-completion-context.js';
import type { ProtectedArtifactClass } from '../domain/completion-protection.js';
import type { ArchitectureConfig } from '../domain/config-types.js';
import { transitionRuleAuthorizedReferents } from '../domain/completion-transition-rule.js';
import type { ObservationReceiptV2 } from '../domain/observation-receipt.js';
import { isPathInsideProject } from '../domain/path-normalization.js';
import { matchesPathGlob } from '../domain/path-glob.js';
import { protectedWorkAuthorizationMatchesRecords } from '../domain/protected-work-authorization.js';
import { hashIdentity } from '../domain/autonomous-work-state.js';
import { stableJson } from '../domain/stable-json.js';
import type { ProjectConfig } from '../domain/types.js';
import type { PlanContractRecordV1 } from '../change-control/plan-contract.js';
import { sha256FileWithinLimit, SOURCE_ARTIFACT_MAX_BYTES } from '../filesystem/bounded-file.js';
import { readProjectFileText } from '../platform/project-files.js';
import { DIFF_GATE_CHECKS, blockingFindings, type DiffGateResult } from '../queries/impact/diff-gate.js';
import { readObligationLifecycle } from '../storage/autonomous-work-obligations.js';
import { createCompletionContextSnapshotFile } from '../storage/autonomous-completion-context.js';
import { recordCompletenessAdmissionDecision } from '../storage/completeness-obligation-admission.js';
import {
  createCompletionEvaluationFiles,
  readCompletionHistory,
  recoverCompletionSuccessorMaterializations,
} from '../storage/autonomous-completion.js';
import {
  protectedArtifactTransitionMatches,
  selectCompletionTransitionRule,
} from '../storage/completion-transition-rule.js';
import {
  readGoalRecords,
  readIntendedChangeRecords,
  GOALS_DIR,
  type WorkStateCreateOptions,
} from '../storage/autonomous-work-state.js';
import { readWorkHistory } from '../storage/autonomous-work-ledger.js';
import { readPlanContractRecords } from '../storage/plan-contract.js';
import { captureFixedRepositoryObservation, captureFixedRepositoryObservationReceipt } from './observation-receipt.js';
import { cliVersion } from './cli-support.js';
import { evaluateArchitectureCompleteness } from './architecture-completeness.js';
import { reconcileCompletenessObligations } from './completeness-reconciliation.js';
import { evaluateResidueCompleteness } from './residue-completeness.js';
import {
  assertFixedProtectedWorkAuthorization,
  type FixedProtectedWorkAuthorizationLease,
} from './protected-work-authorization-controller.js';
import {
  assertFixedProtectedGoalEvidence,
  assertProtectedGoalEvidenceMatchesTarget,
  type FixedProtectedGoalEvidenceLease,
} from './protected-goal-evidence-controller.js';

export const STOP_COMPLETION_POLICY_ID = 'scip-query:stop-completion-policy' as const;
export const STOP_COMPLETION_POLICY_VERSION = 1 as const;
export const STOP_COMPLETION_EVALUATOR_ID = 'scip-query:stop-completion-controller' as const;
export const STOP_COMPLETION_EVALUATOR_CONTRACT_VERSION = 1 as const;

const PROTECTED_ARTIFACT_RULES: readonly ProtectedArtifactRule[] = [
  {
    class: 'goal',
    selectors: ['.scipquery/goals/*'],
    authority: 'fixed-predecessor',
  },
  {
    class: 'transition-rule',
    selectors: ['.scipquery/transition-rules/*'],
    authority: 'fixed-predecessor',
  },
  {
    class: 'evaluator',
    selectors: ['.scipquery/evaluator/**'],
    authority: 'bootstrap-trust-root',
  },
  {
    class: 'test',
    selectors: ['__tests__/**', 'spec/**', 'test/**', 'tests/**'],
    authority: 'fixed-predecessor',
  },
  {
    class: 'baseline',
    selectors: ['.scipquery-baseline.json'],
    authority: 'fixed-predecessor',
  },
  {
    class: 'suppression',
    selectors: ['.scipquery/suppressions/*'],
    authority: 'fixed-predecessor',
  },
  {
    class: 'configuration',
    selectors: ['.scipquery.json'],
    authority: 'fixed-predecessor',
  },
] as const;

export interface FixedCompletionContextLease {
  projectRoot: string;
  collaborationDomainId: string;
  targetObservation: ObservationReceiptV2;
  evaluator: CompletionEvaluatorSnapshot;
  architecture?: ArchitectureConfig;
  authority: CompletionAuthorityInputs;
  requests: readonly CompletionContextSnapshotRequest[];
  records: readonly CompletionContextSnapshotRecordV1[];
  planContracts: readonly PlanContractRecordV1[];
  protectedWorkAuthorization?: FixedProtectedWorkAuthorizationLease;
  protectedGoalEvidence?: FixedProtectedGoalEvidenceLease;
}

export interface CompletionAuthorityInputs {
  predecessor: CompletionAuthorityPredecessor;
  changedPaths: readonly string[];
  protectedWorkAuthorization?: FixedProtectedWorkAuthorizationLease;
  protectedGoalEvidence?: FixedProtectedGoalEvidenceLease;
}

export class CompletionEvaluationContextMovedError extends Error {
  readonly code = 'SCIP_QUERY_COMPLETION_CONTEXT_MOVED';

  constructor(message: string) {
    super(message);
    this.name = 'CompletionEvaluationContextMovedError';
  }
}

/**
 * Capture every repository and policy input needed to interpret a later stop
 * judgment. The returned lease contains immutable values only; the source
 * snapshot's buffers are released before the expensive gate runs.
 */
export function captureFixedCompletionContext(
  projectRoot: string,
  config: ProjectConfig,
  stopMode: CompletionPolicySnapshot['stopMode'],
  options: {
    observedAt?: Date;
    evaluatorEntrypoint?: string;
    protectedWorkAuthorization?: FixedProtectedWorkAuthorizationLease;
    protectedGoalEvidence?: FixedProtectedGoalEvidenceLease;
  } = {},
): FixedCompletionContextLease {
  const collaborationDomainId = config.collaborationDomainId;
  if (!collaborationDomainId) {
    throw new Error('completion evaluation requires a configured collaboration domain');
  }
  if (
    options.protectedWorkAuthorization &&
    (options.protectedWorkAuthorization.projectRoot !== realpathSync(projectRoot) ||
      options.protectedWorkAuthorization.record.collaborationDomainId !== collaborationDomainId)
  ) {
    throw new Error('protected work authorization lease does not belong to this repository collaboration domain');
  }
  recoverCompletionSuccessorMaterializations(projectRoot, collaborationDomainId, {
    toolVersion: cliVersion,
  });
  const observation = captureFixedRepositoryObservation({
    projectRoot,
    config,
    ...(options.observedAt ? { observedAt: options.observedAt } : {}),
    collaborationDomainId,
  });
  const targetObservation = observation.receipt;
  if (options.protectedGoalEvidence) {
    if (!options.protectedWorkAuthorization) {
      throw new Error('protected goal evidence requires a fixed protected work authorization');
    }
    if (
      options.protectedGoalEvidence.projectRoot !== realpathSync(projectRoot) ||
      options.protectedGoalEvidence.record.collaborationDomainId !== collaborationDomainId
    ) {
      throw new Error('protected goal evidence lease does not belong to this repository collaboration domain');
    }
    assertProtectedGoalEvidenceMatchesTarget(options.protectedGoalEvidence, targetObservation);
  }
  const goals = readGoalRecords(projectRoot);
  const allChanges = readIntendedChangeRecords(projectRoot, goals);
  const plans = readPlanContractRecords(projectRoot);
  const completionHistory = readCompletionHistory(projectRoot);
  const terminalChangeIds = new Set(
    completionHistory.summary.states
      .filter((state) => state.state === 'complete' || state.state === 'superseded')
      .map((state) => state.changeId),
  );
  const changes = {
    ...allChanges,
    records: allChanges.records.filter((change) => !terminalChangeIds.has(change.changeId)),
  };
  const recordIssues = [
    ...goals.compatibility.issues.map((issue) => `goal ${issue.path}: ${issue.reason}`),
    ...allChanges.compatibility.issues.map((issue) => `intended change ${issue.path}: ${issue.reason}`),
    ...allChanges.integrityIssues,
    ...completionHistory.integrityIssues.map((issue) => `completion ${issue}`),
    ...plans.compatibility.issues.map((issue) => `plan ${issue.path}: ${issue.reason}`),
    ...plans.integrityIssues.map((issue) => `plan ${issue}`),
  ];
  if (recordIssues.length > 0) {
    throw new Error(`completion context could not fix current goal/change state: ${recordIssues.join('; ')}`);
  }
  const goalsById = new Map(goals.records.map((goal) => [goal.goalId, goal]));
  const evaluator = completionEvaluatorSnapshot(options.evaluatorEntrypoint);
  const policy: CompletionPolicySnapshot = {
    policyId: STOP_COMPLETION_POLICY_ID,
    policyVersion: STOP_COMPLETION_POLICY_VERSION,
    stopMode,
    requiredPredicates: COMPLETION_PREDICATES,
  };
  const commandRegistry = completionCommandRegistry([
    'completion-controller:required-predicates-v1',
    'stop-hook:fixed-context-v1',
    ...DIFF_GATE_CHECKS.map((check) => `diff-gate:${check}`),
  ]);
  const protectedArtifacts = completionProtectedArtifactSet(
    completionProtectedArtifactRules(projectRoot, options.evaluatorEntrypoint),
  );
  const requests = changes.records.map((change): CompletionContextSnapshotRequest => {
    const goal = goalsById.get(change.goalId);
    if (!goal) throw new Error(`intended change ${change.changeId} has no current goal ${change.goalId}`);
    return {
      goal,
      change,
      policy,
      evaluator,
      commandRegistry,
      protectedArtifacts,
      targetObservation,
      ...(options.protectedWorkAuthorization &&
      protectedWorkAuthorizationMatchesRecords(options.protectedWorkAuthorization.record, goal, change)
        ? {
            protectedWorkAuthorization: protectedWorkAuthorizationSnapshot(options.protectedWorkAuthorization),
            ...(options.protectedGoalEvidence &&
            options.protectedGoalEvidence.record.goalId === goal.goalId &&
            options.protectedGoalEvidence.record.changeId === change.changeId
              ? { protectedGoalEvidence: protectedGoalEvidenceSnapshot(options.protectedGoalEvidence) }
              : {}),
          }
        : {}),
    };
  });
  const capturedAt = targetObservation.observedAt;
  const records = requests.map((request) =>
    createCompletionContextSnapshotRecord({
      collaborationDomainId,
      request,
      capturedAt,
      toolVersion: cliVersion,
    }),
  );
  return {
    projectRoot,
    collaborationDomainId,
    targetObservation,
    evaluator,
    ...(config.architecture ? { architecture: JSON.parse(stableJson(config.architecture)) as ArchitectureConfig } : {}),
    authority: {
      predecessor: observation.repositoryContent.base
        ? { kind: 'git-tree', treeOid: observation.repositoryContent.base.treeOid }
        : { kind: 'unavailable', reason: 'no-fixed-predecessor' },
      changedPaths: observation.repositoryContent.files.map((entry) => entry.path),
      ...(options.protectedWorkAuthorization ? { protectedWorkAuthorization: options.protectedWorkAuthorization } : {}),
      ...(options.protectedGoalEvidence ? { protectedGoalEvidence: options.protectedGoalEvidence } : {}),
    },
    requests,
    records,
    planContracts: plans.currentRecords.filter((plan) =>
      changes.records.some((change) => change.changeId === plan.changeId),
    ),
    ...(options.protectedWorkAuthorization ? { protectedWorkAuthorization: options.protectedWorkAuthorization } : {}),
    ...(options.protectedGoalEvidence ? { protectedGoalEvidence: options.protectedGoalEvidence } : {}),
  };
}

/**
 * Re-observe every source whose identity the lease fixed. A moved repository
 * or evaluator build invalidates the result instead of being explained away
 * by a later receipt.
 */
export function assertFixedCompletionContext(
  lease: FixedCompletionContextLease,
  config: ProjectConfig,
  options: { observedAt?: Date; evaluatorEntrypoint?: string } = {},
): void {
  const currentTarget = captureFixedRepositoryObservationReceipt({
    projectRoot: lease.projectRoot,
    config,
    ...(options.observedAt ? { observedAt: options.observedAt } : {}),
    collaborationDomainId: lease.collaborationDomainId,
  });
  if (stableJson(currentTarget.facts.wholeContent) !== stableJson(lease.targetObservation.facts.wholeContent)) {
    throw new CompletionEvaluationContextMovedError(
      'Repository content changed while completion was being evaluated. The judgment was discarded; retry against the new fixed target.',
    );
  }
  const currentEvaluator = completionEvaluatorSnapshot(options.evaluatorEntrypoint);
  if (currentEvaluator.buildIdentity !== lease.evaluator.buildIdentity) {
    throw new CompletionEvaluationContextMovedError(
      'The completion evaluator build changed while completion was being evaluated. The judgment was discarded; retry with one fixed evaluator.',
    );
  }
  if (lease.protectedWorkAuthorization) {
    try {
      assertFixedProtectedWorkAuthorization(lease.protectedWorkAuthorization);
    } catch (error) {
      throw new CompletionEvaluationContextMovedError(
        error instanceof Error ? error.message : 'Protected work authorization moved during completion evaluation.',
      );
    }
  }
  if (lease.protectedGoalEvidence) {
    try {
      assertFixedProtectedGoalEvidence(lease.protectedGoalEvidence);
    } catch (error) {
      throw new CompletionEvaluationContextMovedError(
        error instanceof Error ? error.message : 'Protected goal evidence moved during completion evaluation.',
      );
    }
  }
}

/**
 * Publish context and controller records only after the bracketed evaluation
 * has survived its final source check. Every publication is content-addressed
 * or idempotency-addressed, so retry adds no duplicate ceremony.
 */
export function publishStopCompletionEvaluations(
  lease: FixedCompletionContextLease,
  result: DiffGateResult,
  options: WorkStateCreateOptions,
) {
  return lease.requests.map((request, index) => {
    const contextRecord = lease.records[index];
    if (!contextRecord) throw new Error('completion context request/record cardinality mismatch');
    const context = createCompletionContextSnapshotFile(lease.projectRoot, lease.collaborationDomainId, request, {
      ...options,
      now: () => contextRecord.capturedAt,
    });
    const decisions = [
      ...evaluateArchitectureCompleteness({
        changeId: request.change.changeId,
        architecture: lease.architecture,
        diffGate: result,
        receipt: context.record.targetObservation,
      }),
      ...evaluateResidueCompleteness({
        changeId: request.change.changeId,
        diffGate: result,
        receipt: context.record.targetObservation,
      }).decisions,
    ];
    const admissions = decisions.map((decision) =>
      recordCompletenessAdmissionDecision(lease.projectRoot, lease.collaborationDomainId, decision, options),
    );
    const reconciliations = reconcileCompletenessObligations({
      projectRoot: lease.projectRoot,
      collaborationDomainId: lease.collaborationDomainId,
      changeId: request.change.changeId,
      diffGate: result,
      receipt: context.record.targetObservation,
      planContracts: lease.planContracts.filter((plan) => plan.changeId === request.change.changeId),
      options,
    });
    const evaluationRequest = stopCompletionEvaluationRequest(
      lease.projectRoot,
      context.record,
      result,
      lease.authority,
    );
    const evaluation = createCompletionEvaluationFiles(
      lease.projectRoot,
      lease.collaborationDomainId,
      evaluationRequest,
      options,
    );
    return { context, admissions, reconciliations, evaluation };
  });
}

export function stopCompletionEvaluationRequest(
  projectRoot: string,
  context: CompletionContextSnapshotRecordV1,
  result: DiffGateResult,
  authorityInputs: CompletionAuthorityInputs = {
    predecessor: context.targetObservation.diagnostics?.treeOid
      ? { kind: 'git-tree', treeOid: context.targetObservation.diagnostics.treeOid }
      : { kind: 'unavailable', reason: 'no-fixed-predecessor' },
    changedPaths: result.changedFiles,
  },
): CompletionEvaluationRequest {
  const target = context.targetObservation;
  const blocking = blockingFindings(result.findings);
  const hasFindings = blocking.length > 0;
  const coverageUnknown = diffGateCoverageUnknown(result);
  const protectedEvidence = protectedGoalEvidenceForContext(context, authorityInputs);
  const workHistory = readWorkHistory(projectRoot, context.changeId);
  const workEvidenceCompatible =
    workHistory.integrityIssues.length === 0 && workHistory.summary.unresolvedUnknownAttemptIds.length === 0;
  const obligations = readObligationLifecycle(projectRoot, context.changeId);
  const obligationsReconciled =
    obligations.integrityIssues.length === 0 &&
    obligations.summary.liveObligationIds.length === 0 &&
    obligations.summary.conflictedObligationIds.length === 0 &&
    obligations.summary.orphanTransitionIds.length === 0;
  const rawPredicates: CompletionPredicateJudgment[] = [
    judgment(
      'goal-fulfilled',
      protectedEvidence?.record.judgments.goalFulfilled ?? 'unknown',
      protectedEvidence
        ? `Protected evaluator evidence ${protectedEvidence.record.evidenceId} judged the exact authorized goal against this repository content.`
        : 'The diff gate does not evaluate the goal’s protected acceptance scenarios, and no matching protected evaluator evidence was configured.',
      target,
    ),
    judgment(
      'invariants-preserved',
      hasFindings ? 'disproven' : (protectedEvidence?.record.judgments.invariantsPreserved ?? 'unknown'),
      hasFindings
        ? `${blocking.length} blocking diff-gate finding(s) contradict the current invariant policy.`
        : protectedEvidence
          ? `Protected evaluator evidence ${protectedEvidence.record.evidenceId} judged the fixed invariants against this repository content.`
          : 'No blocking diff-gate finding was observed, but goal-specific invariant coverage is not yet established.',
      target,
    ),
    judgment(
      'evidence-compatible',
      workEvidenceCompatible ? 'established' : 'unknown',
      workEvidenceCompatible
        ? 'The target is a fixed whole-repository observation and the durable work ledger has no unresolved effect.'
        : `The durable work ledger has ${workHistory.summary.unresolvedUnknownAttemptIds.length} unresolved effect(s) and ${workHistory.integrityIssues.length} integrity issue(s).`,
      target,
    ),
    judgment(
      'coverage-complete',
      coverageUnknown ? 'unknown' : (protectedEvidence?.record.judgments.affectedSurfaceReconciled ?? 'established'),
      coverageUnknown
        ? 'One or more configured diff-gate checks did not complete with decision-authoritative coverage.'
        : protectedEvidence
          ? `Every registered stop check completed, and protected evaluator evidence ${protectedEvidence.record.evidenceId} judged the affected surface against this repository content.`
          : 'Every registered stop diff-gate check completed without an unresolved coverage condition.',
      target,
    ),
    judgment(
      'obligations-reconciled',
      obligationsReconciled ? 'established' : 'unknown',
      obligationsReconciled
        ? 'The durable obligation lifecycle has no live, conflicted, orphaned, or unreadable obligation.'
        : 'The durable obligation lifecycle has a live, conflicted, orphaned, or unreadable obligation.',
      target,
    ),
    judgment(
      'policy-permitted',
      'established',
      `Repository policy ${context.policy.policyId}@${context.policy.policyVersion} authorizes autonomous stop evaluation in ${context.policy.stopMode} mode.`,
      target,
    ),
  ];
  const transitionRule = selectCompletionTransitionRule(
    projectRoot,
    {
      goalId: context.goalId,
      predicates: rawPredicates,
    },
    authorityInputs.predecessor,
    authorityInputs.changedPaths,
  );
  const predicatesBeforeAuthority =
    transitionRule.state === 'conflicted'
      ? rawPredicates.map((judgment) =>
          judgment.predicate === 'policy-permitted'
            ? {
                ...judgment,
                state: 'disproven' as const,
                reasons: [
                  ...judgment.reasons,
                  ...transitionRule.reasons.map((reason) => `Successor transition conflict: ${reason}`),
                ],
              }
            : judgment,
        )
      : rawPredicates;
  const authority = createCompletionAuthorityAssessment({
    predecessor: authorityInputs.predecessor,
    changedPaths: authorityInputs.changedPaths,
    protectedArtifacts: context.protectedArtifacts,
    reliances: completionAuthorityReliances(result, transitionRule.state === 'selected'),
    fixedReferents: {
      evaluator: protectedEvidence
        ? `protected-goal-evidence:${protectedEvidence.record.evidenceId}@${protectedEvidence.recordSha256}`
        : `evaluator-build:${context.evaluator.buildIdentity}`,
    },
    authorizedReferents: {
      ...(transitionRule.state === 'selected' ? transitionRuleAuthorizedReferents(transitionRule.rule) : {}),
      ...repositoryPolicyAuthorizedReferents(projectRoot, authorityInputs),
      ...protectedWorkAuthorizationReferents(projectRoot, context, authorityInputs),
    },
  });
  const predicates = applyCompletionAuthorityFirewall(predicatesBeforeAuthority, authority);
  return {
    changeId: context.changeId,
    goalId: context.goalId,
    idempotencyKey: `stop:${context.contextSnapshotId}`,
    context: {
      policyId: context.contextSnapshotId,
      policyVersion: context.policy.policyVersion,
      evaluatorId: context.evaluator.evaluatorId,
      evaluatorVersion: context.evaluator.buildIdentity,
      targetObservation: target,
    },
    predicates,
    authority,
    ...(transitionRule.state === 'selected'
      ? {
          authorizedSuccessor: {
            transitionRuleId: transitionRule.rule.transitionRuleId,
            successorGoalId: transitionRule.rule.successorGoal.goalId,
          },
        }
      : {}),
  };
}

/**
 * Repository-policy authority is permission derived from a fixed predecessor
 * and a hard-coded rule whose accepted successor edits can only strengthen a
 * protected policy. It does not accept a candidate's claim about its own edit.
 */
export function repositoryPolicyAuthorizedReferents(
  projectRoot: string,
  authorityInputs: CompletionAuthorityInputs,
): Partial<Record<ProtectedArtifactClass, string>> {
  if (authorityInputs.predecessor.kind !== 'git-tree') return {};
  const configurationPath = '.scipquery.json';
  if (!authorityInputs.changedPaths.includes(configurationPath)) return {};
  const predecessor = readGitTreeConfiguration(projectRoot, authorityInputs.predecessor.treeOid);
  if (predecessor === undefined) return {};
  let successor: string;
  try {
    successor = readProjectFileText(projectRoot, configurationPath, {
      inputKind: 'scip-query project configuration',
    });
  } catch {
    return {};
  }
  if (!isMonotonicArchitecturePolicyTightening(predecessor, successor)) return {};
  const successorDigest = createHash('sha256').update(successor).digest('hex');
  return {
    configuration: `repository-policy:monotonic-architecture-tightening:${authorityInputs.predecessor.treeOid}@${successorDigest}`,
  };
}

function readGitTreeConfiguration(projectRoot: string, treeOid: string): string | undefined {
  if (!/^[0-9a-f]{40,64}$/u.test(treeOid)) return undefined;
  try {
    return execFileSync('git', ['-C', projectRoot, 'cat-file', 'blob', `${treeOid}:.scipquery.json`], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: SOURCE_ARTIFACT_MAX_BYTES,
    });
  } catch {
    return undefined;
  }
}

export function protectedWorkAuthorizationReferents(
  projectRoot: string,
  context: CompletionContextSnapshotRecordV1,
  authorityInputs: CompletionAuthorityInputs,
): Partial<Record<ProtectedArtifactClass, string>> {
  const fixed = authorityInputs.protectedWorkAuthorization;
  const snapshot = context.protectedWorkAuthorization;
  if (!fixed || !snapshot || !fixedAuthorizationMatchesContext(fixed, snapshot, context)) return {};
  const referentPrefix = `protected-work-authorization:${fixed.record.authorizationId}`;
  const referents: Partial<Record<ProtectedArtifactClass, string>> = {};
  const goalRule = context.protectedArtifacts.rules.find((rule) => rule.class === 'goal');
  const changedGoalPaths = goalRule
    ? [
        ...new Set(
          authorityInputs.changedPaths.filter((path) =>
            goalRule.selectors.some((selector) => matchesPathGlob(selector, path)),
          ),
        ),
      ]
    : [];
  const authorizedGoalPath = join(GOALS_DIR, `${fixed.record.goal.goalId}.json`).replaceAll('\\', '/');
  if (changedGoalPaths.length === 1 && changedGoalPaths[0] === authorizedGoalPath) {
    referents.goal = `${referentPrefix}#goal`;
  }
  for (const rule of context.protectedArtifacts.rules) {
    if (rule.class === 'goal' || rule.class === 'transition-rule') continue;
    const changed = authorityInputs.changedPaths.filter((path) =>
      rule.selectors.some((selector) => matchesPathGlob(selector, path)),
    );
    if (changed.length === 0) continue;
    const everyTransitionMatches = changed.every((path) => {
      const transitions = fixed.record.artifactTransitions.filter(
        (transition) => transition.class === rule.class && transition.path === path,
      );
      return (
        transitions.length === 1 &&
        protectedArtifactTransitionMatches(projectRoot, authorityInputs.predecessor, transitions[0]!)
      );
    });
    if (everyTransitionMatches) referents[rule.class] = `${referentPrefix}#${rule.class}`;
  }
  return referents;
}

function protectedWorkAuthorizationSnapshot(
  lease: FixedProtectedWorkAuthorizationLease,
): ProtectedWorkAuthorizationSnapshot {
  return {
    authorizationId: lease.record.authorizationId,
    recordSha256: lease.recordSha256,
    goalRecordDigest: hashRecord(lease.record.goal),
    changeRecordDigest: hashRecord(lease.record.change),
  };
}

function protectedGoalEvidenceSnapshot(lease: FixedProtectedGoalEvidenceLease): ProtectedGoalEvidenceSnapshot {
  return {
    evidenceId: lease.record.evidenceId,
    recordSha256: lease.recordSha256,
    authorizationId: lease.record.authorizationId,
    evaluatorArtifactSha256: lease.record.evaluator.artifactSha256,
  };
}

function protectedGoalEvidenceForContext(
  context: CompletionContextSnapshotRecordV1,
  authorityInputs: CompletionAuthorityInputs,
): FixedProtectedGoalEvidenceLease | undefined {
  const fixed = authorityInputs.protectedGoalEvidence;
  const snapshot = context.protectedGoalEvidence;
  if (
    !fixed ||
    !snapshot ||
    snapshot.evidenceId !== fixed.record.evidenceId ||
    snapshot.recordSha256 !== fixed.recordSha256 ||
    snapshot.authorizationId !== fixed.record.authorizationId ||
    snapshot.evaluatorArtifactSha256 !== fixed.record.evaluator.artifactSha256 ||
    context.goalId !== fixed.record.goalId ||
    context.goalRecordDigest !== fixed.record.goalRecordDigest ||
    context.changeId !== fixed.record.changeId ||
    context.changeRecordDigest !== fixed.record.changeRecordDigest ||
    stableJson(context.targetObservation.facts.collaborationDomain) !==
      stableJson(fixed.record.targetObservation.facts.collaborationDomain) ||
    stableJson(context.targetObservation.facts.wholeContent) !==
      stableJson(fixed.record.targetObservation.facts.wholeContent)
  ) {
    return undefined;
  }
  return fixed;
}

function fixedAuthorizationMatchesContext(
  fixed: FixedProtectedWorkAuthorizationLease,
  snapshot: ProtectedWorkAuthorizationSnapshot,
  context: CompletionContextSnapshotRecordV1,
): boolean {
  return (
    snapshot.authorizationId === fixed.record.authorizationId &&
    snapshot.recordSha256 === fixed.recordSha256 &&
    snapshot.goalRecordDigest === hashRecord(fixed.record.goal) &&
    snapshot.changeRecordDigest === hashRecord(fixed.record.change) &&
    context.goalId === fixed.record.goal.goalId &&
    context.changeId === fixed.record.change.changeId &&
    context.goalRecordDigest === snapshot.goalRecordDigest &&
    context.changeRecordDigest === snapshot.changeRecordDigest
  );
}

function hashRecord(record: unknown): string {
  return hashIdentity(stableJson(record));
}

function completionAuthorityReliances(
  result: DiffGateResult,
  selectedTransitionRule: boolean,
): CompletionAuthorityReliance[] {
  return [
    {
      class: 'goal',
      predicates: ['goal-fulfilled'],
      reason:
        'The candidate changed the goal that defines fulfillment, so that changed goal cannot be the sole authority for its own acceptance.',
    },
    {
      class: 'evaluator',
      predicates: COMPLETION_PREDICATES,
      reason:
        'The candidate changed the evaluator that produces completion judgments, so those candidate-produced judgments require a fixed predecessor evaluator.',
    },
    {
      class: 'configuration',
      predicates: ['coverage-complete', 'policy-permitted'],
      reason:
        'The candidate changed configuration that selects completion checks or policy, so that changed configuration cannot authorize its own weakened evaluation.',
    },
    ...(selectedTransitionRule
      ? [
          {
            class: 'transition-rule' as const,
            predicates: COMPLETION_PREDICATES,
            reason:
              'The candidate changed the transition rule selected to authorize its successor, so that candidate-controlled rule cannot authorize itself.',
          },
        ]
      : []),
    ...(result.suppressed.length > 0
      ? [
          {
            class: 'suppression' as const,
            predicates: ['invariants-preserved', 'policy-permitted'] as const,
            reason:
              'The gate relied on a suppression changed by this candidate, so that suppression requires predecessor authorization or independent counterevidence.',
          },
        ]
      : []),
    ...(result.checksRun.includes('baseline')
      ? [
          {
            class: 'baseline' as const,
            predicates: ['invariants-preserved'] as const,
            reason:
              'The evaluation relied on a baseline changed by this candidate, so that baseline cannot be the sole authority for accepting its own movement.',
          },
        ]
      : []),
  ];
}

function completionProtectedArtifactRules(
  projectRoot: string,
  evaluatorEntrypoint = process.argv[1],
): readonly ProtectedArtifactRule[] {
  const evaluatorSelectors = completionEvaluatorProtectedSelectors(projectRoot, evaluatorEntrypoint);
  return PROTECTED_ARTIFACT_RULES.map((rule) =>
    rule.class === 'evaluator' ? { ...rule, selectors: evaluatorSelectors } : rule,
  );
}

function completionEvaluatorProtectedSelectors(projectRoot: string, evaluatorEntrypoint: string | undefined): string[] {
  if (!evaluatorEntrypoint) return ['.scipquery/evaluator/**'];
  let canonicalRoot: string;
  let canonicalEntrypoint: string;
  try {
    canonicalRoot = realpathSync(projectRoot);
    canonicalEntrypoint = realpathSync(resolve(evaluatorEntrypoint));
  } catch {
    return ['.scipquery/evaluator/**'];
  }
  if (!isPathInsideProject(canonicalRoot, canonicalEntrypoint)) {
    return ['.scipquery/evaluator/**'];
  }
  const relativeEntrypoint = relative(canonicalRoot, canonicalEntrypoint).replaceAll('\\', '/');
  if (relativeEntrypoint.startsWith('dist/')) {
    return ['src/**', 'package.json', 'package-lock.json', 'tsup.config.ts', relativeEntrypoint].sort();
  }
  return [relativeEntrypoint];
}

function completionEvaluatorSnapshot(entrypoint = process.argv[1]): CompletionEvaluatorSnapshot {
  const resolvedEntrypoint = entrypoint ? resolve(entrypoint) : undefined;
  let entrypointDigest = 'unavailable';
  if (resolvedEntrypoint) {
    try {
      entrypointDigest = sha256FileWithinLimit(realpathSync(resolvedEntrypoint), {
        maxBytes: SOURCE_ARTIFACT_MAX_BYTES,
        inputKind: 'completion evaluator entrypoint',
      });
    } catch {
      // Version and contract still provide an honest weaker build identity.
    }
  }
  return {
    evaluatorId: STOP_COMPLETION_EVALUATOR_ID,
    evaluatorVersion: cliVersion,
    buildIdentity: createHash('sha256')
      .update(
        stableJson({
          kind: 'scip-query-completion-evaluator-build',
          contractVersion: STOP_COMPLETION_EVALUATOR_CONTRACT_VERSION,
          cliVersion,
          entrypointDigest,
        }),
      )
      .digest('hex'),
  };
}

function judgment(
  predicate: CompletionPredicateJudgment['predicate'],
  state: CompletionPredicateJudgment['state'],
  reason: string,
  target: ObservationReceiptV2,
): CompletionPredicateJudgment {
  return { predicate, state, reasons: [reason], evidenceReceipts: [target] };
}

function diffGateCoverageUnknown(result: DiffGateResult): boolean {
  return (
    result.skipped.length > 0 ||
    result.evidenceTiers.some((tier) => tier.state === 'failed') ||
    (result.recordCompatibility !== undefined && !result.recordCompatibility.suppressions.complete)
  );
}
