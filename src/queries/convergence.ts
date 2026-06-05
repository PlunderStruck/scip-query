import type { ScipDatabase } from '../storage/db.js';
import { findFirstSymbolMatch } from '../symbols/symbol-lookup.js';
import { getCalleeRowsForSymbol } from '../symbols/reference-graph.js';
import type { ConvergenceResult } from '../domain/types.js';
import { shortenSymbol } from '../symbols/symbol-parser.js';

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
  if (union.size === 0) {
    strategy = 'Neither function calls other tracked symbols. There is no callee-pattern evidence for consolidation; inspect the source bodies directly.';
  } else if (shared.length === 0) {
    strategy = 'These functions do not share any callees. They are not a callee-based consolidation candidate.';
  } else if (uniqueA.length === 0 && uniqueB.length === 0) {
    strategy = 'These functions have identical tracked callee sets. They are a strong structural match, but identical callees do not prove interchangeable semantics; inspect signatures, control flow, and return values before consolidating.';
  } else if (uniqueA.length === 0) {
    strategy = `A's tracked callees are a subset of B's. B may subsume part of A's structure, but verify signatures, guards, and non-call logic before replacing A with B.`;
  } else if (uniqueB.length === 0) {
    strategy = `B's tracked callees are a subset of A's. A may subsume part of B's structure, but verify signatures, guards, and non-call logic before replacing B with A.`;
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
