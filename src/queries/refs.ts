import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch, getSourceReferenceSites } from '../query-support.js';
import type { RefResult } from '../types.js';

export function refs(db: ScipDatabase, symbolPattern: string): RefResult[] {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (match) {
    const sourceSites = getSourceReferenceSites(db, match)
      .filter((site) => !db.isIgnored(site.file))
      .map((site) => ({
        relativePath: site.file,
        line: site.line,
      }));

    if (sourceSites.length > 0) {
      return sourceSites;
    }
  }

  const rows = db.all<{
    relative_path: string;
    start_line: number;
  }>(
    `SELECT DISTINCT d.relative_path, c.start_line
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    WHERE m.symbol_id = ?
      AND ${db.localSymbolPredicate}
      AND m.role != 1
    ORDER BY d.relative_path, c.start_line`,
    match?.symbolId ?? -1,
  );

  return rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({
      relativePath: r.relative_path,
      line: r.start_line,
    }));
}
