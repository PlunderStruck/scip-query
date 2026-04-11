import type { ScipDatabase } from '../db.js';
import { findExactSymbolMatch, findFirstSymbolMatch, getSourceReferenceSites } from '../query-support.js';
import type { SymbolMatch } from '../query-support.js';
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

  const results: AffectedResult[] = [];
  const visited = new Set<number>([target.symbolId]);
  const seenResults = new Set<string>();
  let frontier = [target];

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.length === 0) break;

    const nextFrontier: typeof frontier = [];

    for (const current of frontier) {
      for (const row of getDirectAffectedRows(db, current, scope)) {
        const resultKey = `${row.file}|${row.shortName}`;
        if (row.symbolId !== null) {
          if (visited.has(row.symbolId)) continue;
          visited.add(row.symbolId);
        } else if (seenResults.has(resultKey)) {
          continue;
        }

        seenResults.add(resultKey);
        results.push({
          symbol: row.symbol,
          shortName: row.shortName,
          file: row.file,
          depth,
        });

        if (row.symbolId !== null && row.symbolMatch) {
          nextFrontier.push(row.symbolMatch);
        }
      }
    }

    frontier = nextFrontier;
  }

  // Sort by depth then file path
  results.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
  return results;
}

function getDirectAffectedRows(
  db: ScipDatabase,
  target: SymbolMatch,
  scope?: string,
): Array<{
  symbolId: number | null;
  symbol: string;
  shortName: string;
  file: string;
  symbolMatch: SymbolMatch | null;
}> {
  const sourceSites = getSourceReferenceSites(db, target)
    .filter((site) => !db.isIgnored(site.file))
    .filter((site) => !scope || site.file.includes(scope));

  if (sourceSites.length > 0) {
    const rows: Array<{
      symbolId: number | null;
      symbol: string;
      shortName: string;
      file: string;
      symbolMatch: SymbolMatch | null;
    }> = [];
    const seen = new Set<string>();

    for (const site of sourceSites) {
      if (!site.enclosingSymbol || site.enclosingSymbol === target.symbol) {
        const key = `${site.file}|(top-level)`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          symbolId: null,
          symbol: site.file,
          shortName: '(top-level)',
          file: site.file,
          symbolMatch: null,
        });
        continue;
      }

      const enclosing = findExactSymbolMatch(db, site.enclosingSymbol);
      if (!enclosing || enclosing.symbolId === target.symbolId || db.isIgnored(enclosing.relativePath)) {
        continue;
      }

      const key = `${enclosing.symbolId}|${enclosing.relativePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        symbolId: enclosing.symbolId,
        symbol: enclosing.symbol,
        shortName: shortenSymbol(enclosing.symbol),
        file: enclosing.relativePath,
        symbolMatch: enclosing,
      });
    }

    return rows;
  }

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
    WHERE m.symbol_id = ?
      AND m.role != 1
      AND enc_gs.id != ?
      ${db.symbolNoiseFor('enc_gs')}
      ${db.pathExclusionsFor('enc_d')}
      ${scope ? `AND enc_d.relative_path LIKE '%${scope}%'` : ''}
    ORDER BY enc_d.relative_path
    LIMIT 1`,
    target.symbolId,
    target.symbolId,
  );

  return rows
    .filter((row) => !db.isIgnored(row.relative_path))
    .map((row) => ({
      symbolId: row.symbol_id,
      symbol: row.symbol,
      shortName: shortenSymbol(row.symbol),
      file: row.relative_path,
      symbolMatch: findExactSymbolMatch(db, row.symbol),
    }));
}
