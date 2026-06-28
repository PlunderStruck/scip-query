import { performance } from 'node:perf_hooks';
import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { resolveImportPath } from '../../resolution/import-path-resolver.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { cached } from './cache.js';
import { definitionNodesForSourceFile } from './definition-node-matcher.js';
import { findIndexedDefinitionNear, indexedDefinitionLeafMap } from './indexed-definitions.js';
import { createTypeScriptSourceFiles } from './source-file-resolver.js';
import {
  discoverWorkspacePackages,
  packageEntryCandidates,
  workspacePackageNameForSpecifier,
} from './workspace-packages.js';
import {
  dedupeLocations,
  isTypeOnlyLocation,
  lineOf,
  referenceLocationsWithoutDeclaration,
  semanticReferencesForNode,
  textualIdentifierLocations,
  toRelative,
} from './semantic-locations.js';
import type { WorkspacePackage } from './workspace-packages.js';
import type { Identifier, ImportDeclaration, Node, Project, SourceFile, ts } from 'ts-morph';
import type {
  SemanticAvailability,
  SemanticCallee,
  SemanticImportUsage,
  SemanticLocation,
  SemanticProvider,
  SemanticReference,
} from '../types.js';
import { discoverTypeScriptTsconfigs } from './tsconfig-discovery.js';
import {
  createTsMorphProjectBundles,
  loadTsMorph,
  unavailableProvider,
  type ProjectBundle,
  type TsMorphModule,
} from './ts-morph-runtime.js';
import { profileEnabled, profileSpan } from '../../runtime/profile.js';

type PackageExportIndex = Map<string, Map<string, Set<number>>>;
type TypeScriptSymbol = ts.Symbol;
type TypeScriptTypeChecker = ts.TypeChecker;

interface ImportIdentifierEntry {
  identifier: Identifier | null;
  importedName: string;
  localName: string | null;
  kind: SemanticImportUsage['kind'];
  isTypeOnly: boolean;
}

interface ResolvedCalleeTarget {
  symbol: string;
  file: string;
  line: number;
}

interface CalleeMapProfileStats {
  callerLookupMs: number;
  expressionSymbolMs: number;
  typeSymbolMs: number;
  targetLookupMs: number;
  declarationsMs: number;
  declarationLocationMs: number;
  indexedLookupMs: number;
  compilerSymbolCacheHits: number;
  compilerSymbolCacheMisses: number;
  targetSymbolHits: number;
  targetMisses: number;
  typeFallbacks: number;
  declarationChecks: number;
  skippedUnrequestedCallers: number;
}

// scip-query: ignore-extract — this is the provider bootstrap boundary:
// optional dependency loading, tsconfig discovery, project construction, and
// unavailable-provider fallbacks define whether TypeScript semantics are live.
export function createTsMorphProvider(db: ScipDatabase, _relativePath?: string): SemanticProvider {
  const mod = loadTsMorph();
  if (!mod) {
    return unavailableProvider('ts-morph is not installed');
  }

  const tsconfigPaths = discoverTypeScriptTsconfigs(db);
  if (tsconfigPaths.length === 0) {
    return unavailableProvider('no tsconfig found');
  }

  try {
    const projects = createTsMorphProjectBundles(mod, tsconfigPaths);
    return new TsMorphSemanticProvider(db, mod, projects);
  } catch (error) {
    return unavailableProvider(error instanceof Error ? error.message : String(error), tsconfigPaths[0], tsconfigPaths);
  }
}

