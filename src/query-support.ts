/**
 * query-support — shared helpers for command queries.
 *
 * Where to get what:
 *
 *   Symbol ranges (for output OR as bounds):
 *     - Per file:   getDefinitionsForFile(db, relativePath)
 *     - Project:    getAllDefinitions(db, { scope? })
 *     - User input: findFirstSymbolMatch(db, pattern)
 *   All three return source-corrected ranges. Do NOT read
 *   defn_enclosing_ranges.start_line/end_line directly if the result
 *   will be shown to a user or used to bound a mention lookup.
 *
 *   Reference lines (where is this used?):
 *     - Primary:    getSourceReferenceSites — cross-file identifier
 *                   scan; returns [] when the leaf name is ambiguous.
 *     - Fallback:   getResolvedReferenceSites — mention-resolved
 *                   chunks with in-chunk line refinement. Always
 *                   returns a result when the symbol has mentions.
 *   Do NOT read chunks.start_line as the "line of a reference";
 *   a chunk spans many source lines.
 *
 *   Enclosing symbol at a line:
 *     - Use findEnclosingDefinition(definitions, line) with a
 *       getDefinitionsForFile result. This matches what
 *       getSourceReferenceSites and getResolvedReferenceSites use
 *       internally, so attribution stays consistent across commands.
 *
 *   Counts and existence checks only:
 *     - Direct SQL on mentions/chunks is fine here — e.g., "how many
 *       files reference this symbol" in fan.ts. Never use chunk
 *       start_line as a line number in output.
 */
import type { ScipDatabase } from './db.js';
import { basename } from 'node:path';
import { findIdentifierLines, getSourceCalls, getSourceConstructorBindings, getSourceImports, getSourceText } from './source-analysis.js';
import type { ParsedSourceCall } from './source-analysis.js';
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

export interface IndexedDefinition extends SymbolMatch {
  leaf: string;
  parentTypeName: string | null;
  isFunctionLike: boolean;
  isTypeLike: boolean;
  kind: number | null;
  documentation: string | null;
  enclosingSymbol: string | null;
}

interface SymbolQueryRow {
  id: number;
  symbol: string;
  document_id: number;
  start_line: number;
  end_line: number;
  relative_path: string;
  display_name?: string | null;
  kind?: number | null;
  documentation?: string | null;
  enclosing_symbol?: string | null;
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
  const indexedFiles = new Set<string>(
    db.all<{ relative_path: string }>(
      `SELECT relative_path
       FROM documents
       WHERE 1 = 1
         ${db.pathExclusionsFor('documents')}
       ORDER BY relative_path`,
    )
      .map((row) => row.relative_path)
      .filter((relativePath) => !db.isIgnored(relativePath)),
  );

  const addEdge = (fromFile: string, toFile: string): void => {
    if (fromFile === toFile) return;
    if (db.isIgnored(fromFile) || db.isIgnored(toFile)) return;
    if (!indexedFiles.has(toFile)) return;
    if (!graph.has(fromFile)) graph.set(fromFile, new Set());
    graph.get(fromFile)!.add(toFile);
  };

  for (const edge of edges) {
    addEdge(edge.from_file, edge.to_file);
  }

  for (const relativePath of indexedFiles) {
    if (scope && !relativePath.includes(scope)) continue;

    for (const entry of getSourceImports(db, relativePath)) {
      if (!entry.sourcePath) continue;
      addEdge(relativePath, entry.sourcePath);
    }
  }

  return graph;
}

export function findFirstSymbolMatch(
  db: ScipDatabase,
  symbolPattern: string,
): SymbolMatch | null {
  const exact = findExactSymbolMatch(db, symbolPattern.trim());
  if (exact) {
    return exact;
  }

  // Handle file:line-line syntax (e.g., "src/foo.ts:10-50").
  // User-supplied lines are editor-1-indexed; DB is 0-indexed.
  const fileLineMatch = symbolPattern.match(/^(.+):(\d+)-(\d+)$/);
  if (fileLineMatch) {
    const [, filePath, startStr, endStr] = fileLineMatch;
    const userStart0 = Math.max(0, parseInt(startStr!, 10) - 1);
    const userEnd0 = Math.max(userStart0, parseInt(endStr!, 10) - 1);
    let row = db.get<SymbolQueryRow>(
      `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.end_line, d.relative_path
      FROM global_symbols gs
      JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
      JOIN documents d ON der.document_id = d.id
      WHERE d.relative_path LIKE ?
        AND der.start_line <= ? AND der.end_line >= ?
        ${db.pathExclusionsFor('d')}
      ORDER BY (der.end_line - der.start_line) ASC
        LIMIT 1`,
      `%${filePath}%`, userStart0, userEnd0,
    );
    if (!row) {
      row = db.get<SymbolQueryRow>(
        `SELECT gs.id, gs.symbol, c.document_id, MIN(c.start_line) AS start_line, MAX(c.end_line) AS end_line, d.relative_path
         FROM global_symbols gs
         JOIN mentions m ON m.symbol_id = gs.id
         JOIN chunks c ON m.chunk_id = c.id
         JOIN documents d ON c.document_id = d.id
         WHERE m.role = 1
           AND d.relative_path LIKE ?
           AND c.start_line <= ? AND c.end_line >= ?
           ${db.pathExclusionsFor('d')}
         GROUP BY gs.id, gs.symbol, c.document_id, d.relative_path
         ORDER BY (MAX(c.end_line) - MIN(c.start_line)) ASC
         LIMIT 1`,
        `%${filePath}%`, userStart0, userEnd0,
      );
    }
    if (row && !db.isIgnored(row.relative_path)) {
      return hydrateSymbolMatch(db, row);
    }
  }

  const cleaned = normalizeLookupPattern(symbolPattern);
  const tokens = lookupTokens(symbolPattern);
  const candidates = getSymbolLookupCandidates(db, tokens);
  const direct = findDirectSymbolCandidate(candidates, symbolPattern, cleaned);
  if (direct && !db.isIgnored(direct.relative_path)) {
    return hydrateSymbolMatch(db, direct);
  }

  let best: {
    row: SymbolQueryRow;
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
    return hydrateSymbolMatch(db, best.row);
  }

  return null;
}

