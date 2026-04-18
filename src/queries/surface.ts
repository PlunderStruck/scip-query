import type { ScipDatabase } from '../db.js';
import { getDefinitionsForFile, resolveIndexedPaths } from '../query-support.js';
import type { SurfaceResult } from '../types.js';
import { isCallableSymbol, shortenSymbol } from '../symbol-parser.js';

/** Public API surface: what symbols do external consumers actually use from this module? */
export function surface(db: ScipDatabase, modulePattern: string): SurfaceResult[] {
  const matchedPaths = resolveIndexedPaths(db, modulePattern);
  if (matchedPaths.length === 0) {
    return [];
  }

  const placeholders = matchedPaths.map(() => '?').join(', ');
  const rows = db.all<{
    relative_path: string;
    symbol: string;
  }>(
    `SELECT DISTINCT d1.relative_path, gs.symbol
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d1 ON c.document_id = d1.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    WHERE d1.relative_path NOT IN (${placeholders})
      AND (
        EXISTS (
          SELECT 1
          FROM defn_enclosing_ranges der
          JOIN documents d2 ON der.document_id = d2.id
          WHERE der.symbol_id = gs.id
            AND d2.relative_path IN (${placeholders})
        )
        OR EXISTS (
          SELECT 1
          FROM mentions def_m
          JOIN chunks def_c ON def_m.chunk_id = def_c.id
          JOIN documents d2 ON def_c.document_id = d2.id
          WHERE def_m.symbol_id = gs.id
            AND def_m.role = 1
            AND d2.relative_path IN (${placeholders})
        )
      )
      AND m.role != 1
      AND ${db.localSymbolPredicate}
      ${db.pathExclusionsFor('d1')}
    ORDER BY d1.relative_path`,
    ...matchedPaths,
    ...matchedPaths,
    ...matchedPaths,
  );

  const exposedDefinitions = matchedPaths.flatMap((relativePath) =>
    getDefinitionsForFile(db, relativePath)
      .filter((definition) => isCallableSymbol(definition.symbol))
      .map((definition) => ({
        relative_path: relativePath,
        symbol: definition.symbol,
      })),
  );

  const seen = new Set<string>();
  return [...rows, ...exposedDefinitions]
    .filter((r) => !db.isIgnored(r.relative_path))
    .filter((r) => {
      const key = `${r.relative_path}|${r.symbol}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => ({
      consumer: r.relative_path,
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
    }));
}