class TsMorphSemanticProvider implements SemanticProvider {
  readonly language = 'typescript' as const;
  private readonly importUsageCache = new Map<string, SemanticImportUsage[]>();
  private readonly referencesCache = new Map<number, SemanticReference[]>();
  private readonly calleesCache = new Map<number, SemanticCallee[]>();
  private readonly fileCalleesCache = new Map<string, Map<number, SemanticCallee[]>>();
  private readonly signatureCache = new Map<number, string | null>();
  private readonly definitionNodeCache = new Map<number, Node | null>();
  private readonly fileDefinitionNodeCache = new Map<string, Map<number, Node>>();
  private readonly indexedDefinitionLeafCache = new Map<string, Map<string, IndexedDefinition>>();
  private readonly compilerCheckerCache = new WeakMap<Project, TypeScriptTypeChecker>();
  private packageImportReferenceIndex: Map<number, SemanticReference[]> | null = null;
  private packageExportIndex: PackageExportIndex | null = null;
  private readonly workspacePackages: WorkspacePackage[];
  private readonly sourceFiles: ReturnType<typeof createTypeScriptSourceFiles>;

  constructor(
    private readonly db: ScipDatabase,
    private readonly tsMorph: TsMorphModule,
    private readonly projects: ProjectBundle[],
  ) {
    this.workspacePackages = discoverWorkspacePackages(db.config.projectRoot);
    this.sourceFiles = createTypeScriptSourceFiles(db, projects);
  }

  availability(): SemanticAvailability {
    return {
      available: true,
      tsconfigPath: this.projects[0]?.tsconfigPath,
      tsconfigPaths: this.projects.map((project) => project.tsconfigPath),
    };
  }

  importUsage(file: string): SemanticImportUsage[] {
    return cached(this.importUsageCache, file, () => {
      const sourceFile = this.sourceFiles.sourceFile(file);
      if (!sourceFile) return [];
      const results: SemanticImportUsage[] = [];
      for (const declaration of sourceFile.getImportDeclarations()) {
        for (const usage of this.importUsageForDeclaration(file, declaration)) {
          results.push(usage);
        }
      }
      return results;
    });
  }

  referencesFor(definition: IndexedDefinition): SemanticReference[] {
    return cached(this.referencesCache, definition.symbolId, () => {
      const node = this.nodeForDefinition(definition);
      const packageRefs = this.packageImportReferencesForDefinition(definition);
      if (!node) return packageRefs;
      return semanticReferencesForNode(node, definition, packageRefs, this.db.config.projectRoot);
    });
  }

  calleesFor(definition: IndexedDefinition): SemanticCallee[] {
    return cached(this.calleesCache, definition.symbolId, () => {
      const fileMap = cached(this.fileCalleesCache, definition.relativePath, () =>
        this.calleeMapForFile(definition.relativePath),
      );
      return fileMap.get(definition.symbolId) ?? [];
    });
  }

  calleesForDefinitions(definitions: readonly IndexedDefinition[]): Map<number, SemanticCallee[]> {
    const result = new Map<number, SemanticCallee[]>();
    const byFile = new Map<string, IndexedDefinition[]>();
    for (const definition of definitions) {
      const bucket = byFile.get(definition.relativePath);
      if (bucket) bucket.push(definition);
      else byFile.set(definition.relativePath, [definition]);
    }

    for (const [relativePath, fileDefinitions] of byFile) {
      const fullFileMap = this.fileCalleesCache.get(relativePath);
      const requestedSymbolIds = new Set(fileDefinitions.map((definition) => definition.symbolId));
      const fileMap = fullFileMap ?? this.calleeMapForFile(relativePath, requestedSymbolIds);
      for (const definition of fileDefinitions) {
        const callees = fileMap.get(definition.symbolId) ?? [];
        this.calleesCache.set(definition.symbolId, callees);
        result.set(definition.symbolId, callees);
      }
    }

    return result;
  }

  signatureFor(definition: IndexedDefinition): string | null {
    return cached(this.signatureCache, definition.symbolId, () => {
      const node = this.nodeForDefinition(definition);
      if (!node) return null;
      if (
        !this.tsMorph.Node.isFunctionDeclaration(node) &&
        !this.tsMorph.Node.isMethodDeclaration(node) &&
        !this.tsMorph.Node.isArrowFunction(node) &&
        !this.tsMorph.Node.isFunctionExpression(node) &&
        !this.tsMorph.Node.isConstructorDeclaration(node)
      ) {
        return null;
      }
      const signature = node.getType().getCallSignatures()[0];
      if (!signature) return null;
      const params = signature.getParameters().map((param) => {
        const decl = param.getDeclarations()[0];
        const type = decl
          ? param.getTypeAtLocation(decl).getText(decl)
          : (param.getValueDeclaration()?.getType().getText() ?? 'unknown');
        return normalizeType(type);
      });
      const returnType = signature.getReturnType().getText(node);
      return `(${params.join(',')})=>${normalizeType(returnType)}`;
    });
  }

