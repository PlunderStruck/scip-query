// scip-query: ignore-stale — public summary returned by augment-vue and read
// by runtime command handlers through the exported augmentation API.
export interface AugmentVueResolvedResult {
  vueFiles: number;
  resolvedReferences: number;
  resolvedReferenceSamples: VueResolvedReferenceSample[];
  insertedMentions: number;
  /** Backwards-compatible count of unresolved source identifier tokens. */
  skippedReferences: number;
  skippedReferenceReasons: VueSkippedReferenceCounts;
  skippedReferenceSamples: VueSkippedReferenceSample[];
  syntheticSymbols: number;
}

export type VueSkippedReferenceReason =
  | 'missing-source-file'
  | 'missing-service-script'
  | 'no-definition'
  | 'same-file-definition'
  | 'unindexed-definition';

export type VueSkippedReferenceCounts = Record<VueSkippedReferenceReason, number>;

export interface VueSkippedReferenceSample {
  sourceFile: string;
  sourceLine: number;
  sourceStartChar: number;
  sourceEndChar: number;
  token: string;
  reason: VueSkippedReferenceReason;
}

export interface ResolvedOccurrence {
  sourceFile: string;
  sourceLine: number;
  sourceStartChar: number;
  sourceEndChar: number;
  sourceToken: string;
  definitionFile: string;
  symbolId: number;
}

export interface VueResolvedReferenceSample extends Omit<ResolvedOccurrence, 'symbolId'> {
  definitionSymbol: string;
}

export interface VueReferenceComputationResult {
  occurrences: ResolvedOccurrence[];
  skippedReferences: number;
  skippedReferenceReasons: VueSkippedReferenceCounts;
  skippedReferenceSamples: VueSkippedReferenceSample[];
}

export interface VueReferenceTask {
  fileName: string;
  startOffset: number;
  endOffset: number;
  countFileSkip: boolean;
}

export const SKIPPED_REFERENCE_SAMPLES_PER_FILE_REASON = 2;

export function emptySkippedReferenceCounts(): VueSkippedReferenceCounts {
  return {
    'missing-source-file': 0,
    'missing-service-script': 0,
    'no-definition': 0,
    'same-file-definition': 0,
    'unindexed-definition': 0,
  };
}

export function emptySkippedReferenceDiagnostics(): Omit<VueReferenceComputationResult, 'occurrences'> {
  return {
    skippedReferences: 0,
    skippedReferenceReasons: emptySkippedReferenceCounts(),
    skippedReferenceSamples: [],
  };
}

export function mergeSkippedReferenceDiagnostics(
  target: Omit<VueReferenceComputationResult, 'occurrences'>,
  source: Pick<
    VueReferenceComputationResult,
    'skippedReferences' | 'skippedReferenceReasons' | 'skippedReferenceSamples'
  >,
): void {
  target.skippedReferences += source.skippedReferences;
  for (const reason of Object.keys(target.skippedReferenceReasons) as VueSkippedReferenceReason[]) {
    target.skippedReferenceReasons[reason] += source.skippedReferenceReasons[reason];
    for (const sample of source.skippedReferenceSamples.filter((candidate) => candidate.reason === reason)) {
      const existing = target.skippedReferenceSamples.filter(
        (candidate) => candidate.reason === reason && candidate.sourceFile === sample.sourceFile,
      ).length;
      if (existing < SKIPPED_REFERENCE_SAMPLES_PER_FILE_REASON) target.skippedReferenceSamples.push(sample);
    }
  }
}
