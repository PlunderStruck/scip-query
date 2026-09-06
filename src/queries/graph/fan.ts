import { indexedReferenceFileCount } from '../internal/indexed-reference-count.js';
import type { ScipDatabase } from '../../storage/db.js';
import { resolveSymbol } from '../../symbols/symbol-lookup.js';
import { resolveIndexedFile } from '../internal/file-resolution.js';
import { buildFileDepGraph } from '../../symbols/graph/file-dep-graph.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';

export interface FanResult {
  name: string;
  count: number;
}

export interface FanInResult extends FanResult {
  /** Exact SCIP symbol identity; `name` is only a shortened display label. */
  symbol: string;
  /** File that owns the exact definition counted by this row. */
  definedIn: string;
}

export interface ExternalSymbolFanOutResult extends FanResult {
  file: string;
  basis: 'external-symbol-references';
}

export interface FileDependencyOutDegreeResult extends FanResult {
  file: string;
  basis: 'file-dependency-edges';
}

/**
 * Fan-in: how many distinct files reference this symbol.
 * High fan-in = widely depended upon = high blast radius for changes.
 */
export function fanIn(db: ScipDatabase, symbolPattern: string): FanInResult[] {
  const resolution = resolveSymbol(db, symbolPattern);
  if (resolution.candidates.length > 0) {
    throw new Error(`Ambiguous symbol: ${symbolPattern}. Use an exact SCIP symbol or file:line.`);
  }
  const match = resolution.match;
  if (!match) {
    return [];
  }

  return [
    {
      name: shortenSymbol(match.symbol),
      count: indexedReferenceFileCount(db, match.symbolId),
      symbol: match.symbol,
      definedIn: match.relativePath,
    },
  ];
}

/** Count distinct externally defined symbols referenced by one indexed file. */
export function externalSymbolFanOut(db: ScipDatabase, filePattern: string): ExternalSymbolFanOutResult[] {
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
    JOIN (
      SELECT m2.symbol_id, c2.document_id
      FROM mentions m2
      JOIN chunks c2 ON m2.chunk_id = c2.id
      WHERE m2.role = 1
      GROUP BY m2.symbol_id
    ) sym_def ON sym_def.symbol_id = gs.id
    JOIN documents def_d ON sym_def.document_id = def_d.id
    WHERE d.relative_path = ?
      AND m.role != 1
      AND def_d.id != d.id
    GROUP BY d.id
    ORDER BY symbol_count DESC, d.relative_path`,
    resolvedFile,
  );

  const indexedResults = rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({
      name: r.relative_path,
      count: r.symbol_count,
      file: r.relative_path,
      basis: 'external-symbol-references' as const,
    }));

  return indexedResults;
}

/** Count outgoing edges in the file symbol-reference dependency graph. */
export function fileDependencyOutDegree(db: ScipDatabase, filePattern: string): FileDependencyOutDegreeResult[] {
  const resolvedFile = resolveIndexedFile(db, filePattern);
  if (!resolvedFile) return [];
  const graph = buildFileDepGraph(db);
  const deps = graph.get(resolvedFile);
  if (!deps || deps.size === 0) {
    return [];
  }

  return [
    {
      name: resolvedFile,
      count: deps.size,
      file: resolvedFile,
      basis: 'file-dependency-edges',
    },
  ];
}

/**
 * @deprecated This compatibility query changes its counting unit when SCIP
 * mention rows are unavailable. Use `externalSymbolFanOut` or
 * `fileDependencyOutDegree` so the selected graph and unit remain explicit.
 */
export function fanOut(db: ScipDatabase, filePattern: string): FanResult[] {
  const externalSymbols = externalSymbolFanOut(db, filePattern);
  return externalSymbols.length > 0 ? externalSymbols : fileDependencyOutDegree(db, filePattern);
}

/**
 * Top fan-in across the whole codebase — the most depended-on symbols.
 */
export function topFanIn(db: ScipDatabase, opts: { limit?: number; scope?: string } = {}): FanInResult[] {
  return fetchTopFanInRows(db, opts).map((r) => ({
    name: shortenSymbol(r.symbol),
    count: r.file_count,
    symbol: r.symbol,
    definedIn: r.defined_in,
  }));
}

function fetchTopFanInRows(
  db: ScipDatabase,
  opts: { limit?: number; scope?: string },
): Array<{ symbol: string; file_count: number; defined_in: string }> {
  const { limit = 30, scope } = opts;
  const scopeFilter = scope ? `AND instr(def_d.relative_path, ?) > 0` : '';
  const scopeParams = scope ? [scope] : [];

  return db.all<{ symbol: string; file_count: number; defined_in: string }>(
    `SELECT gs.symbol,
            COUNT(DISTINCT c.document_id) AS file_count,
            def_d.relative_path AS defined_in
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
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
      AND def_d.id != c.document_id
      ${db.pathExclusionsFor('def_d')}
      ${db.symbolNoiseFor('gs')}
      ${scopeFilter}
    GROUP BY gs.id
    HAVING file_count > 0
    ORDER BY file_count DESC, gs.symbol
    LIMIT ?`,
    ...scopeParams,
    limit,
  );
}

/**
 * Top fan-out across the whole codebase — files that depend on the most external symbols.
 */
// scip-query: ignore-similar — shares SCIP-DB join shape with bottlenecks +
// hotspots; measures per-file external-symbol count. Each query asks a
// different question of the same SCIP graph.
export function topFanOut(db: ScipDatabase, opts: { limit?: number; scope?: string } = {}): FanResult[] {
  const { limit = 30, scope } = opts;
  const scopeFilter = scope ? `AND instr(d.relative_path, ?) > 0` : '';
  const scopeParams = scope ? [scope] : [];

  const rows = db.all<{
    relative_path: string;
    symbol_count: number;
  }>(
    `SELECT d.relative_path, COUNT(DISTINCT gs.id) AS symbol_count
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
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
      AND def_d.id != d.id
      ${db.pathExclusionsFor('d')}
      ${db.symbolNoiseFor('gs')}
      ${scopeFilter}
    GROUP BY d.id
    ORDER BY symbol_count DESC, d.relative_path
    LIMIT ?`,
    ...scopeParams,
    limit,
  );

  return rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({
      name: r.relative_path,
      count: r.symbol_count,
    }));
}
