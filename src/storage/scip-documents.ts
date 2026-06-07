import type { ScipDatabase } from './db.js';

export function indexedDocumentPaths(
  db: ScipDatabase,
  opts: { scope?: string; includeIgnored?: boolean } = {},
): string[] {
  const scopeFilter = opts.scope ? 'AND relative_path LIKE ?' : '';
  const params = opts.scope ? [`%${opts.scope}%`] : [];
  const paths = db.all<{ relative_path: string }>(
    `SELECT relative_path
     FROM documents
     WHERE 1 = 1
       ${db.pathExclusionsFor('documents')}
       ${scopeFilter}
     ORDER BY relative_path`,
    ...params,
  ).map((row) => row.relative_path);
  return opts.includeIgnored === false
    ? paths.filter((relativePath) => !db.isIgnored(relativePath))
    : paths;
}
