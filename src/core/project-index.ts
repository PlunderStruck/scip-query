import type { ScipDatabase } from '../storage/db.js';
import type { IndexedDefinition, SymbolMatch } from '../domain/types.js';
import { classifyFile, isEntrySurface } from '../analysis/file-classifier.js';
import { getDefinitionsForFile, getScopedDefinitions } from '../symbols/definition-catalog.js';
import { buildCalleeMap, buildCrossFileCallerMap, buildFileDepGraph } from '../symbols/reference-graph.js';
import { buildSourceFallbackCallerFiles } from '../symbols/identifier-attribution.js';
import { isCallableSymbol, isFunctionLikeSymbol, isInRustTestModule, isRustTraitImplMember } from '../symbols/symbol-parser.js';
import { getCallableSignature } from '../source/ast.js';
import { getSourceFiles } from '../source/source-fileset.js';
import { hasSuppressionComment } from '../source/source-text.js';
import { scanSourceReferences } from '../symbols/source-reference-scan.js';

interface ProductionCallableDefinitionsOptions {
  scope?: string;
  minLoc?: number;
  maxLoc?: number;
  excludeSymbol?: string;
  excludeEntrySurfaces?: boolean;
  excludeTypesFiles?: boolean;
  excludeRustTraitImplMembers?: boolean;
  includeSuppressed?: boolean;
  requireFunctionLikeSymbol?: boolean;
  requireCallableSymbol?: boolean;
  sortByLocDesc?: boolean;
}

export class ProjectIndex {
  constructor(private readonly db: ScipDatabase) {}

  scopedDefinitions(scope?: string): IndexedDefinition[] {
    return getScopedDefinitions(this.db, scope);
  }

  definitionsForFile(relativePath: string): IndexedDefinition[] {
    return getDefinitionsForFile(this.db, relativePath);
  }

  productionCallableDefinitions(
    opts: ProductionCallableDefinitionsOptions = {},
  ): IndexedDefinition[] {
    const {
      scope,
      minLoc = 1,
      maxLoc = Number.POSITIVE_INFINITY,
      excludeSymbol,
      excludeEntrySurfaces = false,
      excludeTypesFiles = false,
      requireFunctionLikeSymbol = false,
      requireCallableSymbol = false,
      excludeRustTraitImplMembers = false,
      includeSuppressed = false,
      sortByLocDesc = false,
    } = opts;

    const definitions = this.scopedDefinitions(scope)
      .filter((definition) => !this.db.isIgnored(definition.relativePath))
      .filter((definition) => !excludeEntrySurfaces || !isEntrySurface(this.db, definition.relativePath))
      .filter((definition) => matchesCallableMode(definition, { requireFunctionLikeSymbol, requireCallableSymbol }))
      .filter((definition) => excludeSymbol === undefined || definition.symbol !== excludeSymbol)
      .filter((definition) => definitionLoc(definition) >= minLoc && definitionLoc(definition) <= maxLoc)
      .filter((definition) => !excludeTypesFiles || !isTypesFile(definition.relativePath))
      .filter((definition) => !excludeRustTraitImplMembers || !isRustTraitImplMember(definition.symbol))
      .filter((definition) => classifyFile(definition.relativePath) !== 'test')
      .filter((definition) => !isInRustTestModule(definition.symbol))
      .filter((definition) => includeSuppressed || !hasSuppressionComment(this.db, definition.relativePath, definition.startLine));

    return sortByLocDesc
      ? [...definitions].sort((left, right) => definitionLoc(right) - definitionLoc(left))
      : definitions;
  }

  calleeMap(
    definitions: ReadonlyArray<SymbolMatch>,
    opts: { additive?: boolean } = {},
  ): ReturnType<typeof buildCalleeMap> {
    return buildCalleeMap(this.db, definitions, opts);
  }

  crossFileCallerMap(definitions?: ReadonlyArray<SymbolMatch>): ReturnType<typeof buildCrossFileCallerMap> {
    return buildCrossFileCallerMap(this.db, definitions);
  }

  sourceFallbackCallerFiles(definitions: ReadonlyArray<IndexedDefinition>): ReturnType<typeof buildSourceFallbackCallerFiles> {
    return buildSourceFallbackCallerFiles(this.db, definitions);
  }

  fileDependencyGraph(scope?: string): ReturnType<typeof buildFileDepGraph> {
    return buildFileDepGraph(this.db, scope);
  }

  // scip-query: ignore-passthrough — facade method keeps query modules on ProjectIndex.
  fileKind(relativePath: string): ReturnType<typeof classifyFile> {
    return classifyFile(relativePath);
  }

  // scip-query: ignore-wrapper — query modules stay on ProjectIndex instead of
  // reaching into source-text caches directly.
  hasSuppressionComment(definition: Pick<IndexedDefinition, 'relativePath' | 'startLine'>): boolean {
    return hasSuppressionComment(this.db, definition.relativePath, definition.startLine);
  }

  sourceFiles(): string[] {
    return getSourceFiles(this.db);
  }

  scanSourceReferences(
    opts: Parameters<typeof scanSourceReferences>[1],
    visit: Parameters<typeof scanSourceReferences>[2],
  ): void {
    scanSourceReferences(this.db, opts, visit);
  }

  callableSignature(definition: Pick<IndexedDefinition, 'relativePath' | 'startLine' | 'endLine'>): ReturnType<typeof getCallableSignature> {
    return getCallableSignature(this.db, definition.relativePath, definition.startLine, definition.endLine);
  }
}

function definitionLoc(definition: Pick<IndexedDefinition, 'startLine' | 'endLine'>): number {
  return definition.endLine - definition.startLine + 1;
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
