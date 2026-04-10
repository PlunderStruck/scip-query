import type { ScipDatabase } from '../db.js';
import type { BottleneckResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find coupling hubs: symbols with both high fan-in (many consumers)
 * AND high fan-out (references many other symbols).
 *
 * These are the most dangerous symbols to change — they sit at the
 * intersection of many dependency paths. Score = fanIn * fanOut.
 */
export function bottlenecks(
  db: ScipDatabase,
  opts: { limit?: number; scope?: string; minFanIn?: number; minFanOut?: number } = {},
): BottleneckResult[] {
  const { limit = 20, scope, minFanIn = 2, minFanOut = 2 } = opts;
  const scopeFilter = scope ? `AND def_d.relative_path LIKE '%${scope}%'` : '';

  // Use a wrapping query to filter on computed columns
  const rows = db.all<{
    symbol: string;
    defined_in: string;
    fan_in: number;
    fan_out: number;
  }>(
    `SELECT * FROM (
      SELECT
        gs.symbol,
        def_d.relative_path AS defined_in,
        (SELECT COUNT(DISTINCT ref_c.document_id)
         FROM mentions ref_m
         JOIN chunks ref_c ON ref_m.chunk_id = ref_c.id
         WHERE ref_m.symbol_id = gs.id AND ref_m.role = 0
        ) AS fan_in,
        (SELECT COUNT(DISTINCT ref_gs.id)
         FROM mentions ref_m
         JOIN chunks ref_c ON ref_m.chunk_id = ref_c.id
         JOIN global_symbols ref_gs ON ref_m.symbol_id = ref_gs.id
         JOIN defn_enclosing_ranges ref_der ON ref_gs.id = ref_der.symbol_id
         WHERE ref_c.document_id = def_d.id
           AND ref_m.role = 0
           AND ref_der.document_id != def_d.id
        ) AS fan_out
      FROM global_symbols gs
      JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
      JOIN documents def_d ON der.document_id = def_d.id
      WHERE 1 = 1
        ${db.pathExclusionsFor('def_d')}
        ${db.symbolNoiseFor('gs')}
        ${scopeFilter}
    ) WHERE fan_in >= ? AND fan_out >= ?
    ORDER BY (fan_in * fan_out) DESC
    LIMIT ?`,
    minFanIn, minFanOut, limit,
  );

  return rows
    .filter((r) => !db.isIgnored(r.defined_in))
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      fanIn: r.fan_in,
      fanOut: r.fan_out,
      score: r.fan_in * r.fan_out,
      definedIn: r.defined_in,
    }));
}
