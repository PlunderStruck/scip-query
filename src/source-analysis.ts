import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
} from 'node:path';
import type { ScipDatabase } from './db.js';
import { detectAstLanguage, getAst, getConstructorBindings, getDetailedCallSites, type SyntaxNode, type Tree } from './ast.js';

export interface ParsedSourceImport {
  importedName: string;
  localName: string | null;
  sourcePath: string | null;
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
  used: boolean;
  usedMembers: string[];
}

export interface ParsedSourceExport {
  sourcePath: string | null;
  specifier: string;
}

/**
 * A re-export statement in a JavaScript/TypeScript source file — one of:
 *   export { X [as Y] } from './path'
 *   export type { X } from './path'
 *   export * from './path'
 *   export * as Ns from './path'
 *
 * The `sourcePath` is the resolved, project-relative path to the re-exported
 * module (same convention as ParsedSourceImport.sourcePath).
 */
export interface ParsedReExport {
  kind: 'named' | 'star' | 'star-as';
  sourcePath: string | null;
  /** For 'named': the list of re-exported identifiers as they appear in THIS file. */
  names: string[];
  /** Start line in the source (0-indexed) — inclusive. */
  startLine: number;
  /** End line in the source (0-indexed) — inclusive. */
  endLine: number;
}

export interface ParsedSourceCall {
  calleeName: string;
  receiverName: string | null;
  line: number;
}

export interface ParsedSourceBinding {
  localName: string;
  typeName: string;
}

const SOURCE_IMPORT_CACHE = new WeakMap<ScipDatabase, Map<string, ParsedSourceImport[]>>();
const SOURCE_EXPORT_CACHE = new WeakMap<ScipDatabase, Map<string, ParsedSourceExport[]>>();
const SOURCE_TEXT_CACHE = new WeakMap<ScipDatabase, Map<string, string>>();
const SOURCE_CALL_CACHE = new WeakMap<ScipDatabase, Map<string, ParsedSourceCall[]>>();
const SOURCE_BINDING_CACHE = new WeakMap<ScipDatabase, Map<string, ParsedSourceBinding[]>>();
const INDEXED_PATH_CACHE = new WeakMap<ScipDatabase, Set<string>>();

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const PYTHON_SOURCE_EXTENSIONS = ['.py', '.pyi'] as const;
const JVM_SOURCE_EXTENSIONS = ['.java', '.scala', '.kt', '.kts'] as const;
const RUST_SOURCE_EXTENSIONS = ['.rs'] as const;
const RUBY_SOURCE_EXTENSIONS = ['.rb'] as const;
const C_LIKE_SOURCE_EXTENSIONS = ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'] as const;
const DOTNET_SOURCE_EXTENSIONS = ['.cs', '.vb'] as const;
const DART_SOURCE_EXTENSIONS = ['.dart'] as const;
const PHP_SOURCE_EXTENSIONS = ['.php'] as const;

export function getSourceImports(
  db: ScipDatabase,
  relativePath: string,
): ParsedSourceImport[] {
  const cache = getCachedMap(SOURCE_IMPORT_CACHE, db);
  const normalized = normalizePath(relativePath);
  const cached = cache.get(normalized);
  if (cached) {
    return cached;
  }

  const fullPath = join(db.config.projectRoot, normalized);
  if (!existsSync(fullPath)) {
    cache.set(normalized, []);
    return [];
  }

  const source = readFileSync(fullPath, 'utf-8');
  const parsed = isPythonSourcePath(normalized)
    ? parsePythonImports(db, normalized, source)
    : isJavaScriptSourcePath(normalized)
      ? parseJavaScriptImports(db, normalized, source)
      : isJvmSourcePath(normalized)
        ? parseJvmImports(db, normalized, source)
        : isRustSourcePath(normalized)
          ? parseRustImports(db, normalized, source)
          : isRubySourcePath(normalized)
            ? parseRubyImports(db, normalized, source)
            : isCLikeSourcePath(normalized)
              ? parseCLikeImports(db, normalized, source)
              : isDotNetSourcePath(normalized)
                ? parseDotNetImports(db, normalized, source)
                : isDartSourcePath(normalized)
                  ? parseDartImports(db, normalized, source)
                  : isPhpSourcePath(normalized)
                    ? parsePhpImports(db, normalized, source)
                    : [];

  cache.set(normalized, parsed);
  return parsed;
}

export function getSourceExports(
  db: ScipDatabase,
  relativePath: string,
): ParsedSourceExport[] {
  const cache = getCachedMap(SOURCE_EXPORT_CACHE, db);
  const normalized = normalizePath(relativePath);
  const cached = cache.get(normalized);
  if (cached) {
    return cached;
  }

  const fullPath = join(db.config.projectRoot, normalized);
  if (!existsSync(fullPath)) {
    cache.set(normalized, []);
    return [];
  }

  const source = readFileSync(fullPath, 'utf-8');
  const parsed = isDartSourcePath(normalized)
    ? parseDartExports(db, normalized, source)
    : isRustSourcePath(normalized)
      ? parseRustExports(db, normalized, source)
    : [];

  cache.set(normalized, parsed);
  return parsed;
}

export function getSourceCalls(
  db: ScipDatabase,
  relativePath: string,
  opts: { startLine?: number; endLine?: number } = {},
): ParsedSourceCall[] {
  const normalized = normalizePath(relativePath);
  if (!isPythonSourcePath(normalized) && !isJavaScriptSourcePath(normalized)) {
    return [];
  }

  const cache = getCachedMap(SOURCE_CALL_CACHE, db);
  const key = `${normalized}:${opts.startLine ?? 0}:${opts.endLine ?? Number.MAX_SAFE_INTEGER}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  // AST path: tree-sitter call_expression / new_expression nodes give exact
  // call attribution with receiver info. No regex tokenization, no false
  // positives from comment/string content, no missed cases from edge syntax.
  const detailed = getDetailedCallSites(db, normalized);
  if (detailed) {
    const startLine = opts.startLine ?? 0;
    const endLine = opts.endLine ?? Number.MAX_SAFE_INTEGER;
    const calls: ParsedSourceCall[] = detailed
      .filter((c) => c.line >= startLine && c.line <= endLine)
      .map((c) => ({ calleeName: c.calleeName, receiverName: c.receiverName, line: c.line }));
    cache.set(key, calls);
    return calls;
  }

  const source = getSourceText(db, normalized);
  if (!source) {
    cache.set(key, []);
    return [];
  }

  const lines = source.split('\n');
  const startLine = Math.max(0, opts.startLine ?? 0);
  const endLine = Math.min(lines.length - 1, opts.endLine ?? lines.length - 1);
  const scopedLines = lines.slice(startLine, endLine + 1);
  const calls = isPythonSourcePath(normalized)
    ? parsePythonCalls(scopedLines, startLine)
    : parseJavaScriptCalls(scopedLines, startLine);

  cache.set(key, calls);
  return calls;
}

export function getSourceConstructorBindings(
  db: ScipDatabase,
  relativePath: string,
  opts: { startLine?: number; endLine?: number } = {},
): ParsedSourceBinding[] {
  const normalized = normalizePath(relativePath);
  if (!isPythonSourcePath(normalized) && !isJavaScriptSourcePath(normalized)) {
    return [];
  }

  const cache = getCachedMap(SOURCE_BINDING_CACHE, db);
  const key = `${normalized}:${opts.startLine ?? 0}:${opts.endLine ?? Number.MAX_SAFE_INTEGER}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  // AST path: variable_declarator with new_expression / call_expression value
  // is the canonical "x is bound to type Foo" pattern. The regex parser had to
  // hand-write this for each language; AST queries express it once.
  const astBindings = getConstructorBindings(db, normalized);
  if (astBindings) {
    const result: ParsedSourceBinding[] = astBindings.map((b) => ({
      localName: b.localName,
      typeName: b.typeName,
    }));
    cache.set(key, result);
    return result;
  }

  const source = getSourceText(db, normalized);
  if (!source) {
    cache.set(key, []);
    return [];
  }

  const lines = source.split('\n');
  const startLine = Math.max(0, opts.startLine ?? 0);
  const endLine = Math.min(lines.length - 1, opts.endLine ?? lines.length - 1);
  const scopedLines = lines.slice(startLine, endLine + 1);
  const bindings = isPythonSourcePath(normalized)
    ? parsePythonConstructorBindings(scopedLines)
    : parseJavaScriptConstructorBindings(scopedLines);

  cache.set(key, bindings);
  return bindings;
}