  private importUsageForDeclaration(importer: string, declaration: ImportDeclaration): SemanticImportUsage[] {
    const sourcePath = resolveImportPath(this.db, importer, declaration.getModuleSpecifierValue());
    const entries = importIdentifiers(declaration);
    if (declaration.getImportClause()?.isTypeOnly()) {
      return entries.map((entry) => typeOnlyImportUsage(importer, sourcePath, entry));
    }
    return entries.map((entry) => this.valueImportUsageForEntry(importer, sourcePath, entry));
  }

  private valueImportUsageForEntry(
    importer: string,
    sourcePath: string | null,
    entry: ImportIdentifierEntry,
  ): SemanticImportUsage {
    const refs = entry.identifier ? entry.identifier.findReferences() : [];
    const referenceLocations: Array<{ location: SemanticLocation; node: Node }> = [];
    for (const ref of refs) {
      for (const location of referenceLocationsWithoutDeclaration(
        ref,
        importer,
        entry.identifier,
        this.db.config.projectRoot,
      )) {
        referenceLocations.push(location);
      }
    }
    const valueUsed = referenceLocations.some((location) => !isTypeOnlyLocation(location.node));
    const typeUsed = referenceLocations.some((location) => isTypeOnlyLocation(location.node));
    const bindingTypeOnly = entry.isTypeOnly;
    return {
      importer,
      sourcePath,
      importedName: entry.importedName,
      localName: entry.localName,
      kind: entry.kind,
      isTypeOnly: bindingTypeOnly,
      isUsed: bindingTypeOnly || referenceLocations.length > 0,
      isTypeUsed: bindingTypeOnly || typeUsed,
      isValueUsed: valueUsed,
      references: referenceLocations.map((location) => location.location),
    };
  }

  private packageImportReferencesForDefinition(definition: IndexedDefinition): SemanticReference[] {
    const index = this.packageImportReferences();
    return index.get(definition.symbolId) ?? [];
  }

  private packageImportReferences(): Map<number, SemanticReference[]> {
    if (this.packageImportReferenceIndex) return this.packageImportReferenceIndex;
    const index = new Map<number, SemanticReference[]>();
    const exportIndex = this.packageExports();
    for (const relativePath of this.sourceFiles.indexedTypeScriptLikeDocuments()) {
      this.addPackageImportReferencesForDocument(index, exportIndex, relativePath);
    }

    for (const [key, references] of index) {
      index.set(key, dedupeLocations(references));
    }
    this.packageImportReferenceIndex = index;
    return index;
  }

  private addPackageImportReferencesForDocument(
    index: Map<number, SemanticReference[]>,
    exportIndex: PackageExportIndex,
    relativePath: string,
  ): void {
    if (this.db.isIgnored(relativePath)) return;
    const match = this.sourceFiles.sourceFileMatch(relativePath);
    if (!match) return;
    for (const declaration of match.sourceFile.getImportDeclarations()) {
      this.addPackageImportReferencesForDeclaration(index, exportIndex, relativePath, declaration);
    }
  }

