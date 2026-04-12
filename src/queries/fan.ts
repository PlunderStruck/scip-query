import type { ScipDatabase } from '../db.js';
import { buildFileDepGraph, findFirstSymbolMatch, resolveIndexedFile } from '../query-support.js';
import type { FanResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Fan-in: how many distinct files reference this symbol.
 * High fan-in = widely depended upon = high blast radius for changes.
 */
export function fanIn(
  db: ScipDatabase,
  symbolPattern: string,
): FanResult[] {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) {
    return [];
  }

  const row = db.get<{ file_count: number }>(
    `SELECT COUNT(DISTINCT c.document_id) AS file_count
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     WHERE m.symbol_id = ?
       AND m.role != 1`,
    match.symbolId,
  );

  return [{
    name: shortenSymbol(match.symbol),
    count: row?.file_count ?? 0,
  }];
}

/**
 * Fan-out: how many external symbols does this file reference.
 * High fan-out = depends on many things = fragile to upstream changes.
 */
export function fanOut(
  db: ScipDatabase,
  filePattern: string,
): FanResult[] {
  const resolvedFile = resolveIndexedFile(db, filePattern);
  if (!resolvedFile) {
    return [];
  }

  const rows = db.all<{
    relative_path: string;
    symbol_count: number;
  }>(
    `SELECT d.relative_path, COUNT(DISTINCT gs.id) AS symbol_count
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents def_d ON der.document_id = def_d.id
    WHERE d.relative_path = ?
      AND m.role != 1
      AND def_d.id != d.id
    GROUP BY d.id
    ORDER BY symbol_count DESC`,
    resolvedFile,
  );

  const indexedResults = rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({
      name: r.relative_path,
      count: r.symbol_count,
    }));

  if (indexedResults.length > 0) {
    return indexedResults;
  }

  const graph = buildFileDepGraph(db);
  const deps = graph.get(resolvedFile);
  if (!deps || deps.size === 0) {
    return [];
  }

  return [{
    name: resolvedFile,
    count: deps.size,
  }];
}

/**
 * Top fan-in across the whole codebase — the most depended-on symbols.
 */
export function topFanIn(
  db: ScipDatabase,
  opts: { limit?: number; scope?: string } = {},
): FanResult[] {
  const { limit = 30, scope } = opts;
  const scopeFilter = scope
    ? `AND def_d.relative_path LIKE '%${scope}%'`
    : '';

  const rows = db.all<{
    symbol: string;
    file_count: number;
  }>(
    `SELECT gs.symbol, COUNT(DISTINCT c.document_id) AS file_count
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents def_d ON der.document_id = def_d.id
    WHERE m.role != 1
      ${db.pathExclusionsFor('def_d')}
      ${db.symbolNoiseFor('gs')}
      ${scopeFilter}
    GROUP BY gs.id
    HAVING file_count > 1
    ORDER BY file_count DESC
    LIMIT ?`,
    limit,
  );

  return rows.map((r) => ({
    name: shortenSymbol(r.symbol),
    count: r.file_count,
  }));
}

/**
 * Top fan-out across the whole codebase — files that depend on the most external symbols.
 */
export function topFanOut(
  db: ScipDatabase,
  opts: { limit?: number; scope?: string } = {},
): FanResult[] {
  const { limit = 30, scope } = opts;
  const scopeFilter = scope
    ? `AND d.relative_path LIKE '%${scope}%'`
    : '';

  const rows = db.all<{
    relative_path: string;
    symbol_count: number;
  }>(
    `SELECT d.relative_path, COUNT(DISTINCT gs.id) AS symbol_count
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents def_d ON der.document_id = def_d.id
    WHERE m.role != 1
      AND def_d.id != d.id
      ${db.pathExclusionsFor('d')}
      ${db.symbolNoiseFor('gs')}
      ${scopeFilter}
    GROUP BY d.id
    ORDER BY symbol_count DESC
    LIMIT ?`,
    limit,
  );

  return rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({
      name: r.relative_path,
      count: r.symbol_count,
    }));
}
