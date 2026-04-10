import type { ScipDatabase } from '../db.js';
import type { RefResult } from '../types.js';

export function refs(db: ScipDatabase, symbolPattern: string): RefResult[] {
  const rows = db.all<{
    relative_path: string;
    start_line: number;
  }>(
    `SELECT DISTINCT d.relative_path, c.start_line
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    WHERE gs.symbol LIKE ?
      AND ${db.localSymbolPredicate}
      AND m.role = 0
    ORDER BY d.relative_path, c.start_line`,
    `%${symbolPattern}%`,
  );

  return rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({
      relativePath: r.relative_path,
      line: r.start_line,
    }));
}
