import { classifyFile, isEntrySurface, isRootedSymbol } from '../analysis/file-classifier.js';
import type { IndexedDefinition } from '../domain/types.js';
import type { ScipDatabase } from '../storage/db.js';
import { getScopedDefinitions } from '../symbols/definition-catalog.js';
import { definitionLoc } from '../symbols/definition-loc.js';
import {
  isCallableSymbol,
  isFunctionLikeSymbol,
  isInRustTestModule,
  isRustTraitImplMember,
} from '../symbols/symbol-parser.js';
import { hasSuppressionComment } from '../source/source-text.js';

export function productionCallableDefinitions(
  db: ScipDatabase,
  opts: {
    scope?: string;
    minLoc?: number;
    maxLoc?: number;
    excludeSymbol?: string;
    excludeEntrySurfaces?: boolean;
    excludeTypesFiles?: boolean;
    /**
     * Skip externally-live symbols (package surface / entryRoots config).
     * For detectors whose advice is "inline or delete this" — published API
     * has consumers the index cannot see, so that advice would be wrong.
     */
    excludeRootedSymbols?: boolean;
    excludeRustTraitImplMembers?: boolean;
    includeSuppressed?: boolean;
    requireFunctionLikeSymbol?: boolean;
    requireCallableSymbol?: boolean;
    sortByLocDesc?: boolean;
  } = {},
): IndexedDefinition[] {
  const {
    scope,
    minLoc = 1,
    maxLoc = Number.POSITIVE_INFINITY,
    excludeSymbol,
    excludeEntrySurfaces = false,
    excludeTypesFiles = false,
    excludeRootedSymbols = false,
    requireFunctionLikeSymbol = false,
    requireCallableSymbol = false,
    excludeRustTraitImplMembers = false,
    includeSuppressed = false,
    sortByLocDesc = false,
  } = opts;

  const definitions: IndexedDefinition[] = [];
  for (const definition of getScopedDefinitions(db, scope)) {
    const relativePath = definition.relativePath;
    if (db.isIgnored(relativePath)) continue;
    if (excludeEntrySurfaces && isEntrySurface(db, relativePath)) continue;
    if (!matchesCallableMode(definition, { requireFunctionLikeSymbol, requireCallableSymbol })) continue;
    if (excludeSymbol !== undefined && definition.symbol === excludeSymbol) continue;
    const loc = definitionLoc(definition);
    if (loc < minLoc || loc > maxLoc) continue;
    if (excludeTypesFiles && isTypesFile(relativePath)) continue;
    if (excludeRootedSymbols && isRootedSymbol(db, definition.symbol, relativePath)) continue;
    if (excludeRustTraitImplMembers && isRustTraitImplMember(definition.symbol)) continue;
    if (classifyFile(relativePath) === 'test') continue;
    if (isInRustTestModule(definition.symbol)) continue;
    if (!includeSuppressed && hasSuppressionComment(db, relativePath, definition.startLine)) continue;
    definitions.push(definition);
  }

  return sortByLocDesc ? definitions.sort((left, right) => definitionLoc(right) - definitionLoc(left)) : definitions;
}

function matchesCallableMode(
  definition: IndexedDefinition,
  opts: { requireFunctionLikeSymbol: boolean; requireCallableSymbol: boolean },
): boolean {
  if (opts.requireCallableSymbol) {
    return isCallableSymbol(definition.symbol);
  }
  if (opts.requireFunctionLikeSymbol) {
    return isFunctionLikeSymbol(definition.symbol);
  }
  return definition.isFunctionLike;
}

function isTypesFile(relativePath: string): boolean {
  return (relativePath.split('/').pop() ?? '').includes('types');
}
