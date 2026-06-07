import type { ScipDatabase } from '../storage/db.js';
import { resolveIndexedFile } from '../resolution/path-resolver.js';

export interface CouplingResult {
  file1: string;
  file2: string;
  sharedSymbols: number;
}

/**
 * Measure coupling between two files: how many symbols do they share
 * (symbols defined in one and referenced in the other, or vice versa).
 */
export function coupling(
  db: ScipDatabase,
  file1: string,
  file2: string,
): CouplingResult {
  const resolvedFile1 = resolveIndexedFile(db, file1) ?? file1;
  const resolvedFile2 = resolveIndexedFile(db, file2) ?? file2;

  const row = db.get<{ shared: number }>(
    `SELECT COUNT(DISTINCT gs.id) AS shared
    FROM global_symbols gs
    WHERE (
      -- Defined in file1, referenced in file2
      EXISTS (
        SELECT 1
        FROM mentions def_m
        JOIN chunks def_c ON def_m.chunk_id = def_c.id
        JOIN documents d ON def_c.document_id = d.id
        WHERE def_m.symbol_id = gs.id AND def_m.role = 1 AND d.relative_path = ?
      )
      AND EXISTS (
        SELECT 1 FROM mentions m
        JOIN chunks c ON m.chunk_id = c.id
        JOIN documents d ON c.document_id = d.id
        WHERE m.symbol_id = gs.id AND m.role != 1 AND d.relative_path = ?
      )
    ) OR (
      -- Defined in file2, referenced in file1
      EXISTS (
        SELECT 1
        FROM mentions def_m
        JOIN chunks def_c ON def_m.chunk_id = def_c.id
        JOIN documents d ON def_c.document_id = d.id
        WHERE def_m.symbol_id = gs.id AND def_m.role = 1 AND d.relative_path = ?
      )
      AND EXISTS (
        SELECT 1 FROM mentions m
        JOIN chunks c ON m.chunk_id = c.id
        JOIN documents d ON c.document_id = d.id
        WHERE m.symbol_id = gs.id AND m.role != 1 AND d.relative_path = ?
      )
    )`,
    resolvedFile1, resolvedFile2,
    resolvedFile2, resolvedFile1,
  );

  return {
    file1: resolvedFile1,
    file2: resolvedFile2,
    sharedSymbols: row?.shared ?? 0,
  };
}

/**
 * Find the most coupled file pairs in the codebase.
 */
export function topCoupling(
  db: ScipDatabase,
  opts: { limit?: number; scope?: string } = {},
): CouplingResult[] {
  const { limit = 20, scope } = opts;
  const scopeFilter = scope
    ? `AND d1.relative_path LIKE '%${scope}%' AND d2.relative_path LIKE '%${scope}%'`
    : '';

  // Find file pairs that share the most symbols (one defines, other references)
  const rows = db.all<{
    file1: string;
    file2: string;
    shared: number;
  }>(
    `SELECT
      def_d.relative_path AS file1,
      ref_d.relative_path AS file2,
      COUNT(DISTINCT gs.id) AS shared
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents ref_d ON c.document_id = ref_d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN (
      SELECT m2.symbol_id, c2.document_id
      FROM mentions m2
      JOIN chunks c2 ON m2.chunk_id = c2.id
      WHERE m2.role = 1
      GROUP BY m2.symbol_id
    ) sym_def ON sym_def.symbol_id = gs.id
    JOIN documents def_d ON sym_def.document_id = def_d.id
    WHERE m.role != 1
      AND def_d.id != ref_d.id
      ${db.pathExclusionsFor('def_d', 'ref_d')}
      ${scopeFilter}
    GROUP BY def_d.id, ref_d.id
    ORDER BY shared DESC
    LIMIT ?`,
    limit,
  );

  return rows
    .filter((r) => !db.isIgnored(r.file1) && !db.isIgnored(r.file2))
    .map((r) => ({
      file1: r.file1,
      file2: r.file2,
      sharedSymbols: r.shared,
    }));
}
