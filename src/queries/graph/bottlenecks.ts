import type { ScipDatabase } from '../../storage/db.js';
import { getCalleeRowsForSymbol } from '../../symbols/graph/call-graph-evidence.js';
import { getCallerRowsMapForSymbols } from '../../symbols/graph/call-graph-evidence.js';
import type { CallerRow } from '../../symbols/graph/call-graph-evidence.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../internal/project-index.js';
import { applyScanLimit } from '../query-utils.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';

export interface BottleneckResult {
  symbol: string;
  shortName: string;
  fanIn: number;
  fanOut: number;
  callerFiles: string[];
  externalCallees: Array<{ symbol: string; shortName: string; file: string }>;
  /** fanIn * fanOut — higher = more central coupling hub */
  score: number;
  definedIn: string;
  actionTier: 'signal';
  riskKind: 'coordination-hotspot';
  evidenceReasons: string[];
  recommendation: string;
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
  opts: {
    limit?: number;
    scope?: string;
    minFanIn?: number;
    minFanOut?: number;
    scanLimit?: number;
    semantic?: boolean;
  } = {},
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
  const semantic = opts.semantic !== false;
  const callerRows = getCallerRowsMapForSymbols(db, definitions, {
    limit: 500,
    semantic,
    semanticEvidence: symbolSemanticEvidence,
  });
  const rows = definitions.map((definition) =>
    bottleneckRowFor(db, definition, semantic, callerRows.get(definition.symbolId) ?? []),
  );

  return rows
    .filter((row) => row.fanIn >= minFanIn && row.fanOut >= minFanOut)
    .sort((left, right) => right.score - left.score || right.fanIn - left.fanIn)
    .slice(0, limit);
}

function bottleneckRowFor(
  db: ScipDatabase,
  definition: IndexedDefinition,
  semantic: boolean,
  callerRows: readonly CallerRow[],
): BottleneckResult {
  const callerFiles = [...new Set(callerRows.map((row) => row.file))].sort();
  const externalCalleeByIdentity = new Map<string, { symbol: string; shortName: string; file: string }>();
  for (const row of getCalleeRowsForSymbol(db, definition, {
    limit: 500,
    semantic,
    semanticEvidence: symbolSemanticEvidence,
  })) {
    if (row.file === definition.relativePath) continue;
    const identity = `${row.symbol}|${row.file}`;
    if (!externalCalleeByIdentity.has(identity)) {
      externalCalleeByIdentity.set(identity, {
        symbol: row.symbol,
        shortName: shortenSymbol(row.symbol),
        file: row.file,
      });
    }
  }
  const externalCallees = [...externalCalleeByIdentity.values()].sort(
    (left, right) => left.file.localeCompare(right.file) || left.symbol.localeCompare(right.symbol),
  );
  const fanIn = callerFiles.length;
  const fanOut = externalCallees.length;
  const score = fanIn * fanOut;
  return {
    symbol: definition.symbol,
    shortName: shortenSymbol(definition.symbol),
    fanIn,
    fanOut,
    callerFiles,
    externalCallees,
    score,
    definedIn: definition.relativePath,
    actionTier: 'signal',
    riskKind: 'coordination-hotspot',
    evidenceReasons: [
      `${fanIn} incoming file(s) reference this symbol`,
      `${fanOut} distinct cross-file callee symbol(s) are reached from it`,
      `centrality score is ${score} (fan-in * fan-out)`,
    ],
    recommendation:
      'Review ownership, API stability, and caller groups before changing this central symbol; do not refactor solely from graph centrality.',
  };
}
