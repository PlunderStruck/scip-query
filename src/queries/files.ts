import type { ScipDatabase } from '../db.js';
import type { FileResult } from '../types.js';

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
  const rows = db.all<{ relative_path: string }>(
    `SELECT relative_path FROM documents
     WHERE relative_path LIKE ?
     ORDER BY relative_path`,
    likePattern,
  );

  // Apply gitignore filtering
  return rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({ relativePath: r.relative_path }));
}