export function findIdentifierLines(
  db: ScipDatabase,
  relativePath: string,
  identifier: string,
  opts: { excludeStartLine?: number; excludeEndLine?: number } = {},
): number[] {
  if (!identifier) {
    return [];
  }

  const source = getSourceText(db, normalizePath(relativePath));
  if (!source) {
    return [];
  }

  const lines = stripCommentsAndStrings(source).split('\n');
  const regex = new RegExp(`\\b${escapeRegex(identifier)}\\b`);
  const results: number[] = [];

  for (let line = 0; line < lines.length; line++) {
    if (
      typeof opts.excludeStartLine === 'number'
      && typeof opts.excludeEndLine === 'number'
      && line >= opts.excludeStartLine
      && line <= opts.excludeEndLine
    ) {
      continue;
    }

    if (regex.test(lines[line] ?? '')) {
      results.push(line);
    }
  }

  return results;
}

/**
 * Parse all re-export statements (`export ... from '...'`) in a JS/TS source.
 * Returns each statement's kind, resolved source path, re-exported local
 * names (for named re-exports), and line range.
 *
 * Returns an empty array for non-JS/TS source paths.
 */
export function getReExports(
  db: ScipDatabase,
  relativePath: string,
): ParsedReExport[] {
  const normalized = normalizePath(relativePath);
  if (!isJavaScriptSourcePath(normalized)) return [];
  const tree = getAst(db, normalized);
  if (tree) return getReExportsAst(db, normalized, tree);

  const source = getSourceText(db, normalized);
  if (!source) return [];

  const results: ParsedReExport[] = [];

  const namedRegex = /^[ \t]*export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(namedRegex)) {
    if (typeof match.index !== 'number') continue;
    const inner = match[1] ?? '';
    const specifier = match[2] ?? '';
    const names = splitTopLevel(inner)
      .map((binding) => parseReExportBinding(binding.trim()))
      .filter((name): name is string => Boolean(name));
    const start = lineOf(source, match.index);
    const end = lineOf(source, match.index + match[0].length - 1);
    results.push({
      kind: 'named',
      sourcePath: resolveImportPath(db, normalized, specifier),
      names,
      startLine: start,
      endLine: end,
    });
  }

  const starAsRegex = /^[ \t]*export\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(starAsRegex)) {
    if (typeof match.index !== 'number') continue;
    const specifier = match[2] ?? '';
    const start = lineOf(source, match.index);
    const end = lineOf(source, match.index + match[0].length - 1);
    results.push({
      kind: 'star-as',
      sourcePath: resolveImportPath(db, normalized, specifier),
      names: [],
      startLine: start,
      endLine: end,
    });
  }

  const starRegex = /^[ \t]*export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(starRegex)) {
    if (typeof match.index !== 'number') continue;
    const specifier = match[1] ?? '';
    const start = lineOf(source, match.index);
    const end = lineOf(source, match.index + match[0].length - 1);
    results.push({
      kind: 'star',
      sourcePath: resolveImportPath(db, normalized, specifier),
      names: [],
      startLine: start,
      endLine: end,
    });
  }

  return results;
}

function parseReExportBinding(entry: string): string | null {
  if (!entry) return null;
  // Strip trailing comment fragments that survived splitTopLevel
  const cleaned = entry.replace(/^type\s+/, '').trim();
  if (!cleaned) return null;
  // `X` or `X as Y` — we want the LOCAL (post-alias) name, since that's what
  // external consumers see and what mentions in this file carry.
  const asMatch = cleaned.match(/^(\w+)\s+as\s+(\w+)$/);
  if (asMatch) return asMatch[2] ?? null;
  const plainMatch = cleaned.match(/^(\w+)$/);
  return plainMatch ? plainMatch[1] ?? null : null;
}

function lineOf(source: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function getReExportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedReExport[] {
  const results: ParsedReExport[] = [];

  for (const node of tree.rootNode.descendantsOfType('export_statement')) {
    const str = firstChildOfType(node, 'string');
    if (!str) continue; // Not a re-export — it's `export const x = ...` etc.
    const frag = firstChildOfType(str, 'string_fragment');
    if (!frag) continue;
    const specifier = frag.text;
    const sourcePath = resolveImportPath(db, importerPath, specifier);

    const startLine = node.startPosition.row;
    const endLine = node.endPosition.row;

    const exportClause = firstChildOfType(node, 'export_clause');
    if (exportClause) {
      // `export { a, b as c } from 'x'`
      const names: string[] = [];
      for (const spec of exportClause.namedChildren) {
        if (spec.type !== 'export_specifier') continue;
        const importedNode = spec.namedChild(0);
        const aliasNode = spec.namedChild(1);
        if (!importedNode) continue;
        // Re-exports surface the LOCAL (post-alias) name to downstream consumers.
        names.push((aliasNode ?? importedNode).text);
      }
      results.push({ kind: 'named', sourcePath, names, startLine, endLine });
      continue;
    }

    const namespaceExport = firstChildOfType(node, 'namespace_export');
    if (namespaceExport) {
      // `export * as ns from 'x'`
      results.push({ kind: 'star-as', sourcePath, names: [], startLine, endLine });
      continue;
    }

    // `export * from 'x'`
    results.push({ kind: 'star', sourcePath, names: [], startLine, endLine });
  }

  return results;
}

function parseJavaScriptImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const tree = getAst(db, importerPath);
  if (tree) {
    return parseJavaScriptImportsAst(db, importerPath, tree);
  }
  // Fallback: regex parser when AST is unavailable.
  return parseJavaScriptImportStatements(source)
    .flatMap((statement) => parseJavaScriptImportStatement(
      db,
      importerPath,
      statement.clause,
      statement.specifier,
      statement.start,
      statement.end,
      source,
    ));
}

function parseJavaScriptImportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedSourceImport[] {
  // Identifier set excluding everything inside import/export statements,
  // so "used" reflects whether the symbol is referenced in the body.
  const usedNames = collectIdentifiersOutside(
    tree,
    new Set(['import_statement', 'export_statement']),
  );
  const results: ParsedSourceImport[] = [];

  for (const node of tree.rootNode.descendantsOfType('import_statement')) {
    const specifier = jsImportSpecifier(node);
    if (!specifier) continue;
    const sourcePath = resolveImportPath(db, importerPath, specifier);

    const importClause = firstChildOfType(node, 'import_clause');
    if (!importClause) {
      // Side-effect import: `import 'x';`
      results.push({
        importedName: '*',
        localName: null,
        sourcePath,
        kind: 'side-effect',
        used: true,
        usedMembers: [],
      });
      continue;
    }

    for (const child of importClause.namedChildren) {
      switch (child.type) {
        case 'identifier': {
          // Default import: `import Foo from 'x'`
          const localName = child.text;
          results.push({
            importedName: 'default',
            localName,
            sourcePath,
            kind: 'default',
            used: usedNames.has(localName),
            usedMembers: [],
          });
          break;
        }
        case 'namespace_import': {
          const idNode = firstChildOfType(child, 'identifier');
          const localName = idNode?.text ?? '';
          if (!localName) break;
          // `import * as ns from 'x'` — surface members the file actually accesses
          // via `ns.member` so downstream queries (drift, redundant-reexports)
          // can tell which sub-symbols are live.
          const usedMembers = collectMemberAccesses(tree, localName);
          results.push({
            importedName: '*',
            localName,
            sourcePath,
            kind: 'namespace',
            used: usedMembers.length > 0 || usedNames.has(localName),
            usedMembers,
          });
          break;
        }
        case 'named_imports': {
          for (const spec of child.namedChildren) {
            if (spec.type !== 'import_specifier') continue;
            const importedNode = spec.namedChild(0);
            const aliasNode = spec.namedChild(1);
            if (!importedNode) continue;
            const importedName = importedNode.text;
            const localName = aliasNode?.text ?? importedName;
            results.push({
              importedName,
              localName,
              sourcePath,
              kind: 'named',
              used: usedNames.has(localName),
              usedMembers: [],
            });
          }
          break;
        }
      }
    }
  }

  return results;
}

function jsImportSpecifier(node: SyntaxNode): string | null {
  const str = firstChildOfType(node, 'string');
  if (!str) return null;
  const frag = firstChildOfType(str, 'string_fragment');
  return frag ? frag.text : null;
}

function firstChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
  }
  return null;
}

/**
 * Collect names accessed as `<receiver>.<name>` anywhere in the tree.
 * Used to enumerate which members of a namespace import are actually touched.
 */
function collectMemberAccesses(tree: Tree, receiver: string): string[] {
  const names = new Set<string>();
  for (const expr of tree.rootNode.descendantsOfType('member_expression')) {
    const obj = expr.namedChild(0);
    const prop = expr.namedChild(1);
    if (!obj || !prop) continue;
    if (obj.type !== 'identifier' || obj.text !== receiver) continue;
    if (prop.type === 'property_identifier' || prop.type === 'identifier') {
      names.add(prop.text);
    }
  }
  return [...names];
}

