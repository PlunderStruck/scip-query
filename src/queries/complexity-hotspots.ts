import type { ScipDatabase } from '../db.js';
import { getScopedDefinitions } from '../definition-catalog.js';
import { buildCalleeMap, buildCrossFileCallerMap } from '../reference-graph.js';
import type { ComplexityHotspot } from '../types.js';
import { isCallableSymbol, isInRustTestModule, shortenSymbol } from '../symbol-parser.js';
import { classifyFile } from '../file-classifier.js';

/**
 * Find complexity hotspots: symbols with a composite score based on
 * LOC, fan-in, fan-out, and callee count.
 *
 * Score = (loc / 50) * (fanIn / 5) * max(fanOut / 5, 1)
 *
 * Bulk fan-in/out via buildCrossFileCallerMap + buildCalleeMap so we pay
 * one SQL pass per kind regardless of how many definitions we score —
 * replaces the previous per-symbol getCaller/CalleeRowsForSymbol calls
 * that were O(symbols × files) on large indexes.
 */
export function complexityHotspots(
  db: ScipDatabase,
  opts?: { scope?: string; minLoc?: number; limit?: number },
): ComplexityHotspot[] {
  const { scope, minLoc = 10, limit = 30 } = opts ?? {};

  const { definitions, callerMap, calleeMap } = loadComplexityCandidates(db, scope);

  return definitions
    .map((definition) => {
      const loc = definition.endLine - definition.startLine + 1;
      const fanIn = callerMap.get(definition.symbolId)?.size ?? 0;
      const callees = calleeMap.get(definition.symbolId) ?? [];
      const externalCallees = callees.filter((c) => c.file !== definition.relativePath);
      const fanOut = new Set(externalCallees.map((c) => `${c.symbol}|${c.file}`)).size;
      const calleeCount = new Set(callees.map((c) => `${c.symbol}|${c.file}`)).size;
      return {
        symbol: definition.symbol,
        shortName: shortenSymbol(definition.symbol),
        file: definition.relativePath,
        startLine: definition.startLine,
        endLine: definition.endLine,
        loc,
        fanIn,
        fanOut,
        calleeCount,
        score: Math.round((loc / 50) * (fanIn / 5) * Math.max(fanOut / 5, 1) * 100) / 100,
      };
    })
    .filter((row) => row.loc >= minLoc)
    .sort((left, right) => right.score - left.score || right.loc - left.loc)
    .slice(0, limit);
}

// scip-query: ignore-similar — shape overlap with isolated() is just the
// shared "load definitions, build callee+caller maps" pattern; the analyses
// are unrelated (complexity scoring vs disconnected-leaf detection).
function loadComplexityCandidates(
  db: ScipDatabase,
  scope: string | undefined,
): {
  definitions: ReturnType<typeof getScopedDefinitions>;
  callerMap: ReturnType<typeof buildCrossFileCallerMap>;
  calleeMap: ReturnType<typeof buildCalleeMap>;
} {
  // Only callables (methods + free functions) are real complexity hotspots.
  // `isFunctionLike` accepts every `term` suffix, which includes Rust struct
  // fields like `Config:features.` — those have huge synthetic chunk-fallback
  // LOC and high fan-in (every reader of the field), so they otherwise
  // dominate the score even though they're plain data and have no logic.
  const definitions = getScopedDefinitions(db, scope)
    .filter((definition) => isCallableSymbol(definition.symbol) && !db.isIgnored(definition.relativePath))
    // Tests aren't production complexity. A 200-LOC `make_session_and_context()`
    // setup helper isn't a hotspot to refactor — it's the price of testing
    // a complex system. Filter both file-level tests and inline `mod tests`.
    .filter((definition) => classifyFile(definition.relativePath) !== 'test')
    .filter((definition) => !isInRustTestModule(definition.symbol));

  return {
    definitions,
    callerMap: buildCrossFileCallerMap(db, definitions),
    calleeMap: buildCalleeMap(db, definitions),
  };
}
