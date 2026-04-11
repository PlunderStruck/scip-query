import type { ScipDatabase } from '../db.js';
import type { DepResult } from '../types.js';
import { resolveIndexedFile } from '../query-support.js';

/** What internal files does this file depend on? (forward dependencies) */
export function deps(db: ScipDatabase, filePattern: string): DepResult[] {
  const resolvedFile = resolveIndexedFile(db, filePattern);
  if (!resolvedFile) {
    return [];
  }

  const rows = db.all<{ relative_path: string }>(
    `SELECT DISTINCT d2.relative_path
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d1 ON c.document_id = d1.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d2 ON der.document_id = d2.id
    WHERE d1.relative_path = ?
      AND d2.relative_path <> d1.relative_path
      AND ${db.localSymbolPredicate}
    ORDER BY d2.relative_path`,
    resolvedFile,
  );

  return rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({ relativePath: r.relative_path }));
}

/** What files depend on this file/module? (reverse dependencies) */
export function rdeps(db: ScipDatabase, filePattern: string): DepResult[] {
  const resolvedFile = resolveIndexedFile(db, filePattern);
  if (!resolvedFile) {
    return [];
  }

  const rows = db.all<{ relative_path: string }>(
    `SELECT DISTINCT d1.relative_path
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d1 ON c.document_id = d1.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d2 ON der.document_id = d2.id
    WHERE d2.relative_path = ?
      AND d1.relative_path != ?
    ORDER BY d1.relative_path`,
    resolvedFile,
    resolvedFile,
  );

  return rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({ relativePath: r.relative_path }));
}
