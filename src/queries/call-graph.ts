import type { ScipDatabase } from '../db.js';
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
  const target = db.get<{
    id: number;
    symbol: string;
    document_id: number;
    start_line: number;
    end_line: number;
    relative_path: string;
  }>(
    `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.end_line, d.relative_path
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE gs.symbol LIKE ?
      AND d.relative_path NOT LIKE 'node_modules/%'
      AND gs.symbol NOT LIKE '%typeLiteral%'
    LIMIT 1`,
    `%${symbolPattern}%`,
  );

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
      AND caller_gs.symbol NOT LIKE '%typeLiteral%'
      AND caller_d.relative_path NOT LIKE 'node_modules/%'
    ORDER BY caller_d.relative_path
    LIMIT 50`,
    target.id, target.id,
  );

  // CALLEES: symbols referenced within our target's definition range.
  const calleeRows = db.all<{
    callee_symbol: string;
    callee_file: string;
  }>(
    `SELECT DISTINCT callee_gs.symbol AS callee_symbol, callee_d.relative_path AS callee_file
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN global_symbols callee_gs ON m.symbol_id = callee_gs.id
    JOIN defn_enclosing_ranges callee_der ON callee_gs.id = callee_der.symbol_id
    JOIN documents callee_d ON callee_der.document_id = callee_d.id
    WHERE c.document_id = ?
      AND c.start_line >= ?
      AND c.end_line <= ?
      AND m.role = 0
      AND callee_gs.id != ?
      AND callee_gs.symbol NOT LIKE '%typeLiteral%'
      AND callee_d.relative_path NOT LIKE 'node_modules/%'
    ORDER BY callee_d.relative_path
    LIMIT 50`,
    target.document_id, target.start_line, target.end_line, target.id,
  );

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
      .filter((r) => !db.isIgnored(r.callee_file))
      .map((r) => ({
        symbol: r.callee_symbol,
        shortName: shortenSymbol(r.callee_symbol),
        file: r.callee_file,
      })),
  };
}
