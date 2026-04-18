import type { ScipDatabase } from '../db.js';
import { getAllDefinitions, getCalleeRowsForSymbol, getCallerRowsForSymbol } from '../query-support.js';
import type { ComplexityHotspot } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find complexity hotspots: symbols with a composite score based on
 * LOC, fan-in, fan-out, and callee count.
 *
 * Score = (loc / 50) * (fanIn / 5) * max(fanOut / 5, 1)
 *
 * High scores indicate symbols that are large, widely depended upon,
 * AND reach out to many other modules — the riskiest code to change.
 *
 * Uses source-corrected definition ranges via getAllDefinitions so the
 * LOC/callee bounds match `scip symbols` output. Computing fan-in/out
 * through getCallerRowsForSymbol / getCalleeRowsForSymbol keeps the
 * bounds consistent with the corrected ranges instead of whatever raw
 * range the SCIP indexer emitted (which is sometimes too wide and
 * attributes mentions from an adjacent function).
 */
export function complexityHotspots(
  db: ScipDatabase,
  opts?: { scope?: string; minLoc?: number; limit?: number },
): ComplexityHotspot[] {
  const { scope, minLoc = 10, limit = 30 } = opts ?? {};

  return getAllDefinitions(db, { scope })
    .filter((definition) => !db.isIgnored(definition.relativePath))
    .map((definition) => {
      const loc = definition.endLine - definition.startLine + 1;
      const callerRows = getCallerRowsForSymbol(db, definition, { limit: 500 });
      const calleeRows = getCalleeRowsForSymbol(db, definition, { limit: 500 });
      const fanIn = new Set(callerRows.map((row) => row.file)).size;
      const fanOut = new Set(
        calleeRows
          .filter((row) => row.file !== definition.relativePath)
          .map((row) => `${row.symbol}|${row.file}`),
      ).size;
      const calleeCount = new Set(calleeRows.map((row) => `${row.symbol}|${row.file}`)).size;
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
