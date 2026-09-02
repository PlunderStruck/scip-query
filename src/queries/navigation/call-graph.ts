import type { ScipDatabase } from '../../storage/db.js';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { getCalleeRowsForSymbol } from '../../symbols/graph/call-graph-evidence.js';
import { getCallerRowsForSymbol } from '../../symbols/graph/call-graph-evidence.js';
import { isFunctionLikeSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';
import { uniqueSymbolFileRows } from '../query-utils.js';

export interface CallGraphEvidenceRow {
  symbol: string;
  shortName: string;
  file: string;
  relationship: 'resolved-call' | 'reference-candidate' | 'chunk-candidate';
  evidenceStrength: 'exact' | 'candidate';
  evidenceSource: string;
  /** `render` when the edge is a rendered component element (`<Child />`) rather than a call expression. */
  interaction?: 'render';
}

export interface CallGraphResult {
  symbol: string;
  shortName: string;
  /** Symbols that call this one (incoming) */
  callers: Array<{
    symbol: string;
    shortName: string;
    file: string;
  }>;
  /** Symbols called by this one (outgoing) */
  callees: Array<{
    symbol: string;
    shortName: string;
    file: string;
  }>;
  callerEvidence?: CallGraphEvidenceRow[];
  calleeEvidence?: CallGraphEvidenceRow[];
  coverage?: {
    scope: 'indexed-static-call-graph';
    blindSpots: string[];
  };
}

/**
 * Build a call graph for a symbol: who calls it (incoming) and
 * what it calls (outgoing).
 *
 * Incoming: other symbols whose definition ranges contain a reference to this symbol.
 * Outgoing: symbols referenced within this symbol's definition range.
 */
export function callGraph(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { semantic?: boolean } = {},
): CallGraphResult | null {
  // Find the target symbol and its definition range
  const target = findFirstSymbolMatch(db, symbolPattern);

  if (!target) return null;

  const includeSemantic = opts.semantic !== false;
  // Reference evidence also contains imports, type annotations, and module
  // ownership rows. Those belong in refs/dataflow, not in a graph whose
  // contract says every incoming row is a symbol that calls the target.
  const callerRows = getCallerRowsForSymbol(db, target, {
    semantic: includeSemantic,
    semanticEvidence: symbolSemanticEvidence,
  })
    .filter((caller) => isFunctionLikeSymbol(caller.symbol))
    .slice(0, 50);

  // CALLEES: symbols referenced within our target's definition range.
  const calleeRows = uniqueSymbolFileRows(
    getCalleeRowsForSymbol(db, target, {
      limit: 50,
      additive: true,
      callableOnly: true,
      semantic: includeSemantic,
      semanticEvidence: symbolSemanticEvidence,
    }),
  );

  const callerEvidence: CallGraphEvidenceRow[] = callerRows.map((r) => ({
    symbol: r.symbol,
    shortName: shortenSymbol(r.symbol),
    file: r.file,
    relationship:
      r.source !== 'caller-map-inversion'
        ? 'reference-candidate'
        : r.callEvidence === 'scip-chunk'
          ? 'chunk-candidate'
          : 'resolved-call',
    evidenceStrength: r.source === 'caller-map-inversion' && r.callEvidence !== 'scip-chunk' ? 'exact' : 'candidate',
    evidenceSource: r.callEvidence ?? r.source,
  }));
  const calleeEvidence: CallGraphEvidenceRow[] = calleeRows.map((r) => ({
    symbol: r.symbol,
    shortName: shortenSymbol(r.symbol),
    file: r.file,
    relationship: r.source === 'scip-chunk' ? 'chunk-candidate' : 'resolved-call',
    evidenceStrength: r.source === 'scip-chunk' ? 'candidate' : 'exact',
    evidenceSource: r.source,
    ...(r.kind === 'jsx-render' ? { interaction: 'render' as const } : {}),
  }));
  return {
    symbol: target.symbol,
    shortName: shortenSymbol(target.symbol),
    callers: callerEvidence.map(({ symbol, shortName, file }) => ({ symbol, shortName, file })),
    callees: calleeEvidence.map(({ symbol, shortName, file }) => ({ symbol, shortName, file })),
    callerEvidence,
    calleeEvidence,
    coverage: {
      scope: 'indexed-static-call-graph',
      blindSpots: [
        'unresolved dynamic dispatch and reflection',
        'external or unindexed callees without a resolved symbol identity',
        'SCIP chunk co-occurrence is retained only as candidate call evidence',
      ],
    },
  };
}
