import type { ScipDatabase } from '../db.js';
import type { SystemResult, SymbolResult } from '../types.js';
import { resolveIndexedPaths } from '../query-support.js';
import { shortenSymbol } from '../symbol-parser.js';
import { cleanSignature } from './clean-signature.js';

/** Full system map for a module path: files, symbols, deps in/out */
export function system(db: ScipDatabase, modulePattern: string): SystemResult {
  const matchedPaths = resolveIndexedPaths(db, modulePattern);
  if (matchedPaths.length === 0) {
    return { files: [], symbols: [], dependsOn: [], dependedOnBy: [] };
  }

  const placeholders = matchedPaths.map(() => '?').join(', ');
  // Files in this module
  const fileRows = db.all<{ relative_path: string }>(
    `SELECT relative_path FROM documents
     WHERE relative_path IN (${placeholders})
     ORDER BY relative_path`,
    ...matchedPaths,
  );
  const files = fileRows
    .map((r) => r.relative_path)
    .filter((p) => !db.isIgnored(p));

  // Exported symbols
  const symbolRows = db.all<{
    start_line: number;
    end_line: number;
    symbol: string;
    sig: string | null;
  }>(
    `SELECT der.start_line, der.end_line, gs.symbol,
      REPLACE(SUBSTR(gs.documentation, INSTR(gs.documentation, '|') + 1), char(10), ' ') AS sig
    FROM defn_enclosing_ranges der
    JOIN global_symbols gs ON der.symbol_id = gs.id
    JOIN documents d ON der.document_id = d.id
    WHERE d.relative_path IN (${placeholders})
      AND ${db.localSymbolPredicate}
      ${db.symbolNoise}
      AND gs.documentation IS NOT NULL
    ORDER BY d.relative_path, der.start_line`,
    ...matchedPaths,
  );
  const symbols: SymbolResult[] = symbolRows.map((r) => ({
    startLine: r.start_line,
    endLine: r.end_line,
    symbol: r.symbol,
    shortName: shortenSymbol(r.symbol),
    signature: cleanSignature(r.sig),
  }));

  // Internal dependencies (what this module depends on)
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

  // Reverse dependencies (who depends on this module)
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
