import path from 'node:path';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { resolveImportPath } from '../../resolution/import-path-resolver.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { leafName } from '../../symbols/symbol-parser.js';
import type {
  SemanticAvailability,
  SemanticCallee,
  SemanticImportUsage,
  SemanticLocation,
  SemanticProvider,
  SemanticReference,
} from '../types.js';
import { discoverTypeScriptTsconfigs } from './tsconfig-discovery.js';

type TsMorphModule = typeof import('ts-morph');
type Project = import('ts-morph').Project;
type SourceFile = import('ts-morph').SourceFile;
type Node = import('ts-morph').Node;
type ImportDeclaration = import('ts-morph').ImportDeclaration;
type Identifier = import('ts-morph').Identifier;
type ReferencedSymbol = import('ts-morph').ReferencedSymbol;
type Symbol = import('ts-morph').Symbol;

interface ProjectBundle {
  tsconfigPath: string;
  project: Project;
}

interface SourceFileMatch {
  project: Project;
  sourceFile: SourceFile;
}

interface WorkspacePackage {
  name: string;
  rootRelative: string;
  sourceRootRelative: string;
}

type PackageExportIndex = Map<string, Map<string, Set<number>>>;

const require = createRequire(import.meta.url);
let tsMorphModule: TsMorphModule | null | undefined;

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
        results.push(...this.importUsageForDeclaration(file, declaration));
      }
      return results;
    });
  }

  referencesFor(definition: IndexedDefinition): SemanticReference[] {
    return cached(this.referencesCache, definition.symbolId, () => {
      const node = this.nodeForDefinition(definition);
      const packageRefs = this.packageImportReferencesForDefinition(definition);
      if (!node) return packageRefs;
      const refs = findReferencesForNode(node);
      return dedupeLocations(
        [
          ...refs.flatMap((ref: ReferencedSymbol) => referenceLocations(ref, this.db.config.projectRoot))
            .filter((location) => location.file !== definition.relativePath || location.line < definition.startLine || location.line > definition.endLine),
          ...packageRefs,
        ],
      );
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
    if (declaration.getImportClause()?.isTypeOnly()) {
      return importIdentifiers(declaration).map((entry) => ({
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
      }));
    }

    return importIdentifiers(declaration).map((entry) => {
      const identifier = entry.identifier;
      const refs = identifier ? identifier.findReferences() : [];
      const referenceLocations = refs.flatMap((ref) =>
        referenceLocationsWithoutDeclaration(ref, importer, identifier, this.db.config.projectRoot),
      );
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
    });
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
    const documents = this.db.all<{ relative_path: string }>(
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
    );

    for (const document of documents) {
      if (this.db.isIgnored(document.relative_path)) continue;
      const match = this.sourceFileMatch(document.relative_path);
      if (!match) continue;
      for (const declaration of match.sourceFile.getImportDeclarations()) {
        const packageName = workspacePackageNameForSpecifier(this.workspacePackages, declaration.getModuleSpecifierValue());
        if (!packageName) continue;
        const exportedSymbols = exportIndex.get(packageName);
        if (!exportedSymbols) continue;
        for (const entry of importIdentifiers(declaration)) {
          if (entry.kind !== 'named' || !entry.identifier) continue;
          const symbolIds = exportedSymbols.get(entry.importedName);
          if (!symbolIds || symbolIds.size === 0) continue;
          const refs = textualIdentifierLocations(entry.identifier, document.relative_path, this.db.config.projectRoot);
          if (refs.length === 0) continue;
          for (const symbolId of symbolIds) {
            const bucket = index.get(symbolId) ?? [];
            bucket.push(...refs);
            index.set(symbolId, bucket);
          }
        }
      }
    }

    for (const [key, references] of index) {
      index.set(key, dedupeLocations(references));
    }
    this.packageImportReferenceIndex = index;
    return index;
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

  private nodeForDefinition(definition: IndexedDefinition): Node | null {
    const sourceFile = this.sourceFile(definition.relativePath);
    if (!sourceFile) return null;
    const leaf = leafName(definition.symbol) ?? definition.leaf;
    const candidates: Node[] = [];
    sourceFile.forEachDescendant((node) => {
      if (!nodeHasName(this.tsMorph, node, leaf)) return;
      const line = lineOf(sourceFile, node);
      if (line < definition.startLine - 1 || line > definition.endLine + 1) return;
      candidates.push(node);
    });
    return candidates.sort((left, right) =>
      Math.abs(lineOf(sourceFile, left) - definition.startLine)
      - Math.abs(lineOf(sourceFile, right) - definition.startLine),
    )[0] ?? null;
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

  private calleeMapForFile(relativePath: string): Map<number, SemanticCallee[]> {
    const sourceFile = this.sourceFile(relativePath);
    if (!sourceFile) return new Map();

    const definitions = getDefinitionsForFile(this.db, relativePath)
      .sort((left, right) => left.startLine - right.startLine || right.endLine - left.endLine);
    if (definitions.length === 0) return new Map();

    const out = new Map<number, SemanticCallee[]>();
    sourceFile.forEachDescendant((node) => {
      if (!this.tsMorph.Node.isCallExpression(node) && !this.tsMorph.Node.isNewExpression(node)) return;
      const startLine = lineOf(sourceFile, node);
      const caller = findContainingDefinition(definitions, startLine);
      if (!caller) return;

      const expression = node.getExpression();
      if (!expression) return;
      const symbol = expression.getSymbol() ?? expression.getType().getSymbol();
      const target = symbol ? this.definitionFromSymbol(symbol) : null;
      if (!target) return;

      let bucket = out.get(caller.symbolId);
      if (!bucket) {
        bucket = [];
        out.set(caller.symbolId, bucket);
      }
      bucket.push({
        symbol: target.symbol,
        file: target.file,
        line: target.line,
      });
    });

    for (const [symbolId, callees] of out) {
      out.set(symbolId, dedupeCallees(callees));
    }
    return out;
  }
}

function importIdentifiers(declaration: ImportDeclaration): Array<{
  identifier: Identifier | null;
  importedName: string;
  localName: string | null;
  kind: SemanticImportUsage['kind'];
  isTypeOnly: boolean;
}> {
  const out: Array<{
    identifier: Identifier | null;
    importedName: string;
    localName: string | null;
    kind: SemanticImportUsage['kind'];
    isTypeOnly: boolean;
  }> = [];
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

function discoverWorkspacePackages(projectRoot: string): WorkspacePackage[] {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) return [];

  let rootPackage: { workspaces?: string[] | { packages?: string[] } };
  try {
    rootPackage = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as typeof rootPackage;
  } catch {
    return [];
  }

  const patterns = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages ?? [];

  return patterns
    .flatMap((pattern) => workspacePackageDirs(projectRoot, pattern))
    .flatMap((packageRoot) => workspacePackageFromDir(projectRoot, packageRoot));
}

function workspacePackageDirs(projectRoot: string, pattern: string): string[] {
  if (!pattern || pattern.startsWith('!') || pattern.includes('node_modules')) return [];
  if (!pattern.includes('*')) {
    const candidate = path.join(projectRoot, pattern);
    return existsSync(path.join(candidate, 'package.json')) ? [candidate] : [];
  }
  const star = pattern.indexOf('*');
  const prefix = pattern.slice(0, star).replace(/\/$/, '');
  const suffix = pattern.slice(star + 1).replace(/^\//, '');
  const base = path.join(projectRoot, prefix || '.');
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base)
      .map((entry) => path.join(base, entry, suffix))
      .filter((candidate) => existsSync(path.join(candidate, 'package.json')));
  } catch {
    return [];
  }
}

function workspacePackageFromDir(projectRoot: string, packageRoot: string): WorkspacePackage[] {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { name?: string };
    if (!packageJson.name) return [];
    const rootRelative = path.relative(projectRoot, packageRoot).replace(/\\/g, '/');
    return [{
      name: packageJson.name,
      rootRelative,
      sourceRootRelative: `${rootRelative}/src`,
    }];
  } catch {
    return [];
  }
}

function workspacePackageNameForSpecifier(
  packages: ReadonlyArray<WorkspacePackage>,
  specifier: string,
): string | null {
  for (const pkg of packages) {
    if (specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)) return pkg.name;
  }
  return null;
}