export function findExactSymbolMatch(
  db: ScipDatabase,
  symbol: string,
): SymbolMatch | null {
  const row = db.get<SymbolQueryRow>(
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

  return hydrateSymbolMatch(db, row);
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
): SymbolQueryRow[] {
  const tokenClauses = tokens.map(
    () => `(gs.symbol LIKE ? OR d.relative_path LIKE ? OR COALESCE(gs.display_name, '') LIKE ?)`,
  );
  const params = tokens.flatMap((token) => {
    const like = `%${token}%`;
    return [like, like, like];
  });

  const primary = db.all<SymbolQueryRow>(
    `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.end_line, d.relative_path, gs.display_name
     FROM global_symbols gs
     JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
     JOIN documents d ON der.document_id = d.id
     WHERE ${tokenClauses.join('\n       AND ')}
       ${db.pathExclusionsFor('d')}
      LIMIT 200`,
      ...params,
    );
  if (primary.length > 0) {
    return primary;
  }

  return db.all<SymbolQueryRow>(
    `SELECT
      gs.id,
      gs.symbol,
      c.document_id,
      MIN(c.start_line) AS start_line,
      MAX(c.end_line) AS end_line,
      d.relative_path,
      gs.display_name
     FROM global_symbols gs
     JOIN mentions m ON m.symbol_id = gs.id
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.role = 1
       AND ${tokenClauses.join('\n       AND ')}
       ${db.pathExclusionsFor('d')}
     GROUP BY gs.id, gs.symbol, c.document_id, d.relative_path, gs.display_name
     LIMIT 200`,
    ...params,
  );
}

function scoreSymbolCandidate(
  row: SymbolQueryRow,
  originalPattern: string,
  cleanedPattern: string,
  tokens: string[],
): number {
  const originalCase = originalPattern.trim();
  const cleanedCase = cleanedPattern;
  const noParensCase = cleanedCase.replace(/\(\)$/, '');
  const original = originalPattern.toLowerCase();
  const cleaned = cleanedPattern.toLowerCase();
  const noParens = cleaned.replace(/\(\)$/, '');
  const rawCase = row.symbol;
  const shortCase = shortenSymbol(row.symbol);
  const leafCase = leafName(row.symbol);
  const displayCase = row.display_name ?? '';
  const raw = row.symbol.toLowerCase();
  const short = shortCase.toLowerCase();
  const leaf = leafCase.toLowerCase();
  const display = displayCase.toLowerCase();
  const path = row.relative_path.toLowerCase();
  const looksPathLike = /[/:.]/.test(cleanedPattern);

  let score = 0;

  if (rawCase === originalCase || rawCase === cleanedCase) score += 1150;
  if (shortCase === originalCase || shortCase === cleanedCase) score += 1100;
  if (displayCase === noParensCase) score += 980;
  if (leafCase === noParensCase) score += 960;
  if (`${leafCase}()` === originalCase || `${leafCase}()` === cleanedCase) score += 955;
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
  const mentions = db.all<{
    symbol_id: number;
    chunk_id: number;
  }>(
    `SELECT DISTINCT m.symbol_id, c.id AS chunk_id
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     WHERE c.document_id = ?
       AND c.start_line >= ?
       AND c.end_line <= ?
       AND m.role != 1
       AND m.symbol_id != ?
     ${opts.limit ? 'LIMIT ?' : ''}`,
    ...calleeQueryParams(symbol, opts.limit),
  );

  const primary: CalleeRow[] = [];
  const directSeen = new Set<string>();
  for (const mention of mentions) {
    const callee = getFullSymbolMatch(db, {
      symbolId: mention.symbol_id,
      documentId: symbol.documentId,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
    });
    if (!callee || db.isIgnored(callee.relativePath)) continue;

    const key = `${callee.symbol}|${callee.relativePath}|${mention.chunk_id}`;
    if (directSeen.has(key)) continue;
    directSeen.add(key);
    primary.push({
      symbol: callee.symbol,
      file: callee.relativePath,
      chunkId: mention.chunk_id,
    });
  }

  const sourceFallback = getSourceBackedCalleeRows(db, symbol, opts.limit);
  if (sourceFallback.length > 0) {
    return applyLimit(sourceFallback, opts.limit);
  }
  return primary;
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
    caller_file: string;
    line: number;
  }>(
    `SELECT DISTINCT ref_d.relative_path AS caller_file, c.start_line AS line
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents ref_d ON c.document_id = ref_d.id
     WHERE m.symbol_id = ?
       AND m.role != 1
       ${db.pathExclusionsFor('ref_d')}
     ORDER BY ref_d.relative_path
     ${opts.limit ? 'LIMIT ?' : ''}`,
    ...referenceQueryParams(match, opts.limit),
  )
    .filter((row) => !db.isIgnored(row.caller_file))
    .flatMap((row) => {
      const enclosing = findEnclosingDefinition(getDefinitionsForFile(db, row.caller_file), row.line);
      if (!enclosing || enclosing.symbolId === match.symbolId) {
        return [];
      }

      return [{
        symbol: enclosing.symbol,
        file: row.caller_file,
      }];
    });

  const sourceFallback = dedupeCallerRows([
    ...getPythonSourceCallerRows(db, match, opts.limit),
    ...getGenericSourceCallerRows(db, match, opts.limit),
  ]);
  if (sourceFallback.length === 0) {
    return dedupeCallerRows(primary);
  }

  const merged = [...sourceFallback];
  const fallbackFiles = new Set(sourceFallback.map((row) => row.file));
  const seen = new Set(merged.map((row) => `${row.symbol}|${row.file}`));
  for (const row of primary) {
    if (fallbackFiles.has(row.file)) continue;
    const key = `${row.symbol}|${row.file}`;
    if (seen.has(key)) continue;
    if (isFunctionLikeSymbol(row.symbol) || merged.length === 0) {
      seen.add(key);
      merged.push(row);
    }
  }

  return applyLimit(merged, opts.limit);
}

function getGenericSourceCallerRows(
  db: ScipDatabase,
  symbol: SymbolMatch,
  limit?: number,
): CallerRow[] {
  return applyLimit(
    getSourceReferenceSites(db, symbol)
      .filter((site) => site.enclosingSymbol && site.enclosingSymbol !== symbol.symbol)
      .map((site) => ({
        symbol: site.enclosingSymbol!,
        file: site.file,
      })),
    limit,
  );
}

