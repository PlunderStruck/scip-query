import type { ScipDatabase } from '../../storage/db.js';
import { classifyFile } from '../../analysis/file-classifier.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../../core/project-index.js';
import { profileSpan } from '../../instrumentation/profile.js';
import { isFrameworkContractCallable } from './callable-contracts.js';
import { semanticCallerMap } from '../../semantic/shared-primitives.js';
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

  let candidateCount = 0;
  const candidates = profileSpan(
    'isolated.candidates',
    () => {
      const result = applyScanLimit(
        index.productionCallableDefinitions({
          scope,
          minLoc,
          excludeEntrySurfaces: true,
          excludeRootedSymbols: true,
          excludeRustTraitImplMembers: true,
          includeSuppressed: true,
          requireFunctionLikeSymbol: true,
          sortByLocDesc: typeof scanLimit === 'number' && scanLimit > 0,
        }),
        scanLimit,
      );
      const contractSafeCandidates = result.filter((definition) => !isFrameworkContractCallable(db, definition));
      candidateCount = contractSafeCandidates.length;
      return contractSafeCandidates;
    },
    () => ({ definitions: candidateCount }),
  );

  let strictCalleeCount = 0;
  const symbolsWithCallees = profileSpan(
    'isolated.strict-callees',
    () => {
      const result = index.symbolsWithNonSelfCallees(candidates, {
        additive: false,
        semantic: false,
      });
      strictCalleeCount = result.size;
      return result;
    },
    () => ({ definitions: candidates.length, symbols: strictCalleeCount }),
  );
  const candidatesWithoutStrictCallees = candidates.filter(
    (definition) => !symbolsWithCallees.has(definition.symbolId),
  );

  let scipCallerCount = 0;
  const scipCallerMap = profileSpan(
    'isolated.scip-callers',
    () => {
      const result = index.crossFileCallerMap(candidatesWithoutStrictCallees, { semantic: false });
      scipCallerCount = result.size;
      return result;
    },
    () => ({ definitions: candidatesWithoutStrictCallees.length, symbols: scipCallerCount }),
  );
  const symbolsWithCallers = new Set<number>(scipCallerMap.keys());

  for (const symbolId of index.frameworkReferencedSymbolIds(candidatesWithoutStrictCallees)) {
    symbolsWithCallers.add(symbolId);
  }

  let possiblyIsolated = candidatesWithoutStrictCallees.filter(
    (definition) => !symbolsWithCallers.has(definition.symbolId),
  );

  if (includeSemantic && possiblyIsolated.length > 0) {
    for (const symbolId of semanticCallerMap(db, possiblyIsolated).keys()) {
      symbolsWithCallers.add(symbolId);
    }
    for (const symbolId of index.symbolsWithNonSelfCallees(possiblyIsolated, { additive: false, semantic: true })) {
      symbolsWithCallees.add(symbolId);
    }
    possiblyIsolated = possiblyIsolated
      .filter((definition) => !symbolsWithCallers.has(definition.symbolId))
      .filter((definition) => !symbolsWithCallees.has(definition.symbolId));
  }

  let fallbackCallerCount = 0;
  const fallbackCallerMap = profileSpan(
    'isolated.source-fallback-callers',
    () => {
      const result = index.sourceFallbackCallerFiles(possiblyIsolated, {
        skipPath: (relativePath) => classifyFile(relativePath) === 'test',
      });
      fallbackCallerCount = result.size;
      return result;
    },
    () => ({ definitions: possiblyIsolated.length, symbols: fallbackCallerCount }),
  );
  for (const symbolId of fallbackCallerMap.keys()) {
    symbolsWithCallers.add(symbolId);
  }

  const candidatesNeedingAdditiveCallees = possiblyIsolated.filter(
    (definition) => !symbolsWithCallers.has(definition.symbolId),
  );
  let additiveCalleeCount = 0;
  const additiveCalleeIds = profileSpan(
    'isolated.additive-callees',
    () => {
      const result = index.symbolsWithNonSelfCallees(candidatesNeedingAdditiveCallees, {
        additive: true,
        semantic: includeSemantic,
      });
      additiveCalleeCount = result.size;
      return result;
    },
    () => ({ definitions: candidatesNeedingAdditiveCallees.length, symbols: additiveCalleeCount }),
  );
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
