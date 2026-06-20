import type { ScipDatabase } from '../../storage/db.js';
import { loadFileSymbols } from '../../symbols/definition-catalog.js';
import { resolveIndexedPaths } from '../../resolution/path-resolver.js';
import type { SymbolResult } from './symbols.js';

export interface SystemResult {
  files: string[];
  symbols: SymbolResult[];
  dependsOn: string[];
  dependedOnBy: string[];
}

/** Full system map for a module path: files, symbols, deps in/out.
 *
 * Exported-symbol ranges come from getDefinitionsForFile so they are
 * source-corrected and match `scip symbols` output.
 */
export function system(db: ScipDatabase, modulePattern: string): SystemResult {
  const matchedPaths = resolveIndexedPaths(db, modulePattern);
  if (matchedPaths.length === 0) {
    return { files: [], symbols: [], dependsOn: [], dependedOnBy: [] };
  }

  const placeholders = matchedPaths.map(() => '?').join(', ');
  const fileRows = db.all<{ relative_path: string }>(
    `SELECT relative_path FROM documents
     WHERE relative_path IN (${placeholders})
     ORDER BY relative_path`,
    ...matchedPaths,
  );
  const files = fileRows.map((r) => r.relative_path).filter((p) => !db.isIgnored(p));

  // Exported symbols: corrected ranges + documentation filter.
  const symbols: SymbolResult[] = loadFileSymbols(db, files, { onlyDocumented: true, sort: true }).map(
    ({ relativePath: _r, ...rest }) => rest,
  );

  const depRows = db.all<{ relative_path: string }>(
    `SELECT DISTINCT d2.relative_path
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d1 ON c.document_id = d1.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN (
      SELECT m2.symbol_id, c2.document_id
      FROM mentions m2
      JOIN chunks c2 ON m2.chunk_id = c2.id
      WHERE m2.role = 1
      GROUP BY m2.symbol_id
    ) sym_def ON sym_def.symbol_id = gs.id
    JOIN documents d2 ON sym_def.document_id = d2.id
    WHERE d1.relative_path IN (${placeholders})
      AND d2.relative_path NOT IN (${placeholders})
      AND ${db.localSymbolPredicate}
    ORDER BY d2.relative_path`,
    ...matchedPaths,
    ...matchedPaths,
  );
  const dependsOn = depRows.map((r) => r.relative_path).filter((p) => !db.isIgnored(p));

  const rdepRows = db.all<{ relative_path: string }>(
    `SELECT DISTINCT d1.relative_path
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d1 ON c.document_id = d1.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN (
      SELECT m2.symbol_id, c2.document_id
      FROM mentions m2
      JOIN chunks c2 ON m2.chunk_id = c2.id
      WHERE m2.role = 1
      GROUP BY m2.symbol_id
    ) sym_def ON sym_def.symbol_id = gs.id
    JOIN documents d2 ON sym_def.document_id = d2.id
    WHERE d2.relative_path IN (${placeholders})
      AND d1.relative_path NOT IN (${placeholders})
    ORDER BY d1.relative_path`,
    ...matchedPaths,
    ...matchedPaths,
  );
  const dependedOnBy = rdepRows.map((r) => r.relative_path).filter((p) => !db.isIgnored(p));

  return { files, symbols, dependsOn, dependedOnBy };
}
