import type { ScipDatabase } from '../db.js';
import { testFileExclusionSql } from '../query-support.js';
import type { WrapperCandidate } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find wrapper candidates: symbols called by only one other symbol.
 *
 * These are premature abstractions that add indirection without
 * providing reuse. A function with fan-in = 1 whose sole caller
 * is widely used is a strong signal of unnecessary wrapping.
 */
export function wrapperCandidates(
  db: ScipDatabase,
  opts?: { scope?: string; maxLoc?: number; limit?: number },
): WrapperCandidate[] {
  const { scope, maxLoc = 15, limit = 30 } = opts ?? {};
  const scopeFilter = scope ? `AND d.relative_path LIKE '%${scope}%'` : '';

  // Find all symbols with exactly 1 cross-file consumer (fan-in = 1),
  // along with who that single caller is and the caller's own fan-in.
  const rows = db.all<{
    symbol: string;
    file: string;
    start_line: number;
    end_line: number;
    loc: number;
    caller_symbol: string;
    caller_fan_in: number;
  }>(
    `SELECT * FROM (
      SELECT
        gs.symbol,
        d.relative_path AS file,
        der.start_line,
        der.end_line,
        (der.end_line - der.start_line + 1) AS loc,
        -- The single caller: the symbol whose definition range contains
        -- the chunk that references our target
        (SELECT caller_gs.symbol
         FROM mentions ref_m
         JOIN chunks ref_c ON ref_m.chunk_id = ref_c.id
         JOIN defn_enclosing_ranges caller_der
           ON caller_der.document_id = ref_c.document_id
           AND ref_c.start_line >= caller_der.start_line
           AND ref_c.end_line <= caller_der.end_line
         JOIN global_symbols caller_gs ON caller_der.symbol_id = caller_gs.id
         WHERE ref_m.symbol_id = gs.id
           AND ref_m.role = 0
           AND ref_c.document_id != der.document_id
         LIMIT 1
        ) AS caller_symbol,
        -- Fan-in of that single caller
        (SELECT COUNT(DISTINCT caller_ref_c.document_id)
         FROM mentions caller_ref_m
         JOIN chunks caller_ref_c ON caller_ref_m.chunk_id = caller_ref_c.id
         WHERE caller_ref_m.symbol_id = (
           SELECT caller_der2.symbol_id
           FROM mentions ref_m2
           JOIN chunks ref_c2 ON ref_m2.chunk_id = ref_c2.id
           JOIN defn_enclosing_ranges caller_der2
             ON caller_der2.document_id = ref_c2.document_id
             AND ref_c2.start_line >= caller_der2.start_line
             AND ref_c2.end_line <= caller_der2.end_line
           WHERE ref_m2.symbol_id = gs.id
             AND ref_m2.role = 0
             AND ref_c2.document_id != der.document_id
           LIMIT 1
         )
         AND caller_ref_m.role = 0
        ) AS caller_fan_in
      FROM global_symbols gs
      JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
      JOIN documents d ON der.document_id = d.id
      WHERE 1 = 1
        ${db.pathExclusionsFor('d')}
        AND ${testFileExclusionSql('d')}
        ${db.symbolNoiseFor('gs')}
        -- Only functions/terms, not type definitions (types with # are not wrappers)
        AND gs.symbol NOT LIKE '%#'
        AND (der.end_line - der.start_line + 1) <= ?
        AND (der.end_line - der.start_line + 1) >= 2
        ${scopeFilter}
        -- Exactly 1 cross-file consumer
        AND (
          SELECT COUNT(DISTINCT ref_c.document_id)
          FROM mentions ref_m
          JOIN chunks ref_c ON ref_m.chunk_id = ref_c.id
          WHERE ref_m.symbol_id = gs.id
            AND ref_m.role = 0
            AND ref_c.document_id != der.document_id
        ) = 1
    ) WHERE caller_symbol IS NOT NULL AND caller_fan_in > 3
    ORDER BY caller_fan_in DESC, loc DESC
    LIMIT ?`,
    maxLoc, limit,
  );

  return rows
    .filter((r) => !db.isIgnored(r.file))
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      file: r.file,
      startLine: r.start_line,
      endLine: r.end_line,
      loc: r.loc,
      singleCaller: r.caller_symbol,
      singleCallerShort: shortenSymbol(r.caller_symbol),
      callerFanIn: r.caller_fan_in,
    }));
}
