import path from 'node:path';
import { createRequire } from 'node:module';
import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { resolveImportPath } from '../../resolution/import-path-resolver.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { leafName } from '../../symbols/symbol-parser.js';
import { findIndexedDefinitionNear, indexedDefinitionLeafMap } from './indexed-definitions.js';
import { discoverWorkspacePackages, packageEntryCandidates, workspacePackageNameForSpecifier } from './workspace-packages.js';
import { dedupeLocations, isTypeOnlyLocation, lineOf, referenceLocationsWithoutDeclaration, semanticReferencesForNode, textualIdentifierLocations, toRelative } from './semantic-locations.js';
import type { PackageExportIndex, WorkspacePackage } from './workspace-packages.js';
import type {
  CallExpression,
  Identifier,
  ImportDeclaration,
  NewExpression,
  Node,
  Project,
  SourceFile,
  Symbol,
} from 'ts-morph';
import type * as TsMorph from 'ts-morph';
import type {
  SemanticAvailability,
  SemanticCallee,
  SemanticImportUsage,
  SemanticLocation,
  SemanticProvider,
  SemanticReference,
} from '../types.js';
import { discoverTypeScriptTsconfigs } from './tsconfig-discovery.js';

type TsMorphModule = typeof TsMorph;

interface ProjectBundle {
  tsconfigPath: string;
  project: Project;
}

interface SourceFileMatch {
  project: Project;
  sourceFile: SourceFile;
}


interface ImportIdentifierEntry {
  identifier: Identifier | null;
  importedName: string;
  localName: string | null;
  kind: SemanticImportUsage['kind'];
  isTypeOnly: boolean;
}

const require = createRequire(import.meta.url);
let tsMorphModule: TsMorphModule | null | undefined;

// scip-query: ignore-extract — this is the provider bootstrap boundary:
// optional dependency loading, tsconfig discovery, project construction, and
// unavailable-provider fallbacks define whether TypeScript semantics are live.
export function createTsMorphProvider(
  db: ScipDatabase,
  _relativePath?: string,
): SemanticProvider {
  const mod = loadTsMorph();
  if (!mod) {
    return unavailableProvider('ts-morph is not installed');
  }

  const tsconfigPaths = discoverTypeScriptTsconfigs(db);
  if (tsconfigPaths.length === 0) {
    return unavailableProvider('no tsconfig found');
  }

  try {
    const projects = tsconfigPaths.map((tsconfigPath) => ({
      tsconfigPath,
      project: new mod.Project({
        tsConfigFilePath: tsconfigPath,
        skipFileDependencyResolution: false,
      }),
    }));
    return new TsMorphSemanticProvider(db, mod, projects);
  } catch (error) {
    return unavailableProvider(error instanceof Error ? error.message : String(error), tsconfigPaths[0], tsconfigPaths);
  }
}

function loadTsMorph(): TsMorphModule | null {
  if (tsMorphModule !== undefined) return tsMorphModule;
  try {
    tsMorphModule = require('ts-morph') as TsMorphModule;
  } catch {
    tsMorphModule = null;
  }
  return tsMorphModule;
}

function unavailableProvider(reason: string, tsconfigPath?: string, tsconfigPaths?: string[]): SemanticProvider {
  return {
    language: 'typescript',
    availability: () => ({ available: false, reason, tsconfigPath, tsconfigPaths }),
    importUsage: () => [],
    referencesFor: () => [],
    calleesFor: () => [],
    signatureFor: () => null,
  };
}

class TsMorphSemanticProvider implements SemanticProvider {
  readonly language = 'typescript' as const;
  private readonly importUsageCache = new Map<string, SemanticImportUsage[]>();
  private readonly referencesCache = new Map<number, SemanticReference[]>();
  private readonly calleesCache = new Map<number, SemanticCallee[]>();
  private readonly fileCalleesCache = new Map<string, Map<number, SemanticCallee[]>>();
  private readonly signatureCache = new Map<number, string | null>();
  private readonly sourceFileCache = new Map<string, SourceFileMatch | null>();
  private readonly definitionNodeCache = new Map<number, Node | null>();
  private readonly fileDefinitionNodeCache = new Map<string, Map<number, Node>>();
  private readonly indexedDefinitionLeafCache = new Map<string, Map<string, IndexedDefinition>>();
  private packageImportReferenceIndex: Map<number, SemanticReference[]> | null = null;
  private packageExportIndex: PackageExportIndex | null = null;
  private readonly workspacePackages: WorkspacePackage[];

