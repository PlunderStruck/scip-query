import type { ScipDatabase } from '../db.js';
import { resolveIndexedFile } from '../query-support.js';
import type { ChangeSurfaceEntry, ChangeSurfaceResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Pre-change briefing for a file. For each symbol defined in the file,
 * reports external consumer count and blast-radius risk.
 */
export function changeSurface(
  db: ScipDatabase,
  filePattern: string,
): ChangeSurfaceResult | null {
  const resolvedFile = resolveIndexedFile(db, filePattern);
  if (!resolvedFile) return null;

  // Find the file
  const doc = db.get<{ id: number; relative_path: string }>(
    `SELECT id, relative_path FROM documents
     WHERE relative_path = ?
       ${db.pathExclusionsFor('documents')}
     LIMIT 1`,
    resolvedFile,
  );

  if (!doc || db.isIgnored(doc.relative_path)) return null;

  // Get all symbols defined in this file, excluding typeLiterals
  const syms = db.all<{
    symbol_id: number;
    symbol: string;
    start_line: number;
    end_line: number;
  }>(
    `SELECT DISTINCT gs.id AS symbol_id, gs.symbol, der.start_line, der.end_line
    FROM defn_enclosing_ranges der
    JOIN global_symbols gs ON der.symbol_id = gs.id
    WHERE der.document_id = ?
      ${db.symbolNoiseFor('gs')}
    ORDER BY der.start_line`,
    doc.id,
  );

  const symbols: ChangeSurfaceEntry[] = [];
  let totalExternalConsumers = 0;

  for (const sym of syms) {
    // Count external consumers: mentions with role=0 from different documents
    const consumerRow = db.get<{ consumer_count: number }>(
      `SELECT COUNT(DISTINCT c.document_id) AS consumer_count
      FROM mentions m
      JOIN chunks c ON m.chunk_id = c.id
      WHERE m.symbol_id = ?
        AND m.role != 1
        AND c.document_id != ?`,
      sym.symbol_id,
      doc.id,
    );

    const externalConsumers = consumerRow?.consumer_count ?? 0;

    // Risk level is based on blast radius: how many external files depend on this symbol.
    let riskLevel: 'low' | 'medium' | 'high';
    if (externalConsumers > 10) {
      riskLevel = 'high';
    } else if (externalConsumers > 0) {
      riskLevel = 'medium';
    } else {
      riskLevel = 'low';
    }

    totalExternalConsumers += externalConsumers;

    symbols.push({
      symbol: sym.symbol,
      shortName: shortenSymbol(sym.symbol),
      startLine: sym.start_line,
      endLine: sym.end_line,
      externalConsumers,
      riskLevel,
    });
  }

  return {
    file: doc.relative_path,
    symbols,
    totalExternalConsumers,
  };
}
