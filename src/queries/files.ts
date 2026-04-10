import type { ScipDatabase } from '../db.js';
import type { FileResult } from '../types.js';

export function files(db: ScipDatabase, pattern: string): FileResult[] {
  const rows = db.all<{ relative_path: string }>(
    `SELECT relative_path FROM documents
     WHERE relative_path LIKE ?
     ORDER BY relative_path`,
    `%${pattern}%`,
  );

  // Apply gitignore filtering
  return rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({ relativePath: r.relative_path }));
}