function parseJavaScriptImportStatements(source: string): Array<{
  clause: string | null;
  specifier: string;
  start: number;
  end: number;
}> {
  const statements: Array<{
    clause: string | null;
    specifier: string;
    start: number;
    end: number;
  }> = [];

  const importFromRegex = /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(importFromRegex)) {
    const full = match[0];
    const clause = match[1];
    const specifier = match[2];
    if (!full || !specifier || typeof match.index !== 'number') continue;
    statements.push({
      clause,
      specifier,
      start: match.index,
      end: match.index + full.length,
    });
  }

  const sideEffectRegex = /^[ \t]*import\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(sideEffectRegex)) {
    const full = match[0];
    const specifier = match[1];
    if (!full || !specifier || typeof match.index !== 'number') continue;
    statements.push({
      clause: null,
      specifier,
      start: match.index,
      end: match.index + full.length,
    });
  }

  return statements.sort((a, b) => a.start - b.start);
}

function parseJavaScriptImportStatement(
  db: ScipDatabase,
  importerPath: string,
  clause: string | null,
  specifier: string,
  start: number,
  end: number,
  source: string,
): ParsedSourceImport[] {
  const resolvedSource = resolveImportPath(db, importerPath, specifier);
  const body = buildUsageBody(source, start, end);

  if (!clause) {
    return [{
      importedName: '*',
      localName: null,
      sourcePath: resolvedSource,
      kind: 'side-effect',
      used: true,
      usedMembers: [],
    }];
  }

  const bindings = parseImportClause(clause).map((binding) => ({
    ...binding,
    sourcePath: resolvedSource,
  }));

  return bindings.map((binding) => {
    if (binding.kind === 'namespace') {
      const usedMembers = collectNamespaceMembers(body, binding.localName!);
      return {
        ...binding,
        used: usedMembers.length > 0 || hasIdentifierUsage(body, binding.localName!),
        usedMembers,
      };
    }

    if (binding.kind === 'side-effect') {
      return { ...binding, used: true, usedMembers: [] };
    }

    return {
      ...binding,
      used: binding.localName ? hasIdentifierUsage(body, binding.localName) : false,
      usedMembers: [],
    };
  });
}

function parseJvmImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const statements: ParsedSourceImport[] = [];
  for (const match of source.matchAll(/^[ \t]*import\s+(?:static\s+)?(.+?)\s*;?$/gm)) {
    const clause = match[1]?.trim();
    const full = match[0];
    if (!clause || !full || typeof match.index !== 'number') continue;
    const body = buildUsageBody(source, match.index, match.index + full.length);
    statements.push(...parseJvmImportClause(db, importerPath, clause, body));
  }
  return statements;
}

function parseJvmImportClause(
  db: ScipDatabase,
  importerPath: string,
  clause: string,
  body: string,
): ParsedSourceImport[] {
  if (clause.includes('{') && clause.includes('}')) {
    const prefix = clause.slice(0, clause.indexOf('{')).replace(/\.$/, '').trim();
    const inner = clause.slice(clause.indexOf('{') + 1, clause.lastIndexOf('}')).trim();
    return splitTopLevel(inner).flatMap((entry) => {
      const cleaned = entry.trim();
      if (!cleaned) return [];
      const [importedPart, aliasPart] = cleaned.includes('=>')
        ? cleaned.split(/\s*=>\s*/)
        : cleaned.split(/\s+as\s+/);
      const importedName = importedPart?.trim();
      if (!importedName || importedName === '_') return [];
      const localName = (aliasPart ?? importedName.split('.').pop() ?? importedName).trim();
      const qualified = importedName === '_'
        ? prefix
        : `${prefix}.${importedName}`.replace(/\.\./g, '.');
      return [buildSimpleImport(db, importerPath, body, qualified, importedName, localName)];
    });
  }

  return [buildSimpleImport(
    db,
    importerPath,
    body,
    clause,
    clause.split('.').pop() ?? clause,
    clause.split('.').pop() ?? clause,
  )];
}

function parseRustImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const tree = getAst(db, importerPath);
  if (tree) {
    return parseRustImportsAst(db, importerPath, tree);
  }
  // Fallback: regex parser when AST is unavailable (e.g. unreadable source).
  const statements: ParsedSourceImport[] = [];
  for (const match of source.matchAll(/^[ \t]*use\s+(.+?)\s*;$/gm)) {
    const clause = match[1]?.trim();
    const full = match[0];
    if (!clause || !full || typeof match.index !== 'number') continue;
    const body = buildUsageBody(source, match.index, match.index + full.length);
    statements.push(...parseRustUseClause(db, importerPath, clause, body));
  }
  return statements;
}

interface RustImportLeaf {
  qualifiedName: string;
  importedName: string;
  localName: string;
}

function parseRustImportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedSourceImport[] {
  const usedNames = collectIdentifiersOutside(tree, new Set(['use_declaration']));
  const results: ParsedSourceImport[] = [];

  for (const useDecl of tree.rootNode.descendantsOfType('use_declaration')) {
    const root = useDecl.namedChild(0);
    if (!root) continue;
    for (const leaf of flattenRustUseTree(root, '')) {
      if (!leaf.importedName || leaf.importedName === '*') continue;
      const sourcePath = resolveRustImportPath(db, importerPath, leaf.qualifiedName)
        ?? resolveRustImportPath(db, importerPath, leaf.qualifiedName.split('::').slice(0, -1).join('::'));
      results.push({
        importedName: leaf.importedName,
        localName: leaf.localName,
        sourcePath,
        kind: 'named',
        used: usedNames.has(leaf.localName),
        usedMembers: [],
      });
    }
  }

  return results;
}

function flattenRustUseTree(node: SyntaxNode, prefix: string): RustImportLeaf[] {
  switch (node.type) {
    case 'identifier':
    case 'super':
    case 'self':
    case 'crate': {
      const name = node.text;
      return [{
        qualifiedName: joinRustPath(prefix, name),
        importedName: name,
        localName: name,
      }];
    }
    case 'scoped_identifier': {
      const text = node.text;
      const last = text.split('::').pop() ?? text;
      return [{
        qualifiedName: joinRustPath(prefix, text),
        importedName: last,
        localName: last,
      }];
    }
    case 'scoped_use_list': {
      const pathNode = node.namedChild(0);
      const list = node.namedChild(1);
      if (!pathNode || !list) return [];
      const newPrefix = joinRustPath(prefix, pathNode.text);
      const out: RustImportLeaf[] = [];
      for (const child of list.namedChildren) {
        out.push(...flattenRustUseTree(child, newPrefix));
      }
      return out;
    }
    case 'use_list': {
      const out: RustImportLeaf[] = [];
      for (const child of node.namedChildren) {
        out.push(...flattenRustUseTree(child, prefix));
      }
      return out;
    }
    case 'use_as_clause': {
      const path = node.namedChild(0);
      const alias = node.namedChild(1);
      if (!path || !alias) return [];
      const subItems = flattenRustUseTree(path, prefix);
      const aliasName = alias.text;
      return subItems.map((leaf) => ({ ...leaf, localName: aliasName }));
    }
    case 'use_wildcard': {
      const path = node.namedChild(0);
      const text = path ? path.text : '';
      return [{
        qualifiedName: joinRustPath(prefix, `${text}::*`),
        importedName: '*',
        localName: '*',
      }];
    }
    default:
      return [];
  }
}

function joinRustPath(prefix: string, suffix: string): string {
  if (!prefix) return suffix;
  if (!suffix) return prefix;
  return `${prefix}::${suffix}`;
}

/**
 * Walk the AST collecting the text of every `identifier` node that is not
 * a descendant of any node whose type is in `excludeTypes`. Used to figure
 * out whether an imported symbol is actually referenced elsewhere in the
 * file (excluding the import statement itself).
 */
function collectIdentifiersOutside(tree: Tree, excludeTypes: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const walk = (node: SyntaxNode, inside: boolean): void => {
    const skip = inside || excludeTypes.has(node.type);
    if (!skip && node.type === 'identifier') {
      out.add(node.text);
    }
    for (const child of node.children) walk(child, skip);
  };
  walk(tree.rootNode, false);
  return out;
}

/**
 * Per-file set of identifier names that appear in the source. Uses tree-sitter
 * AST when the language is supported (skips comments, strings, type-only
 * positions automatically); falls back to a stripped-source regex tokenize
 * for languages without AST support.
 *
 * Cached per (db, file) so repeat queries — e.g. health's many subcommands —
 * pay the parse cost exactly once per file per process.
 */
