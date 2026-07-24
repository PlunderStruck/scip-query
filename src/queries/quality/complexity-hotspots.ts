import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../internal/project-index.js';
import { runCandidateAnalysis } from '../internal/candidate-scan.js';
import { getSourceFacts } from '../../source/ast.js';
import { branchEstimatesForDefinitions, type BranchEstimateBasis } from './complexity.js';
import { scipFunctionLikeKindNumbers } from '../../symbols/symbol-kind.js';
import { semanticEvidenceProduct } from '../../semantic/shared-primitives.js';
import { mergeSetMaps } from '../../symbols/references/caller-evidence.js';

const SCIP_FUNCTION_LIKE_KINDS = new Set(scipFunctionLikeKindNumbers());

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
  branches: number;
  estimateBasis: BranchEstimateBasis;
  score: number;
}

/**
 * Find complexity hotspots: symbols with a composite score based on
 * LOC, fan-in, fan-out, and callee count.
 *
 * Score = (loc / 50) * (fanIn / 5) * max(fanOut / 5, 1) * max(cyclomatic / 5, 1)
 *
 * Bulk fan-in/out via caller evidence + buildCalleeMap so we pay
 * one SQL pass per kind regardless of how many definitions we score —
 * replaces the previous per-symbol getCaller/CalleeRowsForSymbol calls
 * that were O(symbols × files) on large indexes.
 */
// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function complexityHotspots(
  db: ScipDatabase,
  opts?: { scope?: string; minLoc?: number; limit?: number; scanLimit?: number; semantic?: boolean },
): ComplexityHotspot[] {
  const { scope, minLoc = 10, limit = 30, scanLimit } = opts ?? {};
  const index = new ProjectIndex(db);

  return runCandidateAnalysis({
    candidates: () =>
      index.productionCallableDefinitions({
        scope,
        minLoc,
        requireFunctionLikeSymbol: true,
        includeSuppressed: true,
        sortByLocDesc: typeof scanLimit === 'number' && scanLimit > 0,
      }),
    scanLimit,
    filterCandidate: isComplexityCallableDefinition,
    profile: { name: 'complexity-hotspots' },
    prepare: (definitions) => {
      const languages = languageByFile(db, definitions);
      const useSemantic = opts?.semantic !== false;
      const semanticEvidence = useSemantic ? semanticEvidenceProduct(db) : null;
      semanticEvidence?.materializeReferences(definitions, { prefetchCallees: true });
      const callerMap = index.crossFileCallerMap(definitions, { semantic: false });
      return {
        callerMap: semanticEvidence ? mergeSetMaps(callerMap, semanticEvidence.callerMap(definitions)) : callerMap,
        calleeMap: index.calleeMap(definitions, { semantic: useSemantic }),
        languageByFile: languages,
        clojureCallableIds: clojureCallableDefinitionIds(db, definitions, languages),
        branchEstimates: branchEstimatesForDefinitions(db, definitions),
      };
    },
    evaluate: (definition, maps) => complexityHotspotForDefinition(definition, maps, minLoc),
    orderResults: (left, right) => right.score - left.score || right.loc - left.loc,
    limit,
  });
}

function isComplexityCallableDefinition(definition: IndexedDefinition): boolean {
  if (!definition.symbol.startsWith('rust-analyzer ')) return true;
  return typeof definition.kind === 'number' && SCIP_FUNCTION_LIKE_KINDS.has(definition.kind);
}

function complexityHotspotForDefinition(
  definition: IndexedDefinition,
  maps: {
    callerMap: ReturnType<ProjectIndex['crossFileCallerMap']>;
    calleeMap: ReturnType<ProjectIndex['calleeMap']>;
    languageByFile: Map<string, string | null>;
    clojureCallableIds: Set<number>;
    branchEstimates: Map<number, { branches: number; estimateBasis: BranchEstimateBasis }>;
  },
  minLoc: number,
): ComplexityHotspot | null {
  if (
    maps.languageByFile.get(definition.relativePath) === 'clojure' &&
    !maps.clojureCallableIds.has(definition.symbolId)
  ) {
    return null;
  }
  const loc = definition.endLine - definition.startLine + 1;
  if (loc < minLoc) return null;
  const fanIn = maps.callerMap.get(definition.symbolId)?.size ?? 0;
  const callees = maps.calleeMap.get(definition.symbolId) ?? [];
  const uniqueCallees = new Set<string>();
  const uniqueExternalCallees = new Set<string>();
  for (const callee of callees) {
    const key = `${callee.symbol}|${callee.file}`;
    uniqueCallees.add(key);
    if (callee.file !== definition.relativePath) uniqueExternalCallees.add(key);
  }
  const fanOut = uniqueExternalCallees.size;
  const calleeCount = uniqueCallees.size;
  const branchEstimate = maps.branchEstimates.get(definition.symbolId) ?? {
    branches: 0,
    estimateBasis: 'regex-fallback',
  };
  const cyclomatic = branchEstimate.branches + 1;
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
    branches: branchEstimate.branches,
    estimateBasis: branchEstimate.estimateBasis,
    score: Math.round((loc / 50) * (fanIn / 5) * Math.max(fanOut / 5, 1) * Math.max(cyclomatic / 5, 1) * 100) / 100,
  };
}

function languageByFile(db: ScipDatabase, definitions: ReadonlyArray<IndexedDefinition>): Map<string, string | null> {
  const paths = [...new Set(definitions.map((definition) => definition.relativePath))];
  if (paths.length === 0) return new Map();

  const placeholders = paths.map(() => '?').join(', ');
  const rows = db.all<{ relative_path: string; language: string | null }>(
    `SELECT relative_path, language
     FROM documents
     WHERE relative_path IN (${placeholders})`,
    ...paths,
  );
  return new Map(rows.map((row) => [row.relative_path, row.language?.toLowerCase() ?? null]));
}

function clojureCallableDefinitionIds(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition>,
  languages: Map<string, string | null>,
): Set<number> {
  const ids = new Set<number>();
  const callableKeysByFile = new Map<string, Set<string>>();

  for (const definition of definitions) {
    if (languages.get(definition.relativePath) !== 'clojure') continue;
    let keys = callableKeysByFile.get(definition.relativePath);
    if (!keys) {
      keys = new Set(
        (getSourceFacts(db, definition.relativePath)?.callables ?? []).map(
          (callable) => `${callable.name}:${callable.startLine}`,
        ),
      );
      callableKeysByFile.set(definition.relativePath, keys);
    }
    if (keys.has(`${definition.leaf}:${definition.startLine}`)) {
      ids.add(definition.symbolId);
    }
  }

  return ids;
}
