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
import { getSourceFacts } from '../source/ast.js';
import type { ScipDatabase } from '../storage/db.js';
import { createPerDbCache } from '../storage/per-db-cache.js';
import { stripCommentsAndStrings } from '../source/source-stripper.js';
import { getSourceText } from '../source/source-text.js';

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

  const lines = getIdentifierLineMap(db, relativePath).get(identifier) ?? [];
  return lines.filter((line) => !inExcludedRange(line, opts));
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
const FILE_IDENTIFIER_CACHE = createPerDbCache<string, Set<string>>('file-identifiers', {
  clearGroups: ['whole-project', 'source-file'],
});
// scip-query: ignore-wrapper — public read-side of FILE_IDENTIFIER_CACHE, expresses
// "set of identifiers in this file" as a distinct interface from the line-map cache.
export function getFileIdentifiers(
  db: ScipDatabase,
  relativePath: string,
): Set<string> {
  const facts = getSourceFacts(db, relativePath);
  if (facts) return facts.fileIdentifiers;

  return FILE_IDENTIFIER_CACHE.get(db, relativePath, () =>
    // Derive from the fallback line map so we don't tokenize twice.
    new Set(getIdentifierLineMap(db, relativePath).keys()),
  );
}

/**
 * Per-file map of identifier name → sorted line numbers where it appears.
 * Powers source-text refinement of SCIP mentions when a chunk's start line
 * is too coarse to identify the precise enclosing function. Cached per file.
 */
const FILE_IDENT_LINES_CACHE = createPerDbCache<string, Map<string, number[]>>('file-ident-lines', {
  clearGroups: ['whole-project', 'source-file'],
});
export function getIdentifierLineMap(
  db: ScipDatabase,
  relativePath: string,
): Map<string, number[]> {
  const facts = getSourceFacts(db, relativePath);
  if (facts) return facts.identifierLineMap;

  return FILE_IDENT_LINES_CACHE.get(db, relativePath, () =>
    computeFallbackIdentifierLineMap(db, relativePath),
  );
}

/**
 * Per-file array indexed by line number, where each entry is the Set of
 * identifier names that appear on that line. Computed once per file (cached)
 * and used to compute "identifiers in [startLine..endLine]" in O(range size)
 * — avoiding the O(file identifiers) scan that buildCalleeMap would otherwise
 * pay per definition.
 */
const FILE_IDENTS_BY_LINE_CACHE = createPerDbCache<string, Array<Set<string>>>('file-idents-by-line', {
  clearGroups: ['whole-project', 'source-file'],
});
// scip-query: ignore-wrapper — line-index view of identifier evidence used by
// call-graph evidence; hides the cached identifier map materialization.
export function getIdentifiersByLine(
  db: ScipDatabase,
  relativePath: string,
): Array<Set<string>> {
  const facts = getSourceFacts(db, relativePath);
  if (facts) return facts.identifiersByLine;

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

function computeFallbackIdentifierLineMap(
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