const FILE_IDENTIFIER_CACHE = new WeakMap<ScipDatabase, Map<string, Set<string>>>();
export function getFileIdentifiers(
  db: ScipDatabase,
  relativePath: string,
): Set<string> {
  let cache = FILE_IDENTIFIER_CACHE.get(db);
  if (!cache) {
    cache = new Map();
    FILE_IDENTIFIER_CACHE.set(db, cache);
  }
  const cached = cache.get(relativePath);
  if (cached) return cached;

  const result = computeFileIdentifiers(db, relativePath);
  cache.set(relativePath, result);
  return result;
}

/**
 * Per-file map of identifier name → sorted line numbers where it appears.
 * Powers source-text refinement of SCIP mentions when a chunk's start line
 * is too coarse to identify the precise enclosing function. Cached per file.
 */
const FILE_IDENT_LINES_CACHE = new WeakMap<ScipDatabase, Map<string, Map<string, number[]>>>();
export function getIdentifierLineMap(
  db: ScipDatabase,
  relativePath: string,
): Map<string, number[]> {
  let cache = FILE_IDENT_LINES_CACHE.get(db);
  if (!cache) {
    cache = new Map();
    FILE_IDENT_LINES_CACHE.set(db, cache);
  }
  const cached = cache.get(relativePath);
  if (cached) return cached;

  const result = computeIdentifierLineMap(db, relativePath);
  cache.set(relativePath, result);
  return result;
}

/**
 * Per-file array indexed by line number, where each entry is the Set of
 * identifier names that appear on that line. Computed once per file (cached)
 * and used to compute "identifiers in [startLine..endLine]" in O(range size)
 * — avoiding the O(file identifiers) scan that buildCalleeMap would otherwise
 * pay per definition.
 */
const FILE_IDENTS_BY_LINE_CACHE = new WeakMap<ScipDatabase, Map<string, Array<Set<string>>>>();
export function getIdentifiersByLine(
  db: ScipDatabase,
  relativePath: string,
): Array<Set<string>> {
  let cache = FILE_IDENTS_BY_LINE_CACHE.get(db);
  if (!cache) {
    cache = new Map();
    FILE_IDENTS_BY_LINE_CACHE.set(db, cache);
  }
  const cached = cache.get(relativePath);
  if (cached) return cached;

  const lineMap = getIdentifierLineMap(db, relativePath);
  let maxLine = 0;
  for (const lines of lineMap.values()) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last > maxLine) maxLine = last;
  }
  const out: Array<Set<string>> = new Array(maxLine + 1);
  for (let i = 0; i <= maxLine; i += 1) out[i] = new Set();
  for (const [name, lines] of lineMap) {
    for (const line of lines) {
      out[line]!.add(name);
    }
  }
  cache.set(relativePath, out);
  return out;
}

function computeIdentifierLineMap(
  db: ScipDatabase,
  relativePath: string,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const record = (name: string, line: number): void => {
    const arr = out.get(name);
    if (!arr) {
      out.set(name, [line]);
      return;
    }
    if (arr[arr.length - 1] !== line) arr.push(line);
  };

  if (detectAstLanguage(relativePath)) {
    const tree = getAst(db, relativePath);
    if (tree) {
      const lang = detectAstLanguage(relativePath);
      const identifierTypes = lang === 'rust'
        ? new Set(['identifier', 'type_identifier', 'field_identifier'])
        : lang === 'python'
          ? new Set(['identifier'])
          : new Set(['identifier', 'property_identifier', 'type_identifier']);
      // Rust + Python format strings interpolate identifiers inside the
      // string content (`format!("{IDENT}")` since Rust 1.58, f-strings in
      // Python). tree-sitter doesn't break those into identifier nodes —
      // the whole quoted text is one string_content node. Without
      // extracting the names, they look unreferenced and the dead-code
      // detector flags `IDENT` as dead. We pull them out via a brace-scan
      // of every string_content node.
      const interpolationLangs = new Set(['rust', 'python']);
      const interpolationRegex = /\{(?:\?\s*)?([A-Za-z_][\w]*)/g;
      const walk = (node: SyntaxNode): void => {
        if (identifierTypes.has(node.type)) record(node.text, node.startPosition.row);
        if (lang && interpolationLangs.has(lang) && node.type === 'string_content') {
          const baseLine = node.startPosition.row;
          for (const match of node.text.matchAll(interpolationRegex)) {
            if (match[1]) record(match[1], baseLine);
          }
        }
        for (const child of node.children) walk(child);
      };
      walk(tree.rootNode);
      return out;
    }
  }

  const source = getSourceText(db, relativePath);
  if (!source) return out;
  const lines = stripCommentsAndStrings(source).split(/\r?\n/);
  const re = /\b([A-Za-z_$][\w$]*)\b/g;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    for (const match of line.matchAll(re)) {
      if (match[1]) record(match[1], i);
    }
  }
  return out;
}

function computeFileIdentifiers(
  db: ScipDatabase,
  relativePath: string,
): Set<string> {
  if (detectAstLanguage(relativePath)) {
    const tree = getAst(db, relativePath);
    if (tree) {
      const lang = detectAstLanguage(relativePath);
      // Rust: also harvest type identifiers and field identifiers as references.
      // TS/JS: same — references include `property_identifier`, `type_identifier`.
      // Python: just `identifier`.
      const identifierTypes = lang === 'rust'
        ? new Set(['identifier', 'type_identifier', 'field_identifier'])
        : lang === 'python'
          ? new Set(['identifier'])
          : new Set(['identifier', 'property_identifier', 'type_identifier']);
      const out = new Set<string>();
      const walk = (node: SyntaxNode): void => {
        if (identifierTypes.has(node.type)) out.add(node.text);
        for (const child of node.children) walk(child);
      };
      walk(tree.rootNode);
      return out;
    }
  }

  // Fallback: regex tokenize with comments/strings stripped.
  const source = getSourceText(db, relativePath);
  if (!source) return new Set();
  const stripped = stripCommentsAndStrings(source);
  const out = new Set<string>();
  const re = /\b([A-Za-z_$][\w$]*)\b/g;
  for (const match of stripped.matchAll(re)) {
    if (match[1]) out.add(match[1]);
  }
  return out;
}

function parseRustUseClause(
  db: ScipDatabase,
  importerPath: string,
  clause: string,
  body: string,
): ParsedSourceImport[] {
  const trimmed = clause.trim();
  if (trimmed.includes('{') && trimmed.includes('}')) {
    const prefix = trimmed.slice(0, trimmed.indexOf('{')).replace(/::$/, '').trim();
    const inner = trimmed.slice(trimmed.indexOf('{') + 1, trimmed.lastIndexOf('}')).trim();
    return splitTopLevel(inner).flatMap((entry) => {
      const cleaned = entry.trim();
      if (!cleaned || cleaned === 'self') return [];
      const [importedPart, aliasPart] = cleaned.split(/\s+as\s+/);
      const importedName = importedPart?.trim();
      if (!importedName) return [];
      const localName = (aliasPart ?? importedName.split('::').pop() ?? importedName).trim();
      const moduleSpecifier = `${prefix}::${importedName}`.replace(/::::/g, '::');
      return [buildSimpleImport(
        db,
        importerPath,
        body,
        moduleSpecifier,
        importedName.split('::').pop() ?? importedName,
        localName,
        resolveRustImportPath(db, importerPath, prefix),
      )];
    });
  }

  const [importedPart, aliasPart] = trimmed.split(/\s+as\s+/);
  const importedName = importedPart?.trim() ?? trimmed;
  const localName = (aliasPart ?? importedName.split('::').pop() ?? importedName).trim();
  const resolved = resolveRustImportPath(db, importerPath, importedName)
    ?? resolveRustImportPath(db, importerPath, importedName.split('::').slice(0, -1).join('::'));
  return [buildSimpleImport(
    db,
    importerPath,
    body,
    importedName,
    importedName.split('::').pop() ?? importedName,
    localName,
    resolved,
  )];
}

function parseRustExports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceExport[] {
  const statements: ParsedSourceExport[] = [];
  for (const match of source.matchAll(/^[ \t]*pub\s+use\s+(.+?)\s*;$/gm)) {
    const clause = match[1]?.trim();
    if (!clause) continue;
    statements.push(...parseRustExportClause(db, importerPath, clause));
  }
  return statements;
}

function parseRustExportClause(
  db: ScipDatabase,
  importerPath: string,
  clause: string,
): ParsedSourceExport[] {
  const trimmed = clause.trim();
  if (trimmed.includes('{') && trimmed.includes('}')) {
    const prefix = trimmed.slice(0, trimmed.indexOf('{')).replace(/::$/, '').trim();
    const inner = trimmed.slice(trimmed.indexOf('{') + 1, trimmed.lastIndexOf('}')).trim();
    return splitTopLevel(inner).flatMap((entry) => {
      const cleaned = entry.trim();
      if (!cleaned || cleaned === 'self') return [];
      const [qualifiedPart] = cleaned.split(/\s+as\s+/);
      const qualified = `${prefix}::${qualifiedPart?.trim() ?? cleaned}`.replace(/::::/g, '::');
      return [buildRustExport(db, importerPath, qualified)];
    });
  }

  return [buildRustExport(db, importerPath, trimmed)];
}

