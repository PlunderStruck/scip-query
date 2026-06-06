import type { ScipDatabase } from '../storage/db.js';
import { getCalleeRowsForSymbol, getCallerRowsForSymbol } from '../symbols/reference-graph.js';
import type { IndexedDefinition } from '../domain/types.js';
import type { BottleneckResult } from '../domain/types.js';
import { shortenSymbol } from '../symbols/symbol-parser.js';
import { ProjectIndex } from '../core/project-index.js';

/**
 * Find coupling hubs: symbols with both high fan-in (many consumers)
 * AND high fan-out (references many other symbols).
 *
 * These are the most dangerous symbols to change — they sit at the
 * intersection of many dependency paths. Score = fanIn * fanOut.
 */
// scip-query: ignore-similar — shares the SCIP-DB join shape with topFanOut /
// hotspots, but measures fan-in × fan-out coupling, not fan-out alone.
// Different intent, intentionally separate query.
export function bottlenecks(
  db: ScipDatabase,
  opts: { limit?: number; scope?: string; minFanIn?: number; minFanOut?: number } = {},
): BottleneckResult[] {
  const { limit = 20, scope, minFanIn = 2, minFanOut = 2 } = opts;
  const index = new ProjectIndex(db);
  const rows = index.productionCallableDefinitions({
    scope,
    requireCallableSymbol: true,
    includeSuppressed: true,
  })
    .map((definition) => bottleneckRowFor(db, definition));

  return rows
    .filter((row) => row.fanIn >= minFanIn && row.fanOut >= minFanOut)
    .sort((left, right) => right.score - left.score || right.fanIn - left.fanIn)
    .slice(0, limit);
}

function bottleneckRowFor(
  db: ScipDatabase,
  definition: IndexedDefinition,
): BottleneckResult {
  const fanIn = new Set(
    getCallerRowsForSymbol(db, definition, { limit: 500 }).map((row) => row.file),
  ).size;
  const fanOut = new Set(
    getCalleeRowsForSymbol(db, definition, { limit: 500 })
      .filter((row) => row.file !== definition.relativePath)
      .map((row) => `${row.symbol}|${row.file}`),
  ).size;
  return {
    symbol: definition.symbol,
    shortName: shortenSymbol(definition.symbol),
    fanIn,
    fanOut,
    score: fanIn * fanOut,
    definedIn: definition.relativePath,
  };
}