function packageEntryCandidates(pkg: WorkspacePackage): string[] {
  return [
    `${pkg.sourceRootRelative}/index.ts`,
    `${pkg.sourceRootRelative}/index.tsx`,
    `${pkg.sourceRootRelative}/index.mts`,
    `${pkg.sourceRootRelative}/index.cts`,
  ];
}

function referenceLocations(ref: ReferencedSymbol, projectRoot: string): SemanticReference[] {
  return ref.getReferences().map((entry) => {
    const node = entry.getNode();
    return toSemanticLocation(node, projectRoot);
  });
}

function findReferencesForNode(node: Node): ReferencedSymbol[] {
  const maybeReferenceable = node as Node & { findReferences?: () => ReferencedSymbol[] };
  if (typeof maybeReferenceable.findReferences === 'function') {
    return maybeReferenceable.findReferences();
  }
  return [];
}

function referenceLocationsWithoutDeclaration(
  ref: ReferencedSymbol,
  importer: string,
  declarationIdentifier: Identifier | null,
  projectRoot: string,
): Array<{ location: SemanticLocation; node: Node }> {
  return ref.getReferences()
    .map((entry) => entry.getNode())
    .filter((node) => toRelative(projectRoot, node.getSourceFile().getFilePath()) === importer)
    .filter((node) => !declarationIdentifier || node.getStart() !== declarationIdentifier.getStart())
    .map((node) => ({ location: toSemanticLocation(node, projectRoot), node }));
}

