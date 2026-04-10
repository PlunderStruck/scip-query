import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch, getCalleeRowsForSymbol } from '../query-support.js';
import type { CallGraphResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Build a call graph for a symbol: who calls it (incoming) and
 * what it calls (outgoing).
 *
 * Incoming: other symbols whose definition ranges contain a reference to this symbol.
 * Outgoing: symbols referenced within this symbol's definition range.
 */
export function callGraph(db: ScipDatabase, symbolPattern: string): CallGraphResult | null {
  // Find the target symbol and its definition range
  const target = findFirstSymbolMatch(db, symbolPattern);

  if (!target) return null;

  // CALLERS: symbols whose definition ranges contain a reference to our target.
  // Find chunks that reference our symbol, then find which symbol's definition encloses that chunk.
  const callerRows = db.all<{
    caller_symbol: string;
    caller_file: string;
  }>(
    `SELECT DISTINCT caller_gs.symbol AS caller_symbol, caller_d.relative_path AS caller_file
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents ref_d ON c.document_id = ref_d.id
    -- Find the enclosing symbol for where the reference appears
    JOIN defn_enclosing_ranges caller_der
      ON caller_der.document_id = ref_d.id
      AND c.start_line >= caller_der.start_line
      AND c.end_line <= caller_der.end_line
    JOIN global_symbols caller_gs ON caller_der.symbol_id = caller_gs.id
    JOIN documents caller_d ON caller_der.document_id = caller_d.id
    WHERE m.symbol_id = ?
      AND m.role = 0
      AND caller_gs.id != ?
      ${db.symbolNoiseFor('caller_gs')}
      ${db.pathExclusionsFor('caller_d')}
    ORDER BY caller_d.relative_path
    LIMIT 50`,
    target.symbolId, target.symbolId,
  );

  // CALLEES: symbols referenced within our target's definition range.
  const calleeRows = getCalleeRowsForSymbol(db, target, { limit: 50 });

  return {
    symbol: target.symbol,
    shortName: shortenSymbol(target.symbol),
    callers: callerRows
      .filter((r) => !db.isIgnored(r.caller_file))
      .map((r) => ({
        symbol: r.caller_symbol,
        shortName: shortenSymbol(r.caller_symbol),
        file: r.caller_file,
      })),
    callees: calleeRows
      .map((r) => ({
        symbol: r.symbol,
        shortName: shortenSymbol(r.symbol),
        file: r.file,
      })),
  };
}
