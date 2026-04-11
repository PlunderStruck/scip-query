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
           AND ref_m.role != 1
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
    ORDER BY loc DESC, file ASC, start_line ASC`,
    minLoc,
  );

  const filesWithFunctions = getFilesWithFunctions(db, scope);

  return rows
    .filter((r) => !db.isIgnored(r.file))
    .filter((r) => isTrueStaleAbstraction(r, filesWithFunctions))
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      file: r.file,
      startLine: r.start_line,
      endLine: r.end_line,
      loc: r.loc,
      consumers: r.consumers,
    }))
    .slice(0, limit);
}

function getFilesWithFunctions(
  db: ScipDatabase,
  scope?: string,
): Set<string> {
  const scopeFilter = scope ? `AND d.relative_path LIKE '%${scope}%'` : '';

  return new Set(
    db.all<{ relative_path: string }>(
      `SELECT DISTINCT d.relative_path
       FROM global_symbols gs
       JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
       JOIN documents d ON der.document_id = d.id
       WHERE gs.symbol LIKE '%().'
         ${db.pathExclusionsFor('d')}
         ${scopeFilter}`,
    )
      .map((row) => row.relative_path)
      .filter((path) => !db.isIgnored(path)),
  );
}

function isTrueStaleAbstraction(
  row: { file: string; consumers: number },
  filesWithFunctions: ReadonlySet<string>,
): boolean {
  const basename = row.file.split('/').pop() ?? '';
  const isTypeFile = basename.includes('types') || row.file.includes('/types/');
  if (isTypeFile && row.consumers > 0) {
    return false;
  }

  // 0-consumer types in files that also export functions are often parameter/
  // return-only shapes that the SCIP graph does not model as direct mentions.
  if (row.consumers === 0 && filesWithFunctions.has(row.file)) {
    return false;
  }

  return true;
}
