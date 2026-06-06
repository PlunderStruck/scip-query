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
// scip-query: ignore-extract — this is the passthrough-candidate command
// pipeline: production symbols, callee map, per-symbol scoring, sorting, and
// summary are one result contract.
export function passthroughCandidates(
  db: ScipDatabase,
  opts?: { scope?: string; maxLoc?: number; limit?: number; scanLimit?: number; semantic?: boolean },
): PassthroughCandidate[] {
  const { scope, maxLoc = 15, limit = 30, scanLimit } = opts ?? {};
  const index = new ProjectIndex(db);
  const symbols = applyScanLimit(
    getPassthroughCandidateSymbols(index, scope, maxLoc)
      .sort((left, right) => definitionLoc(left) - definitionLoc(right) || left.relativePath.localeCompare(right.relativePath)),
    scanLimit,
  );
  const calleeMap = index.calleeMap(symbols, { semantic: opts?.semantic !== false });

  const results: PassthroughCandidate[] = [];

  for (const sym of symbols) {
    const candidate = passthroughCandidateForSymbol(db, sym, calleeMap.get(sym.symbolId) ?? []);
    if (candidate) results.push(candidate);
  }

  results.sort((a, b) => a.loc - b.loc || a.file.localeCompare(b.file));
  return results.slice(0, limit);
}

function passthroughCandidateForSymbol(
  db: ScipDatabase,
  sym: IndexedDefinition,
  rawCallees: readonly { symbol: string; file: string }[],
): PassthroughCandidate | null {
  const uniqueCallees = uniquePassthroughCallees(rawCallees);
  if (uniqueCallees.size !== 1) return null;
  // Body-shape gate: must be `return inner(args)` where args === params,
  // not a type guard / partial application / defaulted wrapper that happens
  // to call exactly one function.
  if (!isLiteralPassthrough(db, sym.relativePath, sym.startLine, sym.endLine)) return null;

  const [, callee] = [...uniqueCallees.entries()][0]!;
  return {
    symbol: sym.symbol,
    shortName: shortenSymbol(sym.symbol),
    file: sym.relativePath,
    startLine: sym.startLine,
    endLine: sym.endLine,
    loc: definitionLoc(sym),
    forwardsTo: callee.symbol,
    forwardsToShort: shortenSymbol(callee.symbol),
    forwardsToFile: callee.file,
  };
}

function uniquePassthroughCallees(
  rawCallees: readonly { symbol: string; file: string }[],
): Map<string, { symbol: string; file: string }> {
  const callees = rawCallees.some((c) => isFunctionLikeSymbol(c.symbol))
    ? rawCallees.filter((c) => isFunctionLikeSymbol(c.symbol))
    : rawCallees;
  const uniqueCallees = new Map<string, { symbol: string; file: string }>();
  for (const c of callees) {
    if (!uniqueCallees.has(c.symbol)) uniqueCallees.set(c.symbol, c);
  }
  return uniqueCallees;
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

function applyScanLimit<T>(items: T[], scanLimit: number | undefined): T[] {
  if (typeof scanLimit !== 'number' || scanLimit <= 0 || items.length <= scanLimit) {
    return items;
  }
  return items.slice(0, scanLimit);
}
