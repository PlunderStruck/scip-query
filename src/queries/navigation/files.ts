import type { ScipDatabase } from '../../storage/db.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';

export interface FileResult {
  relativePath: string;
}

/**
 * Convert a glob pattern to a SQL LIKE pattern.
 *  - `**` and `*` both become `%` (match any sequence)
 *  - `?` becomes `_` (match single char)
 *  - A bare substring with no glob chars gets wrapped in `%..%` for contains-match
 */
function globToLike(pattern: string): string {
  const hasGlobChars = /[*?]/.test(pattern);
  if (!hasGlobChars) {
    // Plain substring search (original behavior)
    return `%${pattern}%`;
  }
  // Replace ** first (greedy multi-segment), then * (single-segment acts same in LIKE)
  return pattern
    .replace(/\*\*/g, '%')
    .replace(/\*/g, '%')
    .replace(/\?/g, '_');
}

export function files(db: ScipDatabase, pattern: string): FileResult[] {
  const likePattern = globToLike(pattern);
  return indexedDocumentPaths(db, { like: likePattern, includeIgnored: false })
    .map((relativePath) => ({ relativePath }));
}