  // scip-query: ignore-extract — this records package import references for
  // one declaration; package matching, exported symbol lookup, identifier
  // locations, and symbol buckets are one indexing rule.
  private addPackageImportReferencesForDeclaration(
    index: Map<number, SemanticReference[]>,
    exportIndex: PackageExportIndex,
    relativePath: string,
    declaration: ImportDeclaration,
  ): void {
    const packageName = workspacePackageNameForSpecifier(this.workspacePackages, declaration.getModuleSpecifierValue());
    if (!packageName) return;
    const exportedSymbols = exportIndex.get(packageName);
    if (!exportedSymbols) return;
    for (const entry of importIdentifiers(declaration)) {
      if (entry.kind !== 'named' || !entry.identifier) continue;
      const symbolIds = exportedSymbols.get(entry.importedName);
      if (!symbolIds || symbolIds.size === 0) continue;
      const refs = textualIdentifierLocations(entry.identifier, relativePath, this.db.config.projectRoot);
      if (refs.length > 0) addReferencesForSymbols(index, symbolIds, refs);
    }
  }

  private packageExports(): PackageExportIndex {
    if (this.packageExportIndex) return this.packageExportIndex;
    const index: PackageExportIndex = new Map();
    for (const pkg of this.workspacePackages) {
      const exportsForPackage = new Map<string, Set<number>>();
      for (const entryFile of packageEntryCandidates(pkg)) {
        this.collectPackageExports(pkg, entryFile, exportsForPackage, new Set());
      }
      if (exportsForPackage.size > 0) index.set(pkg.name, exportsForPackage);
    }
    this.packageExportIndex = index;
    return index;
  }

  // scip-query: ignore-extract — this is the recursive package export walker:
  // named exports, star re-exports, workspace source-root filtering, and
  // cycle protection are one traversal policy.
  private collectPackageExports(
    pkg: WorkspacePackage,
    entryFile: string,
    out: Map<string, Set<number>>,
    visited: Set<string>,
  ): void {
    if (visited.has(entryFile)) return;
    visited.add(entryFile);
    const sourceFile = this.sourceFiles.sourceFile(entryFile);
    if (!sourceFile) return;

    for (const declaration of sourceFile.getExportDeclarations()) {
      const moduleSpecifier = declaration.getModuleSpecifierValue();
      const sourcePath = moduleSpecifier ? resolveImportPath(this.db, entryFile, moduleSpecifier) : entryFile;
      if (!sourcePath || !sourcePath.startsWith(`${pkg.sourceRootRelative}/`)) continue;

      const namedExports = declaration.getNamedExports();
      if (namedExports.length === 0) {
        if (declaration.isNamespaceExport()) continue;
        this.collectPackageExports(pkg, sourcePath, out, visited);
        continue;
      }

      for (const exported of namedExports) {
        const sourceName = exported.getNameNode().getText();
        const exportedName = exported.getAliasNode()?.getText() ?? sourceName;
        const definition = this.indexedDefinitionByLeaf(sourcePath, sourceName);
        if (!definition) continue;
        let bucket = out.get(exportedName);
        if (!bucket) {
          bucket = new Set();
          out.set(exportedName, bucket);
        }
        bucket.add(definition.symbolId);
      }
    }
  }

  private indexedDefinitionByLeaf(file: string, leaf: string): IndexedDefinition | null {
    const byLeaf = cached(this.indexedDefinitionLeafCache, file, () => indexedDefinitionLeafMap(this.db, file));
    return byLeaf.get(leaf) ?? null;
  }

  // scip-query: ignore-extract — this finds the ts-morph node for an indexed
  // definition; source-file lookup, name matching, and line matching are one
  // semantic bridge.
  private nodeForDefinition(definition: IndexedDefinition): Node | null {
    return cached(
      this.definitionNodeCache,
      definition.symbolId,
      () => this.definitionNodesForFile(definition.relativePath).get(definition.symbolId) ?? null,
    );
  }

  private definitionNodesForFile(relativePath: string): Map<number, Node> {
    return cached(this.fileDefinitionNodeCache, relativePath, () => {
      const sourceFile = this.sourceFiles.sourceFile(relativePath);
      if (!sourceFile) return new Map();
      return definitionNodesForSourceFile(this.tsMorph, this.db, sourceFile, relativePath);
    });
  }

