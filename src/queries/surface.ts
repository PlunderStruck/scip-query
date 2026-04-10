import type { ScipDatabase } from '../db.js';
import type { SurfaceResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/** Public API surface: what symbols do external consumers actually use from this module? */
export function surface(db: ScipDatabase, modulePattern: string): SurfaceResult[] {
  const rows = db.all<{
    relative_path: string;
    symbol: string;
  }>(
    `SELECT DISTINCT d1.relative_path, gs.symbol
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d1 ON c.document_id = d1.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d2 ON der.document_id = d2.id
    WHERE d2.relative_path LIKE ?
      AND d1.relative_path NOT LIKE ?
      AND ${db.localSymbolPredicate}
      AND m.role != 1
    ORDER BY d1.relative_path`,
    `%${modulePattern}%`,
    `%${modulePattern}%`,
  );

  return rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({
      consumer: r.relative_path,
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
    }));
}
