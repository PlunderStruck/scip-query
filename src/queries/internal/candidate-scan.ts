import { profileSpan } from '../../instrumentation/profile.js';
import { applyScanLimit } from '../query-utils.js';

export type CandidatePipelineMetadata = Record<string, unknown>;

export interface CandidatePipelineProfile {
  name: string;
  metadata?: CandidatePipelineMetadata | (() => CandidatePipelineMetadata);
}

// scip-query: ignore-stale — exported profile contract for candidate-style
// detectors; tests and future pipeline consumers should share this shape.
export interface CandidatePipelineCounters {
  pipeline: string | undefined;
  loadedCandidates: number;
  filteredCandidates: number;
  scannedCandidates: number;
  evaluatedCandidates: number;
  matchedResults: number;
  emittedResults: number;
  scanLimitApplied: boolean;
  resultLimitApplied: boolean;
}

export interface CandidateScanProgress {
  evaluated: number;
  scanned: number;
  matched: number;
}

interface CandidateAnalysis<TCandidate, TContext, TResult> {
  candidates: () => TCandidate[];
  scanLimit?: number;
  orderCandidates?: (left: TCandidate, right: TCandidate) => number;
  /**
   * Evaluation order of the candidates that survived the scan limit. Selection
   * still follows `orderCandidates`; this only changes the order work is done,
   * so a detector can keep per-file evidence hot across neighbouring candidates.
   */
  orderScanned?: (left: TCandidate, right: TCandidate) => number;
  filterCandidate?: (candidate: TCandidate) => boolean;
  prepare?: (candidates: readonly TCandidate[]) => TContext;
  evaluate: (candidate: TCandidate, context: TContext) => TResult | null;
  orderResults?: (left: TResult, right: TResult) => number;
  limit?: number;
  profile?: CandidatePipelineProfile;
  onProfile?: (counters: CandidatePipelineCounters) => void;
  /** Called after every evaluation; the receiver throttles its own reporting. */
  onProgress?: (progress: CandidateScanProgress) => void;
}

/**
 * Shared detector shape for candidate-style analyses: load candidates, apply a
 * bounded scan budget, prepare bulk evidence once, score candidates, sort, and
 * return the report slice.
 */
// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function runCandidateAnalysis<TCandidate, TContext = undefined, TResult = never>(
  opts: CandidateAnalysis<TCandidate, TContext, TResult>,
): TResult[] {
  let counters = emptyCandidatePipelineCounters(opts.profile?.name);

  const run = (): TResult[] => {
    const loaded = opts.candidates();
    const filtered = opts.filterCandidate ? loaded.filter(opts.filterCandidate) : loaded;
    const ordered = opts.orderCandidates ? [...filtered].sort(opts.orderCandidates) : filtered;
    const scanned = applyScanLimit(ordered, opts.scanLimit);
    const candidates = opts.orderScanned ? [...scanned].sort(opts.orderScanned) : scanned;
    counters = {
      pipeline: opts.profile?.name,
      loadedCandidates: loaded.length,
      filteredCandidates: filtered.length,
      scannedCandidates: candidates.length,
      evaluatedCandidates: 0,
      matchedResults: 0,
      emittedResults: 0,
      scanLimitApplied: candidates.length < filtered.length,
      resultLimitApplied: false,
    };

    const context = opts.prepare?.(candidates) ?? (undefined as TContext);
    const results: TResult[] = [];

    for (const candidate of candidates) {
      counters.evaluatedCandidates += 1;
      const result = opts.evaluate(candidate, context);
      if (result) results.push(result);
      opts.onProgress?.({
        evaluated: counters.evaluatedCandidates,
        scanned: candidates.length,
        matched: results.length,
      });
    }

    counters.matchedResults = results.length;
    if (opts.orderResults) results.sort(opts.orderResults);
    const emitted = typeof opts.limit === 'number' ? results.slice(0, opts.limit) : results;
    counters.emittedResults = emitted.length;
    counters.resultLimitApplied = emitted.length < results.length;
    opts.onProfile?.({ ...counters });
    return emitted;
  };

  if (!opts.profile) return run();
  return profileSpan(`candidate-pipeline:${opts.profile.name}`, run, () => ({
    ...candidatePipelineMetadata(opts.profile?.metadata),
    ...counters,
  }));
}

function emptyCandidatePipelineCounters(pipeline: string | undefined): CandidatePipelineCounters {
  return {
    pipeline,
    loadedCandidates: 0,
    filteredCandidates: 0,
    scannedCandidates: 0,
    evaluatedCandidates: 0,
    matchedResults: 0,
    emittedResults: 0,
    scanLimitApplied: false,
    resultLimitApplied: false,
  };
}

function candidatePipelineMetadata(
  metadata: CandidatePipelineProfile['metadata'] | undefined,
): CandidatePipelineMetadata {
  return typeof metadata === 'function' ? metadata() : (metadata ?? {});
}
