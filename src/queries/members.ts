import type { ScipDatabase } from '../db.js';
import type { MemberResult } from '../types.js';
import { shortenSymbol, parseSymbol } from '../symbol-parser.js';
import type { ScipSymbol } from '../types.js';

/**
 * Find all direct children of a symbol (methods, fields, nested types).
 * Uses the enclosing_symbol relationship in global_symbols.
 */
export function members(db: ScipDatabase, symbolPattern: string): MemberResult[] {
  // First find the parent symbol(s)
  const parents = db.all<{ symbol: string }>(
    `SELECT symbol FROM global_symbols WHERE symbol LIKE ?`,
    `%${symbolPattern}%`,
  );

  if (parents.length === 0) return [];

  // Find children whose enclosing_symbol matches any parent
  const placeholders = parents.map(() => '?').join(',');
  const parentSymbols = parents.map((p) => p.symbol);

  const rows = db.all<{
    symbol: string;
    start_line: number;
    end_line: number;
  }>(
    `SELECT gs.symbol, der.start_line, der.end_line
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    WHERE gs.enclosing_symbol IN (${placeholders})
      AND gs.symbol NOT LIKE '%typeLiteral%'
    ORDER BY der.start_line`,
    ...parentSymbols,
  );

  return rows.map((r) => {
    const parsed = parseSymbol(r.symbol);
    let kind = 'unknown';
    if (!('kind' in parsed)) {
      const sym = parsed as ScipSymbol;
      const last = sym.descriptors[sym.descriptors.length - 1];
      if (last) kind = last.suffix;
    }

    return {
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      startLine: r.start_line,
      endLine: r.end_line,
      kind,
    };
  });
}
