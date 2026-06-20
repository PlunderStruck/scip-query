import type { ScipDatabase } from '../../storage/db.js';
import { isLiteralPassthrough } from '../../source/ast.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { isFunctionLikeSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../../core/project-index.js';
import { compareDefinitionsBySmallestLoc, definitionLoc } from '../query-utils.js';
import { runCandidateAnalysis } from '../internal/candidate-scan.js';

export interface PassthroughCandidate {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  forwardsTo: string;
  forwardsToShort: string;
  forwardsToFile: string;
}

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
  return runCandidateAnalysis({
    candidates: () => getPassthroughCandidateSymbols(index, scope, maxLoc),
    orderCandidates: compareDefinitionsBySmallestLoc,
    scanLimit,
    prepare: (symbols) => index.calleeMap(symbols, { semantic: opts?.semantic !== false }),
    evaluate: (sym, calleeMap) => passthroughCandidateForSymbol(db, sym, calleeMap.get(sym.symbolId) ?? []),
    orderResults: (a, b) => a.loc - b.loc || a.file.localeCompare(b.file),
    limit,
  });
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
    // "Inline this passthrough" is wrong advice for published API — external
    // consumers the index can't see depend on the forwarding entry point.
    excludeRootedSymbols: true,
    excludeRustTraitImplMembers: true,
  });
}
