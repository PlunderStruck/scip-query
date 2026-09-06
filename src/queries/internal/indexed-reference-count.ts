import type { ScipDatabase } from '../../storage/db.js';

/** Count distinct indexed files referencing a symbol outside its definition file. */
export function indexedReferenceFileCount(db: ScipDatabase, symbolId: number): number {
  const row = db.get<{ file_count: number }>(
    `SELECT COUNT(DISTINCT c.document_id) AS file_count
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN (
       SELECT m2.symbol_id, c2.document_id
       FROM mentions m2
       JOIN chunks c2 ON m2.chunk_id = c2.id
       WHERE m2.role = 1
       GROUP BY m2.symbol_id
     ) sym_def ON sym_def.symbol_id = m.symbol_id
     WHERE m.symbol_id = ?
       AND m.role != 1
       AND sym_def.document_id != c.document_id`,
    symbolId,
  );

  return row?.file_count ?? 0;
}
