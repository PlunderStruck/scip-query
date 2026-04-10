import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch } from '../query-support.js';
import type { AffectedResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Full transitive closure of symbols that could break if a given symbol changes.
 * BFS from the target through the mention graph: depth 1 = direct consumers,
 * depth 2 = consumers of consumers, etc.
 */
export function affected(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { maxDepth?: number; scope?: string } = {},
): AffectedResult[] {
  const { maxDepth = 5, scope } = opts;

  const target = findFirstSymbolMatch(db, symbolPattern);
  if (!target) return [];

  const scopeFilter = scope
    ? `AND enc_d.relative_path LIKE '%${scope}%'`
    : '';

  const results: AffectedResult[] = [];
  const visited = new Set<number>([target.symbolId]);
  let frontier = new Set<number>([target.symbolId]);

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.size === 0) break;

    const placeholders = [...frontier].map(() => '?').join(',');
    const nextFrontier = new Set<number>();

    // For each symbol in the frontier, find enclosing symbols whose
    // definition ranges contain a reference (role=0) to that frontier symbol.
    const rows = db.all<{
      symbol_id: number;
      symbol: string;
      relative_path: string;
    }>(
      `SELECT DISTINCT
        enc_gs.id AS symbol_id,
        enc_gs.symbol AS symbol,
        enc_d.relative_path AS relative_path
      FROM mentions m
      JOIN chunks c ON m.chunk_id = c.id
      JOIN documents ref_d ON c.document_id = ref_d.id
      JOIN defn_enclosing_ranges enc_der
        ON enc_der.document_id = ref_d.id
        AND c.start_line >= enc_der.start_line
        AND c.end_line <= enc_der.end_line
      JOIN global_symbols enc_gs ON enc_der.symbol_id = enc_gs.id
      JOIN documents enc_d ON enc_der.document_id = enc_d.id
      WHERE m.symbol_id IN (${placeholders})
        AND m.role != 1
        AND enc_gs.id NOT IN (${placeholders})
        ${db.symbolNoiseFor('enc_gs')}
        ${db.pathExclusionsFor('enc_d')}
        ${scopeFilter}`,
      ...[...frontier],
      ...[...frontier],
    );

    for (const row of rows) {
      if (visited.has(row.symbol_id)) continue;
      if (db.isIgnored(row.relative_path)) continue;

      visited.add(row.symbol_id);
      nextFrontier.add(row.symbol_id);

      results.push({
        symbol: row.symbol,
        shortName: shortenSymbol(row.symbol),
        file: row.relative_path,
        depth,
      });
    }

    frontier = nextFrontier;
  }

  // Sort by depth then file path
  results.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
  return results;
}
