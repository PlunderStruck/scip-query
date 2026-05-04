import type { ScipDatabase } from '../db.js';
import { buildCalleeMap, buildCrossFileCallerMap, getScopedDefinitions } from '../query-support.js';
import type { ComplexityHotspot } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

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

  const definitions = getScopedDefinitions(db, scope)
    .filter((definition) => !db.isIgnored(definition.relativePath));

  const callerMap = buildCrossFileCallerMap(db, definitions);
  const calleeMap = buildCalleeMap(db, definitions);

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