  constructor(
    private readonly db: ScipDatabase,
    private readonly tsMorph: TsMorphModule,
    private readonly projects: ProjectBundle[],
  ) {
    this.workspacePackages = discoverWorkspacePackages(db.config.projectRoot);
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
      const sourceFile = this.sourceFile(file);
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

  signatureFor(definition: IndexedDefinition): string | null {
    return cached(this.signatureCache, definition.symbolId, () => {
      const node = this.nodeForDefinition(definition);
      if (!node) return null;
      if (!this.tsMorph.Node.isFunctionDeclaration(node)
        && !this.tsMorph.Node.isMethodDeclaration(node)
        && !this.tsMorph.Node.isArrowFunction(node)
        && !this.tsMorph.Node.isFunctionExpression(node)
        && !this.tsMorph.Node.isConstructorDeclaration(node)) {
        return null;
      }
      const signature = node.getType().getCallSignatures()[0];
      if (!signature) return null;
      const params = signature.getParameters().map((param) => {
        const decl = param.getDeclarations()[0];
        const type = decl ? param.getTypeAtLocation(decl).getText(decl) : param.getValueDeclaration()?.getType().getText() ?? 'unknown';
        return normalizeType(type);
      });
      const returnType = signature.getReturnType().getText(node);
      return `(${params.join(',')})=>${normalizeType(returnType)}`;
    });
  }

  private importUsageForDeclaration(
    importer: string,
    declaration: ImportDeclaration,
  ): SemanticImportUsage[] {
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
      for (const location of referenceLocationsWithoutDeclaration(ref, importer, entry.identifier, this.db.config.projectRoot)) {
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

  private sourceFile(relativePath: string): SourceFile | null {
    return this.sourceFileMatch(relativePath)?.sourceFile ?? null;
  }

  private sourceFileMatch(relativePath: string): SourceFileMatch | null {
    if (!isTypeScriptLike(relativePath)) return null;
    return cached(this.sourceFileCache, relativePath, () => {
      const fullPath = path.join(this.db.config.projectRoot, relativePath);
      for (const { project } of this.projects) {
        const sourceFile = project.getSourceFile(fullPath)
          ?? project.addSourceFileAtPathIfExists(fullPath)
          ?? null;
        if (sourceFile) return { project, sourceFile };
      }
      return null;
    });
  }

  private packageImportReferencesForDefinition(definition: IndexedDefinition): SemanticReference[] {
    const index = this.packageImportReferences();
    return index.get(definition.symbolId) ?? [];
  }

  private packageImportReferences(): Map<number, SemanticReference[]> {
    if (this.packageImportReferenceIndex) return this.packageImportReferenceIndex;
    const index = new Map<number, SemanticReference[]>();
    const exportIndex = this.packageExports();
    for (const relativePath of this.indexedTypeScriptLikeDocuments()) {
      this.addPackageImportReferencesForDocument(index, exportIndex, relativePath);
    }

    for (const [key, references] of index) {
      index.set(key, dedupeLocations(references));
    }
    this.packageImportReferenceIndex = index;
    return index;
  }

  private indexedTypeScriptLikeDocuments(): string[] {
    return this.db.all<{ relative_path: string }>(
      `SELECT relative_path
       FROM documents
       WHERE (
         relative_path LIKE '%.ts'
         OR relative_path LIKE '%.tsx'
         OR relative_path LIKE '%.mts'
         OR relative_path LIKE '%.cts'
         OR relative_path LIKE '%.js'
         OR relative_path LIKE '%.jsx'
         OR relative_path LIKE '%.mjs'
         OR relative_path LIKE '%.cjs'
       )
         ${this.db.pathExclusionsFor('documents')}`,
    ).map((document) => document.relative_path);
  }

  private addPackageImportReferencesForDocument(
    index: Map<number, SemanticReference[]>,
    exportIndex: PackageExportIndex,
    relativePath: string,
  ): void {
    if (this.db.isIgnored(relativePath)) return;
    const match = this.sourceFileMatch(relativePath);
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
    const sourceFile = this.sourceFile(entryFile);
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
    return cached(this.definitionNodeCache, definition.symbolId, () =>
      this.definitionNodesForFile(definition.relativePath).get(definition.symbolId) ?? null,
    );
  }

  private definitionNodesForFile(relativePath: string): Map<number, Node> {
    return cached(this.fileDefinitionNodeCache, relativePath, () => {
      const sourceFile = this.sourceFile(relativePath);
      if (!sourceFile) return new Map();
      const definitionsByLeaf = definitionsByLeafForFile(this.db, relativePath);
      if (definitionsByLeaf.size === 0) return new Map();
      return matchDefinitionNodes(this.tsMorph, sourceFile, definitionsByLeaf);
    });
  }

  private definitionFromSymbol(symbol: Symbol): { symbol: string; file: string; line: number } | null {
    const declarations = symbol.getDeclarations();
    for (const declaration of declarations) {
      const sourceFile = declaration.getSourceFile();
      const file = toRelative(this.db.config.projectRoot, sourceFile.getFilePath());
      if (!file || this.db.isIgnored(file)) continue;
      const line = lineOf(sourceFile, declaration);
      const match = findIndexedDefinitionNear(this.db, file, line, symbol.getName());
      if (match) return { symbol: match.symbol, file: match.relativePath, line: match.startLine };
    }
    return null;
  }

  // scip-query: ignore-extract — this builds the TypeScript semantic callee
  // map for one file; source-file lookup, indexed definitions, descendant
  // traversal, and dedupe are one adapter pass.
  private calleeMapForFile(relativePath: string): Map<number, SemanticCallee[]> {
    const sourceFile = this.sourceFile(relativePath);
    if (!sourceFile) return new Map();

    const definitions = getDefinitionsForFile(this.db, relativePath)
      .sort((left, right) => left.startLine - right.startLine || right.endLine - left.endLine);
    if (definitions.length === 0) return new Map();

    const out = new Map<number, SemanticCallee[]>();
    sourceFile.forEachDescendant((node) => {
      if (!this.tsMorph.Node.isCallExpression(node) && !this.tsMorph.Node.isNewExpression(node)) return;
      const callee = this.semanticCalleeForCallNode(sourceFile, definitions, node);
      if (callee) addSemanticCallee(out, callee.callerId, callee.target);
    });

    for (const [symbolId, callees] of out) {
      out.set(symbolId, dedupeCallees(callees));
    }
    return out;
  }

  private semanticCalleeForCallNode(
    sourceFile: SourceFile,
    definitions: ReadonlyArray<IndexedDefinition>,
    node: CallExpression | NewExpression,
  ): { callerId: number; target: SemanticCallee } | null {
    const caller = findContainingDefinition(definitions, lineOf(sourceFile, node));
    if (!caller) return null;
    const expression = node.getExpression();
    const symbol = expression.getSymbol() ?? expression.getType().getSymbol();
    const target = symbol ? this.definitionFromSymbol(symbol) : null;
    return target
      ? { callerId: caller.symbolId, target: { symbol: target.symbol, file: target.file, line: target.line } }
      : null;
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
    const identifier = alias ?? (name.getKindName() === 'Identifier' ? name as Identifier : null);
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

function definitionsByLeafForFile(db: ScipDatabase, relativePath: string): Map<string, IndexedDefinition[]> {
  const definitionsByLeaf = new Map<string, IndexedDefinition[]>();
  for (const definition of getDefinitionsForFile(db, relativePath)) {
    const leaf = leafName(definition.symbol) ?? definition.leaf;
    if (!leaf) continue;
    let bucket = definitionsByLeaf.get(leaf);
    if (!bucket) {
      bucket = [];
      definitionsByLeaf.set(leaf, bucket);
    }
    bucket.push(definition);
  }
  return definitionsByLeaf;
}

function matchDefinitionNodes(
  tsMorph: TsMorphModule,
  sourceFile: SourceFile,
  definitionsByLeaf: ReadonlyMap<string, readonly IndexedDefinition[]>,
): Map<number, Node> {
  const nodes = new Map<number, Node>();
  const distanceBySymbolId = new Map<number, number>();
  sourceFile.forEachDescendant((node) => {
    for (const name of nodeNames(tsMorph, node)) {
      const definitions = definitionsByLeaf.get(name);
      if (!definitions) continue;
      const line = lineOf(sourceFile, node);
      for (const definition of definitions) {
        if (line < definition.startLine - 1 || line > definition.endLine + 1) continue;
        const distance = Math.abs(line - definition.startLine);
        const previous = distanceBySymbolId.get(definition.symbolId);
        if (previous !== undefined && previous <= distance) continue;
        distanceBySymbolId.set(definition.symbolId, distance);
        nodes.set(definition.symbolId, node);
      }
    }
  });
  return nodes;
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

function addSemanticCallee(
  out: Map<number, SemanticCallee[]>,
  callerId: number,
  target: SemanticCallee,
): void {
  let bucket = out.get(callerId);
  if (!bucket) {
    bucket = [];
    out.set(callerId, bucket);
  }
  bucket.push(target);
}

function nodeNames(tsMorph: TsMorphModule, node: Node): string[] {
  const names: string[] = [];
  const add = (name: string | undefined): void => {
    if (name && !names.includes(name)) names.push(name);
  };
  if ('getNameNode' in node && typeof node.getNameNode === 'function') {
    const nameNode = (node as { getNameNode(): Node | undefined }).getNameNode();
    add(nameNode?.getText());
  }
  if ('getName' in node && typeof node.getName === 'function') {
    const got = (node as { getName(): string | undefined }).getName();
    add(got);
  }
  if (tsMorph.Node.isIdentifier(node)) add(node.getText());
  return names;
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

function cached<K, V>(map: Map<K, V>, key: K, compute: () => V): V {
  if (map.has(key)) return map.get(key)!;
  const value = compute();
  map.set(key, value);
  return value;
}

function isTypeScriptLike(relativePath: string): boolean {
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(relativePath);
}

function normalizeType(type: string): string {
  return type
    .replace(/\s+/g, ' ')
    .replace(/\bimport\("[^"]+"\)\./g, '')
    .trim();
}
