import type { ScipDatabase } from '../db.js';
import type { SymbolResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

export function symbols(db: ScipDatabase, filePattern: string): SymbolResult[] {
  const rows = db.all<{
    start_line: number;
    end_line: number;
    sig: string | null;
    symbol: string;
  }>(
    `SELECT
      der.start_line,
      der.end_line,
      REPLACE(SUBSTR(gs.documentation, INSTR(gs.documentation, '|') + 1), char(10), ' ') AS sig,
      gs.symbol
    FROM defn_enclosing_ranges der
    JOIN global_symbols gs ON der.symbol_id = gs.id
    JOIN documents d ON der.document_id = d.id
    WHERE d.relative_path LIKE ?
      AND ${db.localSymbolPredicate}
      AND gs.symbol NOT LIKE '%().(%'
      AND gs.symbol NOT LIKE '%typeLiteral%'
    ORDER BY der.start_line`,
    `%${filePattern}%`,
  );

  return rows
    .filter((r) => !db.isIgnored(r.symbol))
    .map((r) => ({
      startLine: r.start_line,
      endLine: r.end_line,
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      signature: cleanSignature(r.sig),
    }));
}

/** Clean up the raw doc/signature string from the SCIP index */
function cleanSignature(sig: string | null): string | null {
  if (!sig || !sig.trim()) return null;
  return sig
    .replace(/^```\w*\s*/, '')
    .replace(/\s*```$/, '')
    .replace(/^\(method\)\s*/, '')
    .replace(/^\(property\)\s*/, '')
    .replace(/^\(function\)\s*/, '')
    .replace(/^\(class\)\s*/, '')
    .replace(/^\(interface\)\s*/, '')
    .trim() || null;
}
