import type { ScipDatabase } from '../db.js';
import type { ImportResult, UnusedImportResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * What symbols does this file import?
 * Uses role=2 (import) from the SCIP mentions table.
 */
export function imports(db: ScipDatabase, filePattern: string): ImportResult[] {
  const rows = db.all<{
    symbol: string;
    from_file: string;
  }>(
    `SELECT DISTINCT gs.symbol, def_d.relative_path AS from_file
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents imp_d ON c.document_id = imp_d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    LEFT JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    LEFT JOIN documents def_d ON der.document_id = def_d.id
    WHERE imp_d.relative_path LIKE ?
      AND m.role = 2
    ORDER BY def_d.relative_path, gs.symbol`,
    `%${filePattern}%`,
  );

  return rows.map((r) => ({
    symbol: r.symbol,
    shortName: shortenSymbol(r.symbol),
    fromFile: r.from_file ?? '(external)',
  }));
}

/**
 * Which files import this symbol?
 */
export function importedBy(db: ScipDatabase, symbolPattern: string): ImportResult[] {
  const rows = db.all<{
    symbol: string;
    importer: string;
  }>(
    `SELECT DISTINCT gs.symbol, d.relative_path AS importer
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    WHERE gs.symbol LIKE ?
      AND m.role = 2
    ORDER BY d.relative_path`,
    `%${symbolPattern}%`,
  );

  return rows
    .filter((r) => !db.isIgnored(r.importer))
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      fromFile: r.importer,
    }));
}

/**
 * Find imports in a file that are never referenced (role=0) in the same file.
 * These are likely unused imports.
 */
export function unusedImports(db: ScipDatabase, filePattern: string): UnusedImportResult[] {
  const rows = db.all<{
    symbol: string;
    imported_in: string;
  }>(
    `SELECT gs.symbol, d.relative_path AS imported_in
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    WHERE d.relative_path LIKE ?
      AND m.role = 2
      AND NOT EXISTS (
        SELECT 1
        FROM mentions ref_m
        JOIN chunks ref_c ON ref_m.chunk_id = ref_c.id
        WHERE ref_m.symbol_id = gs.id
          AND ref_m.role = 0
          AND ref_c.document_id = d.id
      )
    ORDER BY d.relative_path, gs.symbol`,
    `%${filePattern}%`,
  );

  return rows.map((r) => ({
    symbol: r.symbol,
    shortName: shortenSymbol(r.symbol),
    importedIn: r.imported_in,
  }));
}
