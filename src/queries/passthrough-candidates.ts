import type { ScipDatabase } from '../db.js';
import { getDefinitionsForFile, getScopedDefinitions } from '../definition-catalog.js';
import { buildCalleeMap } from '../reference-graph.js';
import { isLiteralPassthrough } from '../passthrough-detect.js';
import { hasSuppressionComment } from '../source-text.js';
import type { PassthroughCandidate } from '../types.js';
import { isFunctionLikeSymbol, isInRustTestModule, isRustTraitImplMember, shortenSymbol } from '../symbol-parser.js';

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
  const symbols = getPassthroughCandidateSymbols(db, scope, maxLoc);
  const calleeMap = buildCalleeMap(db, symbols);

  const results: PassthroughCandidate[] = [];

  for (const sym of symbols) {
    if (hasSuppressionComment(db, sym.relativePath, sym.startLine)) continue;
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
  db: ScipDatabase,
  scope: string | undefined,
  maxLoc: number,
): ReturnType<typeof getDefinitionsForFile> {
  return getScopedDefinitions(db, scope)
    .filter((d) => !db.isIgnored(d.relativePath))
    .filter((d) => isFunctionLikeSymbol(d.symbol))
    // Trait-impl methods like `Default::default()`, `From::from()`,
    // `FromStr::from_str()` legitimately delegate to a single inherent
    // method or constructor — that's the trait-protocol idiom, not
    // unnecessary indirection. Filtering these prevents the metric from
    // flooding with idiomatic forwards.
    .filter((d) => !isRustTraitImplMember(d.symbol))
    .filter((d) => !isInRustTestModule(d.symbol))
    .filter((d) => definitionLoc(d) >= 3 && definitionLoc(d) <= maxLoc);
}

function definitionLoc(
  definition: ReturnType<typeof getDefinitionsForFile>[number],
): number {
  return definition.endLine - definition.startLine + 1;
}
