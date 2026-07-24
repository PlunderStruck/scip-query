import type { ScipDatabase } from '../../storage/db.js';
import { ProjectIndex } from '../internal/project-index.js';
import { resolveIndexedPaths } from '../internal/file-resolution.js';
import { isCallableSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';

export interface SurfaceResult {
  consumer: string;
  symbol: string;
  shortName: string;
}

/** Public API surface: what symbols do external consumers actually use from this module? */
export function surface(db: ScipDatabase, modulePattern: string): SurfaceResult[] {
  const matchedPaths = resolveIndexedPaths(db, modulePattern);
  if (matchedPaths.length === 0) {
    return [];
  }

  return dedupeSurfaceRows([
    ...loadExternalSurfaceRows(db, matchedPaths),
    ...loadExposedCallableDefinitions(db, matchedPaths),
  ])
    .filter((row) => !db.isIgnored(row.relative_path))
    .map(surfaceResultFromRow);
}

interface SurfaceRow {
  relative_path: string;
  symbol: string;
}

function loadExternalSurfaceRows(db: ScipDatabase, matchedPaths: string[]): SurfaceRow[] {
  const placeholders = matchedPaths.map(() => '?').join(', ');
  return db.all<SurfaceRow>(
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
}

function loadExposedCallableDefinitions(db: ScipDatabase, matchedPaths: string[]): SurfaceRow[] {
  const index = new ProjectIndex(db);
  return matchedPaths.flatMap((relativePath) =>
    index
      .definitionsForFile(relativePath)
      .filter((definition) => isCallableSymbol(definition.symbol))
      .map((definition) => ({
        relative_path: relativePath,
        symbol: definition.symbol,
      })),
  );
}

function dedupeSurfaceRows(rows: SurfaceRow[]): SurfaceRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.relative_path}|${row.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function surfaceResultFromRow(row: SurfaceRow): SurfaceResult {
  return {
    consumer: row.relative_path,
    symbol: row.symbol,
    shortName: shortenSymbol(row.symbol),
  };
}