function dedupeCallerRows(
  rows: CallerRow[],
): CallerRow[] {
  const seen = new Set<string>();
  const unique: CallerRow[] = [];
  for (const row of rows) {
    const key = `${row.symbol}|${row.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
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
    const definitions = getDefinitionsForFile(db, document.relative_path);

    for (const line of lines) {
      const enclosing = findEnclosingDefinition(definitions, line);

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

/**
 * Precision-upgraded fallback for callers/references when
 * `getSourceReferenceSites` bails out (leaf name is shared across symbols,
 * or the unique-leaf check doesn't apply). Starts from SCIP's authoritative
 * mention table (role != 1) so resolution is correct, then refines each
 * chunk's coarse `start_line` by source-scanning for the symbol's leaf
 * name within the chunk range. Falls back to chunk start when the leaf
 * name is unavailable or the scan finds nothing.
 *
 * Use this instead of raw `c.start_line` for any query that reports where
 * references occur.
 */
export function getResolvedReferenceSites(
  db: ScipDatabase,
  symbol: SymbolLocation,
): ReferenceSite[] {
  const match = getFullSymbolMatch(db, symbol);
  if (!match) {
    return [];
  }

  const rows = db.all<{
    relative_path: string;
    start_line: number;
    end_line: number;
  }>(
    `SELECT DISTINCT d.relative_path, c.start_line, c.end_line
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.symbol_id = ?
       AND m.role != 1
       ${db.pathExclusionsFor('d')}
     ORDER BY d.relative_path, c.start_line`,
    match.symbolId,
  );

  const chunksByFile = new Map<string, Array<{ start_line: number; end_line: number }>>();
  for (const row of rows) {
    if (db.isIgnored(row.relative_path)) continue;
    let bucket = chunksByFile.get(row.relative_path);
    if (!bucket) {
      bucket = [];
      chunksByFile.set(row.relative_path, bucket);
    }
    bucket.push({ start_line: row.start_line, end_line: row.end_line });
  }

  const identifier = leafName(match.symbol);
  const sites: ReferenceSite[] = [];
  const seen = new Set<string>();

  for (const [file, chunks] of chunksByFile) {
    const definitions = getDefinitionsForFile(db, file);
    const excludeOpts = file === match.relativePath
      ? { excludeStartLine: match.startLine, excludeEndLine: match.endLine }
      : {};

    const allHits = identifier
      ? findIdentifierLines(db, file, identifier, excludeOpts)
      : [];

    for (const chunk of chunks) {
      const hitsInChunk = allHits.filter(
        (line) => line >= chunk.start_line && line <= chunk.end_line,
      );
      const lines = hitsInChunk.length > 0 ? hitsInChunk : [chunk.start_line];

      for (const line of lines) {
        const enclosing = findEnclosingDefinition(definitions, line);
        const key = `${file}|${line}|${enclosing?.symbol ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sites.push({
          file,
          line,
          enclosingSymbol: enclosing?.symbol ?? null,
        });
      }
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

function referenceQueryParams(
  symbol: SymbolLocation,
  limit?: number,
): number[] {
  const params = [symbol.symbolId];
  if (typeof limit === 'number') {
    params.push(limit);
  }
  return params;
}

export function findEnclosingDefinition(
  definitions: IndexedDefinition[],
  line: number,
): IndexedDefinition | null {
  let best: IndexedDefinition | null = null;

  for (const definition of definitions) {
    if (definition.startLine > line || definition.endLine < line) continue;
    if (!best || (definition.endLine - definition.startLine) < (best.endLine - best.startLine)) {
      best = definition;
    }
  }

  return best;
}

// ── Language callee config dispatch ──────────────────────────

type ComplexCallResolver = (
  db: ScipDatabase,
  current: IndexedDefinition,
  currentFileDefinitions: IndexedDefinition[],
  imports: ReturnType<typeof getSourceImports>,
  constructorBindings: Map<string, string>,
  receiverName: string | null,
  calleeName: string,
) => IndexedDefinition | null;

interface ComplexCalleeConfig {
  readonly kind: 'complex';
  readonly languageIndex: number;
  readonly resolver: ComplexCallResolver;
}

interface SimpleCalleeConfig {
  readonly kind: 'simple';
  readonly languageIndex: number;
  readonly parseBindings: ((db: ScipDatabase, source: string) => Map<string, string>) | null;
  readonly sourceCallOpts?: { allowInstanceVariables?: boolean; allowBareMemberCalls?: boolean };
  readonly dualAttempt?: {
    readonly baseOpts: { allowInstanceVariables?: boolean };
    readonly extendedOpts: { allowInstanceVariables?: boolean; allowBareMemberCalls?: boolean };
  };
}

type LanguageCalleeConfig = ComplexCalleeConfig | SimpleCalleeConfig;

const LANGUAGE_CALLEE_CONFIGS: readonly LanguageCalleeConfig[] = [
  // Python (index 0) — complex resolver
  { kind: 'complex', languageIndex: 0, resolver: resolvePythonCallTarget },
  // JavaScript/TypeScript (index 1) — complex resolver
  { kind: 'complex', languageIndex: 1, resolver: resolveJavaScriptCallTarget },
  // Java (index 2) — simple with field bindings
  { kind: 'simple', languageIndex: 2, parseBindings: (_db, source) => parseJavaFieldBindings(source) },
  // Kotlin (index 3) — simple with field bindings
  { kind: 'simple', languageIndex: 3, parseBindings: (_db, source) => parseKotlinFieldBindings(source) },
  // Scala (index 4) — simple, no bindings
  { kind: 'simple', languageIndex: 4, parseBindings: null },
  // C# (index 5) — simple, no bindings
  { kind: 'simple', languageIndex: 5, parseBindings: null },
  // Visual Basic (index 6) — simple, no bindings
  { kind: 'simple', languageIndex: 6, parseBindings: null },
  // C++ (index 7) — simple with receiver bindings
  { kind: 'simple', languageIndex: 7, parseBindings: (_db, source) => parseCppReceiverBindings(source) },
  // Rust (index 8) — simple, no bindings
  { kind: 'simple', languageIndex: 8, parseBindings: null },
  // Ruby (index 9) — simple with dual-attempt logic
  {
    kind: 'simple',
    languageIndex: 9,
    parseBindings: (db, source) => parseRubyReceiverBindings(db, source),
    dualAttempt: {
      baseOpts: { allowInstanceVariables: true },
      extendedOpts: { allowInstanceVariables: true, allowBareMemberCalls: true },
    },
  },
  // Dart (index 10) — simple, no bindings
  { kind: 'simple', languageIndex: 10, parseBindings: null },
  // PHP (index 11) — simple, no bindings
  { kind: 'simple', languageIndex: 11, parseBindings: null },
];

function getComplexSourceCalleeRows(
  db: ScipDatabase,
  match: SymbolMatch,
  config: ComplexCalleeConfig,
  limit?: number,
): CalleeRow[] {
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
    const resolved = config.resolver(
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

function getSimpleLanguageCalleeRows(
  db: ScipDatabase,
  match: SymbolMatch,
  config: SimpleCalleeConfig,
  limit?: number,
): CalleeRow[] {
  let calls: ParsedSourceCall[];
  if (config.dualAttempt) {
    const baseCalls = getSimpleSourceCalls(db, match.relativePath, match.startLine, match.endLine, config.dualAttempt.baseOpts);
    const extendedCalls = getSimpleSourceCalls(db, match.relativePath, match.startLine, match.endLine, config.dualAttempt.extendedOpts);
    calls = extendedCalls.length > 0 ? extendedCalls : baseCalls;
  } else {
    calls = getSimpleSourceCalls(db, match.relativePath, match.startLine, match.endLine, config.sourceCallOpts);
  }

  const bindings = config.parseBindings
    ? config.parseBindings(db, getSourceText(db, match.relativePath))
    : new Map<string, string>();

  return resolveSimpleSourceCallees(db, match, calls, bindings, limit);
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

  for (const config of LANGUAGE_CALLEE_CONFIGS) {
    if (!isDocumentLanguage(db, match.relativePath, DOCUMENT_LANGUAGE_TABLE[config.languageIndex]!)) {
      continue;
    }

    if (config.kind === 'complex') {
      return getComplexSourceCalleeRows(db, match, config, limit);
    }

    return getSimpleLanguageCalleeRows(db, match, config, limit);
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

  const pythonConfig = LANGUAGE_CALLEE_CONFIGS[0] as ComplexCalleeConfig;
  for (const candidate of getAllFunctionLikeDefinitions(db)) {
    if (candidate.symbolId === target.symbolId) continue;
    if (!isDocumentLanguage(db, candidate.relativePath, DOCUMENT_LANGUAGE_TABLE[pythonConfig.languageIndex]!)) continue;
    const callees = getComplexSourceCalleeRows(db, candidate, pythonConfig);
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

function getDefinitionRowsForSymbolId(
  db: ScipDatabase,
  symbolId: number,
): SymbolQueryRow[] {
  const primary = db.all<SymbolQueryRow>(
    `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.end_line, d.relative_path, gs.display_name
     FROM global_symbols gs
     JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
     JOIN documents d ON der.document_id = d.id
     WHERE gs.id = ?
     ORDER BY der.start_line, der.end_line`,
    symbolId,
  );
  if (primary.length > 0) {
    return primary;
  }

  return db.all<SymbolQueryRow>(
    `SELECT
      gs.id,
      gs.symbol,
      c.document_id,
      MIN(c.start_line) AS start_line,
      MAX(c.end_line) AS end_line,
      d.relative_path,
      gs.display_name
     FROM global_symbols gs
     JOIN mentions m ON m.symbol_id = gs.id
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE gs.id = ?
       AND m.role = 1
       ${db.pathExclusionsFor('d')}
     GROUP BY gs.id, gs.symbol, c.document_id, d.relative_path, gs.display_name
     ORDER BY start_line, end_line`,
    symbolId,
  );
}

function getFullSymbolMatch(
  db: ScipDatabase,
  symbol: SymbolLocation,
): SymbolMatch | null {
  if ('symbol' in symbol && 'relativePath' in symbol) {
    return symbol as SymbolMatch;
  }

  const row = getDefinitionRowsForSymbolId(db, symbol.symbolId)[0];

  if (!row) {
    return null;
  }

  return hydrateSymbolMatch(db, row);
}

export function getDefinitionsForFile(
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

  const primary = db.all<SymbolQueryRow>(
    `SELECT
      gs.id,
      gs.symbol,
      der.document_id,
      der.start_line,
      der.end_line,
      d.relative_path,
      gs.display_name,
      gs.kind,
      gs.documentation,
      gs.enclosing_symbol
     FROM global_symbols gs
     JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
     JOIN documents d ON der.document_id = d.id
     WHERE d.relative_path = ?
       ${db.symbolNoiseFor('gs')}
     ORDER BY der.start_line, der.end_line`,
    relativePath,
  );

  const fallback = primary.length > 0 ? [] : db.all<SymbolQueryRow>(
    `SELECT
      gs.id,
      gs.symbol,
      c.document_id,
      MIN(c.start_line) AS start_line,
      MAX(c.end_line) AS end_line,
      d.relative_path,
      gs.display_name,
      gs.kind,
      gs.documentation,
      gs.enclosing_symbol
     FROM global_symbols gs
     JOIN mentions m ON m.symbol_id = gs.id
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE d.relative_path = ?
       AND m.role = 1
       ${db.symbolNoiseFor('gs')}
     GROUP BY gs.id, gs.symbol, c.document_id, d.relative_path
     ORDER BY start_line, end_line`,
    relativePath,
  );

  const definitions = correctDefinitionRangesFromSource(
    db,
    relativePath,
    (primary.length > 0 ? primary : fallback).map((row) => ({
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
      kind: row.kind ?? null,
      documentation: row.documentation ?? null,
      enclosingSymbol: row.enclosing_symbol ?? null,
    })),
  );

  cache.set(relativePath, definitions);
  return definitions;
}

function hydrateSymbolMatch(
  db: ScipDatabase,
  row: SymbolQueryRow,
): SymbolMatch {
  const corrected = getDefinitionsForFile(db, row.relative_path)
    .find((definition) => definition.symbolId === row.id);

  if (corrected) {
    return {
      symbolId: corrected.symbolId,
      symbol: corrected.symbol,
      documentId: corrected.documentId,
      startLine: corrected.startLine,
      endLine: corrected.endLine,
      relativePath: corrected.relativePath,
    };
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

function findDirectSymbolCandidate(
  candidates: SymbolQueryRow[],
  symbolPattern: string,
  cleanedPattern: string,
): SymbolQueryRow | null {
  const trimmed = symbolPattern.trim();
  const directMatches = candidates.filter((row) => {
    const short = shortenSymbol(row.symbol);
    const display = (row.display_name ?? '').trim();
    return row.symbol === trimmed
      || short === trimmed
      || short === cleanedPattern
      || display === trimmed
      || display === cleanedPattern
      || `${display}()` === trimmed
      || row.relative_path === trimmed;
  });

  if (directMatches.length === 0) {
    return null;
  }

  directMatches.sort((left, right) =>
    (left.end_line - left.start_line) - (right.end_line - right.start_line)
    || left.relative_path.localeCompare(right.relative_path)
    || left.symbol.localeCompare(right.symbol),
  );
  return directMatches[0] ?? null;
}

function correctDefinitionRangesFromSource(
  db: ScipDatabase,
  relativePath: string,
  definitions: IndexedDefinition[],
): IndexedDefinition[] {
  const source = getSourceText(db, relativePath);
  if (!source) {
    return definitions;
  }

  const lines = source.split(/\r?\n/);
  const correctedStarts = new Map<number, number>();
  for (const definition of definitions) {
    correctedStarts.set(
      definition.symbolId,
      resolveCallableDefinitionStartLine(lines, definition),
    );
  }

  const correctedRanges = new Map<number, { startLine: number; endLine: number }>();
  const callableDefinitions = definitions
    .filter((definition) => isCallableDefinition(definition.symbol))
    .map((definition) => ({
      definition,
      startLine: correctedStarts.get(definition.symbolId) ?? definition.startLine,
    }))
    .sort((left, right) =>
      left.startLine - right.startLine
      || left.definition.startLine - right.definition.startLine
      || left.definition.symbol.localeCompare(right.definition.symbol),
    );

  for (let index = 0; index < callableDefinitions.length; index += 1) {
    const current = callableDefinitions[index]!;
    const next = callableDefinitions[index + 1];
    const maxEndLine = next
      ? Math.max(current.startLine, next.startLine - 1)
      : lines.length - 1;

    correctedRanges.set(current.definition.symbolId, {
      startLine: current.startLine,
      endLine: resolveCallableDefinitionEndLine(
        lines,
        current.definition,
        current.startLine,
        maxEndLine,
      ),
    });
  }

  return definitions.map((definition) => {
    const corrected = correctedRanges.get(definition.symbolId);
    if (!corrected) {
      return definition;
    }

    return {
      ...definition,
      startLine: corrected.startLine,
      endLine: corrected.endLine,
    };
  });
}

function resolveCallableDefinitionStartLine(
  lines: string[],
  definition: IndexedDefinition,
): number {
  if (!isCallableDefinition(definition.symbol)) {
    return definition.startLine;
  }

  const escapedLeaf = escapeRegex(definition.leaf);
  const strongPatterns = [
    new RegExp(`\\b(?:function|def|fn)\\s+${escapedLeaf}\\b`),
    new RegExp(`\\b${escapedLeaf}\\b\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()`),
    // Method/function declaration with optional TypeScript generic
    // parameters: matches `foo(`, `foo<T>(`, `foo<T = Record<string, unknown>>(`.
    // `[^(]*` with greedy backtracking handles nested generics as long as
    // the generic block itself doesn't contain a `(`. Anchored to start of
    // line content (optional leading whitespace + optional access modifiers)
    // so it prefers the declaration line over call sites.
    new RegExp(
      `^\\s*(?:export\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|readonly\\s+|async\\s+|abstract\\s+|get\\s+|set\\s+)*${escapedLeaf}\\s*(?:<[^(]*>)?\\s*\\(`,
    ),
  ];
  const fallbackPatterns = [
    new RegExp(`\\b${escapedLeaf}\\b\\s*\\(`),
  ];

  return findNearestMatchingLine(
    lines,
    [...strongPatterns, ...fallbackPatterns],
    definition.startLine,
    definition.endLine,
  );
}

function findNearestMatchingLine(
  lines: string[],
  patterns: RegExp[],
  preferredStartLine: number,
  preferredEndLine: number,
): number {
  const windowStart = Math.max(0, preferredStartLine - 40);
  const windowEnd = Math.min(lines.length - 1, Math.max(preferredEndLine + 40, preferredStartLine + 5));

  const windowMatch = matchNearestLine(lines, patterns, preferredStartLine, windowStart, windowEnd);
  if (windowMatch !== null) {
    return windowMatch;
  }

  const fullMatch = matchNearestLine(lines, patterns, preferredStartLine, 0, lines.length - 1);
  return fullMatch ?? Math.max(0, Math.min(preferredStartLine, lines.length - 1));
}

function matchNearestLine(
  lines: string[],
  patterns: RegExp[],
  preferredLine: number,
  startLine: number,
  endLine: number,
): number | null {
  let best: { line: number; distance: number } | null = null;

  for (let lineIndex = startLine; lineIndex <= endLine; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if (!patterns.some((pattern) => pattern.test(line))) continue;

    const distance = Math.abs(lineIndex - preferredLine);
    if (!best || distance < best.distance) {
      best = { line: lineIndex, distance };
    }
  }

  return best?.line ?? null;
}

function resolveCallableDefinitionEndLine(
  lines: string[],
  definition: IndexedDefinition,
  startLine: number,
  maxEndLine: number,
): number {
  const boundedEndLine = Math.max(startLine, Math.min(lines.length - 1, maxEndLine));
  const fallbackEndLine = Math.max(startLine, Math.min(boundedEndLine, definition.endLine));

  let braceDepth = 0;
  let parenDepth = 0;
  let sawOpeningBrace = false;

  for (let lineIndex = startLine; lineIndex <= boundedEndLine; lineIndex += 1) {
    const masked = maskStructuralLine(lines[lineIndex] ?? '');
    for (const char of masked) {
      if (char === '{') {
        braceDepth += 1;
        sawOpeningBrace = true;
      } else if (char === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
      } else if (char === '(') {
        parenDepth += 1;
      } else if (char === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
      }
    }

    if (sawOpeningBrace && braceDepth === 0) {
      return lineIndex;
    }

    if (!sawOpeningBrace && parenDepth === 0 && lineIndex >= fallbackEndLine) {
      return lineIndex;
    }
  }

  return fallbackEndLine;
}

function maskStructuralLine(line: string): string {
  let masked = '';
  let quote: '"' | '\'' | '`' | null = null;
  let escaping = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    const next = line[index + 1];

    if (!quote && char === '/' && next === '/') {
      masked += ' '.repeat(line.length - index);
      break;
    }

    if (quote) {
      if (escaping) {
        escaping = false;
        masked += ' ';
        continue;
      }

      if (char === '\\') {
        escaping = true;
        masked += ' ';
        continue;
      }

      if (char === quote) {
        quote = null;
      }

      masked += ' ';
      continue;
    }

    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      masked += ' ';
      continue;
    }

    masked += char;
  }

  return masked;
}

function isCallableDefinition(symbol: string): boolean {
  return symbol.includes('().');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getAllDefinitions(
  db: ScipDatabase,
  opts: { scope?: string } = {},
): IndexedDefinition[] {
  const { scope } = opts;
  const rows = db.all<{ relative_path: string }>(
    `SELECT relative_path
     FROM documents
     WHERE 1 = 1
       ${db.pathExclusionsFor('documents')}
       ${scope ? 'AND relative_path LIKE ?' : ''}
     ORDER BY relative_path`,
    ...(scope ? [`%${scope}%`] : []),
  );

  return rows
    .filter((row) => !db.isIgnored(row.relative_path))
    .flatMap((row) => getDefinitionsForFile(db, row.relative_path));
}

export function getScopedDefinitions(
  db: ScipDatabase,
  scope?: string,
): IndexedDefinition[] {
  const scopeFilter = scope ? `AND relative_path LIKE '%${scope}%'` : '';

  return db.all<{ relative_path: string }>(
    `SELECT relative_path
     FROM documents
     WHERE 1 = 1
       ${db.pathExclusionsFor('documents')}
       ${scopeFilter}
     ORDER BY relative_path`,
  )
    .flatMap((row) => getDefinitionsForFile(db, row.relative_path))
    .filter((row) => !db.isIgnored(row.relativePath));
}

function getAllFunctionLikeDefinitions(db: ScipDatabase): IndexedDefinition[] {
  return getAllDefinitions(db)
    .filter((definition) => definition.isFunctionLike);
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

function resolveSimpleSourceCallees(
  db: ScipDatabase,
  current: SymbolMatch,
  calls: ParsedSourceCall[],
  bindings: Map<string, string>,
  limit?: number,
): CalleeRow[] {
  const currentFileDefinitions = getDefinitionsForFile(db, current.relativePath);
  const currentDefinition = currentFileDefinitions.find((definition) => definition.symbolId === current.symbolId);
  if (!currentDefinition) {
    return [];
  }

  const rows: CalleeRow[] = [];
  const seen = new Set<string>();

  for (const call of calls) {
    const resolved = resolveSimpleSourceCallTarget(
      db,
      currentDefinition,
      currentFileDefinitions,
      bindings,
      call.receiverName,
      call.calleeName,
    );
    if (!resolved || resolved.symbolId === current.symbolId || db.isIgnored(resolved.relativePath)) continue;

    const chunkId = 2_000_000_000 + call.line;
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

function resolveSimpleSourceCallTarget(
  db: ScipDatabase,
  current: IndexedDefinition,
  currentFileDefinitions: IndexedDefinition[],
  bindings: Map<string, string>,
  receiverName: string | null,
  calleeName: string,
): IndexedDefinition | null {
  if (!receiverName) {
    const localMethod = findDefinitionByName(currentFileDefinitions, calleeName, current.parentTypeName, ['function']);
    if (localMethod) {
      return localMethod;
    }
    if (current.parentTypeName) {
      return findProjectDefinitionByTypeAndLeaf(db, current.parentTypeName, calleeName);
    }
    return findDefinitionByName(currentFileDefinitions, calleeName, null, ['function', 'type']);
  }

  const normalizedReceiver = normalizeReceiverName(receiverName);
  const inferredType = bindings.get(normalizedReceiver) ?? inferTypeNameFromReceiver(db, normalizedReceiver);
  if (!inferredType) {
    return null;
  }

  return findProjectDefinitionByTypeAndLeaf(db, inferredType, calleeName);
}

function findProjectDefinitionByTypeAndLeaf(
  db: ScipDatabase,
  typeName: string,
  calleeName: string,
): IndexedDefinition | null {
  const definitions = getAllDefinitions(db)
    .filter((definition) => definition.isFunctionLike || definition.symbol.endsWith('().'));

  const exact = definitions.find((definition) => (
    definition.leaf === calleeName
    && (
      definition.parentTypeName === typeName
      || definition.symbol.includes(typeName)
    )
  ));
  if (exact) {
    return exact;
  }

  const normalizedType = normalizeLookupName(typeName);
  const normalizedMatch = definitions.find((definition) => (
    definition.leaf === calleeName
    && normalizeLookupName(definition.parentTypeName ?? '').includes(normalizedType)
  ));
  if (normalizedMatch) {
    return normalizedMatch;
  }

  return findLooseProjectDefinitionByTypeAndLeaf(db, typeName, calleeName);
}

function inferTypeNameFromReceiver(
  db: ScipDatabase,
  receiverName: string,
): string | null {
  const normalizedReceiver = normalizeLookupName(receiverName);
  if (!normalizedReceiver) {
    return null;
  }

  const candidates = getAllDefinitions(db)
    .filter((definition) => definition.isTypeLike || definition.symbol.endsWith('#'))
    .map((definition) => definition.leaf)
    .filter((leaf) => leaf.length > 0);

  let best: { name: string; score: number } | null = null;
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeLookupName(candidate);
    let score = 0;
    if (normalizedCandidate === normalizedReceiver) score += 100;
    if (normalizedCandidate.endsWith(normalizedReceiver)) score += 80;
    if (normalizedCandidate.includes(normalizedReceiver)) score += 40;
    if (normalizedReceiver.includes(normalizedCandidate)) score += 20;
    if (score > 0 && (!best || score > best.score || (score === best.score && candidate.length < best.name.length))) {
      best = { name: candidate, score };
    }
  }

  return best?.name ?? null;
}

function getSimpleSourceCalls(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
  opts: { allowInstanceVariables?: boolean; allowBareMemberCalls?: boolean } = {},
): ParsedSourceCall[] {
  const source = getSourceText(db, relativePath);
  if (!source) {
    return [];
  }

  const lines = source.split('\n');
  const scoped = lines.slice(startLine, endLine + 1);
  const calls: ParsedSourceCall[] = [];
  const seen = new Set<string>();
  const pattern = opts.allowInstanceVariables
    ? /(@?[A-Za-z_][\w]*)\s*(?:\.|::)\s*([A-Za-z_][\w!?=]*)\s*\(/g
    : /\b([A-Za-z_][\w]*)\s*(?:\.|::)\s*([A-Za-z_][\w]*)\s*\(/g;

  for (let index = 0; index < scoped.length; index++) {
    const rawLine = scoped[index] ?? '';
    for (const match of rawLine.matchAll(pattern)) {
      const receiverName = match[1];
      const calleeName = match[2];
      if (!receiverName || !calleeName) continue;
      const key = `${startLine + index}|${receiverName}|${calleeName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({
        receiverName,
        calleeName,
        line: startLine + index,
      });
    }

    if (opts.allowBareMemberCalls) {
      for (const match of rawLine.matchAll(/(@?[A-Za-z_][\w]*)\s*\.\s*([A-Za-z_][\w!?=]*)\b(?!\s*[:=])/g)) {
        const receiverName = match[1];
        const calleeName = match[2];
        if (!receiverName || !calleeName) continue;
        const key = `${startLine + index}|${receiverName}|${calleeName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        calls.push({
          receiverName,
          calleeName,
          line: startLine + index,
        });
      }
    }

    for (const match of rawLine.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)) {
      const calleeName = match[1];
      const start = match.index ?? -1;
      if (!calleeName || start < 0) continue;

      const prefix = rawLine.slice(0, start).trimEnd();
      if (
        prefix.endsWith('def')
        || prefix.endsWith('fun')
        || prefix.endsWith('fn')
        || /\b(?:class|interface|trait|module|object)\s*$/.test(prefix)
      ) {
        continue;
      }
      if (rawLine.slice(Math.max(0, start - 3), start).includes('.')) {
        continue;
      }
      calls.push({
        receiverName: null,
        calleeName,
        line: startLine + index,
      });
    }
  }

  return calls;
}

function parseJavaFieldBindings(source: string): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const match of source.matchAll(/\b(?:private|protected|public)\s+(?:final\s+)?([A-Z][A-Za-z0-9_$<>?, ]*)\s+([A-Za-z_][\w$]*)\s*;/g)) {
    const typeName = stripGenericType(match[1]);
    const localName = match[2];
    if (typeName && localName) {
      bindings.set(localName, typeName);
    }
  }
  return bindings;
}

function parseKotlinFieldBindings(source: string): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const match of source.matchAll(/\b(?:private|protected|public)?\s*(?:val|var)\s+([A-Za-z_][\w]*)\s*:\s*([A-Z][A-Za-z0-9_.<>?]*)/g)) {
    const localName = match[1];
    const typeName = stripGenericType(match[2]);
    if (typeName && localName) {
      bindings.set(localName, typeName);
    }
  }
  return bindings;
}

function parseCppReceiverBindings(source: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const constructorMatch = source.match(/RunCoordinator::RunCoordinator\s*\(([\s\S]*?)\)\s*(?::\s*([\s\S]*?))?\s*\{/);
  if (!constructorMatch) {
    return bindings;
  }

  const params = constructorMatch[1] ?? '';
  const initializers = constructorMatch[2] ?? '';
  const parameterTypes = new Map<string, string>();

  for (const param of params.split(',')) {
    const trimmed = param.trim();
    const match = trimmed.match(/(.+?)\s+([A-Za-z_][\w]*)$/);
    if (!match) continue;
    const [, rawType, rawName] = match;
    if (!rawType || !rawName) continue;
    const typeName = stripGenericType(rawType.replace(/[&*]+/g, ' ').replace(/\bconst\b/g, ' ').trim());
    if (!typeName) continue;
    parameterTypes.set(normalizeReceiverName(rawName), typeName);
  }

  for (const initializer of initializers.split(',')) {
    const trimmed = initializer.trim();
    const match = trimmed.match(/([A-Za-z_][\w]*)\s*\(\s*([A-Za-z_][\w]*)\s*\)$/);
    if (!match) continue;
    const [, fieldName, sourceName] = match;
    if (!fieldName || !sourceName) continue;
    const typeName = parameterTypes.get(normalizeReceiverName(sourceName));
    if (!typeName) continue;
    bindings.set(normalizeReceiverName(fieldName), typeName);
  }

  return bindings;
}

function parseRubyReceiverBindings(
  db: ScipDatabase,
  source: string,
): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const match of source.matchAll(/@([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w]*)/g)) {
    const ivarName = `@${match[1]}`;
    const localName = match[2];
    const typeName = inferTypeNameFromReceiver(db, localName ?? match[1] ?? '');
    if (typeName) {
      bindings.set(ivarName, typeName);
      bindings.set(match[1]!, typeName);
    }
  }
  return bindings;
}

function stripGenericType(typeName: string | undefined): string {
  return (typeName ?? '')
    .replace(/<.*$/, '')
    .replace(/^.*\./, '')
    .trim();
}

function normalizeReceiverName(receiverName: string): string {
  return receiverName
    .replace(/^@/, '')
    .replace(/^this(?:\.|->)/, '')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .trim();
}

function normalizeLookupName(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
}

function isLikelyTestPath(relativePath: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(relativePath)
    || /\.(?:spec|test)\./.test(relativePath)
    || /_test\./.test(relativePath);
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

function findLooseProjectDefinitionByTypeAndLeaf(
  db: ScipDatabase,
  typeName: string,
  calleeName: string,
): IndexedDefinition | null {
  const rows = db.all<{
    id: number;
    symbol: string;
    document_id: number;
    start_line: number;
    end_line: number;
    relative_path: string;
    kind: number | null;
    documentation: string | null;
    enclosing_symbol: string | null;
  }>(
    `SELECT
      gs.id,
      gs.symbol,
      c.document_id,
      MIN(c.start_line) AS start_line,
      MAX(c.end_line) AS end_line,
      d.relative_path,
      gs.kind,
      gs.documentation,
      gs.enclosing_symbol
     FROM global_symbols gs
     JOIN mentions m ON m.symbol_id = gs.id
     JOIN chunks c ON c.id = m.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE gs.symbol LIKE ?
       AND gs.symbol LIKE ?
       ${db.pathExclusionsFor('d')}
     GROUP BY gs.id, gs.symbol, c.document_id, d.relative_path, gs.kind, gs.documentation, gs.enclosing_symbol`,
    `%${typeName}%`,
    `%${calleeName}%`,
  );

  const normalizedType = normalizeLookupName(typeName);
  const candidates = rows
    .filter((row) => leafName(row.symbol) === calleeName)
    .filter((row) => {
      const parentType = parentTypeName(row.symbol);
      return parentType === typeName
        || row.symbol.includes(typeName)
        || normalizeLookupName(parentType ?? '').includes(normalizedType);
    })
    .sort((left, right) => {
      const leftTest = isLikelyTestPath(left.relative_path) ? 1 : 0;
      const rightTest = isLikelyTestPath(right.relative_path) ? 1 : 0;
      return leftTest - rightTest
        || left.relative_path.localeCompare(right.relative_path)
        || left.start_line - right.start_line;
    });

  const row = candidates[0];
  if (!row) {
    return null;
  }

  return {
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
    kind: row.kind,
    documentation: row.documentation,
    enclosingSymbol: row.enclosing_symbol,
  };
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

// ── Document language lookup ──────────────────────────────

interface DocumentLanguageEntry {
  readonly languages: readonly string[];
  readonly extensionPattern: RegExp;
}

const DOCUMENT_LANGUAGE_TABLE: readonly DocumentLanguageEntry[] = [
  { languages: ['python'], extensionPattern: /\.(?:py|pyi)$/ },
  { languages: ['typescript', 'javascript'], extensionPattern: /\.(?:[cm]?[jt]sx?)$/ },
  { languages: ['java'], extensionPattern: /\.java$/ },
  { languages: ['kotlin'], extensionPattern: /\.(?:kt|kts)$/ },
  { languages: ['scala'], extensionPattern: /\.scala$/ },
  { languages: ['C#'], extensionPattern: /\.cs$/ },
  { languages: ['Visual Basic'], extensionPattern: /\.vb$/ },
  { languages: ['CPP'], extensionPattern: /\.(?:cc|cpp|cxx|hpp|hh|hxx)$/ },
  { languages: ['Rust'], extensionPattern: /\.rs$/ },
  { languages: ['ruby'], extensionPattern: /\.rb$/ },
  { languages: ['Dart'], extensionPattern: /\.dart$/ },
  { languages: ['PHP'], extensionPattern: /\.php$/ },
];

function isDocumentLanguage(db: ScipDatabase, relativePath: string, entry: DocumentLanguageEntry): boolean {
  const row = db.get<{ language: string | null }>(
    `SELECT language FROM documents WHERE relative_path = ? LIMIT 1`,
    relativePath,
  );
  return entry.languages.includes(row?.language ?? '') || entry.extensionPattern.test(relativePath);
}

function isPythonDocument(db: ScipDatabase, relativePath: string): boolean { return isDocumentLanguage(db, relativePath, DOCUMENT_LANGUAGE_TABLE[0]!); }
function isJavaScriptDocument(db: ScipDatabase, relativePath: string): boolean { return isDocumentLanguage(db, relativePath, DOCUMENT_LANGUAGE_TABLE[1]!); }
function isJavaDocument(db: ScipDatabase, relativePath: string): boolean { return isDocumentLanguage(db, relativePath, DOCUMENT_LANGUAGE_TABLE[2]!); }
function isKotlinDocument(db: ScipDatabase, relativePath: string): boolean { return isDocumentLanguage(db, relativePath, DOCUMENT_LANGUAGE_TABLE[3]!); }
function isScalaDocument(db: ScipDatabase, relativePath: string): boolean { return isDocumentLanguage(db, relativePath, DOCUMENT_LANGUAGE_TABLE[4]!); }
function isCSharpDocument(db: ScipDatabase, relativePath: string): boolean { return isDocumentLanguage(db, relativePath, DOCUMENT_LANGUAGE_TABLE[5]!); }
function isVisualBasicDocument(db: ScipDatabase, relativePath: string): boolean { return isDocumentLanguage(db, relativePath, DOCUMENT_LANGUAGE_TABLE[6]!); }
function isCppDocument(db: ScipDatabase, relativePath: string): boolean { return isDocumentLanguage(db, relativePath, DOCUMENT_LANGUAGE_TABLE[7]!); }
function isRustDocument(db: ScipDatabase, relativePath: string): boolean { return isDocumentLanguage(db, relativePath, DOCUMENT_LANGUAGE_TABLE[8]!); }
function isRubyDocument(db: ScipDatabase, relativePath: string): boolean { return isDocumentLanguage(db, relativePath, DOCUMENT_LANGUAGE_TABLE[9]!); }
function isDartDocument(db: ScipDatabase, relativePath: string): boolean { return isDocumentLanguage(db, relativePath, DOCUMENT_LANGUAGE_TABLE[10]!); }
function isPhpDocument(db: ScipDatabase, relativePath: string): boolean { return isDocumentLanguage(db, relativePath, DOCUMENT_LANGUAGE_TABLE[11]!); }

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
    const symbolMatch = findFirstSymbolMatch(db, filePattern);
    if (!symbolMatch || db.isIgnored(symbolMatch.relativePath)) {
      return [];
    }

    return [{
      relativePath: symbolMatch.relativePath,
      score: 700,
    }];
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
