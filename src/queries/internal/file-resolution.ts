/**
 * path-resolver — file-pattern → indexed path resolution, with
 * on-disk fallback for unindexed file types (Vue SFCs, etc.).
 *
 * Given a user-supplied file pattern, return:
 *   - `resolveIndexedFile`: the single best-matching SCIP-indexed path
 *     (or, if nothing matches, an on-disk path for source-text-based
 *     queries that go through `getSourceImports`).
 *   - `resolveIndexedPaths`: every reasonable match (for queries that
 *     accept a pattern matching multiple files).
 *
 * Resolution order (used by both): exact path → suffix path → basename
 * → substring → fall back to symbol lookup. Scoring lives in
 * `scoreDocumentPath`; symbol-lookup is the soft fallback when no
 * document path scores > 0.
 *
 * This query-owned helper depends only on indexed storage plus symbol lookup.
 * It stays behind query entry points because its input is a user-facing file
 * pattern rather than a source-language import specifier.
 */
import type { ScipDatabase } from '../../storage/db.js';
import { existsSync as existsSyncFs } from 'node:fs';
import { isAbsolute as isAbsolutePath, join as pathJoin } from 'node:path';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { resolveIndexedDocumentCandidates, type IndexedDocumentPathCandidate } from '../../storage/scip-documents.js';

export { normalizeLookupPath, scoreDocumentPath } from '../../storage/scip-documents.js';

export function resolveIndexedFile(db: ScipDatabase, filePattern: string): string | null {
  const indexed = resolveDocumentCandidates(db, filePattern, { allowMultiple: false })[0]?.relativePath;
  if (indexed) return indexed;

  // Fallback for file types the SCIP indexers don't include (Vue SFCs in
  // particular — scip-typescript doesn't recognize the `.vue` extension).
  // Source-text-based queries like `imports` / `unused-imports` still work
  // for these files because their parsers go through `getSourceImports`,
  // which reads from disk; we just need to give them a real relative path.
  return resolveOnDiskFile(db, filePattern);
}

export function resolveIndexedPaths(db: ScipDatabase, filePattern: string): string[] {
  return resolveDocumentCandidates(db, filePattern, { allowMultiple: true }).map((candidate) => candidate.relativePath);
}

export function resolveOnDiskFile(db: ScipDatabase, filePattern: string): string | null {
  if (!filePattern) return null;
  const normalized = filePattern.replace(/\\/g, '/').replace(/^\.\//, '');
  // Try exact-relative-to-project resolution first.
  const rel =
    isAbsolutePath(normalized) && normalized.startsWith(db.config.projectRoot)
      ? normalized.slice(db.config.projectRoot.length).replace(/^\/+/, '')
      : normalized;
  const abs = pathJoin(db.config.projectRoot, rel);
  return existsSyncFs(abs) ? rel : null;
}

// scip-query: ignore-extract — this function is the ranked file-resolution
// decision table: exact path, basename, fuzzy path, and symbol fallback need
// to stay readable in priority order.
export function resolveDocumentCandidates(
  db: ScipDatabase,
  filePattern: string,
  opts: { allowMultiple: boolean },
): IndexedDocumentPathCandidate[] {
  const indexed = resolveIndexedDocumentCandidates(db, filePattern, opts);
  if (indexed.length === 0) {
    const symbolMatch = findFirstSymbolMatch(db, filePattern);
    if (!symbolMatch || db.isIgnored(symbolMatch.relativePath)) {
      return [];
    }

    return [
      {
        relativePath: symbolMatch.relativePath,
        score: 700,
      },
    ];
  }

  return indexed;
}
