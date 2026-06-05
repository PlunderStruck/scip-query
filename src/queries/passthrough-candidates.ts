import type { ScipDatabase } from '../storage/db.js';
import { isLiteralPassthrough } from '../analysis/passthrough-detect.js';
import type { IndexedDefinition, PassthroughCandidate } from '../domain/types.js';
import { isFunctionLikeSymbol, shortenSymbol } from '../symbols/symbol-parser.js';
import { ProjectIndex } from '../core/project-index.js';

/**
 * Find passthrough candidates: functions that just forward to one
 * other function.
 *
 * A function with exactly 1 callee and small LOC is likely a thin
 * wrapper that adds no value — it just passes arguments through to
 * the real implementation.
 */
export function passthroughCandidates(
  db: ScipDatabase,
  opts?: { scope?: string; maxLoc?: number; limit?: number },
): PassthroughCandidate[] {
  const { scope, maxLoc = 15, limit = 30 } = opts ?? {};
  const index = new ProjectIndex(db);
  const symbols = getPassthroughCandidateSymbols(index, scope, maxLoc);
  const calleeMap = index.calleeMap(symbols);

  const results: PassthroughCandidate[] = [];

  for (const sym of symbols) {
    const rawCallees = calleeMap.get(sym.symbolId) ?? [];
    const callees = rawCallees.some((c) => isFunctionLikeSymbol(c.symbol))
      ? rawCallees.filter((c) => isFunctionLikeSymbol(c.symbol))
      : rawCallees;

    // Deduplicate by symbol
    const uniqueCallees = new Map<string, { symbol: string; file: string }>();
    for (const c of callees) {
      if (!uniqueCallees.has(c.symbol)) uniqueCallees.set(c.symbol, c);
    }

    if (uniqueCallees.size !== 1) continue;

    // Body-shape gate: must be `return inner(args)` where args === params,
    // not a type guard / partial application / defaulted wrapper that
    // happens to call exactly one function.
    if (!isLiteralPassthrough(db, sym.relativePath, sym.startLine, sym.endLine)) continue;

    const [, callee] = [...uniqueCallees.entries()][0]!;
    results.push({
      symbol: sym.symbol,
      shortName: shortenSymbol(sym.symbol),
      file: sym.relativePath,
      startLine: sym.startLine,
      endLine: sym.endLine,
      loc: definitionLoc(sym),
      forwardsTo: callee.symbol,
      forwardsToShort: shortenSymbol(callee.symbol),
      forwardsToFile: callee.file,
    });
  }

  results.sort((a, b) => a.loc - b.loc || a.file.localeCompare(b.file));
  return results.slice(0, limit);
}

function getPassthroughCandidateSymbols(
  index: ProjectIndex,
  scope: string | undefined,
  maxLoc: number,
): IndexedDefinition[] {
  return index.productionCallableDefinitions({
    scope,
    minLoc: 3,
    maxLoc,
    requireFunctionLikeSymbol: true,
    excludeRustTraitImplMembers: true,
  });
}

function definitionLoc(
  definition: IndexedDefinition,
): number {
  return definition.endLine - definition.startLine + 1;
}
