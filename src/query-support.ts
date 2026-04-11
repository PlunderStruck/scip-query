import type { ScipDatabase } from './db.js';
import { basename } from 'node:path';
import { findIdentifierLines, getSourceCalls, getSourceConstructorBindings, getSourceImports } from './source-analysis.js';
import { isFunctionLikeSymbol, isModuleLikeSymbol, leafName, leafSuffix, parseSymbol, shortenSymbol } from './symbol-parser.js';

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

export interface CallerRow {
  symbol: string;
  file: string;
}

export interface ReferenceSite {
  file: string;
  line: number;
  enclosingSymbol: string | null;
}

interface DocumentPathCandidate {
  relativePath: string;
  score: number;
}

interface IndexedDefinition extends SymbolMatch {
  leaf: string;
  parentTypeName: string | null;
  isFunctionLike: boolean;
  isTypeLike: boolean;
}

const FILE_DEFINITION_CACHE = new WeakMap<ScipDatabase, Map<string, IndexedDefinition[]>>();

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
      AND m.role != 1
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
  // Handle file:line-line syntax (e.g., "src/foo.ts:10-50")
  const fileLineMatch = symbolPattern.match(/^(.+):(\d+)-(\d+)$/);
  if (fileLineMatch) {
    const [, filePath, startStr, endStr] = fileLineMatch;
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
      WHERE d.relative_path LIKE ?
        AND der.start_line <= ? AND der.end_line >= ?
        ${db.pathExclusionsFor('d')}
      ORDER BY (der.end_line - der.start_line) ASC
      LIMIT 1`,
      `%${filePath}%`, parseInt(startStr!, 10), parseInt(endStr!, 10),
    );
    if (row && !db.isIgnored(row.relative_path)) {
      return {
        symbolId: row.id,
        symbol: row.symbol,
        documentId: row.document_id,
        startLine: row.start_line,
        endLine: row.end_line,
        relativePath: row.relative_path,
      };
    }
  }

  const cleaned = normalizeLookupPattern(symbolPattern);
  const tokens = lookupTokens(symbolPattern);
  const candidates = getSymbolLookupCandidates(db, tokens);

  let best: {
    row: {
      id: number;
      symbol: string;
      document_id: number;
      start_line: number;
      end_line: number;
      relative_path: string;
      display_name: string | null;
    };
    score: number;
  } | null = null;

  for (const row of candidates) {
    if (db.isIgnored(row.relative_path)) continue;

    const score = scoreSymbolCandidate(row, symbolPattern, cleaned, tokens);
    if (score <= 0) continue;

    if (!best || score > best.score) {
      best = { row, score };
    }
  }

  if (best) {
    return {
      symbolId: best.row.id,
      symbol: best.row.symbol,
      documentId: best.row.document_id,
      startLine: best.row.start_line,
      endLine: best.row.end_line,
      relativePath: best.row.relative_path,
    };
  }

  return null;
}

export function findExactSymbolMatch(
  db: ScipDatabase,
  symbol: string,
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
     WHERE gs.symbol = ?
       ${db.pathExclusionsFor('d')}
     ORDER BY d.relative_path, der.start_line
     LIMIT 1`,
    symbol,
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

export function resolveIndexedFile(
  db: ScipDatabase,
  filePattern: string,
): string | null {
  return resolveDocumentCandidates(db, filePattern, { allowMultiple: false })[0]?.relativePath ?? null;
}

export function resolveIndexedPaths(
  db: ScipDatabase,
  filePattern: string,
): string[] {
  return resolveDocumentCandidates(db, filePattern, { allowMultiple: true }).map((candidate) => candidate.relativePath);
}

function normalizeLookupPattern(symbolPattern: string): string {
  return symbolPattern.trim().replace(/\(\)$/, '').replace(/\(.*$/, '');
}

function lookupTokens(symbolPattern: string): string[] {
  const cleaned = normalizeLookupPattern(symbolPattern);
  const tokens = cleaned
    .split(/[^A-Za-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  return tokens.length > 0 ? [...new Set(tokens)] : [cleaned];
}

function getSymbolLookupCandidates(
  db: ScipDatabase,
  tokens: string[],
): Array<{
  id: number;
  symbol: string;
  document_id: number;
  start_line: number;
  end_line: number;
  relative_path: string;
  display_name: string | null;
}> {
  const tokenClauses = tokens.map(
    () => `(gs.symbol LIKE ? OR d.relative_path LIKE ? OR COALESCE(gs.display_name, '') LIKE ?)`,
  );
  const params = tokens.flatMap((token) => {
    const like = `%${token}%`;
    return [like, like, like];
  });

  return db.all<{
    id: number;
    symbol: string;
    document_id: number;
    start_line: number;
    end_line: number;
    relative_path: string;
    display_name: string | null;
  }>(
    `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.end_line, d.relative_path, gs.display_name
     FROM global_symbols gs
     JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
     JOIN documents d ON der.document_id = d.id
     WHERE ${tokenClauses.join('\n       AND ')}
       ${db.pathExclusionsFor('d')}
     LIMIT 200`,
    ...params,
  );
}

function scoreSymbolCandidate(
  row: {
    symbol: string;
    relative_path: string;
    start_line: number;
    end_line: number;
    display_name: string | null;
  },
  originalPattern: string,
  cleanedPattern: string,
  tokens: string[],
): number {
  const original = originalPattern.toLowerCase();
  const cleaned = cleanedPattern.toLowerCase();
  const noParens = cleaned.replace(/\(\)$/, '');
  const raw = row.symbol.toLowerCase();
  const short = shortenSymbol(row.symbol).toLowerCase();
  const leaf = leafName(row.symbol).toLowerCase();
  const display = (row.display_name ?? '').toLowerCase();
  const path = row.relative_path.toLowerCase();
  const looksPathLike = /[/:.]/.test(cleanedPattern);

  let score = 0;

  if (raw === original || raw === cleaned) score += 1000;
  if (short === original || short === cleaned) score += 950;
  if (path === original || path === cleaned) score += 925;
  if (path.endsWith(`/${cleaned}`) || path.endsWith(`/${original}`)) score += 875;
  if (display === noParens) score += 850;
  if (leaf === noParens) score += 825;
  if (`${leaf}()` === original || `${leaf}()` === cleaned) score += 820;
  if (short.endsWith(`:${cleaned}`) || short.endsWith(`:${noParens}`) || short.endsWith(`:${noParens}()`)) score += 800;

  if (raw.includes(cleaned)) score += 120;
  if (short.includes(cleaned)) score += 140;
  if (path.includes(cleaned)) score += 140;
  if (display.includes(cleaned)) score += 110;

  if (tokens.every((token) => {
    const lower = token.toLowerCase();
    return raw.includes(lower) || short.includes(lower) || path.includes(lower) || display.includes(lower);
  })) {
    score += 100 + tokens.length * 15;
  }

  if (isFunctionLikeSymbol(row.symbol) && leaf === noParens) {
    score += 60;
  }

  if (!looksPathLike && isModuleLikeSymbol(row.symbol)) {
    score -= 160;
  }

  // Prefer narrower matches when everything else is close.
  score -= Math.min(50, Math.max(0, row.end_line - row.start_line));

  return score;
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
      AND m.role != 1
      AND callee_gs.id != ?
      ${db.symbolNoiseFor('callee_gs')}
      ${db.pathExclusionsFor('callee_d')}
    ORDER BY callee_d.relative_path
    ${opts.limit ? 'LIMIT ?' : ''}`,
    ...calleeQueryParams(symbol, opts.limit),
  );

  const primary = rows.filter((row) => !db.isIgnored(row.file)).map((row) => ({
    symbol: row.symbol,
    file: row.file,
    chunkId: row.chunk_id,
  }));

  const sourceFallback = getSourceBackedCalleeRows(db, symbol, opts.limit);
  if (sourceFallback.length === 0) {
    return primary;
  }

  if (primary.length === 0) {
    return applyLimit(sourceFallback, opts.limit);
  }

  const seen = new Set(primary.map((row) => `${row.symbol}|${row.file}`));
  const merged = [...primary];
  for (const row of sourceFallback) {
    const key = `${row.symbol}|${row.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }

  return applyLimit(merged, opts.limit);
}

export function getCallerRowsForSymbol(
  db: ScipDatabase,
  symbol: SymbolLocation,
  opts: { limit?: number } = {},
): CallerRow[] {
  const match = getFullSymbolMatch(db, symbol);
  if (!match) {
    return [];
  }

  const primary = db.all<{
    caller_symbol: string;
    caller_file: string;
  }>(
    `SELECT DISTINCT caller_gs.symbol AS caller_symbol, caller_d.relative_path AS caller_file
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents ref_d ON c.document_id = ref_d.id
    JOIN defn_enclosing_ranges caller_der
      ON caller_der.document_id = ref_d.id
      AND c.start_line >= caller_der.start_line
      AND c.end_line <= caller_der.end_line
    JOIN global_symbols caller_gs ON caller_der.symbol_id = caller_gs.id
    JOIN documents caller_d ON caller_der.document_id = caller_d.id
    WHERE m.symbol_id = ?
      AND m.role != 1
      AND caller_gs.id != ?
      ${db.symbolNoiseFor('caller_gs')}
      ${db.pathExclusionsFor('caller_d')}
    ORDER BY caller_d.relative_path
    ${opts.limit ? 'LIMIT ?' : ''}`,
    ...callerQueryParams(match, opts.limit),
  )
    .filter((row) => !db.isIgnored(row.caller_file))
    .map((row) => ({
      symbol: row.caller_symbol,
      file: row.caller_file,
    }));

  const sourceFallback = getPythonSourceCallerRows(db, match, opts.limit);
  if (sourceFallback.length === 0) {
    return primary;
  }

  const merged = sourceFallback.length > 0 ? [...sourceFallback] : [];
  const seen = new Set(merged.map((row) => `${row.symbol}|${row.file}`));
  for (const row of primary) {
    const key = `${row.symbol}|${row.file}`;
    if (seen.has(key)) continue;
    if (isFunctionLikeSymbol(row.symbol) || merged.length === 0) {
      seen.add(key);
      merged.push(row);
    }
  }

  return applyLimit(merged, opts.limit);
}

export function getSourceReferenceSites(
  db: ScipDatabase,
  symbol: SymbolLocation,
): ReferenceSite[] {
  const match = getFullSymbolMatch(db, symbol);
  if (!match) {
    return [];
  }

  const identifier = leafName(match.symbol);
  if (!identifier || !hasUniqueLeafDefinition(db, identifier, match.symbolId)) {
    return [];
  }

  const documents = db.all<{ relative_path: string }>(
    `SELECT relative_path
     FROM documents
     WHERE 1 = 1
       ${db.pathExclusionsFor('documents')}
     ORDER BY relative_path`,
  );

  const sites: ReferenceSite[] = [];
  const seen = new Set<string>();

  for (const document of documents) {
    if (db.isIgnored(document.relative_path)) continue;

    const lines = findIdentifierLines(db, document.relative_path, identifier, document.relative_path === match.relativePath
      ? { excludeStartLine: match.startLine, excludeEndLine: match.endLine }
      : {});

    for (const line of lines) {
      const enclosing = db.get<{ symbol: string }>(
        `SELECT gs.symbol
         FROM defn_enclosing_ranges der
         JOIN global_symbols gs ON der.symbol_id = gs.id
         JOIN documents d ON der.document_id = d.id
         WHERE d.relative_path = ?
           AND der.start_line <= ?
           AND der.end_line >= ?
         ORDER BY (der.end_line - der.start_line) ASC
         LIMIT 1`,
        document.relative_path,
        line,
        line,
      );

      const key = `${document.relative_path}|${line}|${enclosing?.symbol ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push({
        file: document.relative_path,
        line,
        enclosingSymbol: enclosing?.symbol ?? null,
      });
    }
  }

  return sites;
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

function callerQueryParams(
  symbol: SymbolLocation,
  limit?: number,
): number[] {
  const params = [symbol.symbolId, symbol.symbolId];
  if (typeof limit === 'number') {
    params.push(limit);
  }
  return params;
}

function getPythonSourceCalleeRows(
  db: ScipDatabase,
  symbol: SymbolLocation,
  limit?: number,
): CalleeRow[] {
  const match = getFullSymbolMatch(db, symbol);
  if (!match || !isPythonDocument(db, match.relativePath)) {
    return [];
  }

  const definitions = getDefinitionsForFile(db, match.relativePath);
  const current = definitions.find((definition) => definition.symbolId === match.symbolId);
  if (!current) {
    return [];
  }

  const imports = getSourceImports(db, match.relativePath);
  const bindings = new Map(
    getSourceConstructorBindings(db, match.relativePath, {
      startLine: match.startLine,
      endLine: match.endLine,
    }).map((binding) => [binding.localName, binding.typeName]),
  );
  const rows: CalleeRow[] = [];
  const seen = new Set<string>();

  for (const call of getSourceCalls(db, match.relativePath, {
    startLine: match.startLine,
    endLine: match.endLine,
  })) {
    const resolved = resolvePythonCallTarget(
      db,
      current,
      definitions,
      imports,
      bindings,
      call.receiverName,
      call.calleeName,
    );
    if (!resolved || resolved.symbolId === match.symbolId || db.isIgnored(resolved.relativePath)) continue;

    const chunkId = 1_000_000_000 + call.line;
    const key = `${resolved.symbol}|${resolved.relativePath}|${chunkId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      symbol: resolved.symbol,
      file: resolved.relativePath,
      chunkId,
    });
  }

  return applyLimit(rows, limit);
}

function getJavaScriptSourceCalleeRows(
  db: ScipDatabase,
  symbol: SymbolLocation,
  limit?: number,
): CalleeRow[] {
  const match = getFullSymbolMatch(db, symbol);
  if (!match || !isJavaScriptDocument(db, match.relativePath)) {
    return [];
  }

  const definitions = getDefinitionsForFile(db, match.relativePath);
  const current = definitions.find((definition) => definition.symbolId === match.symbolId);
  if (!current) {
    return [];
  }

  const imports = getSourceImports(db, match.relativePath);
  const bindings = new Map(
    getSourceConstructorBindings(db, match.relativePath, {
      startLine: match.startLine,
      endLine: match.endLine,
    }).map((binding) => [binding.localName, binding.typeName]),
  );
  const rows: CalleeRow[] = [];
  const seen = new Set<string>();

  for (const call of getSourceCalls(db, match.relativePath, {
    startLine: match.startLine,
    endLine: match.endLine,
  })) {
    const resolved = resolveJavaScriptCallTarget(
      db,
      current,
      definitions,
      imports,
      bindings,
      call.receiverName,
      call.calleeName,
    );
    if (!resolved || resolved.symbolId === match.symbolId || db.isIgnored(resolved.relativePath)) continue;

    const chunkId = 1_000_000_000 + call.line;
    const key = `${resolved.symbol}|${resolved.relativePath}|${chunkId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      symbol: resolved.symbol,
      file: resolved.relativePath,
      chunkId,
    });
  }

  return applyLimit(rows, limit);
}

function getSourceBackedCalleeRows(
  db: ScipDatabase,
  symbol: SymbolLocation,
  limit?: number,
): CalleeRow[] {
  const match = getFullSymbolMatch(db, symbol);
  if (!match) {
    return [];
  }

  if (isPythonDocument(db, match.relativePath)) {
    return getPythonSourceCalleeRows(db, match, limit);
  }

  if (isJavaScriptDocument(db, match.relativePath)) {
    return getJavaScriptSourceCalleeRows(db, match, limit);
  }

  return [];
}

function getPythonSourceCallerRows(
  db: ScipDatabase,
  target: SymbolMatch,
  limit?: number,
): CallerRow[] {
  if (!isPythonDocument(db, target.relativePath)) {
    return [];
  }

  const rows: CallerRow[] = [];
  const seen = new Set<string>();

  for (const candidate of getAllFunctionLikeDefinitions(db)) {
    if (candidate.symbolId === target.symbolId) continue;
    const callees = getPythonSourceCalleeRows(db, candidate);
    if (!callees.some((callee) => callee.symbol === target.symbol)) continue;

    const key = `${candidate.symbol}|${candidate.relativePath}`;
    if (seen.has(key) || db.isIgnored(candidate.relativePath)) continue;
    seen.add(key);
    rows.push({
      symbol: candidate.symbol,
      file: candidate.relativePath,
    });

    if (typeof limit === 'number' && rows.length >= limit) {
      break;
    }
  }

  return rows;
}

function getFullSymbolMatch(
  db: ScipDatabase,
  symbol: SymbolLocation,
): SymbolMatch | null {
  if ('symbol' in symbol && 'relativePath' in symbol) {
    return symbol as SymbolMatch;
  }

  const row = db.get<{
    symbol: string;
    relative_path: string;
  }>(
    `SELECT gs.symbol, d.relative_path
     FROM global_symbols gs
     JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
     JOIN documents d ON der.document_id = d.id
     WHERE gs.id = ?
     LIMIT 1`,
    symbol.symbolId,
  );

  if (!row) {
    return null;
  }

  return {
    ...symbol,
    symbol: row.symbol,
    relativePath: row.relative_path,
  };
}

function getDefinitionsForFile(
  db: ScipDatabase,
  relativePath: string,
): IndexedDefinition[] {
  let cache = FILE_DEFINITION_CACHE.get(db);
  if (!cache) {
    cache = new Map<string, IndexedDefinition[]>();
    FILE_DEFINITION_CACHE.set(db, cache);
  }

  const cached = cache.get(relativePath);
  if (cached) {
    return cached;
  }

  const definitions = db.all<{
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
     WHERE d.relative_path = ?
       ${db.symbolNoiseFor('gs')}
     ORDER BY der.start_line, der.end_line`,
    relativePath,
  ).map((row) => ({
    symbolId: row.id,
    symbol: row.symbol,
    documentId: row.document_id,
    startLine: row.start_line,
    endLine: row.end_line,
    relativePath: row.relative_path,
    leaf: leafName(row.symbol),
    parentTypeName: parentTypeName(row.symbol),
    isFunctionLike: isFunctionLikeSymbol(row.symbol),
    isTypeLike: leafSuffix(row.symbol) === 'type',
  }));

  cache.set(relativePath, definitions);
  return definitions;
}

function getAllFunctionLikeDefinitions(db: ScipDatabase): IndexedDefinition[] {
  const rows = db.all<{
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
     WHERE 1 = 1
       ${db.pathExclusionsFor('d')}
       ${db.symbolNoiseFor('gs')}
     ORDER BY d.relative_path, der.start_line`,
  );

  return rows
    .filter((row) => !db.isIgnored(row.relative_path))
    .filter((row) => isFunctionLikeSymbol(row.symbol))
    .map((row) => ({
      symbolId: row.id,
      symbol: row.symbol,
      documentId: row.document_id,
      startLine: row.start_line,
      endLine: row.end_line,
      relativePath: row.relative_path,
      leaf: leafName(row.symbol),
      parentTypeName: parentTypeName(row.symbol),
      isFunctionLike: true,
      isTypeLike: false,
    }));
}

function resolvePythonCallTarget(
  db: ScipDatabase,
  current: IndexedDefinition,
  currentFileDefinitions: IndexedDefinition[],
  imports: ReturnType<typeof getSourceImports>,
  constructorBindings: Map<string, string>,
  receiverName: string | null,
  calleeName: string,
): IndexedDefinition | null {
  if (receiverName === 'self' || receiverName === 'cls') {
    return findDefinitionByName(currentFileDefinitions, calleeName, current.parentTypeName, ['function']);
  }

  if (receiverName) {
    const inferredType = constructorBindings.get(receiverName);
    if (inferredType) {
      const boundMethod = findDefinitionByName(currentFileDefinitions, calleeName, inferredType, ['function']);
      if (boundMethod) {
        return boundMethod;
      }

      for (const entry of imports) {
        if (entry.localName !== inferredType || !entry.sourcePath) continue;
        const importedDefinitions = getDefinitionsForFile(db, entry.sourcePath);
        const importedMethod = findDefinitionByName(importedDefinitions, calleeName, entry.importedName, ['function']);
        if (importedMethod) {
          return importedMethod;
        }
      }
    }

    const localClassMethod = findDefinitionByName(currentFileDefinitions, calleeName, receiverName, ['function']);
    if (localClassMethod) {
      return localClassMethod;
    }

    const namespaceImport = imports.find((entry) => entry.localName === receiverName && entry.sourcePath);
    if (namespaceImport?.sourcePath) {
      const importedDefinitions = getDefinitionsForFile(db, namespaceImport.sourcePath);
      const importedTypeMethod = namespaceImport.kind === 'named'
        ? findDefinitionByName(importedDefinitions, calleeName, namespaceImport.importedName, ['function'])
        : null;
      if (importedTypeMethod) {
        return importedTypeMethod;
      }

      return findDefinitionByName(importedDefinitions, calleeName, null, ['function', 'type']);
    }

    return null;
  }

  const importedBinding = imports.find((entry) => entry.localName === calleeName && entry.sourcePath);
  if (importedBinding?.sourcePath) {
    const importedDefinitions = getDefinitionsForFile(db, importedBinding.sourcePath);
    const importedName = importedBinding.importedName === '*' ? calleeName : importedBinding.importedName;
    const importedDefinition = findDefinitionByName(importedDefinitions, importedName, null, ['function', 'type']);
    if (importedDefinition) {
      return importedDefinition;
    }
  }

  return findDefinitionByName(currentFileDefinitions, calleeName, null, ['function', 'type']);
}

function resolveJavaScriptCallTarget(
  db: ScipDatabase,
  current: IndexedDefinition,
  currentFileDefinitions: IndexedDefinition[],
  imports: ReturnType<typeof getSourceImports>,
  constructorBindings: Map<string, string>,
  receiverName: string | null,
  calleeName: string,
): IndexedDefinition | null {
  if (receiverName === 'this') {
    return findDefinitionByName(currentFileDefinitions, calleeName, current.parentTypeName, ['function']);
  }

  if (receiverName) {
    const inferredType = constructorBindings.get(receiverName);
    if (inferredType) {
      const boundMethod = findDefinitionByName(currentFileDefinitions, calleeName, inferredType, ['function']);
      if (boundMethod) {
        return boundMethod;
      }

      for (const entry of imports) {
        if (entry.localName !== inferredType || !entry.sourcePath) continue;
        const importedDefinitions = getDefinitionsForFile(db, entry.sourcePath);
        const importedMethod = findDefinitionByName(importedDefinitions, calleeName, entry.importedName, ['function']);
        if (importedMethod) {
          return importedMethod;
        }
      }
    }

    const localClassMethod = findDefinitionByName(currentFileDefinitions, calleeName, receiverName, ['function']);
    if (localClassMethod) {
      return localClassMethod;
    }

    const namespaceImport = imports.find((entry) => entry.localName === receiverName && entry.sourcePath);
    if (namespaceImport?.sourcePath) {
      const importedDefinitions = getDefinitionsForFile(db, namespaceImport.sourcePath);
      if (namespaceImport.kind === 'named' || namespaceImport.kind === 'default') {
        const importedTypeMethod = findDefinitionByName(
          importedDefinitions,
          calleeName,
          namespaceImport.importedName,
          ['function'],
        );
        if (importedTypeMethod) {
          return importedTypeMethod;
        }
      }

      return findDefinitionByName(importedDefinitions, calleeName, null, ['function', 'type']);
    }

    return null;
  }

  const importedBinding = imports.find((entry) => (
    entry.localName === calleeName
    && entry.sourcePath
    && entry.kind !== 'namespace'
  ));
  if (importedBinding?.sourcePath) {
    const importedDefinitions = getDefinitionsForFile(db, importedBinding.sourcePath);
    const importedName = importedBinding.importedName === 'default'
      ? importedBinding.localName ?? calleeName
      : importedBinding.importedName;
    const importedDefinition = findDefinitionByName(importedDefinitions, importedName, null, ['function', 'type']);
    if (importedDefinition) {
      return importedDefinition;
    }
  }

  return findDefinitionByName(currentFileDefinitions, calleeName, null, ['function', 'type']);
}

function findDefinitionByName(
  definitions: IndexedDefinition[],
  leaf: string,
  parentType: string | null,
  preference: Array<'function' | 'type'>,
): IndexedDefinition | null {
  const candidates = definitions.filter((definition) => (
    definition.leaf === leaf
    && definition.parentTypeName === parentType
  ));

  if (candidates.length === 0) {
    return null;
  }

  for (const preferred of preference) {
    const match = candidates.find((candidate) => (
      preferred === 'function' ? candidate.isFunctionLike : candidate.isTypeLike
    ));
    if (match) {
      return match;
    }
  }

  return candidates[0] ?? null;
}

function hasUniqueLeafDefinition(
  db: ScipDatabase,
  leaf: string,
  symbolId: number,
): boolean {
  const rows = db.all<{ id: number; symbol: string }>(
    `SELECT id, symbol
     FROM global_symbols
     WHERE symbol LIKE ?
     LIMIT 50`,
    `%${leaf}%`,
  );

  let count = 0;
  for (const row of rows) {
    if (leafName(row.symbol) !== leaf) continue;
    count++;
    if (count > 1 && row.id !== symbolId) {
      return false;
    }
  }

  return count === 1;
}

function parentTypeName(rawSymbol: string): string | null {
  const parsed = parseSymbol(rawSymbol);
  if ('kind' in parsed) {
    return null;
  }

  for (let index = parsed.descriptors.length - 2; index >= 0; index--) {
    const descriptor = parsed.descriptors[index];
    if (descriptor?.suffix === 'type') {
      return descriptor.name;
    }
  }

  return null;
}

function isPythonDocument(
  db: ScipDatabase,
  relativePath: string,
): boolean {
  const row = db.get<{ language: string | null }>(
    `SELECT language FROM documents WHERE relative_path = ? LIMIT 1`,
    relativePath,
  );

  return row?.language === 'python' || relativePath.endsWith('.py') || relativePath.endsWith('.pyi');
}

function isJavaScriptDocument(
  db: ScipDatabase,
  relativePath: string,
): boolean {
  const row = db.get<{ language: string | null }>(
    `SELECT language FROM documents WHERE relative_path = ? LIMIT 1`,
    relativePath,
  );

  return row?.language === 'typescript'
    || row?.language === 'javascript'
    || /\.(?:[cm]?[jt]sx?)$/.test(relativePath);
}

function applyLimit<T>(
  values: T[],
  limit?: number,
): T[] {
  return typeof limit === 'number' ? values.slice(0, limit) : values;
}

function resolveDocumentCandidates(
  db: ScipDatabase,
  filePattern: string,
  opts: { allowMultiple: boolean },
): DocumentPathCandidate[] {
  const normalizedPattern = normalizeLookupPath(filePattern);
  if (!normalizedPattern) {
    return [];
  }

  const rows = db.all<{ relative_path: string }>(
    `SELECT relative_path
     FROM documents
     WHERE 1 = 1
       ${db.pathExclusionsFor('documents')}
     ORDER BY relative_path`,
  );

  const scored = rows
    .filter((row) => !db.isIgnored(row.relative_path))
    .map((row) => ({
      relativePath: row.relative_path,
      score: scoreDocumentPath(row.relative_path, normalizedPattern),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));

  if (scored.length === 0) {
    return [];
  }

  const exactish = scored.filter((row) => row.score >= 800);
  if (exactish.length > 0) {
    return opts.allowMultiple ? exactish : [exactish[0]!];
  }

  return opts.allowMultiple ? scored : [scored[0]!];
}

function scoreDocumentPath(
  relativePath: string,
  rawPattern: string,
): number {
  const normalizedPath = normalizeLookupPath(relativePath);
  const pathBase = basename(normalizedPath);
  const patternBase = basename(rawPattern);

  let score = 0;
  if (normalizedPath === rawPattern) score += 1200;
  if (normalizedPath.endsWith(`/${rawPattern}`)) score += 1100;
  if (pathBase === patternBase) score += 900;
  if (normalizedPath.startsWith(`${rawPattern}/`)) score += 850;
  if (normalizedPath.includes(rawPattern)) score += 250;

  return score;
}

function normalizeLookupPath(filePattern: string): string {
  return filePattern
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function uniquePatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns)];
}
