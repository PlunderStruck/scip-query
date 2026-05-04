import type { ScipDatabase } from '../db.js';
import { getAllDefinitions } from '../definition-catalog.js';
import { getCallerRowsForSymbol } from '../reference-graph.js';
import type { IndexedDefinition } from '../types.js';
import type { HotspotResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find the most-referenced symbols in the codebase — the choke points
 * where changes have the widest blast radius.
 */
export function hotspots(
  db: ScipDatabase,
  opts: { limit?: number; scope?: string } = {},
): HotspotResult[] {
  const { limit = 30, scope } = opts;

  const scopeFilter = scope ? `AND def_d.relative_path LIKE '%${scope}%'` : '';

  const rows = db.all<{
    symbol: string;
    ref_count: number;
    file_count: number;
    defined_in: string;
  }>(
    `SELECT
      gs.symbol,
      COUNT(*) AS ref_count,
      COUNT(DISTINCT ref_d.id) AS file_count,
      def_d.relative_path AS defined_in
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents ref_d ON c.document_id = ref_d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN (
      SELECT m2.symbol_id, c2.document_id
      FROM mentions m2
      JOIN chunks c2 ON m2.chunk_id = c2.id
      WHERE m2.role = 1
      GROUP BY m2.symbol_id
    ) sym_def ON sym_def.symbol_id = gs.id
    JOIN documents def_d ON sym_def.document_id = def_d.id
    WHERE m.role != 1
      ${db.pathExclusionsFor('def_d')}
      ${db.symbolNoiseFor('gs')}
      ${scopeFilter}
    GROUP BY gs.id
    ORDER BY ref_count DESC
    LIMIT ?`,
    limit,
  );

  const indexedResults = rows
    .filter((r) => !db.isIgnored(r.defined_in))
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      refCount: r.ref_count,
      fileCount: r.file_count,
      definedIn: r.defined_in,
    }));

  if (indexedResults.length > 0) {
    return indexedResults;
  }

  return hotspotsByDefinitionFallback(db, scope, limit);
}

function hotspotsByDefinitionFallback(
  db: ScipDatabase,
  scope: string | undefined,
  limit: number,
): HotspotResult[] {
  return getAllDefinitions(db, { scope })
    .filter((definition) => !db.isIgnored(definition.relativePath))
    .map((definition) => hotspotRowFor(db, definition))
    .filter((row) => row.refCount > 0)
    .sort((left, right) => right.refCount - left.refCount || right.fileCount - left.fileCount)
    .slice(0, limit);
}

function hotspotRowFor(
  db: ScipDatabase,
  definition: IndexedDefinition,
): HotspotResult {
  const callerRows = getCallerRowsForSymbol(db, definition, { limit: 500 });
  return {
    symbol: definition.symbol,
    shortName: shortenSymbol(definition.symbol),
    refCount: callerRows.length,
    fileCount: new Set(callerRows.map((row) => row.file)).size,
    definedIn: definition.relativePath,
  };
}
