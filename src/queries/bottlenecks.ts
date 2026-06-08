import type { ScipDatabase } from '../storage/db.js';
import { getCalleeRowsForSymbol } from '../symbols/call-graph-evidence.js';
import { callerRowsForSymbol } from '../symbols/caller-evidence.js';
import type { IndexedDefinition } from '../domain/types.js';
import { shortenSymbol } from '../symbols/symbol-parser.js';
import { ProjectIndex } from '../core/project-index.js';
import { applyScanLimit } from './query-utils.js';

export interface BottleneckResult {
  symbol: string;
  shortName: string;
  fanIn: number;
  fanOut: number;
  /** fanIn * fanOut — higher = more central coupling hub */
  score: number;
  definedIn: string;
}

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
  opts: { limit?: number; scope?: string; minFanIn?: number; minFanOut?: number; scanLimit?: number; semantic?: boolean } = {},
): BottleneckResult[] {
  const { limit = 20, scope, minFanIn = 2, minFanOut = 2, scanLimit } = opts;
  const index = new ProjectIndex(db);
  const definitions = applyScanLimit(
    index.productionCallableDefinitions({
      scope,
      requireCallableSymbol: true,
      includeSuppressed: true,
      sortByLocDesc: typeof scanLimit === 'number' && scanLimit > 0,
    }),
    scanLimit,
  );
  const rows = definitions.map((definition) => bottleneckRowFor(db, definition, opts.semantic !== false));

  return rows
    .filter((row) => row.fanIn >= minFanIn && row.fanOut >= minFanOut)
    .sort((left, right) => right.score - left.score || right.fanIn - left.fanIn)
    .slice(0, limit);
}

function bottleneckRowFor(
  db: ScipDatabase,
  definition: IndexedDefinition,
  semantic: boolean,
): BottleneckResult {
  const fanIn = new Set(
    callerRowsForSymbol(db, definition, { limit: 500, semantic }).map((row) => row.file),
  ).size;
  const fanOut = new Set(
    getCalleeRowsForSymbol(db, definition, { limit: 500, semantic })
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
