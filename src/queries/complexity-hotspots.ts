import type { ScipDatabase } from '../db.js';
import { testFileExclusionSql } from '../query-support.js';
import type { ComplexityHotspot } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find complexity hotspots: symbols with a composite score based on
 * LOC, fan-in, fan-out, and callee count.
 *
 * Score = (loc / 50) * (fanIn / 5) * max(fanOut / 5, 1)
 *
 * High scores indicate symbols that are large, widely depended upon,
 * AND reach out to many other modules — the riskiest code to change.
 */
export function complexityHotspots(
  db: ScipDatabase,
  opts?: { scope?: string; minLoc?: number; limit?: number },
): ComplexityHotspot[] {
  const { scope, minLoc = 10, limit = 30 } = opts ?? {};
  const scopeFilter = scope ? `AND d.relative_path LIKE '%${scope}%'` : '';

  const rows = db.all<{
    symbol: string;
    file: string;
    start_line: number;
    end_line: number;
    loc: number;
    fan_in: number;
    fan_out: number;
    callee_count: number;
  }>(
    `SELECT
      gs.symbol,
      d.relative_path AS file,
      der.start_line,
      der.end_line,
      (der.end_line - der.start_line + 1) AS loc,
      -- fanIn: distinct files that reference this symbol
      (SELECT COUNT(DISTINCT ref_c.document_id)
       FROM mentions ref_m
       JOIN chunks ref_c ON ref_m.chunk_id = ref_c.id
       WHERE ref_m.symbol_id = gs.id AND ref_m.role = 0
      ) AS fan_in,
      -- fanOut: distinct symbols referenced within this definition range
      -- that are defined in different files
      (SELECT COUNT(DISTINCT out_gs.id)
       FROM mentions out_m
       JOIN chunks out_c ON out_m.chunk_id = out_c.id
       JOIN global_symbols out_gs ON out_m.symbol_id = out_gs.id
       JOIN defn_enclosing_ranges out_der ON out_gs.id = out_der.symbol_id
       WHERE out_c.document_id = der.document_id
         AND out_c.start_line >= der.start_line
         AND out_c.end_line <= der.end_line
         AND out_m.role = 0
         AND out_gs.id != gs.id
         AND out_der.document_id != der.document_id
      ) AS fan_out,
      -- calleeCount: total distinct callees within definition range
      (SELECT COUNT(DISTINCT callee_gs.id)
       FROM mentions callee_m
       JOIN chunks callee_c ON callee_m.chunk_id = callee_c.id
       JOIN global_symbols callee_gs ON callee_m.symbol_id = callee_gs.id
       WHERE callee_c.document_id = der.document_id
         AND callee_c.start_line >= der.start_line
         AND callee_c.end_line <= der.end_line
         AND callee_m.role = 0
         AND callee_gs.id != gs.id
      ) AS callee_count
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE 1 = 1
      ${db.pathExclusionsFor('d')}
      AND ${testFileExclusionSql('d')}
      ${db.symbolNoiseFor('gs')}
      AND (der.end_line - der.start_line + 1) >= ?
      ${scopeFilter}
    ORDER BY (
      CAST((der.end_line - der.start_line + 1) AS REAL) / 50.0
      * CAST((SELECT COUNT(DISTINCT ref_c2.document_id)
              FROM mentions ref_m2
              JOIN chunks ref_c2 ON ref_m2.chunk_id = ref_c2.id
              WHERE ref_m2.symbol_id = gs.id AND ref_m2.role = 0
             ) AS REAL) / 5.0
      * MAX(CAST((SELECT COUNT(DISTINCT out_gs2.id)
                  FROM mentions out_m2
                  JOIN chunks out_c2 ON out_m2.chunk_id = out_c2.id
                  JOIN global_symbols out_gs2 ON out_m2.symbol_id = out_gs2.id
                  JOIN defn_enclosing_ranges out_der2 ON out_gs2.id = out_der2.symbol_id
                  WHERE out_c2.document_id = der.document_id
                    AND out_c2.start_line >= der.start_line
                    AND out_c2.end_line <= der.end_line
                    AND out_m2.role = 0
                    AND out_gs2.id != gs.id
                    AND out_der2.document_id != der.document_id
                 ) AS REAL) / 5.0, 1.0)
    ) DESC
    LIMIT ?`,
    minLoc, limit,
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
      fanIn: r.fan_in,
      fanOut: r.fan_out,
      calleeCount: r.callee_count,
      score:
        Math.round(
          (r.loc / 50) * (r.fan_in / 5) * Math.max(r.fan_out / 5, 1) * 100,
        ) / 100,
    }));
}
