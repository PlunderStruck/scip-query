import type { ScipDatabase } from '../db.js';
import type { DocCoverageResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Check documentation coverage: what percentage of symbols have doc strings?
 * Reports overall stats and lists undocumented symbols.
 */
export function docCoverage(
  db: ScipDatabase,
  opts: { scope?: string; minLoc?: number; limit?: number } = {},
): DocCoverageResult {
  const { scope, minLoc = 3, limit = 50 } = opts;
  const scopeFilter = scope ? `AND d.relative_path LIKE '%${scope}%'` : '';

  // Count all local symbols meeting the threshold
  const totalRow = db.get<{ c: number }>(
    `SELECT COUNT(*) AS c
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE 1 = 1
      ${db.pathExclusionsFor('d')}
      ${db.symbolNoiseFor('gs')}
      AND gs.symbol NOT LIKE '%#%'
      AND (der.end_line - der.start_line + 1) >= ?
      ${scopeFilter}`,
    minLoc,
  );

  const docRow = db.get<{ c: number }>(
    `SELECT COUNT(*) AS c
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE 1 = 1
      ${db.pathExclusionsFor('d')}
      ${db.symbolNoiseFor('gs')}
      AND gs.symbol NOT LIKE '%#%'
      AND (der.end_line - der.start_line + 1) >= ?
      AND gs.documentation IS NOT NULL
      AND gs.documentation != ''
      ${scopeFilter}`,
    minLoc,
  );

  const total = totalRow?.c ?? 0;
  const documented = docRow?.c ?? 0;

  // Get undocumented symbols
  const undocRows = db.all<{
    symbol: string;
    relative_path: string;
    start_line: number;
  }>(
    `SELECT gs.symbol, d.relative_path, der.start_line
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE 1 = 1
      ${db.pathExclusionsFor('d')}
      ${db.symbolNoiseFor('gs')}
      AND gs.symbol NOT LIKE '%#%'
      AND (der.end_line - der.start_line + 1) >= ?
      AND (gs.documentation IS NULL OR gs.documentation = '')
      ${scopeFilter}
    ORDER BY d.relative_path, der.start_line
    LIMIT ?`,
    minLoc, limit,
  );

  return {
    totalSymbols: total,
    documented,
    undocumented: total - documented,
    coveragePercent: total > 0 ? Math.round((documented / total) * 100) : 0,
    undocumentedSymbols: undocRows
      .filter((r) => !db.isIgnored(r.relative_path))
      .map((r) => ({
        symbol: r.symbol,
        shortName: shortenSymbol(r.symbol),
        relativePath: r.relative_path,
        startLine: r.start_line,
      })),
  };
}
