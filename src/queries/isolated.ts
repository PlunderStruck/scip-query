import type { ScipDatabase } from '../db.js';
import type { IsolatedResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find isolated symbols: defined locally, referenced by nothing,
 * and referencing nothing external. These are truly orphaned code —
 * not just unused exports, but completely disconnected from the graph.
 */
export function isolated(
  db: ScipDatabase,
  opts: { scope?: string; minLoc?: number } = {},
): IsolatedResult[] {
  const { scope, minLoc = 3 } = opts;
  const scopeFilter = scope ? `AND d.relative_path LIKE '%${scope}%'` : '';

  const rows = db.all<{
    symbol: string;
    relative_path: string;
    start_line: number;
    end_line: number;
    loc: number;
  }>(
    `SELECT
      gs.symbol,
      d.relative_path,
      der.start_line,
      der.end_line,
      (der.end_line - der.start_line + 1) AS loc
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE d.relative_path NOT LIKE 'node_modules/%'
      AND d.relative_path NOT LIKE '.git/%'
      AND d.relative_path NOT LIKE '%/__tests__/%'
      AND d.relative_path NOT LIKE '%.test.%'
      AND d.relative_path NOT LIKE '%.spec.%'
      AND gs.symbol NOT LIKE '%typeLiteral%'
      AND gs.symbol NOT LIKE '%().(%'
      AND gs.symbol NOT LIKE '%#%'
      AND (der.end_line - der.start_line + 1) >= ?
      ${scopeFilter}
      -- No cross-file references TO this symbol
      AND NOT EXISTS (
        SELECT 1 FROM mentions m
        JOIN chunks c ON m.chunk_id = c.id
        WHERE m.symbol_id = gs.id AND m.role = 0 AND c.document_id != d.id
      )
      -- No same-file references either
      AND NOT EXISTS (
        SELECT 1 FROM mentions m
        JOIN chunks c ON m.chunk_id = c.id
        WHERE m.symbol_id = gs.id AND m.role = 0 AND c.document_id = d.id
      )
    ORDER BY loc DESC, d.relative_path`,
    minLoc,
  );

  return rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      relativePath: r.relative_path,
      startLine: r.start_line,
      endLine: r.end_line,
      loc: r.loc,
    }));
}
