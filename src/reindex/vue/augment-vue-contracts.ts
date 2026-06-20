// scip-query: ignore-stale — public summary returned by augment-vue and read
// by runtime command handlers through the exported augmentation API.
export interface AugmentVueResolvedResult {
  vueFiles: number;
  resolvedReferences: number;
  insertedMentions: number;
  skippedReferences: number;
  syntheticSymbols: number;
}

export interface ResolvedOccurrence {
  sourceFile: string;
  sourceLine: number;
  sourceStartChar: number;
  sourceEndChar: number;
  symbolId: number;
}

export interface VueReferenceComputationResult {
  occurrences: ResolvedOccurrence[];
  skippedReferences: number;
}

export interface VueReferenceTask {
  fileName: string;
  startOffset: number;
  endOffset: number;
  countFileSkip: boolean;
}
