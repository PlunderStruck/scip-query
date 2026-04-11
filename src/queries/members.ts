import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch } from '../query-support.js';
import type { MemberResult } from '../types.js';
import { isDirectChildSymbol, leafSuffix, shortenSymbol } from '../symbol-parser.js';

/**
 * Find all direct children of a symbol (methods, fields, nested types).
 * Uses descriptor-chain fallback when enclosing_symbol is not populated.
 */
export function members(db: ScipDatabase, symbolPattern: string): MemberResult[] {
  const parent = findFirstSymbolMatch(db, symbolPattern);
  if (!parent) return [];

  const rows = db.all<{
    symbol: string;
    start_line: number;
    end_line: number;
  }>(
    `SELECT gs.symbol, der.start_line, der.end_line
     FROM global_symbols gs
     JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
     WHERE der.document_id = ?
       AND gs.symbol != ?
       ${db.symbolNoiseFor('gs')}
     ORDER BY der.start_line`,
    parent.documentId,
    parent.symbol,
  );

  return rows
    .filter((row) => isDirectChildSymbol(parent.symbol, row.symbol))
    .map((row) => ({
      symbol: row.symbol,
      shortName: shortenSymbol(row.symbol),
      startLine: row.start_line,
      endLine: row.end_line,
      kind: leafSuffix(row.symbol) ?? 'unknown',
    }));
}
