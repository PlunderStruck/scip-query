import { basename } from 'node:path';
import type { ScipDatabase } from './db.js';
import { createPerDbCache } from './per-db-cache.js';

export interface IndexedDocumentPathOptions {
  scope?: string;
  like?: string;
  extensions?: readonly string[];
  includeIgnored?: boolean;
}

export interface IndexedDocumentPathCandidate {
  relativePath: string;
  score: number;
}

const INDEXED_DOCUMENT_PATHS_CACHE = createPerDbCache<string, readonly string[]>('indexed-document-paths', {
  clearGroups: ['whole-project'],
});

export function indexedDocumentPaths(db: ScipDatabase, opts: IndexedDocumentPathOptions = {}): string[] {
  const key = indexedDocumentPathCacheKey(opts);
  const cached = INDEXED_DOCUMENT_PATHS_CACHE.get(db, key, () => {
    const scopeFilter = opts.scope ? 'AND relative_path LIKE ?' : '';
    const likeFilter = opts.like ? 'AND relative_path LIKE ?' : '';
    const params = [...(opts.scope ? [`%${opts.scope}%`] : []), ...(opts.like ? [opts.like] : [])];
    const paths = db
      .all<{ relative_path: string }>(
        `SELECT relative_path
       FROM documents
       WHERE 1 = 1
         ${db.pathExclusionsFor('documents')}
         ${scopeFilter}
         ${likeFilter}
       ORDER BY relative_path`,
        ...params,
      )
      .map((row) => row.relative_path);
    const extensionFiltered = opts.extensions
      ? paths.filter((relativePath) =>
          opts.extensions!.some((extension) => relativePath.toLowerCase().endsWith(extension.toLowerCase())),
        )
      : paths;
    return opts.includeIgnored === false
      ? extensionFiltered.filter((relativePath) => !db.isIgnored(relativePath))
      : extensionFiltered;
  });
  return [...cached];
}

function indexedDocumentPathCacheKey(opts: IndexedDocumentPathOptions): string {
  const extensions = opts.extensions
    ? [...new Set(opts.extensions.map((extension) => extension.toLowerCase()))].sort()
    : null;
  return JSON.stringify({
    scope: opts.scope ?? null,
    like: opts.like ?? null,
    extensions,
    includeIgnored: opts.includeIgnored !== false,
  });
}

/**
 * Resolves user-facing file text to indexed document identities without
 * crossing into symbol lookup. Exact paths take the documents unique index;
 * fuzzy candidates retain the established deterministic scoring policy.
 */
export function resolveIndexedDocumentCandidates(
  db: ScipDatabase,
  filePattern: string,
  opts: { allowMultiple: boolean },
): IndexedDocumentPathCandidate[] {
  const normalizedPattern = normalizeLookupPath(filePattern);
  if (!normalizedPattern) return [];

  const exact = db
    .all<{ relative_path: string }>(
      `SELECT relative_path
       FROM documents
       WHERE relative_path = ?
         ${db.pathExclusionsFor('documents')}`,
      normalizedPattern,
    )
    .filter((row) => !db.isIgnored(row.relative_path))
    .map((row) => ({
      relativePath: row.relative_path,
      score: scoreDocumentPath(row.relative_path, normalizedPattern),
    }));
  if (exact.length > 0) return exact;

  const scored = indexedDocumentPaths(db, { includeIgnored: false })
    .map((relativePath) => ({
      relativePath,
      score: scoreDocumentPath(relativePath, normalizedPattern),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));

  const exactPathMatches = scored.filter((row) => row.score >= 1100);
  if (exactPathMatches.length > 0) {
    return opts.allowMultiple ? exactPathMatches : [exactPathMatches[0]!];
  }

  const basenameMatches = scored.filter((row) => row.score >= 800);
  if (basenameMatches.length > 0) {
    return opts.allowMultiple ? basenameMatches : [basenameMatches[0]!];
  }

  return opts.allowMultiple ? scored : scored.slice(0, 1);
}

export function scoreDocumentPath(relativePath: string, rawPattern: string): number {
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
  return filePattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}
