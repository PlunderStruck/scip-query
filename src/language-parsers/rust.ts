/**
 * Rust parser. Owns `.rs`. AST path uses tree-sitter-rust to flatten
 * `use` trees (including aliased, nested, and wildcard variants);
 * regex fallback handles the rare cases where tree-sitter can't parse.
 *
 * Owns both imports (`use … ;`) and exports (`pub use … ;`) — Rust's
 * pub-use is the export construct other languages handle via their
 * AST `export` nodes.
 */
import { getAst, type SyntaxNode, type Tree } from '../source/ast.js';
import type { ScipDatabase } from '../storage/db.js';
import { resolveRustImportPath } from '../resolution/import-path-resolver.js';
import type { ParsedSourceExport, ParsedSourceImport } from '../domain/types.js';
import { buildSimpleImport, collectIdentifiersOutside, parseImportLineMatches, splitTopLevel } from './utils.js';

interface RustImportLeaf {
  qualifiedName: string;
  importedName: string;
  localName: string;
}

export function parseRustImports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceImport[] {
  const tree = getAst(db, importerPath);
  if (tree) {
    return parseRustImportsAst(db, importerPath, tree);
  }
  // Fallback: regex parser when AST is unavailable (e.g. unreadable source).
  return parseImportLineMatches(source, /^[ \t]*use\s+(.+?)\s*;$/gm, (match, body) => {
    const clause = match[1]?.trim();
    if (!clause) return [];
    return parseRustUseClause(db, importerPath, clause, body);
  });
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

// ── Exports (pub use) ─────────────────────────────────────────────

export function parseRustExports(
  db: ScipDatabase,
  importerPath: string,
  source: string,
): ParsedSourceExport[] {
  const tree = getAst(db, importerPath);
  if (tree) {
    return parseRustExportsAst(db, importerPath, tree);
  }
  // Regex fallback for files where tree-sitter can't parse the source.
  const statements: ParsedSourceExport[] = [];
  for (const match of source.matchAll(/^[ \t]*pub\s+use\s+(.+?)\s*;$/gm)) {
    const clause = match[1]?.trim();
    if (!clause) continue;
    statements.push(...parseRustExportClause(db, importerPath, clause));
  }
  return statements;
}

function parseRustExportsAst(
  db: ScipDatabase,
  importerPath: string,
  tree: Tree,
): ParsedSourceExport[] {
  const results: ParsedSourceExport[] = [];

  for (const useDecl of tree.rootNode.descendantsOfType('use_declaration')) {
    // Only `pub use ...` re-exports, not plain `use`.
    if (!hasPubVisibility(useDecl)) continue;

    // The use-tree root is the first named child after any `pub`/visibility
    // modifier. flattenRustUseTree handles braced lists, aliases, globs,
    // nested paths.
    const root = useDecl.namedChildren.find((c) => c.type !== 'visibility_modifier');
    if (!root) continue;

    for (const leaf of flattenRustUseTree(root, '')) {
      if (!leaf.importedName) continue;
      results.push(buildRustExport(db, importerPath, leaf.qualifiedName));
    }
  }

  return results;
}

function hasPubVisibility(node: SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === 'visibility_modifier' && child.text.startsWith('pub')) return true;
  }
  return false;
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
