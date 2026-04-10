import type { ScipDatabase } from '../db.js';
import { testFileExclusionSql } from '../query-support.js';
import type { StaleAbstraction } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find stale abstractions: type-level symbols (classes, interfaces, type
 * aliases) that have 0 or 1 cross-file consumers.
 *
 * A type that only one file uses is over-abstracted — it was designed
 * for reuse that never materialized. Large single-consumer types are
 * the strongest signal of wasted abstraction.
 */
export function staleAbstractions(
  db: ScipDatabase,
  opts?: { scope?: string; minLoc?: number; limit?: number },
): StaleAbstraction[] {
  const { scope, minLoc = 3, limit = 30 } = opts ?? {};
  const scopeFilter = scope ? `AND d.relative_path LIKE '%${scope}%'` : '';

  const rows = db.all<{
    symbol: string;
    file: string;
    start_line: number;
    end_line: number;
    loc: number;
    consumers: number;
  }>(
    `SELECT * FROM (
      SELECT
        gs.symbol,
        d.relative_path AS file,
        der.start_line,
        der.end_line,
        (der.end_line - der.start_line + 1) AS loc,
        (SELECT COUNT(DISTINCT ref_c.document_id)
         FROM mentions ref_m
         JOIN chunks ref_c ON ref_m.chunk_id = ref_c.id
         WHERE ref_m.symbol_id = gs.id
           AND ref_m.role = 0
           AND ref_c.document_id != der.document_id
        ) AS consumers
      FROM global_symbols gs
      JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
      JOIN documents d ON der.document_id = d.id
      WHERE 1 = 1
        ${db.pathExclusionsFor('d')}
        AND ${testFileExclusionSql('d')}
        ${db.symbolNoiseFor('gs')}
        -- Top-level type symbols: ends with # but does not contain nested #
        AND gs.symbol LIKE '%#'
        AND gs.symbol NOT LIKE '%#%#%'
        AND (der.end_line - der.start_line + 1) >= ?
        ${scopeFilter}
    ) WHERE consumers <= 1
    ORDER BY loc DESC
    LIMIT ?`,
    minLoc, limit,
  );

  return rows
    .filter((r) => !db.isIgnored(r.file))
    // Exclude types defined in dedicated type files (types.ts, types/, etc.)
    // These are intentional public API types, not premature abstractions.
    .filter((r) => {
      const basename = r.file.split('/').pop() ?? '';
      const isTypeFile = basename.includes('types') || r.file.includes('/types/');
      // Types in type files with 1 consumer are normal API types — skip them.
      // Types in type files with 0 consumers are genuinely unused — keep them.
      if (isTypeFile && r.consumers > 0) return false;
      return true;
    })
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      file: r.file,
      startLine: r.start_line,
      endLine: r.end_line,
      loc: r.loc,
      consumers: r.consumers,
    }));
}