  private definitionFromCompilerSymbol(
    symbol: TypeScriptSymbol,
    stats?: CalleeMapProfileStats,
  ): ResolvedCalleeTarget | null {
    const symbolName = symbol.name;
    const declarationsStart = stats ? performance.now() : 0;
    const declarations = symbol.declarations ?? [];
    if (stats) {
      stats.declarationsMs += performance.now() - declarationsStart;
      stats.declarationChecks += declarations.length;
    }

    for (const declaration of declarations) {
      const locationStart = stats ? performance.now() : 0;
      const sourceFile = declaration.getSourceFile();
      const file = toRelative(this.db.config.projectRoot, sourceFile.fileName);
      const line = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line;
      if (stats) stats.declarationLocationMs += performance.now() - locationStart;
      if (!file || this.db.isIgnored(file)) continue;

      const lookupStart = stats ? performance.now() : 0;
      const match = findIndexedDefinitionNear(this.db, file, line, symbolName);
      if (stats) stats.indexedLookupMs += performance.now() - lookupStart;
      if (match) return { symbol: match.symbol, file: match.relativePath, line: match.startLine };
    }
    return null;
  }

  // scip-query: ignore-extract — this builds the TypeScript semantic callee
  // map for one file; source-file lookup, indexed definitions, descendant
  // traversal, and dedupe are one adapter pass.
  private calleeMapForFile(
    relativePath: string,
    requestedSymbolIds?: ReadonlySet<number>,
  ): Map<number, SemanticCallee[]> {
    const profiling = profileEnabled();
    let definitionsCount = 0;
    let callNodes = 0;
    let resolvedCallees = 0;
    let outputRows = 0;
    let sourceFileLookupMs = 0;
    let definitionsLoadMs = 0;
    let checkerLookupMs = 0;
    let traversalMs = 0;
    const stats = profiling ? createCalleeMapProfileStats() : undefined;

    return profileSpan(
      'typescript.callee-map.file',
      () => {
        const sourceLookupStart = profiling ? performance.now() : 0;
        const sourceFile = this.sourceFiles.sourceFile(relativePath);
        if (profiling) sourceFileLookupMs = Math.round(performance.now() - sourceLookupStart);
        if (!sourceFile) return new Map();

        const definitionsStart = profiling ? performance.now() : 0;
        const definitions = getDefinitionsForFile(this.db, relativePath).sort(
          (left, right) => left.startLine - right.startLine || right.endLine - left.endLine,
        );
        if (profiling) definitionsLoadMs = Math.round(performance.now() - definitionsStart);
        definitionsCount = definitions.length;
        if (definitions.length === 0) return new Map();

        const out = new Map<number, SemanticCallee[]>();
        const checkerStart = profiling ? performance.now() : 0;
        const checker = this.compilerCheckerForSourceFile(sourceFile);
        const compilerSourceFile = sourceFile.compilerNode;
        if (profiling) checkerLookupMs = Math.round(performance.now() - checkerStart);
        const symbolCache = new Map<TypeScriptSymbol, ResolvedCalleeTarget | null>();
        const visit = (node: ts.Node): void => {
          if (this.tsMorph.ts.isCallExpression(node) || this.tsMorph.ts.isNewExpression(node)) {
            if (profiling) callNodes += 1;
            const callee = this.semanticCalleeForCallNode(
              checker,
              compilerSourceFile,
              definitions,
              node,
              symbolCache,
              requestedSymbolIds,
              stats,
            );
            if (callee) {
              if (profiling) resolvedCallees += 1;
              addSemanticCallee(out, callee.callerId, callee.target);
            }
          }
          this.tsMorph.ts.forEachChild(node, visit);
        };
        const traversalStart = profiling ? performance.now() : 0;
        visit(compilerSourceFile);
        if (profiling) traversalMs = Math.round(performance.now() - traversalStart);

        for (const [symbolId, callees] of out) {
          out.set(symbolId, dedupeCallees(callees));
        }
        outputRows = out.size;
        return out;
      },
      () => ({
        relativePath,
        definitions: definitionsCount,
        callNodes,
        resolvedCallees,
        outputRows,
        requestedDefinitions: requestedSymbolIds?.size ?? definitionsCount,
        sourceFileLookupMs,
        definitionsLoadMs,
        checkerLookupMs,
        traversalMs,
        ...(stats ? roundCalleeMapProfileStats(stats) : {}),
      }),
    );
  }

