import type { ScipDatabase } from '../db.js';
import type { SystemResult, SymbolResult } from '../types.js';
import { getDefinitionsForFile, resolveIndexedPaths } from '../query-support.js';
import { shortenSymbol } from '../symbol-parser.js';
import { cleanSignature, extractSignature } from './clean-signature.js';

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
  const files = fileRows
    .map((r) => r.relative_path)
    .filter((p) => !db.isIgnored(p));

  // Exported symbols: corrected ranges + documentation filter.
  const symbols: SymbolResult[] = files
    .flatMap((relativePath) => getDefinitionsForFile(db, relativePath))
    .filter((d) => d.documentation !== null && d.documentation !== '')
    .sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath)
      || a.startLine - b.startLine
      || a.endLine - b.endLine,
    )
    .map((d) => {
      const sig = extractSignature(d.documentation);
      return {
        startLine: d.startLine,
        endLine: d.endLine,
        symbol: d.symbol,
        shortName: shortenSymbol(d.symbol),
        signature: cleanSignature(sig),
      };
    });

  const depRows = db.all<{ relative_path: string }>(
    `SELECT DISTINCT d2.relative_path
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d1 ON c.document_id = d1.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d2 ON der.document_id = d2.id
    WHERE d1.relative_path IN (${placeholders})
      AND d2.relative_path NOT IN (${placeholders})
      AND ${db.localSymbolPredicate}
    ORDER BY d2.relative_path`,
    ...matchedPaths,
    ...matchedPaths,
  );
  const dependsOn = depRows
    .map((r) => r.relative_path)
    .filter((p) => !db.isIgnored(p));

  const rdepRows = db.all<{ relative_path: string }>(
    `SELECT DISTINCT d1.relative_path
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d1 ON c.document_id = d1.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d2 ON der.document_id = d2.id
    WHERE d2.relative_path IN (${placeholders})
      AND d1.relative_path NOT IN (${placeholders})
    ORDER BY d1.relative_path`,
    ...matchedPaths,
    ...matchedPaths,
  );
  const dependedOnBy = rdepRows
    .map((r) => r.relative_path)
    .filter((p) => !db.isIgnored(p));

  return { files, symbols, dependsOn, dependedOnBy };
}