function buildRustExport(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): ParsedSourceExport {
  return {
    specifier,
    sourcePath: resolveRustImportPath(db, importerPath, specifier)
      ?? resolveRustImportPath(db, importerPath, specifier.split('::').slice(0, -1).join('::')),
  };
}

function parseRubyImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const statements: ParsedSourceImport[] = [];
  for (const match of source.matchAll(/^[ \t]*(require_relative|require)\s+["']([^"']+)["']\s*$/gm)) {
    const kind = match[1];
    const specifier = match[2];
    const full = match[0];
    if (!kind || !specifier || !full || typeof match.index !== 'number') continue;
    const body = buildUsageBody(source, match.index, match.index + full.length);
    const sourcePath = kind === 'require_relative'
      ? resolveRubyImportPath(db, importerPath, specifier)
      : null;

    if (sourcePath) {
      const localName = rubyConstantName(specifier);
      statements.push({
        importedName: localName,
        localName,
        sourcePath,
        kind: 'named',
        used: hasIdentifierUsage(body, localName),
        usedMembers: [],
      });
      continue;
    }

    statements.push({
      importedName: specifier,
      localName: null,
      sourcePath,
      kind: 'side-effect',
      used: true,
      usedMembers: [],
    });
  }
  return statements;
}

function rubyConstantName(specifier: string): string {
  return basename(specifier)
    .replace(/\.[^.]+$/, '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function parseCLikeImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const statements: ParsedSourceImport[] = [];
  for (const match of source.matchAll(/^[ \t]*#include\s+[<"]([^">]+)[">]\s*$/gm)) {
    const specifier = match[1]?.trim();
    const full = match[0];
    if (!specifier || !full || typeof match.index !== 'number') continue;
    const body = buildUsageBody(source, match.index, match.index + full.length);
    const localName = basename(specifier).replace(/\.[^.]+$/, '');
    statements.push({
      importedName: specifier,
      localName,
      sourcePath: resolveCLikeImportPath(db, importerPath, specifier),
      kind: 'named',
      used: hasIdentifierUsage(body, localName),
      usedMembers: [],
    });
  }
  return statements;
}

function parseDotNetImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const statements: ParsedSourceImport[] = [];
  const lineRegex = isVisualBasicSourcePath(importerPath)
    ? /^[ \t]*Imports\s+(.+?)\s*$/gm
    : /^[ \t]*using\s+(.+?)\s*;$/gm;

  for (const match of source.matchAll(lineRegex)) {
    const clause = match[1]?.trim();
    const full = match[0];
    if (!clause || !full || typeof match.index !== 'number') continue;
    const body = buildUsageBody(source, match.index, match.index + full.length);

    const [aliasPart, targetPart] = isVisualBasicSourcePath(importerPath)
      ? clause.split(/\s*=\s*/)
      : clause.split(/\s*=\s*/);
    const hasAlias = Boolean(targetPart);
    const qualified = (hasAlias ? targetPart : aliasPart)?.trim() ?? clause;
    const importedName = qualified.split('.').pop() ?? qualified;
    const localName = hasAlias
      ? aliasPart?.trim() ?? importedName
      : importedName;

    statements.push(buildSimpleImport(
      db,
      importerPath,
      body,
      qualified,
      importedName,
      localName,
      resolveQualifiedImportPath(db, qualified, DOTNET_SOURCE_EXTENSIONS),
    ));
  }

  return statements;
}

function parseDartImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const statements: ParsedSourceImport[] = [];
  for (const match of source.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"](?:\s+as\s+([A-Za-z_]\w*))?[\s\S]*?;$/gm)) {
    const specifier = match[1]?.trim();
    const alias = match[2]?.trim() ?? null;
    const full = match[0];
    if (!specifier || !full || typeof match.index !== 'number') continue;
    const body = buildUsageBody(source, match.index, match.index + full.length);
    statements.push({
      importedName: specifier,
      localName: alias,
      sourcePath: resolveDartImportPath(db, importerPath, specifier),
      kind: alias ? 'namespace' : 'side-effect',
      used: alias ? hasIdentifierUsage(body, alias) : true,
      usedMembers: alias ? collectNamespaceMembers(body, alias) : [],
    });
  }
  return statements;
}

function parseDartExports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceExport[] {
  const statements: ParsedSourceExport[] = [];
  for (const match of source.matchAll(/^[ \t]*export\s+['"]([^'"]+)['"][\s\S]*?;$/gm)) {
    const specifier = match[1]?.trim();
    if (!specifier) continue;
    statements.push({
      specifier,
      sourcePath: resolveDartImportPath(db, importerPath, specifier),
    });
  }
  return statements;
}

function parsePhpImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const statements: ParsedSourceImport[] = [];
  for (const match of source.matchAll(/^[ \t]*use\s+(.+?)\s*;$/gm)) {
    const clause = match[1]?.trim();
    const full = match[0];
    if (!clause || !full || typeof match.index !== 'number') continue;
    const body = buildUsageBody(source, match.index, match.index + full.length);
    for (const entry of splitTopLevel(clause)) {
      const cleaned = entry.trim();
      if (!cleaned) continue;
      const [qualifiedPart, aliasPart] = cleaned.split(/\s+as\s+/i);
      const qualified = qualifiedPart?.trim() ?? cleaned;
      const importedName = qualified.split('\\').pop() ?? qualified;
      const localName = (aliasPart ?? importedName).trim();
      statements.push(buildSimpleImport(
        db,
        importerPath,
        body,
        qualified,
        importedName,
        localName,
        resolveQualifiedImportPath(db, qualified.replace(/\\/g, '.'), PHP_SOURCE_EXTENSIONS),
      ));
    }
  }
  return statements;
}

function buildSimpleImport(
  db: ScipDatabase,
  importerPath: string,
  body: string,
  qualifiedName: string,
  importedName: string,
  localName: string,
  sourcePath?: string | null,
): ParsedSourceImport {
  return {
    importedName,
    localName,
    sourcePath: sourcePath ?? resolveQualifiedImportPath(db, qualifiedName, extensionFamilyFor(importerPath)),
    kind: 'named',
    used: hasIdentifierUsage(body, localName),
    usedMembers: [],
  };
}

function parsePythonCalls(lines: string[], baseLine: number): ParsedSourceCall[] {
  const calls: ParsedSourceCall[] = [];
  const controlKeywords = new Set([
    'if',
    'for',
    'while',
    'with',
    'except',
    'elif',
    'return',
    'yield',
    'assert',
    'raise',
    'lambda',
    'class',
    'def',
  ]);

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index] ?? '';
    const stripped = stripCommentsAndStrings(rawLine);
    if (!stripped.trim()) continue;

    const attributeMatches = [...stripped.matchAll(/\b([A-Za-z_][\w]*)\s*\.\s*([A-Za-z_][\w]*)\s*\(/g)];
    const attributeRanges = attributeMatches.map((match) => ({
      start: match.index ?? -1,
      end: (match.index ?? -1) + match[0].length,
    }));

    for (const match of attributeMatches) {
      const receiverName = match[1];
      const calleeName = match[2];
      if (!receiverName || !calleeName) continue;
      calls.push({
        receiverName,
        calleeName,
        line: baseLine + index,
      });
    }

    for (const match of stripped.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)) {
      const calleeName = match[1];
      const start = match.index ?? -1;
      if (!calleeName || start < 0) continue;
      if (controlKeywords.has(calleeName)) continue;
      if (attributeRanges.some((range) => start >= range.start && start < range.end)) continue;

      const prefix = stripped.slice(0, start).trimEnd();
      if (prefix.endsWith('def') || prefix.endsWith('class') || prefix.endsWith('async def')) {
        continue;
      }

      calls.push({
        receiverName: null,
        calleeName,
        line: baseLine + index,
      });
    }
  }

  return calls;
}

