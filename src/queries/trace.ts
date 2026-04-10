import type { ScipDatabase } from '../db.js';
import type { TraceResult } from '../types.js';
import { cleanSignature } from './clean-signature.js';

export function trace(db: ScipDatabase, symbolPattern: string): TraceResult {
  // Definitions
  const defRows = db.all<{
    relative_path: string;
    start_line: number;
    end_line: number;
    sig: string | null;
  }>(
    `SELECT d.relative_path, der.start_line, der.end_line,
      REPLACE(SUBSTR(gs.documentation, INSTR(gs.documentation, '|') + 1), char(10), ' ') AS sig
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE gs.symbol LIKE ?
      AND ${db.localSymbolPredicate}
      AND gs.symbol NOT LIKE '%().(%'
      AND gs.symbol NOT LIKE '%typeLiteral%'
    ORDER BY d.relative_path, der.start_line
    LIMIT 10`,
    `%${symbolPattern}%`,
  );

  const definitions = defRows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({
      relativePath: r.relative_path,
      startLine: r.start_line,
      endLine: r.end_line,
      signature: cleanSignature(r.sig),
    }));

  // References
  const refRows = db.all<{ relative_path: string }>(
    `SELECT DISTINCT d.relative_path
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    WHERE gs.symbol LIKE ?
      AND ${db.localSymbolPredicate}
      AND gs.symbol NOT LIKE '%().(%'
      AND gs.symbol NOT LIKE '%typeLiteral%'
      AND m.role = 0
    ORDER BY d.relative_path`,
    `%${symbolPattern}%`,
  );

  const referencedBy = refRows
    .map((r) => r.relative_path)
    .filter((p) => !db.isIgnored(p));

  return { definitions, referencedBy };
}

