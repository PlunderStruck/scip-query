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
 * This module is a foundation layer — depended on by definition-catalog
 * (`loadFileSymbols`) and reference-graph; it depends only on
 * symbol-lookup (one-way: path-resolver → symbol-lookup, for the
 * symbol-pattern fallback).
 */
import type { ScipDatabase } from '../storage/db.js';
import { existsSync as existsSyncFs } from 'node:fs';
import { basename, isAbsolute as isAbsolutePath, join as pathJoin } from 'node:path';
import { findFirstSymbolMatch } from '../symbols/symbol-lookup.js';
import type { DocumentPathCandidate } from '../domain/types.js';

export function resolveIndexedFile(
  db: ScipDatabase,
  filePattern: string,
): string | null {
  const indexed = resolveDocumentCandidates(db, filePattern, { allowMultiple: false })[0]?.relativePath;
  if (indexed) return indexed;

  // Fallback for file types the SCIP indexers don't include (Vue SFCs in
  // particular — scip-typescript doesn't recognize the `.vue` extension).
  // Source-text-based queries like `imports` / `unused-imports` still work
  // for these files because their parsers go through `getSourceImports`,
  // which reads from disk; we just need to give them a real relative path.
  return resolveOnDiskFile(db, filePattern);
}

export function resolveIndexedPaths(
  db: ScipDatabase,
  filePattern: string,
): string[] {
  return resolveDocumentCandidates(db, filePattern, { allowMultiple: true }).map((candidate) => candidate.relativePath);
}

export function resolveOnDiskFile(db: ScipDatabase, filePattern: string): string | null {
  if (!filePattern) return null;
  const normalized = filePattern.replace(/\\/g, '/').replace(/^\.\//, '');
  // Try exact-relative-to-project resolution first.
  const rel = isAbsolutePath(normalized) && normalized.startsWith(db.config.projectRoot)
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
): DocumentPathCandidate[] {
  const normalizedPattern = normalizeLookupPath(filePattern);
  if (!normalizedPattern) {
    return [];
  }

  const rows = db.all<{ relative_path: string }>(
    `SELECT relative_path
     FROM documents
     WHERE 1 = 1
       ${db.pathExclusionsFor('documents')}
     ORDER BY relative_path`,
  );

  const scored = rows
    .filter((row) => !db.isIgnored(row.relative_path))
    .map((row) => ({
      relativePath: row.relative_path,
      score: scoreDocumentPath(row.relative_path, normalizedPattern),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));

  if (scored.length === 0) {
    const symbolMatch = findFirstSymbolMatch(db, filePattern);
    if (!symbolMatch || db.isIgnored(symbolMatch.relativePath)) {
      return [];
    }

    return [{
      relativePath: symbolMatch.relativePath,
      score: 700,
    }];
  }

  const exactPathMatches = scored.filter((row) => row.score >= 1100);
  if (exactPathMatches.length > 0) {
    return opts.allowMultiple ? exactPathMatches : [exactPathMatches[0]!];
  }

  const basenameMatches = scored.filter((row) => row.score >= 800);
  if (basenameMatches.length > 0) {
    return opts.allowMultiple ? basenameMatches : [basenameMatches[0]!];
  }

  return opts.allowMultiple ? scored : [scored[0]!];
}

export function scoreDocumentPath(
  relativePath: string,
  rawPattern: string,
): number {
  const normalizedPath = normalizeLookupPath(relativePath);
  const pathBase = basename(normalizedPath);
  const patternBase = basename(rawPattern);

  let score = 0;
  if (normalizedPath === rawPattern) score += 1200;
  if (normalizedPath.endsWith(`/${rawPattern}`)) score += 1100;
  if (pathBase === patternBase) score += 900;
  if (normalizedPath.startsWith(`${rawPattern}/`)) score += 850;
  if (normalizedPath.includes(rawPattern)) score += 250;

  return score;
}

export function normalizeLookupPath(filePattern: string): string {
  return filePattern
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}