function parseJavaScriptCalls(lines: string[], baseLine: number): ParsedSourceCall[] {
  const calls: ParsedSourceCall[] = [];
  const controlKeywords = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'function',
    'class',
    'return',
    'typeof',
    'import',
  ]);

  for (let index = 0; index < lines.length; index++) {
    const stripped = stripCommentsAndStrings(lines[index] ?? '');
    if (!stripped.trim()) continue;

    const attributeMatches = [
      ...stripped.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*\(/g),
      ...stripped.matchAll(/\bthis\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*\(/g),
    ];
    const attributeRanges = attributeMatches.map((match) => ({
      start: match.index ?? -1,
      end: (match.index ?? -1) + match[0].length,
    }));

    for (const match of attributeMatches) {
      const receiverName = match[2] ? match[1] : 'this';
      const calleeName = match[2] ?? match[1];
      if (!receiverName || !calleeName) continue;
      calls.push({
        receiverName,
        calleeName,
        line: baseLine + index,
      });
    }

    for (const match of stripped.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const calleeName = match[1];
      const start = match.index ?? -1;
      if (!calleeName || start < 0) continue;
      if (controlKeywords.has(calleeName)) continue;
      if (attributeRanges.some((range) => start >= range.start && start < range.end)) continue;

      const prefix = stripped.slice(0, start).trimEnd();
      if (
        prefix.endsWith('function')
        || prefix.endsWith('class')
        || prefix.endsWith('new')
      ) {
        continue;
      }

      calls.push({
        receiverName: null,
        calleeName,
        line: baseLine + index,
      });
    }
  }

  return calls;
}

function parsePythonConstructorBindings(lines: string[]): ParsedSourceBinding[] {
  const bindings = new Map<string, string>();

  for (const rawLine of lines) {
    const stripped = stripCommentsAndStrings(rawLine);
    const constructorMatch = stripped.match(/\b([A-Za-z_][\w]*)\s*=\s*([A-Z][\w]*)\s*\(/);
    if (constructorMatch?.[1] && constructorMatch[2]) {
      bindings.set(constructorMatch[1], constructorMatch[2]);
    }
  }

  return [...bindings.entries()].map(([localName, typeName]) => ({ localName, typeName }));
}

function parseJavaScriptConstructorBindings(lines: string[]): ParsedSourceBinding[] {
  const bindings = new Map<string, string>();

  for (const rawLine of lines) {
    const stripped = stripCommentsAndStrings(rawLine);

    for (const match of stripped.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*([A-Z][A-Za-z0-9_$]*)\b/g)) {
      const localName = match[1];
      const typeName = match[2];
      if (localName && typeName) {
        bindings.set(localName, typeName);
      }
    }

    const constructorMatch = stripped.match(/\b(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*[A-Z][A-Za-z0-9_$<> ,]*)?\s*=\s*new\s+([A-Z][A-Za-z0-9_$]*)\s*\(/);
    if (constructorMatch?.[1] && constructorMatch[2]) {
      bindings.set(constructorMatch[1], constructorMatch[2]);
    }
  }

  return [...bindings.entries()].map(([localName, typeName]) => ({ localName, typeName }));
}

function parsePythonImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const tree = getAst(db, importerPath);
  if (tree) {
    return parsePythonImportsAst(db, importerPath, tree);
  }
  return collectPythonImportStatements(source).flatMap((statement) =>
    parsePythonImportStatement(db, importerPath, statement, source),
  );
}

function parsePythonImportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedSourceImport[] {
  const usedNames = collectIdentifiersOutside(
    tree,
    new Set(['import_statement', 'import_from_statement']),
  );
  const results: ParsedSourceImport[] = [];

  // Plain `import X` and `import X as Y`, possibly comma-separated.
  for (const node of tree.rootNode.descendantsOfType('import_statement')) {
    for (const child of node.namedChildren) {
      const item = parsePythonImportItem(child);
      if (!item) continue;
      const sourcePath = resolvePythonImportPath(db, importerPath, item.qualifiedName);
      results.push({
        importedName: item.qualifiedName,
        localName: item.localName,
        sourcePath,
        kind: 'namespace',
        used: usedNames.has(item.localName),
        usedMembers: [], // member-access tracking via AST is possible but skipped here for parity
      });
    }
  }

  // `from X import a, b as c, *`
  for (const node of tree.rootNode.descendantsOfType('import_from_statement')) {
    const moduleNode = node.namedChild(0);
    if (!moduleNode) continue;
    const moduleSpec = pythonModuleSpec(moduleNode);
    if (moduleSpec === null) continue;
    const sourcePath = resolvePythonImportPath(db, importerPath, moduleSpec);

    // First named child is the module; remaining children are the imported names.
    for (let i = 1; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i)!;
      if (child.type === 'wildcard_import') {
        results.push({
          importedName: '*',
          localName: null,
          sourcePath,
          kind: 'side-effect',
          used: true,
          usedMembers: [],
        });
        continue;
      }
      const item = parsePythonImportItem(child);
      if (!item) continue;
      results.push({
        importedName: item.qualifiedName,
        localName: item.localName,
        sourcePath,
        kind: 'named',
        used: usedNames.has(item.localName),
        usedMembers: [],
      });
    }
  }

  return results;
}

function parsePythonImportItem(node: SyntaxNode): { qualifiedName: string; localName: string } | null {
  if (node.type === 'aliased_import') {
    const inner = node.namedChild(0);
    const alias = node.namedChild(1);
    if (!inner || !alias) return null;
    const qualifiedName = inner.text;
    return { qualifiedName, localName: alias.text };
  }
  if (node.type === 'dotted_name') {
    const text = node.text;
    return { qualifiedName: text, localName: text.split('.')[0] ?? text };
  }
  if (node.type === 'identifier') {
    return { qualifiedName: node.text, localName: node.text };
  }
  return null;
}

function pythonModuleSpec(moduleNode: SyntaxNode): string | null {
  if (moduleNode.type === 'dotted_name') {
    return moduleNode.text;
  }
  if (moduleNode.type === 'relative_import') {
    // `.`, `..`, `..pkg.sub`, etc. — concatenate `import_prefix` (the dots)
    // and any trailing `dotted_name`.
    const prefix = firstChildOfType(moduleNode, 'import_prefix')?.text ?? '';
    const dotted = firstChildOfType(moduleNode, 'dotted_name')?.text ?? '';
    return `${prefix}${dotted}`;
  }
  return null;
}

function collectPythonImportStatements(source: string): Array<{
  kind: 'import' | 'from';
  module: string | null;
  clause: string;
  start: number;
  end: number;
}> {
  const lines = source.split('\n');
  const statements: Array<{
    kind: 'import' | 'from';
    module: string | null;
    clause: string;
    start: number;
    end: number;
  }> = [];

  let offset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const trimmed = line.trimStart();
    const lineStart = offset;
    offset += line.length + 1;

    if (!trimmed.startsWith('import ') && !trimmed.startsWith('from ')) {
      continue;
    }

    let statement = line;
    let statementEnd = lineStart + line.length;
    let balance = pythonParenBalance(line);

    while (
      lineIndex + 1 < lines.length
      && (balance > 0 || statement.trimEnd().endsWith('\\'))
    ) {
      lineIndex++;
      const nextLine = lines[lineIndex]!;
      statement += `\n${nextLine}`;
      statementEnd += 1 + nextLine.length;
      balance += pythonParenBalance(nextLine);
      offset += nextLine.length + 1;
    }

    const parsed = parsePythonStatementHeader(statement);
    if (parsed) {
      statements.push({
        ...parsed,
        start: lineStart,
        end: statementEnd,
      });
    }
  }

  return statements;
}

function parsePythonStatementHeader(statement: string): {
  kind: 'import' | 'from';
  module: string | null;
  clause: string;
} | null {
  const normalized = statement
    .replace(/\\\s*\n/g, ' ')
    .trim();

  if (normalized.startsWith('import ')) {
    return {
      kind: 'import',
      module: null,
      clause: normalized.slice('import '.length).trim(),
    };
  }

  const fromMatch = normalized.match(/^from\s+([.\w]+)\s+import\s+([\s\S]+)$/);
  if (!fromMatch) {
    return null;
  }

  let clause = fromMatch[2]!.trim();
  if (clause.startsWith('(') && clause.endsWith(')')) {
    clause = clause.slice(1, -1).trim();
  }

  return {
    kind: 'from',
    module: fromMatch[1]!,
    clause,
  };
}

