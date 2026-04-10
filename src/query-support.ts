import type { ScipDatabase } from './db.js';

export interface SymbolLocation {
  documentId: number;
  startLine: number;
  endLine: number;
  symbolId: number;
}

export interface SymbolMatch extends SymbolLocation {
  symbol: string;
  relativePath: string;
}

export interface CalleeRow {
  symbol: string;
  file: string;
  chunkId: number;
}

export const TEST_FILE_PATTERNS = [
  '%/__tests__/%',
  '%.test.%',
  '%.spec.%',
  '%/test/%',
  '%/tests/%',
  '%_test.%',
  '%_spec.%',
  '%/test_%.%',
  '%/spec_%.%',
] as const;

export const TEST_SUPPORT_PATH_PATTERNS = [
  '%/test-utils/%',
] as const;

export function testFileMatchSql(
  alias: string,
  patterns: readonly string[] = TEST_FILE_PATTERNS,
): string {
  return `(${patterns.map((pattern) => `${alias}.relative_path LIKE '${pattern}'`).join(' OR ')})`;
}

export function testFileExclusionSql(
  alias: string,
  extraPatterns: readonly string[] = [],
): string {
  const patterns = uniquePatterns([...TEST_FILE_PATTERNS, ...extraPatterns]);
  return patterns
    .map((pattern) => `${alias}.relative_path NOT LIKE '${pattern}'`)
    .join('\n      AND ');
}

export function buildFileDepGraph(
  db: ScipDatabase,
  scope?: string,
): Map<string, Set<string>> {
  const scopeFilter = scope ? `AND d1.relative_path LIKE '%${scope}%'` : '';

  const edges = db.all<{ from_file: string; to_file: string }>(
    `SELECT DISTINCT
      d1.relative_path AS from_file,
      d2.relative_path AS to_file
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d1 ON c.document_id = d1.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d2 ON der.document_id = d2.id
    WHERE d1.id != d2.id
      AND m.role = 0
      ${db.pathExclusionsFor('d1', 'd2')}
      ${scopeFilter}`,
  );

  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (db.isIgnored(edge.from_file) || db.isIgnored(edge.to_file)) continue;
    if (!graph.has(edge.from_file)) graph.set(edge.from_file, new Set());
    graph.get(edge.from_file)!.add(edge.to_file);
  }

  return graph;
}

export function findFirstSymbolMatch(
  db: ScipDatabase,
  symbolPattern: string,
): SymbolMatch | null {
  const row = db.get<{
    id: number;
    symbol: string;
    document_id: number;
    start_line: number;
    end_line: number;
    relative_path: string;
  }>(
    `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.end_line, d.relative_path
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE gs.symbol LIKE ?
      ${db.pathExclusionsFor('d')}
      ${db.symbolNoiseFor('gs')}
    LIMIT 1`,
    `%${symbolPattern}%`,
  );

  if (!row || db.isIgnored(row.relative_path)) {
    return null;
  }

  return {
    symbolId: row.id,
    symbol: row.symbol,
    documentId: row.document_id,
    startLine: row.start_line,
    endLine: row.end_line,
    relativePath: row.relative_path,
  };
}

export function getCalleeRowsForSymbol(
  db: ScipDatabase,
  symbol: SymbolLocation,
  opts: { limit?: number } = {},
): CalleeRow[] {
  const rows = db.all<{
    symbol: string;
    file: string;
    chunk_id: number;
  }>(
    `SELECT DISTINCT
      callee_gs.symbol AS symbol,
      callee_d.relative_path AS file,
      c.id AS chunk_id
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN global_symbols callee_gs ON m.symbol_id = callee_gs.id
    JOIN defn_enclosing_ranges callee_der ON callee_gs.id = callee_der.symbol_id
    JOIN documents callee_d ON callee_der.document_id = callee_d.id
    WHERE c.document_id = ?
      AND c.start_line >= ?
      AND c.end_line <= ?
      AND m.role = 0
      AND callee_gs.id != ?
      ${db.symbolNoiseFor('callee_gs')}
      ${db.pathExclusionsFor('callee_d')}
    ORDER BY callee_d.relative_path
    ${opts.limit ? 'LIMIT ?' : ''}`,
    ...calleeQueryParams(symbol, opts.limit),
  );

  return rows.filter((row) => !db.isIgnored(row.file)).map((row) => ({
    symbol: row.symbol,
    file: row.file,
    chunkId: row.chunk_id,
  }));
}

function calleeQueryParams(
  symbol: SymbolLocation,
  limit?: number,
): number[] {
  const params = [
    symbol.documentId,
    symbol.startLine,
    symbol.endLine,
    symbol.symbolId,
  ];

  if (typeof limit === 'number') {
    params.push(limit);
  }

  return params;
}

function uniquePatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns)];
}
