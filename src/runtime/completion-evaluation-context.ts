import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  COMPLETION_PREDICATES,
  type CompletionEvaluationRequest,
  type CompletionPredicateJudgment,
} from '../domain/autonomous-completion.js';
import {
  completionCommandRegistry,
  completionProtectedArtifactSet,
  createCompletionContextSnapshotRecord,
  type CompletionContextSnapshotRecordV1,
  type CompletionContextSnapshotRequest,
  type CompletionEvaluatorSnapshot,
  type CompletionPolicySnapshot,
  type ProtectedArtifactRule,
} from '../domain/autonomous-completion-context.js';
import type { ObservationReceiptV2 } from '../domain/observation-receipt.js';
import { stableJson } from '../domain/stable-json.js';
import type { ProjectConfig } from '../domain/types.js';
import { sha256FileWithinLimit, SOURCE_ARTIFACT_MAX_BYTES } from '../filesystem/bounded-file.js';
import { DIFF_GATE_CHECKS, type DiffGateResult } from '../queries/impact/diff-gate.js';
import { readObligationLifecycle } from '../storage/autonomous-work-obligations.js';
import { createCompletionContextSnapshotFile } from '../storage/autonomous-completion-context.js';
import { createCompletionEvaluationFiles } from '../storage/autonomous-completion.js';
import {
  readGoalRecords,
  readIntendedChangeRecords,
  type WorkStateCreateOptions,
} from '../storage/autonomous-work-state.js';
import { captureFixedRepositoryObservationReceipt } from './observation-receipt.js';
import { cliVersion } from './cli-support.js';

export const STOP_COMPLETION_POLICY_ID = 'scip-query:stop-completion-policy' as const;
export const STOP_COMPLETION_POLICY_VERSION = 1 as const;
export const STOP_COMPLETION_EVALUATOR_ID = 'scip-query:stop-completion-controller' as const;
export const STOP_COMPLETION_EVALUATOR_CONTRACT_VERSION = 1 as const;

const PROTECTED_ARTIFACT_RULES: readonly ProtectedArtifactRule[] = [
  {
    class: 'goal',
    selectors: ['.scipquery/goals/*.json'],
    authority: 'fixed-predecessor',
  },
  {
    class: 'transition-rule',
    selectors: ['.scipquery/transition-rules/*.json'],
    authority: 'fixed-predecessor',
  },
  {
    class: 'evaluator',
    selectors: [
      'src/domain/autonomous-completion*.ts',
      'src/runtime/agent-hooks.ts',
      'src/runtime/completion-evaluation-context.ts',
      'src/runtime/diff-gate-execution.ts',
      'src/storage/autonomous-completion*.ts',
    ],
    authority: 'bootstrap-trust-root',
  },
  {
    class: 'test',
    selectors: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
    authority: 'fixed-predecessor',
  },
  {
    class: 'baseline',
    selectors: ['.scipquery-baseline.json'],
    authority: 'fixed-predecessor',
  },
  {
    class: 'suppression',
    selectors: ['.scipquery/suppressions/*.json'],
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
  requests: readonly CompletionContextSnapshotRequest[];
  records: readonly CompletionContextSnapshotRecordV1[];
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
  options: { observedAt?: Date; evaluatorEntrypoint?: string } = {},
): FixedCompletionContextLease {
  const collaborationDomainId = config.collaborationDomainId;
  if (!collaborationDomainId) {
    throw new Error('completion evaluation requires a configured collaboration domain');
  }
  const targetObservation = captureFixedRepositoryObservationReceipt({
    projectRoot,
    config,
    ...(options.observedAt ? { observedAt: options.observedAt } : {}),
    collaborationDomainId,
  });
  const goals = readGoalRecords(projectRoot);
  const changes = readIntendedChangeRecords(projectRoot, goals);
  const recordIssues = [
    ...goals.compatibility.issues.map((issue) => `goal ${issue.path}: ${issue.reason}`),
    ...changes.compatibility.issues.map((issue) => `intended change ${issue.path}: ${issue.reason}`),
    ...changes.integrityIssues,
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
  const protectedArtifacts = completionProtectedArtifactSet(PROTECTED_ARTIFACT_RULES);
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
    requests,
    records,
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
    const evaluationRequest = stopCompletionEvaluationRequest(lease.projectRoot, context.record, result);
    const evaluation = createCompletionEvaluationFiles(
      lease.projectRoot,
      lease.collaborationDomainId,
      evaluationRequest,
      options,
    );
    return { context, evaluation };
  });
}

export function stopCompletionEvaluationRequest(
  projectRoot: string,
  context: CompletionContextSnapshotRecordV1,
  result: DiffGateResult,
): CompletionEvaluationRequest {
  const target = context.targetObservation;
  const hasFindings = result.findings.length > 0;
  const coverageUnknown = diffGateCoverageUnknown(result);
  const obligations = readObligationLifecycle(projectRoot, context.changeId);
  const obligationsReconciled =
    obligations.integrityIssues.length === 0 &&
    obligations.summary.liveObligationIds.length === 0 &&
    obligations.summary.conflictedObligationIds.length === 0 &&
    obligations.summary.orphanTransitionIds.length === 0;
  const predicates: CompletionPredicateJudgment[] = [
    judgment(
      'goal-fulfilled',
      'unknown',
      'The diff gate does not yet evaluate the goal’s protected acceptance scenarios.',
      target,
    ),
    judgment(
      'invariants-preserved',
      hasFindings ? 'disproven' : 'unknown',
      hasFindings
        ? `${result.findings.length} diff-gate finding(s) contradict the current invariant policy.`
        : 'No diff-gate finding was observed, but goal-specific invariant coverage is not yet established.',
      target,
    ),
    judgment(
      'evidence-compatible',
      'established',
      'The target is a fixed whole-repository observation in the change collaboration domain.',
      target,
    ),
    judgment(
      'coverage-complete',
      coverageUnknown ? 'unknown' : 'established',
      coverageUnknown
        ? 'One or more configured diff-gate checks did not complete with decision-authoritative coverage.'
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
  };
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
