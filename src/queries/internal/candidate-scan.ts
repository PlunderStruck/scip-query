import { applyScanLimit } from '../query-utils.js';

interface CandidateAnalysis<TCandidate, TContext, TResult> {
  candidates: () => TCandidate[];
  scanLimit?: number;
  orderCandidates?: (left: TCandidate, right: TCandidate) => number;
  prepare?: (candidates: readonly TCandidate[]) => TContext;
  evaluate: (candidate: TCandidate, context: TContext) => TResult | null;
  orderResults?: (left: TResult, right: TResult) => number;
  limit?: number;
}

/**
 * Shared detector shape for candidate-style analyses: load candidates, apply a
 * bounded scan budget, prepare bulk evidence once, score candidates, sort, and
 * return the report slice.
 */
export function runCandidateAnalysis<TCandidate, TContext = undefined, TResult = never>(
  opts: CandidateAnalysis<TCandidate, TContext, TResult>,
): TResult[] {
  const ordered = opts.orderCandidates ? [...opts.candidates()].sort(opts.orderCandidates) : opts.candidates();
  const candidates = applyScanLimit(ordered, opts.scanLimit);
  const context = opts.prepare?.(candidates) ?? (undefined as TContext);
  const results: TResult[] = [];

  for (const candidate of candidates) {
    const result = opts.evaluate(candidate, context);
    if (result) results.push(result);
  }

  if (opts.orderResults) results.sort(opts.orderResults);
  return typeof opts.limit === 'number' ? results.slice(0, opts.limit) : results;
}
