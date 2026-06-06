import type { ScipDatabase } from '../storage/db.js';
import type { ComplexityHotspot, IndexedDefinition } from '../domain/types.js';
import { shortenSymbol } from '../symbols/symbol-parser.js';
import { ProjectIndex } from '../core/project-index.js';

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
  opts?: { scope?: string; minLoc?: number; limit?: number; scanLimit?: number; semantic?: boolean },
): ComplexityHotspot[] {
  const { scope, minLoc = 10, limit = 30, scanLimit } = opts ?? {};

  const { definitions, callerMap, calleeMap } = loadComplexityCandidates(db, scope, scanLimit, opts?.semantic !== false);

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
  scanLimit: number | undefined,
  semantic: boolean,
): {
  definitions: IndexedDefinition[];
  callerMap: ReturnType<ProjectIndex['crossFileCallerMap']>;
  calleeMap: ReturnType<ProjectIndex['calleeMap']>;
} {
  const index = new ProjectIndex(db);
  const definitions = applyScanLimit(index.productionCallableDefinitions({
    scope,
    requireCallableSymbol: true,
    includeSuppressed: true,
    sortByLocDesc: typeof scanLimit === 'number' && scanLimit > 0,
  }), scanLimit);

  return {
    definitions,
    callerMap: index.crossFileCallerMap(definitions, { semantic }),
    calleeMap: index.calleeMap(definitions, { semantic }),
  };
}

function applyScanLimit<T>(items: T[], scanLimit: number | undefined): T[] {
  if (typeof scanLimit !== 'number' || scanLimit <= 0 || items.length <= scanLimit) {
    return items;
  }
  return items.slice(0, scanLimit);
}