  private semanticCalleeForCallNode(
    checker: TypeScriptTypeChecker,
    sourceFile: ts.SourceFile,
    definitions: ReadonlyArray<IndexedDefinition>,
    node: ts.CallExpression | ts.NewExpression,
    symbolCache: Map<TypeScriptSymbol, ResolvedCalleeTarget | null>,
    requestedSymbolIds?: ReadonlySet<number>,
    stats?: CalleeMapProfileStats,
  ): { callerId: number; target: SemanticCallee } | null {
    const callerStart = stats ? performance.now() : 0;
    const caller = findContainingDefinition(definitions, lineOfCompilerNode(sourceFile, node));
    if (stats) stats.callerLookupMs += performance.now() - callerStart;
    if (!caller) return null;
    if (requestedSymbolIds && !requestedSymbolIds.has(caller.symbolId)) {
      if (stats) stats.skippedUnrequestedCallers += 1;
      return null;
    }
    const expression = node.expression;
    const symbol = this.compilerSymbolForExpression(checker, expression, stats);
    let target: ResolvedCalleeTarget | null = null;
    if (symbol) {
      if (stats) stats.targetSymbolHits += 1;
      if (symbolCache.has(symbol)) {
        if (stats) stats.compilerSymbolCacheHits += 1;
        target = symbolCache.get(symbol) ?? null;
      } else {
        if (stats) stats.compilerSymbolCacheMisses += 1;
        const targetStart = stats ? performance.now() : 0;
        target = this.definitionFromCompilerSymbol(symbol, stats);
        if (stats) stats.targetLookupMs += performance.now() - targetStart;
        symbolCache.set(symbol, target);
      }
    } else if (stats) {
      stats.targetMisses += 1;
    }
    return target
      ? { callerId: caller.symbolId, target: { symbol: target.symbol, file: target.file, line: target.line } }
      : null;
  }

  private compilerSymbolForExpression(
    checker: TypeScriptTypeChecker,
    expression: ts.Expression,
    stats?: CalleeMapProfileStats,
  ): TypeScriptSymbol | undefined {
    const symbolStart = stats ? performance.now() : 0;
    const symbol = checker.getSymbolAtLocation(expression);
    if (stats) stats.expressionSymbolMs += performance.now() - symbolStart;
    if (symbol) return symbol;

    if (stats) stats.typeFallbacks += 1;
    const typeStart = stats ? performance.now() : 0;
    const typeSymbol = checker.getTypeAtLocation(expression).getSymbol();
    if (stats) stats.typeSymbolMs += performance.now() - typeStart;
    return typeSymbol;
  }

  private compilerCheckerForSourceFile(sourceFile: SourceFile): TypeScriptTypeChecker {
    const project = sourceFile.getProject();
    let checker = this.compilerCheckerCache.get(project);
    if (!checker) {
      checker = project.getTypeChecker().compilerObject;
      this.compilerCheckerCache.set(project, checker);
    }
    return checker;
  }
}

