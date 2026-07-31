/**
 * JavaScript-family import parser for `.ts`, `.tsx`, `.mts`, `.cts`, `.js`,
 * `.jsx`, `.mjs`, `.cjs`, and `.vue` files.
 *
 * AST path uses tree-sitter-typescript or tree-sitter-javascript through the
 * shared dispatcher in `ast.ts`. Regex fallback handles cases where
 * tree-sitter cannot parse the source.
 */
import { isVueSfcPath, type SyntaxNode, type Tree } from '../../source/ast.js';
import type { ScipDatabase } from '../../storage/db.js';
import { resolveImportPath } from '../../source/primitives/import-path-resolver.js';
import {
  buildUsageBody,
  collectNamespaceMembers,
  hasIdentifierUsage,
} from '../../source/primitives/source-stripper.js';
import type { ParsedSourceImport } from '../../domain/types.js';
import {
  buildNamedImport,
  buildNamespaceImport,
  buildSideEffectImport,
  buildUsedImport,
  collectIdentifiersOutside,
  firstChildOfType,
  parseWithAstFallback,
  splitTopLevel,
} from './utils.js';
import { collectVueNonScriptIdentifiers } from './vue-non-script-identifiers.js';

export function parseJavaScriptImports(db: ScipDatabase, importerPath: string, source: string): ParsedSourceImport[] {
  return parseWithAstFallback(
    db,
    importerPath,
    (tree) => parseJavaScriptImportsAst(db, importerPath, tree),
    () => parseJavaScriptImportsRegex(db, importerPath, source),
    source,
  );
}

function parseJavaScriptImportsRegex(db: ScipDatabase, importerPath: string, source: string): ParsedSourceImport[] {
  return parseJavaScriptImportStatements(source).flatMap((statement) =>
    parseJavaScriptImportStatement(
      db,
      importerPath,
      statement.clause,
      statement.specifier,
      statement.start,
      statement.end,
      source,
    ),
  );
}

function parseJavaScriptImportsAst(db: ScipDatabase, importerPath: string, tree: Tree): ParsedSourceImport[] {
  const usedNames = astImportUsedNames(db, importerPath, tree);
  const results: ParsedSourceImport[] = [];
  for (const node of tree.rootNode.descendantsOfType('import_statement')) {
    results.push(...parseAstImportNode(db, importerPath, tree, node, usedNames));
  }
  return results;
}

function astImportUsedNames(db: ScipDatabase, importerPath: string, tree: Tree): Set<string> {
  // Only IMPORT contexts are exclusions; value exports like `export function f()`
  // are also `export_statement` nodes, so excluding them here would make every
  // identifier used inside an exported function body look unused.
  const usedNames = collectIdentifiersOutside(tree, new Set(['import_statement']));
  if (isVueSfcPath(importerPath)) {
    for (const name of collectVueNonScriptIdentifiers(db, importerPath)) {
      usedNames.add(name);
    }
  }
  return usedNames;
}

// scip-query: ignore-extract - this is the JavaScript AST import parser:
// side-effect imports, import clauses, specifiers, and type-only detection are
// one node-level parsing rule.
function parseAstImportNode(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
  node: SyntaxNode,
  usedNames: ReadonlySet<string>,
): ParsedSourceImport[] {
  const specifier = jsImportSpecifier(node);
  if (!specifier) return [];

  const sourcePath = resolveImportPath(db, importerPath, specifier);
  const importClause = firstChildOfType(node, 'import_clause');
  if (!importClause) {
    return [buildSideEffectImport('*', sourcePath)];
  }

  return parseAstImportClause(tree, importClause, sourcePath, usedNames, isTypeOnlyImportStatement(node.text));
}

function parseAstImportClause(
  tree: Tree,
  importClause: SyntaxNode,
  sourcePath: string | null,
  usedNames: ReadonlySet<string>,
  clauseTypeOnly: boolean,
): ParsedSourceImport[] {
  const results: ParsedSourceImport[] = [];
  for (const child of importClause.namedChildren) {
    if (child.type === 'identifier') {
      results.push(defaultImport(child.text, sourcePath, usedNames, clauseTypeOnly));
    } else if (child.type === 'namespace_import') {
      const parsed = namespaceImport(tree, child, sourcePath, usedNames, clauseTypeOnly);
      if (parsed) results.push(parsed);
    } else if (child.type === 'named_imports') {
      results.push(...namedImports(child, sourcePath, usedNames, clauseTypeOnly));
    }
  }
  return results;
}

function defaultImport(
  localName: string,
  sourcePath: string | null,
  usedNames: ReadonlySet<string>,
  isTypeOnly: boolean,
): ParsedSourceImport {
  return buildNamedImport('default', localName, sourcePath, usedNames, 'default', { isTypeOnly });
}

