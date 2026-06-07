import type { ScipDatabase } from '../storage/db.js';
import type { IndexedDefinition, SymbolMatch } from '../domain/types.js';
import { classifyFile, isEntrySurface } from '../analysis/file-classifier.js';
import { getDefinitionsForFile, getScopedDefinitions } from '../symbols/definition-catalog.js';
import { buildCalleeMap } from '../symbols/call-graph-evidence.js';
import { buildFileDepGraph } from '../symbols/file-dep-graph.js';
import { buildCrossFileCallerMap } from '../symbols/reference-callers.js';
import { buildSourceFallbackCallerFiles } from '../symbols/identifier-attribution.js';
import { isCallableSymbol, isFunctionLikeSymbol, isInRustTestModule, isRustTraitImplMember } from '../symbols/symbol-parser.js';
import { getCallableSignature } from '../source/ast-signatures.js';
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

  // scip-query: ignore-extract — this is the shared production-callable gate:
  // scope, suppression comments, tests, generated files, LOC, and callable
  // mode form the contract used by several health commands.
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

    const definitions: IndexedDefinition[] = [];
    for (const definition of this.scopedDefinitions(scope)) {
      const relativePath = definition.relativePath;
      if (this.db.isIgnored(relativePath)) continue;
      if (excludeEntrySurfaces && isEntrySurface(this.db, relativePath)) continue;
      if (!matchesCallableMode(definition, { requireFunctionLikeSymbol, requireCallableSymbol })) continue;
      if (excludeSymbol !== undefined && definition.symbol === excludeSymbol) continue;
      const loc = definitionLoc(definition);
      if (loc < minLoc || loc > maxLoc) continue;
      if (excludeTypesFiles && isTypesFile(relativePath)) continue;
      if (excludeRustTraitImplMembers && isRustTraitImplMember(definition.symbol)) continue;
      if (classifyFile(relativePath) === 'test') continue;
      if (isInRustTestModule(definition.symbol)) continue;
      if (!includeSuppressed && hasSuppressionComment(this.db, relativePath, definition.startLine)) continue;
      definitions.push(definition);
    }

    return sortByLocDesc
      ? definitions.sort((left, right) => definitionLoc(right) - definitionLoc(left))
      : definitions;
  }

  calleeMap(
    definitions: ReadonlyArray<SymbolMatch>,
    opts: { additive?: boolean; semantic?: boolean } = {},
  ): ReturnType<typeof buildCalleeMap> {
    return buildCalleeMap(this.db, definitions, opts);
  }

  crossFileCallerMap(
    definitions?: ReadonlyArray<SymbolMatch>,
    opts: { semantic?: boolean } = {},
  ): ReturnType<typeof buildCrossFileCallerMap> {
    return buildCrossFileCallerMap(this.db, definitions, opts);
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

function definitionLoc(definition: Pick<IndexedDefinition, 'startLine' | 'endLine'>): number {
  return definition.endLine - definition.startLine + 1;
}

function isTypesFile(relativePath: string): boolean {
  return (relativePath.split('/').pop() ?? '').includes('types');
}