function importIdentifiers(declaration: ImportDeclaration): ImportIdentifierEntry[] {
  const out: ImportIdentifierEntry[] = [];
  const defaultImport = declaration.getDefaultImport();
  if (defaultImport) {
    out.push({
      identifier: defaultImport,
      importedName: 'default',
      localName: defaultImport.getText(),
      kind: 'default',
      isTypeOnly: declaration.getImportClause()?.isTypeOnly() ?? false,
    });
  }
  const namespaceImport = declaration.getNamespaceImport();
  if (namespaceImport) {
    out.push({
      identifier: namespaceImport,
      importedName: '*',
      localName: namespaceImport.getText(),
      kind: 'namespace',
      isTypeOnly: declaration.getImportClause()?.isTypeOnly() ?? false,
    });
  }
  for (const named of declaration.getNamedImports()) {
    const name = named.getNameNode();
    const alias = named.getAliasNode();
    const identifier = alias ?? (name.getKindName() === 'Identifier' ? (name as Identifier) : null);
    out.push({
      identifier,
      importedName: name.getText(),
      localName: identifier?.getText() ?? name.getText(),
      kind: 'named',
      isTypeOnly: named.isTypeOnly() || (declaration.getImportClause()?.isTypeOnly() ?? false),
    });
  }
  if (out.length === 0) {
    out.push({
      identifier: null,
      importedName: '*',
      localName: null,
      kind: 'side-effect',
      isTypeOnly: false,
    });
  }
  return out;
}

function typeOnlyImportUsage(
  importer: string,
  sourcePath: string | null,
  entry: ImportIdentifierEntry,
): SemanticImportUsage {
  return {
    importer,
    sourcePath,
    importedName: entry.importedName,
    localName: entry.localName,
    kind: entry.kind,
    isTypeOnly: true,
    isUsed: true,
    isTypeUsed: true,
    isValueUsed: false,
    references: [],
  };
}

function addSemanticCallee(out: Map<number, SemanticCallee[]>, callerId: number, target: SemanticCallee): void {
  let bucket = out.get(callerId);
  if (!bucket) {
    bucket = [];
    out.set(callerId, bucket);
  }
  bucket.push(target);
}

function findContainingDefinition(
  definitions: ReadonlyArray<IndexedDefinition>,
  line: number,
): IndexedDefinition | null {
  let best: IndexedDefinition | null = null;
  for (const definition of definitions) {
    if (line < definition.startLine || line > definition.endLine) continue;
    if (!best || definition.startLine >= best.startLine) {
      best = definition;
    }
  }
  return best;
}

function lineOfCompilerNode(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
}

function createCalleeMapProfileStats(): CalleeMapProfileStats {
  return {
    callerLookupMs: 0,
    expressionSymbolMs: 0,
    typeSymbolMs: 0,
    targetLookupMs: 0,
    declarationsMs: 0,
    declarationLocationMs: 0,
    indexedLookupMs: 0,
    compilerSymbolCacheHits: 0,
    compilerSymbolCacheMisses: 0,
    targetSymbolHits: 0,
    targetMisses: 0,
    typeFallbacks: 0,
    declarationChecks: 0,
    skippedUnrequestedCallers: 0,
  };
}

function roundCalleeMapProfileStats(stats: CalleeMapProfileStats): CalleeMapProfileStats {
  return {
    ...stats,
    callerLookupMs: Math.round(stats.callerLookupMs),
    expressionSymbolMs: Math.round(stats.expressionSymbolMs),
    typeSymbolMs: Math.round(stats.typeSymbolMs),
    targetLookupMs: Math.round(stats.targetLookupMs),
    declarationsMs: Math.round(stats.declarationsMs),
    declarationLocationMs: Math.round(stats.declarationLocationMs),
    indexedLookupMs: Math.round(stats.indexedLookupMs),
  };
}

function addReferencesForSymbols(
  index: Map<number, SemanticReference[]>,
  symbolIds: Iterable<number>,
  references: readonly SemanticReference[],
): void {
  for (const symbolId of symbolIds) {
    const bucket = index.get(symbolId) ?? [];
    bucket.push(...references);
    index.set(symbolId, bucket);
  }
}

function dedupeCallees(callees: SemanticCallee[]): SemanticCallee[] {
  const seen = new Set<string>();
  const out: SemanticCallee[] = [];
  for (const callee of callees) {
    const key = `${callee.symbol}|${callee.file}|${callee.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(callee);
  }
  return out;
}

function normalizeType(type: string): string {
  return type
    .replace(/\s+/g, ' ')
    .replace(/\bimport\("[^"]+"\)\./g, '')
    .trim();
}
