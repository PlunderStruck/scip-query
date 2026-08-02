import type { ObservationReceiptV2 } from '../domain/observation-receipt.js';
import type { PlanContractRecordV1 } from '../change-control/plan-contract.js';
import { hashIdentity } from '../domain/autonomous-work-state.js';
import { diffGateFailedClosed, type DiffGateCheck, type DiffGateResult } from '../queries/impact/diff-gate.js';
import { createObligationTransitionFile, readObligationLifecycle } from '../storage/autonomous-work-obligations.js';
import type { WorkStateCreateOptions } from '../storage/autonomous-work-state.js';

const RECONCILABLE_COMPLETENESS_CHECKS = new Set<DiffGateCheck>([
  'architecture',
  'echo',
  'incomplete-migration',
  'new-dead',
]);

/**
 * Close a detector-backed obligation only when a later fixed gate run has
 * complete coverage for the same check and no longer contains its factual
 * identity. Suppressed findings remain present facts and therefore stay live.
 */
export function reconcileCompletenessObligations(input: {
  projectRoot: string;
  collaborationDomainId: string;
  changeId: string;
  diffGate: DiffGateResult;
  receipt: ObservationReceiptV2;
  options: WorkStateCreateOptions;
  planContracts?: readonly PlanContractRecordV1[];
}) {
  if (diffGateFailedClosed(input.diffGate) || input.diffGate.recordCompatibility?.suppressions.complete !== true) {
    return [];
  }
  const lifecycle = readObligationLifecycle(input.projectRoot, input.changeId);
  if (lifecycle.integrityIssues.length > 0) {
    throw new Error(`completion obligations could not be reconciled: ${lifecycle.integrityIssues.join('; ')}`);
  }
  const completeChecks = new Set(
    input.diffGate.checksRun.filter((check) => !input.diffGate.skipped.some((skipped) => skipped.check === check)),
  );
  const currentFindingIds = new Set([
    ...input.diffGate.findings.map((finding) => finding.id),
    ...input.diffGate.suppressed.map(({ finding }) => finding.id),
    ...(input.diffGate.policyEscalations ?? []).map((escalation) => escalation.findingId),
  ]);
  const detectorReconciliations = lifecycle.summary.obligations
    .filter((state) => state.state === 'live')
    .flatMap((state) => {
      const source = state.obligation.source;
      if (
        source.kind !== 'detector-finding' ||
        !RECONCILABLE_COMPLETENESS_CHECKS.has(source.check as DiffGateCheck) ||
        !completeChecks.has(source.check as DiffGateCheck) ||
        currentFindingIds.has(source.findingId)
      ) {
        return [];
      }
      return [
        createObligationTransitionFile(
          input.projectRoot,
          input.collaborationDomainId,
          {
            changeId: input.changeId,
            obligationId: state.obligation.obligationId,
            idempotencyKey: `completion-reconcile-${hashIdentity({
              obligationId: state.obligation.obligationId,
              target: input.receipt.facts.wholeContent,
            }).slice(0, 48)}`,
            to: 'invalidated',
            reason: 'premise-disproven',
            basisAttemptIds: [],
            evidenceReceipts: [input.receipt],
            rationale: `${source.check} completed against the fixed target without finding ${source.findingId}; the admitted detector premise is no longer current.`,
          },
          input.options,
        ),
      ];
    });
  const plansById = new Map((input.planContracts ?? []).map((plan) => [plan.planId, plan]));
  const planReconciliations = lifecycle.summary.obligations
    .filter((state) => state.state === 'live' && state.obligation.source.kind === 'agent-discovery')
    .flatMap((state) => {
      const source = state.obligation.source;
      if (source.kind !== 'agent-discovery') return [];
      const parsed = parsePlanObligationReferent(source.referent);
      if (!parsed) return [];
      const plan = plansById.get(parsed.planId);
      if (!plan || plan.changeId !== input.changeId) return [];
      if (parsed.kind === 'architecture') {
        if (!completeChecks.has('architecture') || hasCurrentCheckFinding(input.diffGate, 'architecture')) return [];
      } else if (parsed.kind === 'retire') {
        if (!completeChecks.has('new-dead')) return [];
        const rootCauseKey = `plan-retirement:${parsed.planId}:${parsed.itemId}`;
        if (hasCurrentRootCause(input.diffGate, rootCauseKey)) return [];
      } else {
        if (!completeChecks.has('new-dead')) return [];
        const rootCauseKey = `plan-reuse:${parsed.planId}:${parsed.itemId}`;
        if (hasCurrentRootCause(input.diffGate, rootCauseKey)) return [];
      }
      return [
        createObligationTransitionFile(
          input.projectRoot,
          input.collaborationDomainId,
          {
            changeId: input.changeId,
            obligationId: state.obligation.obligationId,
            idempotencyKey: `plan-reconcile-${hashIdentity({
              obligationId: state.obligation.obligationId,
              target: input.receipt.facts.wholeContent,
            }).slice(0, 48)}`,
            to: 'fulfilled',
            reason: 'condition-established',
            basisAttemptIds: [],
            evidenceReceipts: [input.receipt],
            rationale:
              parsed.kind === 'architecture'
                ? 'The configured architecture check completed against the fixed target with no current architecture finding.'
                : parsed.kind === 'retire'
                  ? 'The plan retirement closure completed against the fixed target with no current contradiction for this item.'
                  : 'The compiler-resolved call graph establishes the selected reuse authority for every named consumer.',
          },
          input.options,
        ),
      ];
    });
  return [...detectorReconciliations, ...planReconciliations];
}

function parsePlanObligationReferent(
  referent: string,
): { planId: string; kind: 'architecture' | 'retire' | 'reuse'; itemId: string } | null {
  const match = /^(SQP-[A-F0-9]{32})#(architecture|retire|reuse):([a-z0-9][a-z0-9._-]*)$/u.exec(referent);
  return match ? { planId: match[1]!, kind: match[2] as 'architecture' | 'retire' | 'reuse', itemId: match[3]! } : null;
}

function hasCurrentCheckFinding(result: DiffGateResult, check: DiffGateCheck): boolean {
  return (
    result.findings.some((finding) => finding.check === check) ||
    result.suppressed.some(({ finding }) => finding.check === check) ||
    (result.policyEscalations ?? []).some((finding) => finding.check === check)
  );
}

function hasCurrentRootCause(result: DiffGateResult, rootCauseKey: string): boolean {
  return (
    result.findings.some((finding) => finding.rootCauseKey === rootCauseKey) ||
    result.suppressed.some(({ finding }) => finding.rootCauseKey === rootCauseKey) ||
    (result.policyEscalations ?? []).some((finding) => finding.findingId.includes(rootCauseKey))
  );
}
