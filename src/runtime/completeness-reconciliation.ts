import type { ObservationReceiptV2 } from '../domain/observation-receipt.js';
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
  return lifecycle.summary.obligations
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
}
