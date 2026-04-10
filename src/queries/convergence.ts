import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch, getCalleeRowsForSymbol } from '../query-support.js';
import { shortenSymbol } from '../symbol-parser.js';

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
): ConvergenceResult | null {
  const matchA = findFirstSymbolMatch(db, symbolPatternA);
  const matchB = findFirstSymbolMatch(db, symbolPatternB);

  if (!matchA || !matchB) return null;

  const calleesA = new Set(
    getCalleeRowsForSymbol(db, matchA).map((r) => r.symbol),
  );
  const calleesB = new Set(
    getCalleeRowsForSymbol(db, matchB).map((r) => r.symbol),
  );

  const shared: string[] = [];
  for (const c of calleesA) {
    if (calleesB.has(c)) shared.push(c);
  }

  const uniqueA: string[] = [];
  for (const c of calleesA) {
    if (!calleesB.has(c)) uniqueA.push(c);
  }

  const uniqueB: string[] = [];
  for (const c of calleesB) {
    if (!calleesA.has(c)) uniqueB.push(c);
  }

  const union = new Set([...calleesA, ...calleesB]);
  const similarity = union.size > 0 ? shared.length / union.size : 0;

  // Generate a consolidation strategy description
  let strategy: string;
  if (uniqueA.length === 0 && uniqueB.length === 0) {
    strategy = 'These functions have identical callee sets. One can replace the other directly.';
  } else if (uniqueA.length === 0) {
    strategy = `A is a subset of B. A can be replaced by calling B (B does everything A does plus more).`;
  } else if (uniqueB.length === 0) {
    strategy = `B is a subset of A. B can be replaced by calling A (A does everything B does plus more).`;
  } else if (uniqueA.length <= 2 && uniqueB.length <= 2) {
    strategy = `Create a shared function with the ${shared.length} common callees. Pass the ${uniqueA.length + uniqueB.length} divergent callees as parameters or strategy callbacks.`;
  } else {
    strategy = `Extract the ${shared.length} shared callees into a common helper. Each function calls the helper plus its own unique logic (${uniqueA.length} callees in A, ${uniqueB.length} in B).`;
  }

  const locA = matchA.endLine - matchA.startLine + 1;
  const locB = matchB.endLine - matchB.startLine + 1;

  return {
    symbolA: {
      symbol: matchA.symbol,
      shortName: shortenSymbol(matchA.symbol),
      file: matchA.relativePath,
      loc: locA,
    },
    symbolB: {
      symbol: matchB.symbol,
      shortName: shortenSymbol(matchB.symbol),
      file: matchB.relativePath,
      loc: locB,
    },
    similarity,
    sharedCallees: shared.map(shortenSymbol),
    uniqueToA: uniqueA.map(shortenSymbol),
    uniqueToB: uniqueB.map(shortenSymbol),
    consolidationStrategy: strategy,
  };
}
