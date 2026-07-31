import type { CompletenessFindingCandidate } from '../domain/completeness-obligation-admission.js';
import type { DiffGateFinding } from '../queries/impact/diff-gate.js';

/**
 * Project one diff-gate fact into the canonical finding shape consumed by
 * completeness admission policies.
 */
export function completenessFindingCandidate(finding: DiffGateFinding): CompletenessFindingCandidate {
  return {
    findingId: finding.id,
    check: finding.check,
    evidence: finding.evidence,
    actionTier: finding.actionTier ?? 'signal',
    confidence: finding.confidence ?? 0,
    advisory: finding.advisory === true,
    ...(finding.file ? { file: finding.file } : {}),
    relatedFiles: [...new Set(finding.relatedFiles ?? [])].sort(),
    message: finding.message,
    remediation: finding.remediation,
  };
}
