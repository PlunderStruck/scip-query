import type { ScipDatabase } from '../storage/db.js';
import { ProjectIndex } from '../core/project-index.js';
import { resolveIndexedFile } from '../resolution/path-resolver.js';
import type { ChangeSurfaceEntry, ChangeSurfaceResult } from '../domain/types.js';
import { shortenSymbol } from '../symbols/symbol-parser.js';

/**
 * Pre-change briefing for a file. For each symbol defined in the file,
 * reports external consumer count and blast-radius risk.
 *
 * Symbol ranges come from getDefinitionsForFile so they are source-corrected
 * and match `scip symbols` output.
 */
export function changeSurface(
  db: ScipDatabase,
  filePattern: string,
): ChangeSurfaceResult | null {
  const resolvedFile = resolveIndexedFile(db, filePattern);
  if (!resolvedFile) return null;

  const doc = db.get<{ id: number; relative_path: string }>(
    `SELECT id, relative_path FROM documents
     WHERE relative_path = ?
       ${db.pathExclusionsFor('documents')}
     LIMIT 1`,
    resolvedFile,
  );

  if (!doc || db.isIgnored(doc.relative_path)) return null;

  const index = new ProjectIndex(db);
  const definitions = index.definitionsForFile(doc.relative_path)
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  const symbols: ChangeSurfaceEntry[] = [];
  let totalExternalConsumers = 0;

  for (const def of definitions) {
    const consumerRow = db.get<{ consumer_count: number }>(
      `SELECT COUNT(DISTINCT c.document_id) AS consumer_count
      FROM mentions m
      JOIN chunks c ON m.chunk_id = c.id
      WHERE m.symbol_id = ?
        AND m.role != 1
        AND c.document_id != ?`,
      def.symbolId,
      doc.id,
    );

    const externalConsumers = consumerRow?.consumer_count ?? 0;

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
      symbol: def.symbol,
      shortName: shortenSymbol(def.symbol),
      startLine: def.startLine,
      endLine: def.endLine,
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
