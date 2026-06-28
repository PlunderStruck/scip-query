import type { ScipDatabase } from '../../storage/db.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../../core/project-index.js';
import { applyScanLimit, definitionLoc } from '../query-utils.js';

export interface IsolatedResult {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  loc: number;
}

/**
 * Find isolated callables: defined locally, referenced by nothing,
 * and calling nothing else. These are truly disconnected leaves.
 */
// scip-query: ignore-similar — fingerprint overlaps with loadComplexityCandidates
// (shared scoped-definition + callee/caller graph plumbing) but the heuristics
// are unrelated.
export function isolated(
  db: ScipDatabase,
  opts: { scope?: string; minLoc?: number; scanLimit?: number; semantic?: boolean } = {},
): IsolatedResult[] {
  const { scope, minLoc = 3, scanLimit } = opts;
  const index = new ProjectIndex(db);
  const includeSemantic = opts.semantic !== false;

  const candidates = applyScanLimit(
    index.productionCallableDefinitions({
      scope,
      minLoc,
      excludeEntrySurfaces: true,
      excludeRustTraitImplMembers: true,
      includeSuppressed: true,
      sortByLocDesc: typeof scanLimit === 'number' && scanLimit > 0,
    }),
    scanLimit,
  );

  const scipCallerMap = index.crossFileCallerMap(candidates, { semantic: false });
  const symbolsWithCallers = new Set<number>(scipCallerMap.keys());

  for (const symbolId of index.frameworkReferencedSymbolIds(candidates)) {
    symbolsWithCallers.add(symbolId);
  }

  const symbolsWithCallees = index.symbolsWithNonSelfCallees(candidates, {
    additive: false,
    semantic: false,
  });
  let possiblyIsolated = candidates
    .filter((definition) => !symbolsWithCallers.has(definition.symbolId))
    .filter((definition) => !symbolsWithCallees.has(definition.symbolId));

  if (includeSemantic && possiblyIsolated.length > 0) {
    for (const symbolId of index.crossFileCallerMap(possiblyIsolated, { semantic: true }).keys()) {
      symbolsWithCallers.add(symbolId);
    }
    for (const symbolId of index.symbolsWithNonSelfCallees(possiblyIsolated, { additive: false, semantic: true })) {
      symbolsWithCallees.add(symbolId);
    }
    possiblyIsolated = possiblyIsolated
      .filter((definition) => !symbolsWithCallers.has(definition.symbolId))
      .filter((definition) => !symbolsWithCallees.has(definition.symbolId));
  }

  const fallbackCallerMap = index.sourceFallbackCallerFiles(possiblyIsolated);
  for (const symbolId of fallbackCallerMap.keys()) {
    symbolsWithCallers.add(symbolId);
  }

  const candidatesNeedingAdditiveCallees = possiblyIsolated.filter(
    (definition) => !symbolsWithCallers.has(definition.symbolId),
  );
  const additiveCalleeIds = index.symbolsWithNonSelfCallees(candidatesNeedingAdditiveCallees, {
    additive: true,
    semantic: includeSemantic,
  });
  for (const symbolId of additiveCalleeIds) {
    symbolsWithCallees.add(symbolId);
  }

  return candidatesNeedingAdditiveCallees
    .filter((definition) => !symbolsWithCallees.has(definition.symbolId))
    .sort(
      (left, right) =>
        definitionLoc(right) - definitionLoc(left) ||
        left.relativePath.localeCompare(right.relativePath) ||
        left.startLine - right.startLine,
    )
    .map((definition) => ({
      symbol: definition.symbol,
      shortName: shortenSymbol(definition.symbol),
      relativePath: definition.relativePath,
      startLine: definition.startLine,
      endLine: definition.endLine,
      loc: definitionLoc(definition),
    }));
}