function parsePythonImportStatement(
  db: ScipDatabase,
  importerPath: string,
  statement: {
    kind: 'import' | 'from';
    module: string | null;
    clause: string;
    start: number;
    end: number;
  },
  source: string,
): ParsedSourceImport[] {
  const body = buildUsageBody(source, statement.start, statement.end);
  const normalizedClause = statement.clause.replace(/\n/g, ' ').trim();

  if (statement.kind === 'import') {
    return splitTopLevel(normalizedClause).flatMap((entry) => {
      const cleaned = entry.trim().replace(/,$/, '');
      if (!cleaned) return [];

      const [moduleName, alias] = cleaned.split(/\s+as\s+/);
      const importedName = moduleName!.trim();
      const localName = (alias ?? importedName.split('.')[0] ?? importedName).trim();
      const sourcePath = resolvePythonImportPath(db, importerPath, importedName);
      const usedMembers = collectNamespaceMembers(body, localName);

      return [{
        importedName,
        localName,
        sourcePath,
        kind: 'namespace' as const,
        used: hasIdentifierUsage(body, localName) || usedMembers.length > 0,
        usedMembers,
      }];
    });
  }

  const sourcePath = statement.module
    ? resolvePythonImportPath(db, importerPath, statement.module)
    : null;
  const results: ParsedSourceImport[] = [];
  for (const entry of splitTopLevel(normalizedClause)) {
    const cleaned = entry.trim().replace(/,$/, '');
    if (!cleaned) continue;

    if (cleaned === '*') {
      results.push({
        importedName: '*',
        localName: null,
        sourcePath,
        kind: 'side-effect' as const,
        used: true,
        usedMembers: [],
      });
      continue;
    }

    const [importedName, alias] = cleaned.split(/\s+as\s+/);
    const localName = (alias ?? importedName)!.trim();
    results.push({
      importedName: importedName!.trim(),
      localName,
      sourcePath,
      kind: 'named' as const,
      used: hasIdentifierUsage(body, localName),
      usedMembers: [],
    });
  }

  return results;
}

function parseImportClause(clause: string): Array<{
  importedName: string;
  localName: string | null;
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
}> {
  const trimmed = clause.trim().replace(/^type\s+/, '');
  const [first, second] = splitImportClause(trimmed);
  const entries: Array<{
    importedName: string;
    localName: string | null;
    kind: 'named' | 'default' | 'namespace' | 'side-effect';
  }> = [];

  if (first) {
    entries.push(...parseImportBinding(first));
  }

  if (second) {
    entries.push(...parseImportBinding(second));
  }

  return entries;
}

function parseImportBinding(
  binding: string,
): Array<{
  importedName: string;
  localName: string | null;
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
}> {
  const trimmed = binding.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];

    return splitTopLevel(inner).map((entry) => {
      const cleaned = entry.trim().replace(/^type\s+/, '');
      const [importedName, alias] = cleaned.split(/\s+as\s+/);
      return {
        importedName: importedName!.trim(),
        localName: (alias ?? importedName)!.trim(),
        kind: 'named' as const,
      };
    });
  }

  if (trimmed.startsWith('* as ')) {
    return [{
      importedName: '*',
      localName: trimmed.slice(5).trim(),
      kind: 'namespace',
    }];
  }

  return [{
    importedName: 'default',
    localName: trimmed,
    kind: 'default',
  }];
}

function splitImportClause(clause: string): [string, string | null] {
  let depth = 0;
  for (let i = 0; i < clause.length; i++) {
    const char = clause[i]!;
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (char === ',' && depth === 0) {
      return [clause.slice(0, i).trim(), clause.slice(i + 1).trim()];
    }
  }

  return [clause.trim(), null];
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (char === '{' || char === '[' || char === '(') depth++;
    if (char === '}' || char === ']' || char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

// Single-entry cache keyed by source string identity. Each parseXImports/Exports
// loop calls buildUsageBody many times with the same `source` string, but the
// previous implementation re-ran the 8-pass stripCommentsAndStrings for every
// call. For a 8,790-line Rust file with 50 use statements, that was 50 full-file
// regex sweeps. With this cache, each unique source pays the strip cost exactly
// once across an entire parser invocation.
let __stripCacheSource: string | null = null;
let __stripCacheResult = '';
function getStrippedSource(source: string): string {
  if (__stripCacheSource === source) return __stripCacheResult;
  __stripCacheSource = source;
  __stripCacheResult = stripCommentsAndStrings(source);
  return __stripCacheResult;
}

function buildUsageBody(source: string, start: number, end: number): string {
  const stripped = getStrippedSource(source);
  return `${stripped.slice(0, start)}${' '.repeat(end - start)}${stripped.slice(end)}`;
}

export function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/'''[\s\S]*?'''/g, maskPreservingLines)
    .replace(/"""[\s\S]*?"""/g, maskPreservingLines)
    .replace(/#.*$/gm, maskPreservingLines)
    .replace(/\/\/.*$/gm, maskPreservingLines)
    .replace(/\/\*[\s\S]*?\*\//g, maskPreservingLines)
    .replace(/`(?:\\[\s\S]|[^`])*`/g, maskPreservingLines)
    .replace(/'(?:\\.|[^'\\\r\n])*'/g, maskPreservingLines)
    .replace(/"(?:\\.|[^"\\\r\n])*"/g, maskPreservingLines);
}

function maskPreservingLines(segment: string): string {
  return segment.replace(/[^\r\n]/g, ' ');
}

function hasIdentifierUsage(body: string, identifier: string): boolean {
  return new RegExp(`\\b${escapeRegex(identifier)}\\b`, 'm').test(body);
}

function collectNamespaceMembers(body: string, namespaceName: string): string[] {
  const members = new Set<string>();
  const regex = new RegExp(`\\b${escapeRegex(namespaceName)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
  for (const match of body.matchAll(regex)) {
    const member = match[1];
    if (member) {
      members.add(member);
    }
  }
  return [...members];
}

export function resolveImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  if (isPythonSourcePath(importerPath)) {
    return resolvePythonImportPath(db, importerPath, specifier);
  }

  if (isRustSourcePath(importerPath)) {
    return resolveRustImportPath(db, importerPath, specifier);
  }

  if (isRubySourcePath(importerPath)) {
    return resolveRubyImportPath(db, importerPath, specifier);
  }

  if (isCLikeSourcePath(importerPath)) {
    return resolveCLikeImportPath(db, importerPath, specifier);
  }

  if (isJvmSourcePath(importerPath) || isDotNetSourcePath(importerPath) || isPhpSourcePath(importerPath)) {
    return resolveQualifiedImportPath(db, specifier.replace(/\\/g, '.'), extensionFamilyFor(importerPath));
  }

  if (isDartSourcePath(importerPath)) {
    return resolveDartImportPath(db, importerPath, specifier);
  }

  return resolveJavaScriptImportPath(db, importerPath, specifier);
}

function resolveJavaScriptImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null;
  }

  const importerDir = dirname(join(db.config.projectRoot, importerPath));
  const absolute = resolve(importerDir, specifier);
  const indexedPaths = getIndexedPaths(db);

  for (const candidate of candidateImportPaths(absolute)) {
    const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
    if (indexedPaths.has(relativeCandidate) || existsSync(candidate)) {
      return relativeCandidate;
    }
  }

  return normalizePath(relative(db.config.projectRoot, absolute));
}

function resolvePythonImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  const indexedPaths = getIndexedPaths(db);

  let basePath: string;
  if (specifier.startsWith('.')) {
    const match = specifier.match(/^(\.+)(.*)$/);
    if (!match) return null;

    const dots = match[1]!.length;
    const remainder = match[2]!.replace(/^\./, '');
    let baseDir = dirname(join(db.config.projectRoot, importerPath));

    for (let i = 1; i < dots; i++) {
      baseDir = dirname(baseDir);
    }

    basePath = remainder
      ? resolve(baseDir, remainder.replace(/\./g, '/'))
      : baseDir;
  } else {
    basePath = resolve(db.config.projectRoot, specifier.replace(/\./g, '/'));
  }

  for (const candidate of pythonCandidateImportPaths(basePath)) {
    const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
    if (indexedPaths.has(relativeCandidate) || existsSync(candidate)) {
      return relativeCandidate;
    }
  }

  return null;
}

function resolveRustImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  if (!specifier) return null;
  const normalizedSpecifier = specifier.replace(/\s+as\s+.+$/, '').trim();
  if (!normalizedSpecifier.startsWith('crate::') && !normalizedSpecifier.startsWith('self::') && !normalizedSpecifier.startsWith('super::')) {
    return null;
  }

  const importerDir = dirname(join(db.config.projectRoot, importerPath));
  let basePath: string;
  if (normalizedSpecifier.startsWith('crate::')) {
    basePath = resolve(db.config.projectRoot, 'src', normalizedSpecifier.slice('crate::'.length).replace(/::/g, '/'));
  } else if (normalizedSpecifier.startsWith('self::')) {
    basePath = resolve(importerDir, normalizedSpecifier.slice('self::'.length).replace(/::/g, '/'));
  } else {
    basePath = resolve(dirname(importerDir), normalizedSpecifier.slice('super::'.length).replace(/::/g, '/'));
  }

  for (const candidate of rustCandidateImportPaths(basePath)) {
    const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
    if (getIndexedPaths(db).has(relativeCandidate) || existsSync(candidate)) {
      return relativeCandidate;
    }
  }

  return null;
}

function resolveRubyImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  const importerDir = dirname(join(db.config.projectRoot, importerPath));
  const absolute = resolve(importerDir, specifier);
  for (const candidate of rubyCandidateImportPaths(absolute)) {
    const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
    if (getIndexedPaths(db).has(relativeCandidate) || existsSync(candidate)) {
      return relativeCandidate;
    }
  }
  return null;
}

function resolveCLikeImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  const indexedPaths = getIndexedPaths(db);
  const importerDir = dirname(join(db.config.projectRoot, importerPath));
  const candidates = [
    resolve(importerDir, specifier),
    resolve(db.config.projectRoot, specifier),
    resolve(db.config.projectRoot, 'include', specifier),
    resolve(db.config.projectRoot, 'src', specifier),
  ];

  for (const candidate of candidates) {
    const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
    if (indexedPaths.has(relativeCandidate) || existsSync(candidate)) {
      return relativeCandidate;
    }
  }

  return null;
}

function resolveQualifiedImportPath(
  db: ScipDatabase,
  specifier: string,
  extensions: readonly string[],
): string | null {
  const indexedPaths = getIndexedPaths(db);
  const normalized = specifier.replace(/\\/g, '.').replace(/::/g, '.').replace(/^global::/, '');
  const pathified = normalized.replace(/\./g, '/');
  const basenameOnly = normalized.split('.').pop() ?? normalized;

  for (const ext of extensions) {
    const exactSuffix = `${pathified}${ext}`;
    const exact = [...indexedPaths].find((relativePath) => relativePath.endsWith(exactSuffix));
    if (exact) return exact;
  }

  for (const ext of extensions) {
    const basenameMatch = [...indexedPaths].find((relativePath) => basename(relativePath) === `${basenameOnly}${ext}`);
    if (basenameMatch) return basenameMatch;
  }

  const folderMatches = [...indexedPaths]
    .filter((relativePath) => extensions.includes(extname(relativePath).toLowerCase()))
    .filter((relativePath) => (
      relativePath.includes(`/${pathified}/`)
      || relativePath.includes(`/${basenameOnly}/`)
    ))
    .sort((left, right) => left.localeCompare(right));
  if (folderMatches.length === 1) {
    return folderMatches[0]!;
  }

  return null;
}

function resolveDartImportPath(
  db: ScipDatabase,
  importerPath: string,
  specifier: string,
): string | null {
  const indexedPaths = getIndexedPaths(db);
  if (specifier.startsWith('package:')) {
    const withoutScheme = specifier.slice('package:'.length);
    const slashIndex = withoutScheme.indexOf('/');
    if (slashIndex < 0) return null;
    const packageRelative = withoutScheme.slice(slashIndex + 1);
    const candidate = normalizePath(packageRelative.startsWith('lib/')
      ? packageRelative
      : `lib/${packageRelative}`);
    if (indexedPaths.has(candidate)) return candidate;
    return null;
  }

  const importerDir = dirname(join(db.config.projectRoot, importerPath));
  const absolute = resolve(importerDir, specifier);
  for (const candidate of dartCandidateImportPaths(absolute)) {
    const relativeCandidate = normalizePath(relative(db.config.projectRoot, candidate));
    if (indexedPaths.has(relativeCandidate) || existsSync(candidate)) {
      return relativeCandidate;
    }
  }
  return null;
}

function pythonCandidateImportPaths(basePath: string): string[] {
  const ext = extname(basePath);
  if (PYTHON_SOURCE_EXTENSIONS.includes(ext as typeof PYTHON_SOURCE_EXTENSIONS[number])) {
    return [basePath];
  }

  return [
    `${basePath}.py`,
    `${basePath}.pyi`,
    join(basePath, '__init__.py'),
    join(basePath, '__init__.pyi'),
  ];
}

function rustCandidateImportPaths(basePath: string): string[] {
  const ext = extname(basePath);
  if (RUST_SOURCE_EXTENSIONS.includes(ext as typeof RUST_SOURCE_EXTENSIONS[number])) {
    return [basePath];
  }

  return [
    `${basePath}.rs`,
    join(basePath, 'mod.rs'),
  ];
}

function rubyCandidateImportPaths(basePath: string): string[] {
  const ext = extname(basePath);
  if (RUBY_SOURCE_EXTENSIONS.includes(ext as typeof RUBY_SOURCE_EXTENSIONS[number])) {
    return [basePath];
  }

  return [
    `${basePath}.rb`,
    join(basePath, 'index.rb'),
  ];
}

function dartCandidateImportPaths(basePath: string): string[] {
  const ext = extname(basePath);
  if (DART_SOURCE_EXTENSIONS.includes(ext as typeof DART_SOURCE_EXTENSIONS[number])) {
    return [basePath];
  }

  return [`${basePath}.dart`, basePath];
}

function candidateImportPaths(absolute: string): string[] {
  const ext = extname(absolute);
  const candidates = new Set<string>();

  if (ext) {
    candidates.add(absolute);
    for (const sourceExt of SOURCE_EXTENSIONS) {
      candidates.add(absolute.slice(0, -ext.length) + sourceExt);
    }
  } else {
    for (const sourceExt of SOURCE_EXTENSIONS) {
      candidates.add(`${absolute}${sourceExt}`);
      candidates.add(join(absolute, `index${sourceExt}`));
    }
  }

  return [...candidates];
}

function getIndexedPaths(db: ScipDatabase): Set<string> {
  const cached = INDEXED_PATH_CACHE.get(db);
  if (cached) {
    return cached;
  }

  const paths = new Set(
    db.all<{ relative_path: string }>(
      `SELECT relative_path
       FROM documents
       WHERE 1 = 1
         ${db.pathExclusionsFor('documents')}`,
    )
      .map((row) => normalizePath(row.relative_path))
      .filter((relativePath) => !db.isIgnored(relativePath)),
  );

  INDEXED_PATH_CACHE.set(db, paths);
  return paths;
}

function getCachedMap<K, V>(
  cache: WeakMap<ScipDatabase, Map<K, V>>,
  db: ScipDatabase,
): Map<K, V> {
  let map = cache.get(db);
  if (!map) {
    map = new Map<K, V>();
    cache.set(db, map);
  }
  return map;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

// ── Language extension lookup ──────────────────────────────

const LANGUAGE_EXTENSION_FAMILIES: ReadonlyArray<readonly string[]> = [
  SOURCE_EXTENSIONS,
  PYTHON_SOURCE_EXTENSIONS,
  JVM_SOURCE_EXTENSIONS,
  RUST_SOURCE_EXTENSIONS,
  RUBY_SOURCE_EXTENSIONS,
  C_LIKE_SOURCE_EXTENSIONS,
  DOTNET_SOURCE_EXTENSIONS,
  DART_SOURCE_EXTENSIONS,
  PHP_SOURCE_EXTENSIONS,
];

function hasExtensionIn(relativePath: string, extensions: readonly string[]): boolean {
  return (extensions as readonly string[]).includes(extname(relativePath).toLowerCase());
}

function isJavaScriptSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, SOURCE_EXTENSIONS); }
function isPythonSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, PYTHON_SOURCE_EXTENSIONS); }
function isJvmSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, JVM_SOURCE_EXTENSIONS); }
function isRustSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, RUST_SOURCE_EXTENSIONS); }
function isRubySourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, RUBY_SOURCE_EXTENSIONS); }
function isCLikeSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, C_LIKE_SOURCE_EXTENSIONS); }
function isDotNetSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, DOTNET_SOURCE_EXTENSIONS); }
function isVisualBasicSourcePath(relativePath: string): boolean { return extname(relativePath).toLowerCase() === '.vb'; }
function isDartSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, DART_SOURCE_EXTENSIONS); }
function isPhpSourcePath(relativePath: string): boolean { return hasExtensionIn(relativePath, PHP_SOURCE_EXTENSIONS); }

function extensionFamilyFor(relativePath: string): readonly string[] {
  const ext = extname(relativePath).toLowerCase();
  for (const family of LANGUAGE_EXTENSION_FAMILIES) {
    if ((family as readonly string[]).includes(ext)) return family;
  }
  return SOURCE_EXTENSIONS;
}

export function getSourceText(
  db: ScipDatabase,
  relativePath: string,
): string {
  const cache = getCachedMap(SOURCE_TEXT_CACHE, db);
  const normalized = normalizePath(relativePath);
  const cached = cache.get(normalized);
  if (typeof cached === 'string') {
    return cached;
  }

  const fullPath = join(db.config.projectRoot, normalized);
  if (!existsSync(fullPath)) {
    cache.set(normalized, '');
    return '';
  }

  const source = readFileSync(fullPath, 'utf-8');
  cache.set(normalized, source);
  return source;
}

function pythonParenBalance(value: string): number {
  let balance = 0;
  for (const char of value) {
    if (char === '(') balance++;
    if (char === ')') balance--;
  }
  return balance;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
