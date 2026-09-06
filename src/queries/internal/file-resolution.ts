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
 * Resolution order for a path-shaped selector: exact path → suffix path.
 * Bare filenames may additionally use basename → substring → symbol lookup. Scoring lives in
 * `scoreDocumentPath`; symbol-lookup is the soft fallback when no
 * document path scores > 0.
 *
 * This query-owned helper depends only on indexed storage plus symbol lookup.
 * It stays behind query entry points because its input is a user-facing file
 * pattern rather than a source-language import specifier.
 */
import type { ScipDatabase } from '../../storage/db.js';
import { statSync } from 'node:fs';
import { isAbsolute as isAbsolutePath, join as pathJoin, relative } from 'node:path';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import {
  indexedDocumentPaths,
  resolveIndexedDocumentCandidates,
  type IndexedDocumentPathCandidate,
} from '../../storage/scip-documents.js';

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

/** Resolve a file selector only when it identifies one indexed document. */
export function resolveUniqueIndexedPath(db: ScipDatabase, filePattern: string): string | null {
  const candidates = resolveDocumentCandidates(db, filePattern, { allowMultiple: true });
  return candidates.length === 1 ? candidates[0]!.relativePath : null;
}

/** Resolve a file:line path without ever degrading to a basename or substring match. */
export function resolveIndexedLocationPath(db: ScipDatabase, filePattern: string): string | null {
  const candidates = resolveIndexedDocumentCandidates(db, filePattern, {
    allowMultiple: true,
    requirePathMatch: true,
  });
  return candidates.length === 1 ? candidates[0]!.relativePath : null;
}

export function resolveOnDiskFile(db: ScipDatabase, filePattern: string): string | null {
  if (!filePattern) return null;
  const normalized = filePattern.replace(/\\/g, '/').replace(/^\.\//, '');
  // Try exact-relative-to-project resolution first.
  const rel = isAbsolutePath(normalized) ? relative(db.config.projectRoot, normalized) : normalized;
  if (rel === '..' || rel.startsWith('../') || isAbsolutePath(rel)) return null;
  const abs = pathJoin(db.config.projectRoot, rel);
  return statSync(abs, { throwIfNoEntry: false })?.isFile() ? rel : null;
}

// scip-query: ignore-extract — this function is the ranked file-resolution
// decision table: exact path, basename, fuzzy path, and symbol fallback need
// to stay readable in priority order.
export function resolveDocumentCandidates(
  db: ScipDatabase,
  filePattern: string,
  opts: { allowMultiple: boolean },
): IndexedDocumentPathCandidate[] {
  if (opts.allowMultiple && filePattern.trim()) {
    const children = resolveIndexedDirectory(db, filePattern);
    if (children.length) return children;
  }
  const onDiskFile = resolveOnDiskFile(db, filePattern);
  if (onDiskFile) {
    return resolveIndexedDocumentCandidates(db, onDiskFile, opts).filter(
      (candidate) => candidate.relativePath === onDiskFile,
    );
  }

  const normalizedPattern = filePattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const pathIntent = isAbsolutePath(normalizedPattern) || normalizedPattern.includes('/');
  const indexed = resolveIndexedDocumentCandidates(db, filePattern, {
    ...opts,
    requirePathMatch: pathIntent,
  });
  if (indexed.length || pathIntent) return indexed;
  // A path-shaped request cannot degrade to symbol lookup. Exact on-disk paths
  // were already handled above, including files with no compiler document.
  const symbolMatch = findFirstSymbolMatch(db, filePattern);
  if (!symbolMatch || db.isIgnored(symbolMatch.relativePath)) return [];
  return [{ relativePath: symbolMatch.relativePath, score: 700 }];
}

function resolveIndexedDirectory(db: ScipDatabase, filePattern: string): IndexedDocumentPathCandidate[] {
  const path = isAbsolutePath(filePattern) ? relative(db.config.projectRoot, filePattern) : filePattern;
  const directory = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const prefix = directory === '.' || directory === '' ? '' : `${directory}/`;
  const children = indexedDocumentPaths(db, { includeIgnored: false }).filter((file) => file.startsWith(prefix));
  return children.map((relativePath) => ({ relativePath, score: 1100 }));
}
