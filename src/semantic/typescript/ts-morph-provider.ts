import path from 'node:path';
import { createRequire } from 'node:module';
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
import { findNearestTsconfig } from './tsconfig-discovery.js';

type TsMorphModule = typeof import('ts-morph');
type Project = import('ts-morph').Project;
type SourceFile = import('ts-morph').SourceFile;
type Node = import('ts-morph').Node;
type ImportDeclaration = import('ts-morph').ImportDeclaration;
type Identifier = import('ts-morph').Identifier;
type ReferencedSymbol = import('ts-morph').ReferencedSymbol;
type Symbol = import('ts-morph').Symbol;

const require = createRequire(import.meta.url);
let tsMorphModule: TsMorphModule | null | undefined;

export function createTsMorphProvider(
  db: ScipDatabase,
  relativePath?: string,
): SemanticProvider {
  const mod = loadTsMorph();
  if (!mod) {
    return unavailableProvider('ts-morph is not installed');
  }

  const tsconfigPath = findNearestTsconfig(db.config.projectRoot, relativePath);
  if (!tsconfigPath) {
    return unavailableProvider('no tsconfig found');
  }

  try {
    const project = new mod.Project({
      tsConfigFilePath: tsconfigPath,
      skipFileDependencyResolution: false,
    });
    return new TsMorphSemanticProvider(db, mod, project, tsconfigPath);
  } catch (error) {
    return unavailableProvider(error instanceof Error ? error.message : String(error), tsconfigPath);
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

function unavailableProvider(reason: string, tsconfigPath?: string): SemanticProvider {
  return {
    language: 'typescript',
    availability: () => ({ available: false, reason, tsconfigPath }),
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

  constructor(
    private readonly db: ScipDatabase,
    private readonly tsMorph: TsMorphModule,
    private readonly project: Project,
    private readonly tsconfigPath: string,
  ) {}

  availability(): SemanticAvailability {
    return { available: true, tsconfigPath: this.tsconfigPath };
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
      if (!node) return [];
      const refs = findReferencesForNode(node);
      return dedupeLocations(
        refs.flatMap((ref: ReferencedSymbol) => referenceLocations(ref, this.db.config.projectRoot))
          .filter((location) => location.file !== definition.relativePath || location.line < definition.startLine || location.line > definition.endLine),
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
    if (!isTypeScriptLike(relativePath)) return null;
    const fullPath = path.join(this.db.config.projectRoot, relativePath);
    return this.project.getSourceFile(fullPath)
      ?? this.project.addSourceFileAtPathIfExists(fullPath)
      ?? null;
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
