import type { ScipDatabase } from '../../storage/db.js';
import { resolveIndexedFile } from '../../resolution/path-resolver.js';

export interface DepResult {
  relativePath: string;
}

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
    JOIN (
      SELECT m2.symbol_id, c2.document_id
      FROM mentions m2
      JOIN chunks c2 ON m2.chunk_id = c2.id
      WHERE m2.role = 1
      GROUP BY m2.symbol_id
    ) sym_def ON sym_def.symbol_id = gs.id
    JOIN documents d2 ON sym_def.document_id = d2.id
    WHERE d1.relative_path = ?
      AND d2.relative_path <> d1.relative_path
      AND ${db.localSymbolPredicate}
    ORDER BY d2.relative_path`,
    resolvedFile,
  );

  return rows.filter((r) => !db.isIgnored(r.relative_path)).map((r) => ({ relativePath: r.relative_path }));
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
    JOIN (
      SELECT m2.symbol_id, c2.document_id
      FROM mentions m2
      JOIN chunks c2 ON m2.chunk_id = c2.id
      WHERE m2.role = 1
      GROUP BY m2.symbol_id
    ) sym_def ON sym_def.symbol_id = gs.id
    JOIN documents d2 ON sym_def.document_id = d2.id
    WHERE d2.relative_path = ?
      AND d1.relative_path != ?
    ORDER BY d1.relative_path`,
    resolvedFile,
    resolvedFile,
  );

  return rows.filter((r) => !db.isIgnored(r.relative_path)).map((r) => ({ relativePath: r.relative_path }));
}
