/**
 * JavaScript-family re-export parser for `export ... from '...'` statements.
 *
 * Returns each statement's kind, resolved source path, re-exported local names
 * for named re-exports, and line range.
 */
import { getAst, type SyntaxNode, type Tree } from '../source/ast.js';
import type { ScipDatabase } from '../storage/db.js';
import { resolveImportPath } from '../resolution/import-path-resolver.js';
import type { ParsedReExport } from '../domain/types.js';
import { firstChildOfType, splitTopLevel } from './utils.js';

export function parseReExports(
  db: ScipDatabase,
  relativePath: string,
  source: string,
): ParsedReExport[] {
  const tree = getAst(db, relativePath);
  if (tree) return getReExportsAst(db, relativePath, tree);
  return parseReExportsRegex(db, relativePath, source);
}

function parseReExportsRegex(
  db: ScipDatabase,
  relativePath: string,
  source: string,
): ParsedReExport[] {
  return [
    ...parseNamedReExportsRegex(db, relativePath, source),
    ...parseStarAsReExportsRegex(db, relativePath, source),
    ...parseStarReExportsRegex(db, relativePath, source),
  ];
}

function parseNamedReExportsRegex(
  db: ScipDatabase,
  relativePath: string,
  source: string,
): ParsedReExport[] {
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
      sourcePath: resolveImportPath(db, relativePath, specifier),
      names,
      startLine: start,
      endLine: end,
    });
  }
  return results;
}

function parseStarAsReExportsRegex(
  db: ScipDatabase,
  relativePath: string,
  source: string,
): ParsedReExport[] {
  const results: ParsedReExport[] = [];
  const starAsRegex = /^[ \t]*export\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(starAsRegex)) {
    if (typeof match.index !== 'number') continue;
    const specifier = match[2] ?? '';
    const start = lineOf(source, match.index);
    const end = lineOf(source, match.index + match[0].length - 1);
    results.push({
      kind: 'star-as',
      sourcePath: resolveImportPath(db, relativePath, specifier),
      names: [],
      startLine: start,
      endLine: end,
    });
  }
  return results;
}

function parseStarReExportsRegex(
  db: ScipDatabase,
  relativePath: string,
  source: string,
): ParsedReExport[] {
  const results: ParsedReExport[] = [];
  const starRegex = /^[ \t]*export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(starRegex)) {
    if (typeof match.index !== 'number') continue;
    const specifier = match[1] ?? '';
    const start = lineOf(source, match.index);
    const end = lineOf(source, match.index + match[0].length - 1);
    results.push({
      kind: 'star',
      sourcePath: resolveImportPath(db, relativePath, specifier),
      names: [],
      startLine: start,
      endLine: end,
    });
  }

  return results;
}

function parseReExportBinding(entry: string): string | null {
  if (!entry) return null;
  const cleaned = entry.replace(/^type\s+/, '').trim();
  if (!cleaned) return null;
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
    const sourcePath = resolveExportSpecifierSource(db, importerPath, node);
    if (sourcePath === undefined) continue;

    const startLine = node.startPosition.row;
    const endLine = node.endPosition.row;
    const result = parseReExportClause(node, sourcePath, startLine, endLine);
    results.push(result);
  }

  return results;
}

function resolveExportSpecifierSource(
  db: ScipDatabase,
  importerPath: string,
  node: SyntaxNode,
): string | null | undefined {
  const str = firstChildOfType(node, 'string');
  if (!str) return undefined;
  const frag = firstChildOfType(str, 'string_fragment');
  if (!frag) return undefined;
  return resolveImportPath(db, importerPath, frag.text);
}

function parseReExportClause(
  node: SyntaxNode,
  sourcePath: string | null,
  startLine: number,
  endLine: number,
): ParsedReExport {
  const exportClause = firstChildOfType(node, 'export_clause');
  if (exportClause) {
    const names: string[] = [];
    for (const spec of exportClause.namedChildren) {
      if (spec.type !== 'export_specifier') continue;
      const importedNode = spec.namedChild(0);
      const aliasNode = spec.namedChild(1);
      if (!importedNode) continue;
      names.push((aliasNode ?? importedNode).text);
    }
    return { kind: 'named', sourcePath, names, startLine, endLine };
  }

  const namespaceExport = firstChildOfType(node, 'namespace_export');
  if (namespaceExport) {
    return { kind: 'star-as', sourcePath, names: [], startLine, endLine };
  }

  return { kind: 'star', sourcePath, names: [], startLine, endLine };
}
