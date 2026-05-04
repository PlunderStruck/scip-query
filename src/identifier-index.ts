/**
 * identifier-index — per-file maps of identifier → line numbers, identifier
 * sets, and per-line identifier sets. Used wherever we need to ask "where
 * does identifier X appear in file F?" without re-walking the AST every
 * time.
 *
 * Three caches power three views of the same underlying scan:
 *   - `getIdentifierLineMap` — `name → sorted line numbers`. Powers
 *     `findIdentifierLines` and source-text-refinement of SCIP mentions.
 *   - `getFileIdentifiers` — set of every identifier name in the file.
 *     Used as a cheap "does this file mention X at all?" gate.
 *   - `getIdentifiersByLine` — array indexed by line, each entry being the
 *     set of names on that line. Used by `buildCalleeMap` to avoid the
 *     O(file-identifiers × definitions) scan it would otherwise pay.
 *
 * AST path uses tree-sitter; regex fallback uses the source-stripper to
 * tokenize comment- and string-free source into identifier tokens.
 */
import { detectAstLanguage, getAst, type SyntaxNode } from './ast.js';
import type { ScipDatabase } from './db.js';
import { createPerDbCache } from './per-db-cache.js';
import { escapeRegex, getStrippedLines, stripCommentsAndStrings } from './source-stripper.js';
import { getSourceText } from './source-text.js';

/**
 * Lines in `relativePath` where `identifier` appears (0-indexed). Excludes
 * any line in `[opts.excludeStartLine, opts.excludeEndLine]` if both are
 * provided — used to skip the defining range when scanning for refs.
 */
export function findIdentifierLines(
  db: ScipDatabase,
  relativePath: string,
  identifier: string,
  opts: { excludeStartLine?: number; excludeEndLine?: number } = {},
): number[] {
  if (!identifier) {
    return [];
  }

  const source = getSourceText(db, relativePath);
  if (!source) {
    return [];
  }

  // Cheap early-exit: if the raw source doesn't even contain the identifier
  // substring, neither the stripped source nor the AST can either. Saves
  // both the 8-pass regex strip and the AST walk on every file that doesn't
  // reference this symbol — the common case for cross-file `refs`.
  if (source.indexOf(identifier) === -1) {
    return [];
  }

  // AST path: getIdentifierLineMap already walks the tree once per file
  // and caches the result. For the AST-supported languages this is more
  // accurate than regex (correctly handles raw strings, JSX text, format
  // string interpolation, nested template literals) AND faster on the
  // second-and-later identifier lookup in the same file.
  if (detectAstLanguage(relativePath)) {
    const lineMap = getIdentifierLineMap(db, relativePath);
    const lines = lineMap.get(identifier) ?? [];
    return lines.filter((line) => !inExcludedRange(line, opts));
  }

  // Regex fallback for languages without an AST parser.
  const lines = getStrippedLines(db, relativePath, source);
  const regex = new RegExp(`\\b${escapeRegex(identifier)}\\b`);
  const results: number[] = [];

  for (let line = 0; line < lines.length; line++) {
    if (inExcludedRange(line, opts)) continue;
    if (regex.test(lines[line] ?? '')) {
      results.push(line);
    }
  }

  return results;
}

function inExcludedRange(
  line: number,
  opts: { excludeStartLine?: number; excludeEndLine?: number },
): boolean {
  return typeof opts.excludeStartLine === 'number'
    && typeof opts.excludeEndLine === 'number'
    && line >= opts.excludeStartLine
    && line <= opts.excludeEndLine;
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
const FILE_IDENTIFIER_CACHE = createPerDbCache<string, Set<string>>('file-identifiers');
// scip-query: ignore-wrapper — public read-side of FILE_IDENTIFIER_CACHE, expresses
// "set of identifiers in this file" as a distinct interface from the line-map cache.
export function getFileIdentifiers(
  db: ScipDatabase,
  relativePath: string,
): Set<string> {
  return FILE_IDENTIFIER_CACHE.get(db, relativePath, () =>
    // Derive from the line-map walk so we don't pay the AST traversal twice.
    new Set(getIdentifierLineMap(db, relativePath).keys()),
  );
}

/**
 * Per-file map of identifier name → sorted line numbers where it appears.
 * Powers source-text refinement of SCIP mentions when a chunk's start line
 * is too coarse to identify the precise enclosing function. Cached per file.
 */
const FILE_IDENT_LINES_CACHE = createPerDbCache<string, Map<string, number[]>>('file-ident-lines');
export function getIdentifierLineMap(
  db: ScipDatabase,
  relativePath: string,
): Map<string, number[]> {
  return FILE_IDENT_LINES_CACHE.get(db, relativePath, () =>
    computeIdentifierLineMap(db, relativePath),
  );
}

/**
 * Per-file array indexed by line number, where each entry is the Set of
 * identifier names that appear on that line. Computed once per file (cached)
 * and used to compute "identifiers in [startLine..endLine]" in O(range size)
 * — avoiding the O(file identifiers) scan that buildCalleeMap would otherwise
 * pay per definition.
 */
const FILE_IDENTS_BY_LINE_CACHE = createPerDbCache<string, Array<Set<string>>>('file-idents-by-line');
export function getIdentifiersByLine(
  db: ScipDatabase,
  relativePath: string,
): Array<Set<string>> {
  return FILE_IDENTS_BY_LINE_CACHE.get(db, relativePath, () => {
    const lineMap = getIdentifierLineMap(db, relativePath);
    let maxLine = 0;
    for (const lines of lineMap.values()) {
      const last = lines[lines.length - 1];
      if (last !== undefined && last > maxLine) maxLine = last;
    }
    const out: Array<Set<string>> = new Array(maxLine + 1);
    for (let i = 0; i <= maxLine; i += 1) out[i] = new Set();
    for (const [name, lines] of lineMap) {
      for (const line of lines) out[line]!.add(name);
    }
    return out;
  });
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
