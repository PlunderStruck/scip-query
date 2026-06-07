import type { ScipDatabase } from './db.js';

export interface IndexedDocumentPathOptions {
  scope?: string;
  like?: string;
  extensions?: readonly string[];
  includeIgnored?: boolean;
}

export function indexedDocumentPaths(
  db: ScipDatabase,
  opts: IndexedDocumentPathOptions = {},
): string[] {
  const scopeFilter = opts.scope ? 'AND relative_path LIKE ?' : '';
  const likeFilter = opts.like ? 'AND relative_path LIKE ?' : '';
  const params = [
    ...(opts.scope ? [`%${opts.scope}%`] : []),
    ...(opts.like ? [opts.like] : []),
  ];
  const paths = db.all<{ relative_path: string }>(
    `SELECT relative_path
     FROM documents
     WHERE 1 = 1
       ${db.pathExclusionsFor('documents')}
       ${scopeFilter}
       ${likeFilter}
     ORDER BY relative_path`,
    ...params,
  ).map((row) => row.relative_path);
  const extensionFiltered = opts.extensions
    ? paths.filter((relativePath) => opts.extensions!.some((extension) => relativePath.toLowerCase().endsWith(extension.toLowerCase())))
    : paths;
  return opts.includeIgnored === false
    ? extensionFiltered.filter((relativePath) => !db.isIgnored(relativePath))
    : extensionFiltered;
}
