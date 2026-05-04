import type { ScipDatabase } from '../db.js';
import { buildCalleeMap, getDefinitionsForFile, getScopedDefinitions } from '../query-support.js';
import type { PassthroughCandidate } from '../types.js';
import { isFunctionLikeSymbol, shortenSymbol } from '../symbol-parser.js';

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
  const symbols = getScopedDefinitions(db, scope)
    .filter((d) => !db.isIgnored(d.relativePath))
    .filter((d) => isFunctionLikeSymbol(d.symbol))
    .filter((d) => definitionLoc(d) >= 3 && definitionLoc(d) <= maxLoc);

  const calleeMap = buildCalleeMap(db, symbols);

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

function definitionLoc(
  definition: ReturnType<typeof getDefinitionsForFile>[number],
): number {
  return definition.endLine - definition.startLine + 1;
}