function toSemanticLocation(node: Node, projectRoot: string): SemanticLocation {
  const sourceFile = node.getSourceFile();
  const pos = sourceFile.getLineAndColumnAtPos(node.getStart());
  return {
    file: toRelative(projectRoot, sourceFile.getFilePath()) ?? sourceFile.getBaseName(),
    line: pos.line - 1,
    column: pos.column - 1,
  };
}

function textualIdentifierLocations(
  identifier: Identifier,
  importer: string,
  projectRoot: string,
): SemanticReference[] {
  const sourceFile = identifier.getSourceFile();
  const declarationLine = lineOf(sourceFile, identifier);
  const name = identifier.getText();
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
  const lines = sourceFile.getFullText().split('\n');
  const locations: SemanticReference[] = [];

  for (let line = 0; line < lines.length; line++) {
    if (line === declarationLine) continue;
    const text = lines[line] ?? '';
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      locations.push({
        file: importer,
        line,
        column: match.index,
      });
    }
  }

  return dedupeLocations(locations.filter((location) =>
    toRelative(projectRoot, path.join(projectRoot, location.file)) === importer,
  ));
}

function isTypeOnlyLocation(node: Node): boolean {
  for (let current: Node | undefined = node; current; current = current.getParent()) {
    const kind = current.getKindName();
    if (kind.includes('Type') || kind === 'InterfaceDeclaration' || kind === 'TypeAliasDeclaration') return true;
    if (kind === 'CallExpression' || kind === 'NewExpression' || kind === 'ExpressionStatement') return false;
  }
  return false;
}

function nodeHasName(tsMorph: TsMorphModule, node: Node, name: string): boolean {
  if ('getNameNode' in node && typeof node.getNameNode === 'function') {
    const nameNode = (node as { getNameNode(): Node | undefined }).getNameNode();
    if (nameNode?.getText() === name) return true;
  }
  if ('getName' in node && typeof node.getName === 'function') {
    const got = (node as { getName(): string | undefined }).getName();
    if (got === name) return true;
  }
  return tsMorph.Node.isIdentifier(node) && node.getText() === name;
}

