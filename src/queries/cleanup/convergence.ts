import type { ScipDatabase } from '../../storage/db.js';
import { similarConsolidationPlan } from './similar.js';

export interface ConvergenceResult {
  symbolA: { symbol: string; shortName: string; file: string; loc: number };
  symbolB: { symbol: string; shortName: string; file: string; loc: number };
  similarity: number;
  sharedCallees: string[];
  uniqueToA: string[];
  uniqueToB: string[];
  consolidationStrategy: string;
}

/**
 * Given two similar symbols, show what a consolidated version would look like.
 * The shared callee set becomes the common body. The unique callees become
 * the parameterization points.
 */
export function convergence(
  db: ScipDatabase,
  symbolPatternA: string,
  symbolPatternB: string,
  opts: { semantic?: boolean } = {},
): ConvergenceResult | null {
  const plan = similarConsolidationPlan(db, symbolPatternA, symbolPatternB, opts);
  if (!plan) return null;
  return {
    symbolA: plan.symbolA,
    symbolB: plan.symbolB,
    similarity: plan.similarity,
    sharedCallees: plan.sharedEvidence,
    uniqueToA: plan.uniqueToA,
    uniqueToB: plan.uniqueToB,
    consolidationStrategy: plan.consolidationStrategy,
  };
}
