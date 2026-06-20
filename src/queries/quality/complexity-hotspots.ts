import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../../core/project-index.js';
import { runCandidateAnalysis } from '../internal/candidate-scan.js';

export interface ComplexityHotspot {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  fanIn: number;
  fanOut: number;
  calleeCount: number;
  score: number;
}

/**
 * Find complexity hotspots: symbols with a composite score based on
 * LOC, fan-in, fan-out, and callee count.
 *
 * Score = (loc / 50) * (fanIn / 5) * max(fanOut / 5, 1)
 *
 * Bulk fan-in/out via caller evidence + buildCalleeMap so we pay
 * one SQL pass per kind regardless of how many definitions we score —
 * replaces the previous per-symbol getCaller/CalleeRowsForSymbol calls
 * that were O(symbols × files) on large indexes.
 */
export function complexityHotspots(
  db: ScipDatabase,
  opts?: { scope?: string; minLoc?: number; limit?: number; scanLimit?: number; semantic?: boolean },
): ComplexityHotspot[] {
  const { scope, minLoc = 10, limit = 30, scanLimit } = opts ?? {};
  const index = new ProjectIndex(db);

  return runCandidateAnalysis({
    candidates: () => index.productionCallableDefinitions({
      scope,
      requireCallableSymbol: true,
      includeSuppressed: true,
      sortByLocDesc: typeof scanLimit === 'number' && scanLimit > 0,
    }),
    scanLimit,
    prepare: (definitions) => ({
      callerMap: index.crossFileCallerMap(definitions, { semantic: opts?.semantic !== false }),
      calleeMap: index.calleeMap(definitions, { semantic: opts?.semantic !== false }),
    }),
    evaluate: (definition, maps) => complexityHotspotForDefinition(definition, maps, minLoc),
    orderResults: (left, right) => right.score - left.score || right.loc - left.loc,
    limit,
  });
}

function complexityHotspotForDefinition(
  definition: IndexedDefinition,
  maps: {
    callerMap: ReturnType<ProjectIndex['crossFileCallerMap']>;
    calleeMap: ReturnType<ProjectIndex['calleeMap']>;
  },
  minLoc: number,
): ComplexityHotspot | null {
  const loc = definition.endLine - definition.startLine + 1;
  if (loc < minLoc) return null;
  const fanIn = maps.callerMap.get(definition.symbolId)?.size ?? 0;
  const callees = maps.calleeMap.get(definition.symbolId) ?? [];
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
}