function findIndexedDefinitionNear(
  db: ScipDatabase,
  file: string,
  line: number,
  symbolName: string,
): IndexedDefinition | null {
  const rows = db.all<IndexedDefinition>(
    `SELECT
       gs.id AS symbolId,
       gs.symbol,
       d.relative_path AS relativePath,
       COALESCE(der.start_line, c.start_line) AS startLine,
       COALESCE(der.end_line, c.end_line) AS endLine,
       COALESCE(gs.display_name, '') AS leaf,
       NULL AS parentTypeName,
       CASE WHEN gs.kind IN (6, 12, 13) OR gs.symbol LIKE '%().' THEN 1 ELSE 0 END AS isFunctionLike,
       CASE WHEN gs.kind IN (5, 8, 11) THEN 1 ELSE 0 END AS isTypeLike,
       gs.kind AS kind,
       gs.documentation AS documentation,
       gs.enclosing_symbol AS enclosingSymbol
     FROM global_symbols gs
     LEFT JOIN defn_enclosing_ranges der ON der.symbol_id = gs.id
     LEFT JOIN chunks c ON c.document_id = der.document_id
     JOIN documents d ON d.id = der.document_id
     WHERE d.relative_path = ?
       AND COALESCE(gs.display_name, gs.symbol) LIKE ?
     ORDER BY ABS(COALESCE(der.start_line, c.start_line) - ?)
     LIMIT 5`,
    file,
    `%${symbolName}%`,
    line,
  );
  return rows[0] ?? null;
}

function indexedDefinitionLeafMap(
  db: ScipDatabase,
  file: string,
): Map<string, IndexedDefinition> {
  const rows = db.all<IndexedDefinition>(
    `SELECT
       d.id AS documentId,
       gs.id AS symbolId,
       gs.symbol,
       d.relative_path AS relativePath,
       der.start_line AS startLine,
       der.end_line AS endLine,
       COALESCE(gs.display_name, '') AS leaf,
       NULL AS parentTypeName,
       CASE WHEN gs.kind IN (6, 12, 13) OR gs.symbol LIKE '%().' THEN 1 ELSE 0 END AS isFunctionLike,
       CASE WHEN gs.kind IN (5, 8, 11) THEN 1 ELSE 0 END AS isTypeLike,
       gs.kind AS kind,
       gs.documentation AS documentation,
       gs.enclosing_symbol AS enclosingSymbol
     FROM global_symbols gs
     JOIN defn_enclosing_ranges der ON der.symbol_id = gs.id
     JOIN documents d ON d.id = der.document_id
     WHERE d.relative_path = ?
     UNION ALL
     SELECT
       d.id AS documentId,
       gs.id AS symbolId,
       gs.symbol,
       d.relative_path AS relativePath,
       MIN(c.start_line) AS startLine,
       MAX(c.end_line) AS endLine,
       COALESCE(gs.display_name, '') AS leaf,
       NULL AS parentTypeName,
       CASE WHEN gs.kind IN (6, 12, 13) OR gs.symbol LIKE '%().' THEN 1 ELSE 0 END AS isFunctionLike,
       CASE WHEN gs.kind IN (5, 8, 11) THEN 1 ELSE 0 END AS isTypeLike,
       gs.kind AS kind,
       gs.documentation AS documentation,
       gs.enclosing_symbol AS enclosingSymbol
     FROM global_symbols gs
     JOIN mentions m ON m.symbol_id = gs.id
     JOIN chunks c ON c.id = m.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE d.relative_path = ?
       AND m.role = 1
     GROUP BY gs.id, gs.symbol, d.id, d.relative_path, gs.display_name, gs.kind, gs.documentation, gs.enclosing_symbol
     ORDER BY startLine, endLine`,
    file,
    file,
  );
  const byId = new Set<number>();
  const byLeaf = new Map<string, IndexedDefinition>();
  for (const row of rows) {
    if (byId.has(row.symbolId)) continue;
    byId.add(row.symbolId);
    const leaf = row.leaf || leafName(row.symbol);
    if (!leaf || byLeaf.has(leaf)) continue;
    byLeaf.set(leaf, { ...row, leaf });
  }
  return byLeaf;
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

function lineOf(sourceFile: SourceFile, node: Node): number {
  return sourceFile.getLineAndColumnAtPos(node.getStart()).line - 1;
}

function dedupeLocations(locations: SemanticReference[]): SemanticReference[] {
  const seen = new Set<string>();
  const out: SemanticReference[] = [];
  for (const location of locations) {
    const key = `${location.file}:${location.line}:${location.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(location);
  }
  return out;
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

function toRelative(root: string, fullPath: string): string | null {
  const relative = path.relative(root || process.cwd(), fullPath).replace(/\\/g, '/');
  if (!relative || relative.startsWith('..')) return null;
  return relative;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
