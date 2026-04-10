import type { ScipDatabase } from '../db.js';
import type { HotspotResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find the most-referenced symbols in the codebase — the choke points
 * where changes have the widest blast radius.
 */
export function hotspots(
  db: ScipDatabase,
  opts: { limit?: number; scope?: string } = {},
): HotspotResult[] {
  const { limit = 30, scope } = opts;

  const scopeFilter = scope ? `AND def_d.relative_path LIKE '%${scope}%'` : '';

  const rows = db.all<{
    symbol: string;
    ref_count: number;
    file_count: number;
    defined_in: string;
  }>(
    `SELECT
      gs.symbol,
      COUNT(*) AS ref_count,
      COUNT(DISTINCT ref_d.id) AS file_count,
      def_d.relative_path AS defined_in
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents ref_d ON c.document_id = ref_d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents def_d ON der.document_id = def_d.id
    WHERE m.role != 1
      ${db.pathExclusionsFor('def_d')}
      ${db.symbolNoiseFor('gs')}
      ${scopeFilter}
    GROUP BY gs.id
    ORDER BY ref_count DESC
    LIMIT ?`,
    limit,
  );

  return rows
    .filter((r) => !db.isIgnored(r.defined_in))
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      refCount: r.ref_count,
      fileCount: r.file_count,
      definedIn: r.defined_in,
    }));
}
