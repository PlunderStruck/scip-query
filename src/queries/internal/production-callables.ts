import { classifyFile, isEntrySurface, isRootedSymbol } from '../../analysis/file-classifier.js';
import type { IndexedDefinition } from '../../domain/types.js';
import type { ScipDatabase } from '../../storage/db.js';
import {
  getDefinitionsForFile,
  getScopedFunctionLikeDefinitions,
  getScopedDefinitionsMatchingSymbols,
} from '../../symbols/definition-catalog.js';
import { definitionLoc } from '../../symbols/definition-loc.js';
import {
  isCallableSymbol,
  isFunctionLikeSymbol,
  isInRustTestModule,
  isRustTraitImplMember,
} from '../../symbols/symbol-parser.js';
import { hasSuppressionComment } from '../../source/primitives/source-text.js';

// scip-query: ignore-extract — reviewed E1 workflow owner; callable eligibility is one shared detector policy.
export function productionCallableDefinitions(
  db: ScipDatabase,
  opts: {
    scope?: string;
    files?: readonly string[];
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
    files,
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
  const candidates = candidateDefinitions(db, { scope, files, requireFunctionLikeSymbol, requireCallableSymbol });
  const entrySurfaceByFile = new Map<string, boolean>();
  const fileKindByFile = new Map<string, ReturnType<typeof classifyFile>>();
  const getEntrySurface = (relativePath: string): boolean => {
    const cached = entrySurfaceByFile.get(relativePath);
    if (cached !== undefined) return cached;
    const value = isEntrySurface(db, relativePath);
    entrySurfaceByFile.set(relativePath, value);
    return value;
  };
  const getFileKind = (relativePath: string): ReturnType<typeof classifyFile> => {
    const cached = fileKindByFile.get(relativePath);
    if (cached !== undefined) return cached;
    const value = classifyFile(relativePath);
    fileKindByFile.set(relativePath, value);
    return value;
  };

  const selection = {
    excludeEntrySurfaces,
    requireFunctionLikeSymbol,
    requireCallableSymbol,
    excludeSymbol,
    minLoc,
    maxLoc,
  };
  const ownership = { excludeTypesFiles, excludeRootedSymbols, excludeRustTraitImplMembers };
  for (const definition of candidates) {
    if (!matchesProductionCallableSelection(db, definition, selection, getEntrySurface)) continue;
    if (!matchesProductionCallableOwnership(db, definition, ownership)) continue;
    if (!isUnsuppressedProductionCallable(db, definition, includeSuppressed, getFileKind)) continue;
    definitions.push(definition);
  }

  return sortByLocDesc ? definitions.sort((left, right) => definitionLoc(right) - definitionLoc(left)) : definitions;
}

function matchesProductionCallableSelection(
  db: ScipDatabase,
  definition: IndexedDefinition,
  opts: {
    excludeEntrySurfaces: boolean;
    requireFunctionLikeSymbol: boolean;
    requireCallableSymbol: boolean;
    excludeSymbol: string | undefined;
    minLoc: number;
    maxLoc: number;
  },
  getEntrySurface: (relativePath: string) => boolean,
): boolean {
  const relativePath = definition.relativePath;
  if (db.isIgnored(relativePath)) return false;
  if (opts.excludeEntrySurfaces && getEntrySurface(relativePath)) return false;
  if (!matchesCallableMode(definition, opts)) return false;
  if (opts.excludeSymbol !== undefined && definition.symbol === opts.excludeSymbol) return false;
  const loc = definitionLoc(definition);
  return !(loc < opts.minLoc || loc > opts.maxLoc);
}

function matchesProductionCallableOwnership(
  db: ScipDatabase,
  definition: IndexedDefinition,
  opts: { excludeTypesFiles: boolean; excludeRootedSymbols: boolean; excludeRustTraitImplMembers: boolean },
): boolean {
  const relativePath = definition.relativePath;
  if (opts.excludeTypesFiles && isTypesFile(relativePath)) return false;
  if (opts.excludeRootedSymbols && isRootedSymbol(db, definition.symbol, relativePath)) return false;
  return !opts.excludeRustTraitImplMembers || !isRustTraitImplMember(definition.symbol);
}

function isUnsuppressedProductionCallable(
  db: ScipDatabase,
  definition: IndexedDefinition,
  includeSuppressed: boolean,
  getFileKind: (relativePath: string) => ReturnType<typeof classifyFile>,
): boolean {
  const relativePath = definition.relativePath;
  if (getFileKind(relativePath) === 'test') return false;
  if (isInRustTestModule(definition.symbol)) return false;
  return includeSuppressed || !hasSuppressionComment(db, relativePath, definition.startLine);
}

function candidateDefinitions(
  db: ScipDatabase,
  opts: {
    scope?: string;
    files?: readonly string[];
    requireFunctionLikeSymbol: boolean;
    requireCallableSymbol: boolean;
  },
): IndexedDefinition[] {
  if (opts.files !== undefined) {
    const scopedFiles = [...new Set(opts.files.map((file) => file.replace(/\\/g, '/')))]
      .sort()
      .filter((file) => !opts.scope || file.includes(opts.scope));
    return scopedFiles.flatMap((relativePath) => getDefinitionsForFile(db, relativePath));
  }

  if (opts.requireCallableSymbol) {
    return getScopedDefinitionsMatchingSymbols(db, {
      scope: opts.scope,
      symbolMatches: isCallableSymbol,
      sqlPrefilter: 'callable',
    });
  }
  if (opts.requireFunctionLikeSymbol) {
    return getScopedDefinitionsMatchingSymbols(db, {
      scope: opts.scope,
      symbolMatches: isFunctionLikeSymbol,
      sqlPrefilter: 'function-like',
    });
  }
  return getScopedFunctionLikeDefinitions(db, opts.scope);
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
