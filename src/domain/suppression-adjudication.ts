import {
  SUPPRESSION_REASON_CODES,
  type FindingSuppression,
  type SuppressionCounterevidence,
  type SuppressionDecision,
} from './config-types.js';
import { isObservationReceipt } from './observation-receipt.js';

export interface SuppressionAdjudicationFinding {
  id: string;
  check: string;
  evidence: string;
  actionTier?: string;
  file?: string;
}

export interface SuppressionAdjudicationRuntime {
  now: number;
  contentHash(path: string): string | undefined;
}

export type SuppressionAdjudicationResult =
  | { kind: 'accepted' }
  | { kind: 'expired' | 'invalidated' | 'escalated'; reasons: string[] };

export const AUTOMATIC_SUPPRESSION_BURST_LIMIT = 100;
export const AUTOMATIC_SUPPRESSION_RATIO_MINIMUM_FINDINGS = 25;
export const AUTOMATIC_SUPPRESSION_RATIO_LIMIT = 0.9;

export function automaticSuppressionRateIsAnomalous(accepted: number, total: number): boolean {
  return (
    accepted > AUTOMATIC_SUPPRESSION_BURST_LIMIT ||
    (total >= AUTOMATIC_SUPPRESSION_RATIO_MINIMUM_FINDINGS && accepted / total > AUTOMATIC_SUPPRESSION_RATIO_LIMIT)
  );
}

export function isSuppressionDecision(value: unknown): value is SuppressionDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const decision = value as Partial<SuppressionDecision>;
  return (
    decision.kind === 'automated-adjudication' &&
    decision.policyVersion === 1 &&
    (decision.decidedBy === 'agent' || decision.decidedBy === 'human') &&
    SUPPRESSION_REASON_CODES.includes(decision.reasonCode as (typeof SUPPRESSION_REASON_CODES)[number]) &&
    Array.isArray(decision.evidence) &&
    decision.evidence.length > 0 &&
    decision.evidence.every(isSuppressionCounterevidence) &&
    (decision.observation === undefined || isObservationReceipt(decision.observation)) &&
    Boolean(decision.invalidateOn) &&
    typeof decision.invalidateOn === 'object' &&
    typeof decision.invalidateOn.targetContentChange === 'boolean' &&
    typeof decision.invalidateOn.detectorMajorChange === 'boolean'
  );
}

/**
 * Decide whether one model-authored record can immediately waive one finding.
 * The caller supplies current content hashes; this pure policy never reads the
 * repository or trusts free-form prose as authority.
 */
export function evaluateSuppressionAdjudication(
  suppression: FindingSuppression,
  finding: SuppressionAdjudicationFinding,
  runtime: SuppressionAdjudicationRuntime,
): SuppressionAdjudicationResult {
  if (suppression.expiresAt && Date.parse(suppression.expiresAt) <= runtime.now) {
    return { kind: 'expired', reasons: ['suppression-expired'] };
  }

  const reasons: string[] = [];
  if (suppression.id !== finding.id) reasons.push('exact-finding-id-required');
  const decision = suppression.decision;
  if (!decision) return { kind: 'escalated', reasons: [...reasons, 'legacy-unadjudicated'] };
  if (decision.kind !== 'automated-adjudication') reasons.push('unsupported-decision-kind');
  if (decision.policyVersion !== 1) reasons.push('unsupported-policy-version');
  if (!SUPPRESSION_REASON_CODES.includes(decision.reasonCode)) reasons.push('unsupported-reason-code');
  if (decision.evidence.length === 0) reasons.push('counterevidence-required');
  if (!decision.invalidateOn.detectorMajorChange) reasons.push('detector-change-invalidation-required');

  const contentEvidence = decision.evidence.filter(hasContentReferent);
  if (decision.invalidateOn.targetContentChange && contentEvidence.length === 0) {
    reasons.push('content-invalidation-evidence-required');
  }
  const invalidated: string[] = [];
  for (const evidence of contentEvidence) {
    if (!evidence.contentHash) {
      reasons.push(`counterevidence-content-hash-required:${evidence.referent}`);
      continue;
    }
    const current = runtime.contentHash(evidence.referent);
    if (!current || current !== evidence.contentHash) {
      invalidated.push(`counterevidence-content-changed:${evidence.referent}`);
    }
  }
  if (invalidated.length > 0) return { kind: 'invalidated', reasons: invalidated };

  if (requiresDirectCounterevidence(finding) && !decision.evidence.some(isDirectCounterevidence)) {
    reasons.push('direct-counterevidence-required');
  }
  return reasons.length === 0 ? { kind: 'accepted' } : { kind: 'escalated', reasons: [...new Set(reasons)] };
}

function hasContentReferent(evidence: SuppressionCounterevidence): boolean {
  return evidence.kind === 'source' || evidence.kind === 'config' || evidence.kind === 'test';
}

function isDirectCounterevidence(evidence: SuppressionCounterevidence): boolean {
  return evidence.kind === 'source' || evidence.kind === 'config' || evidence.kind === 'graph';
}

function requiresDirectCounterevidence(finding: SuppressionAdjudicationFinding): boolean {
  return (
    finding.actionTier === 'direct' ||
    finding.evidence === 'graph-fact' ||
    finding.evidence === 'change-graph' ||
    finding.evidence === 'baseline'
  );
}

function isSuppressionCounterevidence(value: unknown): value is SuppressionCounterevidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = value as Partial<SuppressionCounterevidence>;
  return (
    (evidence.kind === 'source' ||
      evidence.kind === 'config' ||
      evidence.kind === 'test' ||
      evidence.kind === 'graph') &&
    typeof evidence.referent === 'string' &&
    evidence.referent.trim() !== '' &&
    typeof evidence.claim === 'string' &&
    evidence.claim.trim() !== '' &&
    (evidence.contentHash === undefined || /^[a-f0-9]{64}$/u.test(evidence.contentHash)) &&
    (evidence.generation === undefined || (typeof evidence.generation === 'string' && evidence.generation.length > 0))
  );
}
