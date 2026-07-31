import { hashIdentity } from './autonomous-work-state.js';

export const RESIDUE_EVIDENCE_CONTRACT_VERSION = 1 as const;

export type ResidueReferenceKind = 'removed-call' | 'removed-reference';

export interface ResidueReferent {
  kind: 'callable';
  symbol: string;
  file: string;
  displayName: string;
}

export interface ResidueChangeEvidence {
  kind: ResidueReferenceKind;
  changedFile: string;
  baseOccurrences: number;
  currentOccurrences: number;
}

export type CurrentRoleProofKind =
  | 'production-consumers'
  | 'declared-external-root'
  | 'entry-surface'
  | 'framework-dispatch';

export interface CurrentRoleProof {
  kind: CurrentRoleProofKind;
  referent: ResidueReferent;
  evidencePaths: readonly string[];
  consumers?: readonly string[];
  policyReferents?: readonly string[];
  reasons: readonly string[];
}

export interface ResidueEvidenceCoverage {
  state: 'complete' | 'partial';
  scope: 'changed-source-reference-delta-to-current-production-callables';
  analyzedFiles: readonly string[];
  notApplicableFiles: readonly string[];
  omitted: ReadonlyArray<{ file: string; reason: string }>;
  unresolvedReferences: ReadonlyArray<{
    changedFile: string;
    leaf: string;
    reason: 'no-current-callable' | 'ambiguous-current-callable' | 'base-reference-not-attributed';
  }>;
}

export interface ResidueObservation {
  observationId: string;
  contractVersion: typeof RESIDUE_EVIDENCE_CONTRACT_VERSION;
  referent: ResidueReferent;
  changeEvidence: readonly ResidueChangeEvidence[];
  currentRoleProofs: readonly CurrentRoleProof[];
  coverage: ResidueEvidenceCoverage;
}

export type ResidueEvaluationDisposition = 'candidate' | 'current-role-proven' | 'insufficient-evidence';

export interface ResidueEvaluation {
  disposition: ResidueEvaluationDisposition;
  reasons: readonly string[];
  observation: ResidueObservation;
}

/**
 * Residue is a current repository artifact made suspect by evidence that the
 * present change removed its former route into behavior. A current-role proof
 * defeats that suspicion only when it names the same callable and a concrete
 * production consumer, declared external root, entry surface, or framework
 * dispatch referent. Mere survival, a test-only reference, or detector silence
 * does not establish a current role.
 */
export function evaluateResidueObservation(input: ResidueObservation): ResidueEvaluation {
  const observation = canonicalObservation(input);
  if (observation.changeEvidence.length === 0) {
    return {
      disposition: 'insufficient-evidence',
      reasons: ['No removed call or reference ties this referent to the current change.'],
      observation,
    };
  }
  const validProofs = observation.currentRoleProofs.filter((proof) =>
    currentRoleProofMatches(proof, observation.referent),
  );
  if (validProofs.length > 0) {
    return {
      disposition: 'current-role-proven',
      reasons: validProofs.flatMap((proof) => proof.reasons),
      observation,
    };
  }
  if (observation.coverage.state !== 'complete') {
    return {
      disposition: 'insufficient-evidence',
      reasons: [
        'The changed-source reference comparison did not complete.',
        ...observation.coverage.omitted.map((item) => `${item.file}: ${item.reason}`),
      ],
      observation,
    };
  }
  return {
    disposition: 'candidate',
    reasons: [
      'A call or reference disappeared in this change.',
      'No current production consumer, declared external root, entry surface, or framework dispatch role was established.',
    ],
    observation,
  };
}

export function residueObservationId(referent: ResidueReferent): string {
  return `SQR-${hashIdentity({
    contractVersion: RESIDUE_EVIDENCE_CONTRACT_VERSION,
    referent: canonicalReferent(referent),
  })
    .slice(0, 32)
    .toUpperCase()}`;
}

function currentRoleProofMatches(proof: CurrentRoleProof, referent: ResidueReferent): boolean {
  if (
    proof.referent.symbol !== referent.symbol ||
    proof.referent.file !== referent.file ||
    proof.evidencePaths.length === 0 ||
    proof.reasons.length === 0
  ) {
    return false;
  }
  if (proof.kind === 'production-consumers') {
    return proof.consumers?.some((consumer) => proof.evidencePaths.includes(consumer)) === true;
  }
  if (proof.kind === 'declared-external-root') {
    return (proof.policyReferents?.length ?? 0) > 0 && proof.evidencePaths.includes(referent.file);
  }
  return proof.evidencePaths.includes(referent.file);
}

function canonicalObservation(input: ResidueObservation): ResidueObservation {
  const referent = canonicalReferent(input.referent);
  return {
    observationId: residueObservationId(referent),
    contractVersion: RESIDUE_EVIDENCE_CONTRACT_VERSION,
    referent,
    changeEvidence: [...input.changeEvidence]
      .map((evidence) => ({ ...evidence }))
      .sort(
        (left, right) =>
          left.changedFile.localeCompare(right.changedFile) ||
          left.kind.localeCompare(right.kind) ||
          left.baseOccurrences - right.baseOccurrences,
      ),
    currentRoleProofs: [...input.currentRoleProofs]
      .map((proof) => ({
        ...proof,
        referent: canonicalReferent(proof.referent),
        evidencePaths: [...new Set(proof.evidencePaths)].sort(),
        ...(proof.consumers ? { consumers: [...new Set(proof.consumers)].sort() } : {}),
        ...(proof.policyReferents ? { policyReferents: [...new Set(proof.policyReferents)].sort() } : {}),
        reasons: [...new Set(proof.reasons)],
      }))
      .sort((left, right) => left.kind.localeCompare(right.kind)),
    coverage: {
      ...input.coverage,
      analyzedFiles: [...new Set(input.coverage.analyzedFiles)].sort(),
      notApplicableFiles: [...new Set(input.coverage.notApplicableFiles)].sort(),
      omitted: [...input.coverage.omitted].sort((left, right) => left.file.localeCompare(right.file)),
      unresolvedReferences: [...input.coverage.unresolvedReferences].sort(
        (left, right) => left.changedFile.localeCompare(right.changedFile) || left.leaf.localeCompare(right.leaf),
      ),
    },
  };
}

function canonicalReferent(referent: ResidueReferent): ResidueReferent {
  return {
    kind: 'callable',
    symbol: referent.symbol,
    file: referent.file.replaceAll('\\', '/'),
    displayName: referent.displayName,
  };
}
