import type { ScipDatabase } from '../db.js';
import type { MethodResult } from '../types.js';
import { leafName } from '../symbol-parser.js';

export function methods(db: ScipDatabase, className: string): MethodResult[] {
  const rows = db.all<{
    start_line: number;
    end_line: number;
    symbol: string;
  }>(
    `SELECT der.start_line, der.end_line, gs.symbol
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    WHERE gs.symbol LIKE ?
      AND ${db.localSymbolPredicate}
      AND gs.symbol LIKE '%().%'
      AND gs.symbol NOT LIKE '%().(%'
      AND gs.symbol NOT LIKE '%typeLiteral%'
    ORDER BY der.start_line`,
    `%${className}#%`,
  );

  return rows.map((r) => ({
    startLine: r.start_line,
    endLine: r.end_line,
    name: leafName(r.symbol),
  }));
}
