/**
 * Source-file reader with a per-database cache. Tiny module, but the cache
 * itself is hot — every per-language parser, every source-text-driven
 * query (refs/dataflow/trace), and the AST runtime all read source
 * through here so we pay the disk cost once per file per process.
 */
import type { ScipDatabase } from '../../storage/db.js';
import { isMissingProjectFileError, readProjectFileText } from '../../platform/project-files.js';
import { createPerDbCache } from '../../storage/per-db-cache.js';

const SOURCE_TEXT_CACHE = createPerDbCache<string, string>('source-text', {
  clearGroups: ['whole-project', 'source-file'],
});

const SOURCE_LINES_CACHE = createPerDbCache<string, readonly string[]>('source-lines', {
  clearGroups: ['whole-project', 'source-file'],
});

export function getSourceText(db: ScipDatabase, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  return SOURCE_TEXT_CACHE.get(db, normalized, () => readSourceTextUncached(db, normalized));
}

/** Reads one source file without retaining its bytes in the per-database analysis cache. */
export function readSourceTextUncached(db: ScipDatabase, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  try {
    return readProjectFileText(db.config.projectRoot, normalized, {
      inputKind: 'indexed source file',
    });
  } catch (error) {
    if (isMissingProjectFileError(error)) return '';
    throw error;
  }
}

/** Split source text into lines without a trailing empty line from a final newline. */
export function splitSearchableSourceLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

export function getSourceLines(db: ScipDatabase, relativePath: string): readonly string[] {
  const normalized = relativePath.replace(/\\/g, '/');
  return SOURCE_LINES_CACHE.get(db, normalized, () => {
    const source = getSourceText(db, normalized);
    return source ? source.split('\n') : [];
  });
}

const SUPPRESS_COMMENT_RE =
  /^\s*(?:\/\/|#|\/\*+|\*)\s*scip-query[\s:-]*ignore(?:[\s:-]+(dead(?:-code)?|stale|wrapper|passthrough|drift|extract|similar|twin))?\b/i;

export function suppressionCommentCategory(line: string): string | null {
  const match = SUPPRESS_COMMENT_RE.exec(line);
  if (!match) return null;
  return match[1] ?? '';
}

/**
 * True when a `// scip-query: ignore-...` (or similar) comment appears on
 * the line immediately preceding `startLine` (0-indexed). Used by the
 * health-suite heuristics to let users opt out of false positives without
 * touching the detector.
 */
export function hasSuppressionComment(db: ScipDatabase, relativePath: string, startLine: number): boolean {
  return suppressionCommentsBeforeDefinition(db, relativePath, startLine).length > 0;
}

export function hasSuppressionCommentCategory(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  category: string,
): boolean {
  const expected = category.toLowerCase();
  return suppressionCommentsBeforeDefinition(db, relativePath, startLine).some(
    (candidate) => candidate.toLowerCase() === expected,
  );
}

function suppressionCommentsBeforeDefinition(db: ScipDatabase, relativePath: string, startLine: number): string[] {
  if (startLine <= 0) return [];
  const lines = getSourceLines(db, relativePath);
  if (lines.length === 0) return [];
  const categories: string[] = [];
  // Walk upward through contiguous comment / blank / decorator lines so a
  // suppression comment placed two lines above (with a JSDoc in between, etc.)
  // still counts.
  for (let i = startLine - 1; i >= 0 && i >= startLine - 5; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '') continue;
    const category = suppressionCommentCategory(line);
    if (category !== null) {
      categories.push(category);
      continue;
    }
    // Stop scanning once we hit a non-comment, non-decorator line.
    if (
      !line.startsWith('//') &&
      !line.startsWith('*') &&
      !line.startsWith('/*') &&
      !line.startsWith('@') &&
      !line.startsWith('#')
    ) {
      return categories;
    }
  }
  return categories;
}
