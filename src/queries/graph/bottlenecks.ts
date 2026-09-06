import { calleeEvidenceStrength } from '../../symbols/graph/call-graph-evidence.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getCalleeRowsForSymbol } from '../../symbols/graph/call-graph-evidence.js';
import { getCallerRowsMapForSymbols } from '../../symbols/graph/call-graph-evidence.js';
import type { CallerRow } from '../../symbols/graph/call-graph-evidence.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../internal/project-index.js';
import { applyScanLimit } from '../query-utils.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';

export interface CoordinationHubCalleeEvidence {
  symbol: string;
  shortName: string;
  file: string;
  evidenceStrength: 'exact' | 'candidate';
  evidenceSource: string;
}

export interface BottleneckResult {
  symbol: string;
  shortName: string;
  fanIn: number;
  fanOut: number;
  callerFiles: string[];
  candidateCallerFiles?: string[];
  externalCallees: Array<{
    symbol: string;
    shortName: string;
    file: string;
  }>;
  externalCalleeEvidence?: CoordinationHubCalleeEvidence[];
  candidateExternalCallees?: string[];
  inputBasis?: 'mixed-static-call-or-reference-evidence';
  /** fanIn * fanOut — higher = more central coupling hub */
  score: number;
  definedIn: string;
  actionTier: 'signal';
  riskKind: 'coordination-hotspot';
  evidenceReasons: string[];
  recommendation: string;
}

/**
 * Find coordination hubs: symbols with both many incoming caller/reference
 * evidence files and many outgoing cross-file callable targets.
 *
 * This is a coordination-hub heuristic, not a graph-theoretic articulation
 * point or proof that a change is dangerous. Score = fanIn * fanOut.
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

// scip-query: ignore-passthrough — public query name describes the coordination interpretation of bottleneck rows.
export function coordinationHubs(
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
  return bottlenecks(db, opts);
}

function bottleneckRowFor(
  db: ScipDatabase,
  definition: IndexedDefinition,
  semantic: boolean,
  callerRows: readonly CallerRow[],
): BottleneckResult {
  const externalCallers = callerRows.filter((row) => row.file !== definition.relativePath);
  const callerFiles = [...new Set(externalCallers.map((row) => row.file))].sort();
  const candidateCallerFiles = [
    ...new Set(
      externalCallers
        .filter(
          (row) => row.source !== 'caller-map-inversion' || calleeEvidenceStrength(row.callEvidence) === 'candidate',
        )
        .map((row) => row.file),
    ),
  ].sort();
  const externalCalleeByIdentity = new Map<string, CoordinationHubCalleeEvidence>();
  for (const row of getCalleeRowsForSymbol(db, definition, {
    semantic,
    semanticEvidence: symbolSemanticEvidence,
  })) {
    if (row.file === definition.relativePath) continue;
    const identity = `${row.symbol}|${row.file}`;
    if (
      !externalCalleeByIdentity.has(identity) ||
      (externalCalleeByIdentity.get(identity)!.evidenceStrength === 'candidate' &&
        calleeEvidenceStrength(row.source) === 'exact')
    ) {
      externalCalleeByIdentity.set(identity, {
        symbol: row.symbol,
        shortName: shortenSymbol(row.symbol),
        file: row.file,
        evidenceStrength: calleeEvidenceStrength(row.source),
        evidenceSource: row.source,
      });
    }
  }
  const externalCalleeEvidence = [...externalCalleeByIdentity.values()].sort(
    (left, right) => left.file.localeCompare(right.file) || left.symbol.localeCompare(right.symbol),
  );
  const fanIn = callerFiles.length;
  const fanOut = externalCalleeEvidence.length;
  const score = fanIn * fanOut;
  const candidateExternalCallees = externalCalleeEvidence
    .filter((callee) => callee.evidenceStrength === 'candidate')
    .map((callee) => callee.symbol);
  return {
    symbol: definition.symbol,
    shortName: shortenSymbol(definition.symbol),
    fanIn,
    fanOut,
    callerFiles,
    candidateCallerFiles,
    externalCallees: externalCalleeEvidence.map(({ symbol, shortName, file }) => ({ symbol, shortName, file })),
    externalCalleeEvidence,
    candidateExternalCallees,
    inputBasis: 'mixed-static-call-or-reference-evidence',
    score,
    definedIn: definition.relativePath,
    actionTier: 'signal',
    riskKind: 'coordination-hotspot',
    evidenceReasons: [
      `${fanIn} incoming file(s) reference this symbol`,
      `${fanOut} distinct cross-file callee target(s) are observed; candidate targets do not establish reachability`,
      `centrality score is ${score} (fan-in * fan-out)`,
      `${candidateCallerFiles.length} incoming file(s) and ${candidateExternalCallees.length} outgoing target(s) rely on candidate rather than exact call evidence`,
    ],
    recommendation:
      'Review ownership, API stability, and caller groups before changing this central symbol; do not refactor solely from graph centrality.',
  };
}