function namespaceImport(
  tree: Tree,
  node: SyntaxNode,
  sourcePath: string | null,
  usedNames: ReadonlySet<string>,
  isTypeOnly: boolean,
): ParsedSourceImport | null {
  const idNode = firstChildOfType(node, 'identifier');
  const localName = idNode?.text ?? '';
  if (!localName) return null;
  const usedMembers = collectMemberAccesses(tree, localName);
  return buildNamespaceImport('*', sourcePath, {
    localName,
    usedMembers,
    isTypeOnly,
    used: usedMembers.length > 0 || usedNames.has(localName),
  });
}

function namedImports(
  node: SyntaxNode,
  sourcePath: string | null,
  usedNames: ReadonlySet<string>,
  clauseTypeOnly: boolean,
): ParsedSourceImport[] {
  const results: ParsedSourceImport[] = [];
  for (const spec of node.namedChildren) {
    if (spec.type !== 'import_specifier') continue;
    const importedNode = spec.namedChild(0);
    const aliasNode = spec.namedChild(1);
    if (!importedNode) continue;
    const importedName = importedNode.text;
    const localName = aliasNode?.text ?? importedName;
    results.push(
      buildNamedImport(importedName, localName, sourcePath, usedNames, 'named', {
        isTypeOnly: clauseTypeOnly || isTypeOnlyImportSpecifier(spec.text),
      }),
    );
  }
  return results;
}

function jsImportSpecifier(node: SyntaxNode): string | null {
  const str = firstChildOfType(node, 'string');
  if (!str) return null;
  const frag = firstChildOfType(str, 'string_fragment');
  return frag ? frag.text : null;
}

function isTypeOnlyImportStatement(text: string): boolean {
  return /^\s*import\s+type\b/.test(text);
}

function isTypeOnlyImportSpecifier(text: string): boolean {
  return /^\s*type\b/.test(text.trim());
}

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
    return [buildSideEffectImport('*', resolvedSource)];
  }

  const bindings = parseImportClause(clause).map((binding) => ({
    ...binding,
    sourcePath: resolvedSource,
  }));

  return bindings.map((binding) => {
    if (binding.kind === 'namespace') {
      const usedMembers = collectNamespaceMembers(body, binding.localName!);
      return buildNamespaceImport(binding.importedName, binding.sourcePath, {
        localName: binding.localName,
        usedMembers,
        used: usedMembers.length > 0 || hasIdentifierUsage(body, binding.localName!),
        isTypeOnly: binding.isTypeOnly,
      });
    }

    if (binding.kind === 'side-effect') {
      return buildSideEffectImport(binding.importedName, binding.sourcePath);
    }

    return buildUsedImport(
      binding.importedName,
      binding.localName ?? '',
      binding.sourcePath,
      binding.localName ? hasIdentifierUsage(body, binding.localName) : false,
      binding.kind,
      [],
      { isTypeOnly: binding.isTypeOnly },
    );
  });
}

function parseImportClause(clause: string): Array<{
  importedName: string;
  localName: string | null;
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
  isTypeOnly: boolean;
}> {
  const raw = clause.trim();
  const clauseTypeOnly = /^type\b/.test(raw);
  const trimmed = raw.replace(/^type\s+/, '');
  const [first, second] = splitImportClause(trimmed);
  const entries: Array<{
    importedName: string;
    localName: string | null;
    kind: 'named' | 'default' | 'namespace' | 'side-effect';
    isTypeOnly: boolean;
  }> = [];

  if (first) {
    entries.push(...parseImportBinding(first, clauseTypeOnly));
  }

  if (second) {
    entries.push(...parseImportBinding(second, clauseTypeOnly));
  }

  return entries;
}

function parseImportBinding(
  binding: string,
  clauseTypeOnly: boolean,
): Array<{
  importedName: string;
  localName: string | null;
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
  isTypeOnly: boolean;
}> {
  const trimmed = binding.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];

    return splitTopLevel(inner).map((entry) => {
      const raw = entry.trim();
      const bindingTypeOnly = clauseTypeOnly || /^type\b/.test(raw);
      const cleaned = raw.replace(/^type\s+/, '');
      const [importedName, alias] = cleaned.split(/\s+as\s+/);
      return {
        importedName: importedName!.trim(),
        localName: (alias ?? importedName)!.trim(),
        kind: 'named' as const,
        isTypeOnly: bindingTypeOnly,
      };
    });
  }

  if (trimmed.startsWith('* as ')) {
    return [
      {
        importedName: '*',
        localName: trimmed.slice(5).trim(),
        kind: 'namespace',
        isTypeOnly: clauseTypeOnly,
      },
    ];
  }

  return [
    {
      importedName: 'default',
      localName: trimmed,
      kind: 'default',
      isTypeOnly: clauseTypeOnly,
    },
  ];
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
