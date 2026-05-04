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
import { existsSync as existsSyncFs } from 'node:fs';
import { basename, isAbsolute as isAbsolutePath, join as pathJoin } from 'node:path';
import { detectAstLanguage, getCallableSites, getCallSites, type CallableSite } from './ast.js';
import { createPerDbCache, createPerDbValue } from './per-db-cache.js';
import { getSourceFiles } from './source-fileset.js';
import { findIdentifierLines, getFileIdentifiers, getIdentifiersByLine, getSourceImports, getSourceText } from './source-analysis.js';
import { isFunctionLikeSymbol, isModuleLikeSymbol, leafName, leafSuffix, parseSymbol, shortenSymbol } from './symbol-parser.js';
/**
 * Clean up the raw doc/signature string from the SCIP index. Strips fenced
 * code-block markers and the parenthesized kind prefixes (`(method)`,
 * `(property)`, etc.) that some SCIP indexers prepend.
 */
export function cleanSignature(sig: string | null): string | null {
  if (!sig || !sig.trim()) return null;
  return sig
    .replace(/^```\w*\s*/, '')
    .replace(/\s*```$/, '')
    .replace(/^\(method\)\s*/, '')
    .replace(/^\(property\)\s*/, '')
    .replace(/^\(function\)\s*/, '')
    .replace(/^\(class\)\s*/, '')
    .replace(/^\(interface\)\s*/, '')
    .replace(/^\(enum\)\s*/, '')
    .replace(/^\(type alias\)\s*/, '')
    .replace(/^\(const\)\s*/, '')
    .replace(/^\(var\)\s*/, '')
    .trim() || null;
}

/**
 * SCIP indexers store `documentation` as "docstring|signature" (pipe-delimited).
 * `extractSignature` pulls the signature half; newlines are flattened to spaces
 * so downstream one-liner rendering works. If the pipe is absent the whole
 * `documentation` string is treated as signature.
 */
export function extractSignature(doc: string | null): string | null {
  if (!doc) return null;
  const pipeIdx = doc.indexOf('|');
  if (pipeIdx === -1) return doc.replace(/\n/g, ' ');
  return doc.slice(pipeIdx + 1).replace(/\n/g, ' ');
}

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

const FILE_DEFINITION_CACHE = createPerDbCache<string, IndexedDefinition[]>('file-definitions');

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

const FILE_DEP_GRAPH_CACHE = createPerDbCache<string, Map<string, Set<string>>>('file-dep-graph');

export function buildFileDepGraph(
  db: ScipDatabase,
  scope?: string,
): Map<string, Set<string>> {
  return FILE_DEP_GRAPH_CACHE.get(db, scope ?? '', () => {
    const scopeFilter = scope ? `AND d1.relative_path LIKE '%${scope}%'` : '';

    const edges = db.all<{ from_file: string; to_file: string }>(
      `SELECT DISTINCT
        d1.relative_path AS from_file,
        d2.relative_path AS to_file
      FROM mentions m
      JOIN chunks c ON m.chunk_id = c.id
      JOIN documents d1 ON c.document_id = d1.id
      JOIN global_symbols gs ON m.symbol_id = gs.id
      JOIN (
        SELECT m2.symbol_id, c2.document_id
        FROM mentions m2
        JOIN chunks c2 ON m2.chunk_id = c2.id
        WHERE m2.role = 1
        GROUP BY m2.symbol_id
      ) sym_def ON sym_def.symbol_id = gs.id
      JOIN documents d2 ON sym_def.document_id = d2.id
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

    for (const edge of edges) addEdge(edge.from_file, edge.to_file);

    for (const relativePath of indexedFiles) {
      if (scope && !relativePath.includes(scope)) continue;
      for (const entry of getSourceImports(db, relativePath)) {
        if (!entry.sourcePath) continue;
        addEdge(relativePath, entry.sourcePath);
      }
    }

    return graph;
  });
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
  const primary = db.get<SymbolQueryRow>(
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

  const row = primary ?? db.get<SymbolQueryRow>(
    `SELECT
      gs.id,
      gs.symbol,
      c.document_id,
      MIN(c.start_line) AS start_line,
      MAX(c.end_line) AS end_line,
      d.relative_path
     FROM global_symbols gs
     JOIN mentions m ON m.symbol_id = gs.id
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE gs.symbol = ?
       AND m.role = 1
       ${db.pathExclusionsFor('d')}
     GROUP BY gs.id, gs.symbol, c.document_id, d.relative_path
     ORDER BY d.relative_path, start_line
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
  const indexed = resolveDocumentCandidates(db, filePattern, { allowMultiple: false })[0]?.relativePath;
  if (indexed) return indexed;

  // Fallback for file types the SCIP indexers don't include (Vue SFCs in
  // particular — scip-typescript doesn't recognize the `.vue` extension).
  // Source-text-based queries like `imports` / `unused-imports` still work
  // for these files because their parsers go through `getSourceImports`,
  // which reads from disk; we just need to give them a real relative path.
  return resolveOnDiskFile(db, filePattern);
}

function resolveOnDiskFile(db: ScipDatabase, filePattern: string): string | null {
  if (!filePattern) return null;
  const normalized = filePattern.replace(/\\/g, '/').replace(/^\.\//, '');
  // Try exact-relative-to-project resolution first.
  const rel = isAbsolutePath(normalized) && normalized.startsWith(db.config.projectRoot)
    ? normalized.slice(db.config.projectRoot.length).replace(/^\/+/, '')
    : normalized;
  const abs = pathJoin(db.config.projectRoot, rel);
  return existsSyncFs(abs) ? rel : null;
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
  // Delegates to the shared bulk path so callers automatically benefit from
  // tree-sitter call attribution, source-confirmation, and the merged AST +
  // SCIP results. Avoids the older per-symbol mention-scan that under-
  // attributed for AST-supported languages and missed call/callee shape
  // refinements that the bulk helper already handles.
  const map = buildCalleeMap(db, [symbol]);
  const callees = map.get(symbol.symbolId) ?? [];
  return applyLimit(callees, opts.limit);
}

export function getCallerRowsForSymbol(
  db: ScipDatabase,
  symbol: SymbolLocation,
  opts: { limit?: number } = {},
): CallerRow[] {
  // Delegates to the cached inverse-callee map (built from buildCalleeMap of
  // all definitions). One inversion per process gives every per-symbol
  // caller query AST-quality attribution + SCIP fallback in O(1) lookup.
  const inverse = buildCallerRowsMap(db);
  const callers = inverse.get(symbol.symbolId) ?? [];
  return applyLimit(callers, opts.limit);
}

const CALLER_ROWS_CACHE = createPerDbValue<Map<number, CallerRow[]>>('caller-rows');

/**
 * Inverse of buildCalleeMap: for every (caller, callee) edge, register the
 * caller's symbol + file under the callee's symbolId. Cached so the entire
 * inversion happens once per ScipDatabase instance.
 */
function buildCallerRowsMap(db: ScipDatabase): Map<number, CallerRow[]> {
  return CALLER_ROWS_CACHE.get(db, () => {
    const allDefs = getAllDefinitions(db);
    const calleeMap = buildCalleeMap(db, allDefs);

    const symbolToId = new Map<string, number>();
    for (const def of allDefs) symbolToId.set(def.symbol, def.symbolId);

    const result = new Map<number, CallerRow[]>();
    const seen = new Map<number, Set<string>>();
    for (const callerDef of allDefs) {
      const callees = calleeMap.get(callerDef.symbolId);
      if (!callees || callees.length === 0) continue;
      for (const callee of callees) {
        const calleeId = symbolToId.get(callee.symbol);
        if (calleeId === undefined) continue;
        if (calleeId === callerDef.symbolId) continue; // skip self-recursion
        let bucket = result.get(calleeId);
        if (!bucket) {
          bucket = [];
          result.set(calleeId, bucket);
          seen.set(calleeId, new Set());
        }
        const dedupeKey = `${callerDef.symbol}|${callerDef.relativePath}`;
        if (seen.get(calleeId)!.has(dedupeKey)) continue;
        seen.get(calleeId)!.add(dedupeKey);
        bucket.push({ symbol: callerDef.symbol, file: callerDef.relativePath });
      }
    }

    return result;
  });
}

export function getSourceReferenceSites(
  db: ScipDatabase,
  symbol: SymbolLocation,
): ReferenceSite[] {
  const prelude = resolveReferencePrelude(db, symbol);
  if (!prelude) return [];
  const { match, identifier } = prelude;
  if (!identifier) return [];

  // If the leaf identifier is uniquely defined in the index, ANY textual hit
  // of it must refer to this symbol — fast path, scan every file.
  if (hasUniqueLeafDefinition(db, identifier, match.symbolId)) {
    return buildReferenceSites(db, sourceCandidateLines(db, match, identifier));
  }

  // Otherwise the leaf is shared by 2+ definitions (a frontend `listInventoryItems`
  // and a backend twin, for instance). We can still find references precisely
  // by following each candidate file's imports: a textual hit only counts if
  // the file imports `identifier` from a path that resolves back to *this*
  // symbol's defining file.
  return buildReferenceSites(db, importAttributedCandidateLines(db, match, identifier));
}

function sourceCandidateLines(
  db: ScipDatabase,
  match: { relativePath: string; startLine: number; endLine: number },
  identifier: string,
): Map<string, number[]> {
  const allFiles = getSourceFiles(db);

  const fileLines = new Map<string, number[]>();
  for (const file of allFiles) {
    const lines = findIdentifierLines(
      db,
      file,
      identifier,
      file === match.relativePath
        ? { excludeStartLine: match.startLine, excludeEndLine: match.endLine }
        : {},
    );
    if (lines.length > 0) fileLines.set(file, lines);
  }
  return fileLines;
}

/**
 * When a leaf identifier has multiple global definitions, attribute textual
 * hits to the right one by following each candidate file's imports. A file
 * counts as a referrer of `match` only if it imports `identifier` from a path
 * that resolves to `match.relativePath` (or to a re-exporting barrel that
 * resolves there). This is what disambiguates a frontend `listInventoryItems`
 * from a backend twin: Vue files import the frontend version, never the
 * backend one.
 */
function importAttributedCandidateLines(
  db: ScipDatabase,
  match: { relativePath: string; startLine: number; endLine: number },
  identifier: string,
): Map<string, number[]> {
  const allFiles = getSourceFiles(db);
  const targetFile = match.relativePath;

  const fileLines = new Map<string, number[]>();
  for (const file of allFiles) {
    let isReferrer = file === targetFile;
    if (!isReferrer) {
      // Cheap source-text gate: if the identifier doesn't appear in the
      // raw text, skip the import-list walk entirely.
      const source = getSourceText(db, file);
      if (!source || source.indexOf(identifier) === -1) continue;

      for (const entry of getSourceImports(db, file)) {
        const matchesName = entry.localName === identifier
          || entry.importedName === identifier
          || (entry.kind === 'namespace' && entry.usedMembers.includes(identifier));
        if (!matchesName) continue;
        if (entry.sourcePath && pathsResolveSame(entry.sourcePath, targetFile)) {
          isReferrer = true;
          break;
        }
      }
    }
    if (!isReferrer) continue;

    const lines = findIdentifierLines(
      db,
      file,
      identifier,
      file === targetFile
        ? { excludeStartLine: match.startLine, excludeEndLine: match.endLine }
        : {},
    );
    if (lines.length > 0) fileLines.set(file, lines);
  }
  return fileLines;
}

function pathsResolveSame(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
  return norm(a) === norm(b);
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
  const prelude = resolveReferencePrelude(db, symbol);
  if (!prelude) return [];
  return buildReferenceSites(db, resolvedCandidateLines(db, prelude.match, prelude.identifier));
}

function resolvedCandidateLines(
  db: ScipDatabase,
  match: { symbolId: number; relativePath: string; startLine: number; endLine: number },
  identifier: string | null,
): Map<string, number[]> {
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

  const fileLines = new Map<string, number[]>();
  for (const [file, chunks] of chunksByFile) {
    const excludeOpts = file === match.relativePath
      ? { excludeStartLine: match.startLine, excludeEndLine: match.endLine }
      : {};
    const allHits = identifier
      ? findIdentifierLines(db, file, identifier, excludeOpts)
      : [];

    const lines: number[] = [];
    for (const chunk of chunks) {
      const hitsInChunk = allHits.filter((line) => line >= chunk.start_line && line <= chunk.end_line);
      const chosen = hitsInChunk.length > 0 ? hitsInChunk : [chunk.start_line];
      for (const l of chosen) lines.push(l);
    }
    fileLines.set(file, lines);
  }
  return fileLines;
}

interface ReferencePrelude {
  match: NonNullable<ReturnType<typeof getFullSymbolMatch>>;
  identifier: string | null;
}

function resolveReferencePrelude(
  db: ScipDatabase,
  symbol: SymbolLocation,
): ReferencePrelude | null {
  const match = getFullSymbolMatch(db, symbol);
  if (!match) return null;
  return { match, identifier: leafName(match.symbol) || null };
}

function buildReferenceSites(
  db: ScipDatabase,
  perFileLines: Map<string, number[]>,
): ReferenceSite[] {
  const sites: ReferenceSite[] = [];
  const seen = new Set<string>();
  for (const [file, lines] of perFileLines) {
    const definitions = getDefinitionsForFile(db, file);
    for (const line of lines) {
      const enclosing = findEnclosingDefinition(definitions, line);
      const key = `${file}|${line}|${enclosing?.symbol ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push({ file, line, enclosingSymbol: enclosing?.symbol ?? null });
    }
  }
  return sites;
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
  return FILE_DEFINITION_CACHE.get(db, relativePath, () => {
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

    return correctDefinitionRangesFromSource(
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
  });
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
  // Tree-sitter path: gives both startLine and endLine in one shot from the
  // parsed AST, so no brace-counting or regex sweeps are needed. This is the
  // primary path for Rust / TS / JS / Python.
  const callables = getCallableSites(db, relativePath);
  if (callables) {
    return correctDefinitionRangesFromAst(definitions, callables);
  }

  // Regex fallback for languages without tree-sitter support.
  const source = getSourceText(db, relativePath);
  if (!source) {
    return definitions;
  }

  const lines = source.split(/\r?\n/);

  const declarationLines = definitions.some((d) => isCallableDefinition(d.symbol))
    ? buildDeclarationCandidatesMap(lines)
    : null;

  const correctedStarts = new Map<number, number>();
  for (const definition of definitions) {
    correctedStarts.set(
      definition.symbolId,
      resolveCallableDefinitionStartLine(lines, declarationLines, definition),
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

/**
 * Match each callable definition against tree-sitter callable sites by leaf
 * name; pick the AST site whose startLine is nearest to the SCIP-reported
 * startLine. Non-callable definitions (types, constants) pass through with
 * their original chunk-level ranges since the AST query targets functions.
 */
function correctDefinitionRangesFromAst(
  definitions: IndexedDefinition[],
  callables: ReadonlyArray<CallableSite>,
): IndexedDefinition[] {
  const sitesByName = new Map<string, CallableSite[]>();
  for (const site of callables) {
    const arr = sitesByName.get(site.name);
    if (arr) arr.push(site);
    else sitesByName.set(site.name, [site]);
  }

  return definitions.map((def) => {
    if (!isCallableDefinition(def.symbol) || !def.leaf) return def;
    const sites = sitesByName.get(def.leaf);
    if (!sites || sites.length === 0) return def;

    let best = sites[0]!;
    let bestDistance = Math.abs(best.startLine - def.startLine);
    for (let i = 1; i < sites.length; i += 1) {
      const site = sites[i]!;
      const distance = Math.abs(site.startLine - def.startLine);
      if (distance < bestDistance) {
        best = site;
        bestDistance = distance;
      }
    }

    return { ...def, startLine: best.startLine, endLine: best.endLine };
  });
}

function resolveCallableDefinitionStartLine(
  lines: string[],
  declarationLines: DeclarationCandidatesMap | null,
  definition: IndexedDefinition,
): number {
  if (!isCallableDefinition(definition.symbol)) {
    return definition.startLine;
  }
  const fallback = Math.max(0, Math.min(definition.startLine, lines.length - 1));
  if (!declarationLines) return fallback;

  const candidates = declarationLines.get(definition.leaf);
  if (!candidates || candidates.length === 0) return fallback;

  // Original semantics: prefer the declaration line nearest the chunk-reported
  // startLine. Strong and fallback patterns shared the same nearest-wins pick,
  // so we merge them into one candidate list per name.
  let best: { line: number; distance: number } | null = null;
  for (const line of candidates) {
    const distance = Math.abs(line - definition.startLine);
    if (!best || distance < best.distance) {
      best = { line, distance };
    }
  }
  return best?.line ?? fallback;
}

type DeclarationCandidatesMap = Map<string, number[]>;

/**
 * Single pass through the file's lines: for each line, run name-CAPTURING
 * variants of the same declaration patterns the per-definition resolver
 * used. Build `name → sorted candidate line numbers`.
 *
 * Patterns are kept identical in shape to the original strong + fallback
 * patterns — only the literal `\b{name}\b` is swapped for `\b(\w+)\b` so
 * we can capture instead of testing.
 */
function buildDeclarationCandidatesMap(lines: string[]): DeclarationCandidatesMap {
  const namedFunction = /\b(?:function|def|fn)\s+([A-Za-z_$][\w$]*)/g;
  const assignedFunction = /\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\b|\()/g;
  const methodDeclaration = /^\s*(?:(?:export|public|private|protected|static|readonly|async|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\s*\(/;
  const callShape = /\b([A-Za-z_$][\w$]*)\s*\(/g;

  const map: DeclarationCandidatesMap = new Map();
  const record = (name: string, line: number): void => {
    const arr = map.get(name);
    if (!arr) {
      map.set(name, [line]);
      return;
    }
    if (arr[arr.length - 1] !== line) arr.push(line);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    for (const match of line.matchAll(namedFunction)) {
      if (match[1]) record(match[1], i);
    }
    for (const match of line.matchAll(assignedFunction)) {
      if (match[1]) record(match[1], i);
    }
    const methodMatch = line.match(methodDeclaration);
    if (methodMatch?.[1]) record(methodMatch[1], i);
    for (const match of line.matchAll(callShape)) {
      if (match[1]) record(match[1], i);
    }
  }

  return map;
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

export function getAllDefinitions(
  db: ScipDatabase,
  opts: { scope?: string } = {},
): IndexedDefinition[] {
  return getScopedDefinitions(db, opts.scope);
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

/**
 * Project a set of file paths (or a file pattern) into the symbol-list shape
 * shared by `symbols`, `system`, and `outline`. Encapsulates the read →
 * filter ignored → optionally drop undocumented → optionally sort →
 * project pipeline that those three queries used to inline (which made
 * them register as similar-callee pairs).
 */
export function loadFileSymbols(
  db: ScipDatabase,
  filePatternOrPaths: string | string[],
  opts: { onlyDocumented?: boolean; sort?: boolean } = {},
): FileSymbolResult[] {
  const paths = typeof filePatternOrPaths === 'string'
    ? resolveIndexedPaths(db, filePatternOrPaths)
    : filePatternOrPaths;
  if (paths.length === 0) return [];

  let definitions = paths
    .flatMap((relativePath) => getDefinitionsForFile(db, relativePath))
    .filter((row) => !db.isIgnored(row.relativePath));

  if (opts.onlyDocumented) {
    definitions = definitions.filter((d) => d.documentation !== null && d.documentation !== '');
  }
  if (opts.sort) {
    definitions = definitions.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath)
      || a.startLine - b.startLine
      || a.endLine - b.endLine,
    );
  }

  return definitions.map((d) => ({
    startLine: d.startLine,
    endLine: d.endLine,
    symbol: d.symbol,
    shortName: shortenSymbol(d.symbol),
    signature: cleanSignature(extractSignature(d.documentation)),
    relativePath: d.relativePath,
    enclosingSymbol: d.enclosingSymbol,
  }));
}

export interface FileSymbolResult {
  startLine: number;
  endLine: number;
  symbol: string;
  shortName: string;
  signature: string | null;
  relativePath: string;
  enclosingSymbol: string | null;
}

/**
 * Bulk callee map: for each definition in the list, find every symbol it
 * actually calls.
 *
 * For files with tree-sitter support (Rust, TS/JS, Python), we use AST
 * call_expression / new_expression nodes — every callsite is exact, every
 * attribution is to the precise enclosing function.
 *
 * For files without AST support (Java, JVM, Ruby, .NET, Dart, PHP, C/C++),
 * we fall back to chunk-level SCIP mentions.
 *
 * `opts.additive`:
 *   - false (default, "call-strict"): AST is the ground truth for AST files;
 *     chunk attribution is NOT unioned in. Use for callee fingerprints,
 *     extract/passthrough analysis, callGraph — anywhere you need exact
 *     "what does this function call" without false positives from chunk
 *     attribution placing a mention in the wrong enclosing function.
 *   - true ("union with chunks"): merges both paths. Use for liveness
 *     checks (isolated, "has any callee at all") where ambiguous-leaf
 *     callees that AST resolution skips would otherwise produce false
 *     positives.
 */
export function buildCalleeMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<SymbolLocation>,
  opts: { additive?: boolean } = {},
): Map<number, Array<{ symbol: string; file: string; chunkId: number }>> {
  if (definitions.length === 0) return new Map();
  const additive = opts.additive ?? false;

  const astDefs: SymbolLocation[] = [];
  const chunkOnlyDefs: SymbolLocation[] = [];
  for (const def of definitions) {
    if (detectAstLanguage(def.relativePath) && getCallSites(db, def.relativePath) !== null) {
      astDefs.push(def);
    } else {
      chunkOnlyDefs.push(def);
    }
  }

  const merged = new Map<number, Array<{ symbol: string; file: string; chunkId: number }>>();
  const addAll = (
    src: Map<number, Array<{ symbol: string; file: string; chunkId: number }>>,
  ): void => {
    for (const [id, list] of src) {
      let bucket = merged.get(id);
      if (!bucket) { bucket = []; merged.set(id, bucket); }
      const seen = new Set(bucket.map((c) => `${c.symbol}|${c.chunkId}`));
      for (const c of list) {
        const key = `${c.symbol}|${c.chunkId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bucket.push(c);
      }
    }
  };

  if (astDefs.length > 0) addAll(buildAstCalleeMap(db, astDefs));
  // Chunk path runs for non-AST defs always; for AST defs only when additive.
  const chunkDefs = additive ? definitions : chunkOnlyDefs;
  if (chunkDefs.length > 0) addAll(buildChunkCalleeMap(db, chunkDefs));
  return merged;
}

/**
 * AST-based callee detection. For each definition's file:
 *   1. Walk callsites (cached AST query).
 *   2. Match each callsite to its enclosing definition by line containment
 *      against the file's known definitions sorted by start line.
 *   3. Resolve the callee leaf to a SCIP symbol via the global leaf index.
 */
function buildAstCalleeMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<SymbolLocation>,
): Map<number, Array<{ symbol: string; file: string; chunkId: number }>> {
  const result = new Map<number, Array<{ symbol: string; file: string; chunkId: number }>>();

  // Index defs by file so we can attribute callsites to the smallest
  // containing definition without walking the full set per callsite.
  const byFile = new Map<string, SymbolLocation[]>();
  for (const def of definitions) {
    const arr = byFile.get(def.relativePath);
    if (arr) arr.push(def);
    else byFile.set(def.relativePath, [def]);
    result.set(def.symbolId, []);
  }

  const leafIndex = getGlobalLeafIndex(db);

  for (const [file, fileDefs] of byFile) {
    const callsites = getCallSites(db, file);
    if (!callsites) continue; // Source unreadable — defs return empty callee arrays.

    // Sort defs by smallest range first so the innermost containing def wins
    // (handles nested closures / inner fns correctly).
    const sortedDefs = [...fileDefs].sort((a, b) => {
      const aSize = a.endLine - a.startLine;
      const bSize = b.endLine - b.startLine;
      return aSize - bSize;
    });

    for (const site of callsites) {
      // Innermost containing definition.
      let owner: SymbolLocation | null = null;
      for (const def of sortedDefs) {
        if (site.line >= def.startLine && site.line <= def.endLine) {
          owner = def;
          break;
        }
      }
      if (!owner) continue;

      // Resolve callee leaf to one or more SCIP symbols.
      const candidates = leafIndex.get(site.calleeLeaf);
      if (!candidates || candidates.length === 0) continue;

      // Prefer same-file resolution (covers free-functions and methods on
      // types defined in the same file). Otherwise accept a unique global
      // match. Skip ambiguous names — without scope analysis we'd be guessing.
      let pick: { symbol: string; file: string } | null = null;
      const sameFile = candidates.find((c) => c.file === file);
      if (sameFile) pick = sameFile;
      else if (candidates.length === 1) pick = candidates[0]!;
      if (!pick) continue;
      if (pick.symbol === owner.symbol) continue; // skip self-recursion

      const list = result.get(owner.symbolId)!;
      list.push({ symbol: pick.symbol, file: pick.file, chunkId: site.line });
    }
  }

  return result;
}

const GLOBAL_LEAF_INDEX_CACHE = createPerDbValue<Map<string, Array<{ symbol: string; symbolId: number; file: string }>>>('global-leaf-index');
function getGlobalLeafIndex(
  db: ScipDatabase,
): Map<string, Array<{ symbol: string; symbolId: number; file: string }>> {
  return GLOBAL_LEAF_INDEX_CACHE.get(db, () => {
    const rows = db.all<{ id: number; symbol: string; relative_path: string | null }>(
      `SELECT gs.id, gs.symbol,
              COALESCE(der_doc.relative_path, mention_doc.relative_path) AS relative_path
       FROM global_symbols gs
       LEFT JOIN defn_enclosing_ranges der ON der.symbol_id = gs.id
       LEFT JOIN documents der_doc ON der_doc.id = der.document_id
       LEFT JOIN (
         SELECT m.symbol_id, MIN(d.relative_path) AS relative_path
         FROM mentions m
         JOIN chunks c ON m.chunk_id = c.id
         JOIN documents d ON c.document_id = d.id
         WHERE m.role = 1
         GROUP BY m.symbol_id
       ) mention_doc ON mention_doc.symbol_id = gs.id
       WHERE 1 = 1
         ${db.symbolNoiseFor('gs')}`,
    );

    const index = new Map<string, Array<{ symbol: string; symbolId: number; file: string }>>();
    for (const row of rows) {
      if (!row.relative_path || db.isIgnored(row.relative_path)) continue;
      const leaf = leafName(row.symbol);
      if (!leaf) continue;
      let bucket = index.get(leaf);
      if (!bucket) { bucket = []; index.set(leaf, bucket); }
      // Dedupe: same symbol can show up via both joins.
      if (!bucket.some((e) => e.symbolId === row.id)) {
        bucket.push({ symbol: row.symbol, symbolId: row.id, file: row.relative_path });
      }
    }
    return index;
  });
}

function buildChunkCalleeMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<SymbolLocation>,
): Map<number, Array<{ symbol: string; file: string; chunkId: number }>> {
  if (definitions.length === 0) return new Map();

  // All non-definition mentions with their chunk doc/line range
  const refRows = db.all<{
    document_id: number;
    chunk_id: number;
    start_line: number;
    end_line: number;
    symbol_id: number;
  }>(
    `SELECT c.document_id, c.id AS chunk_id, c.start_line, c.end_line, m.symbol_id
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     WHERE m.role != 1`,
  );

  // Group by document
  const byDoc = new Map<number, Array<typeof refRows[number]>>();
  for (const row of refRows) {
    if (!byDoc.has(row.document_id)) byDoc.set(row.document_id, []);
    byDoc.get(row.document_id)!.push(row);
  }

  // Callee symbol info: symbolId → {symbol string, defining file}.
  //
  // Defining file is resolved by preferring `defn_enclosing_ranges` (the
  // canonical source when populated, e.g. scip-python) and falling back to
  // any chunk that holds a role=1 mention (every other indexer). global_symbols
  // is the authoritative symbol table — joining off mentions only would drop
  // symbols that have no role=1 mention recorded (test fixtures, indexers
  // that emit definitions only via enclosing ranges).
  const docPaths = new Map<number, string>(
    db.all<{ id: number; relative_path: string }>(
      `SELECT id, relative_path FROM documents`,
    ).map((r) => [r.id, r.relative_path]),
  );
  const calleeInfo = new Map<number, { symbol: string; file: string }>();
  const calleeRows = db.all<{ symbol_id: number; symbol: string; document_id: number | null }>(
    `SELECT gs.id AS symbol_id, gs.symbol,
            COALESCE(der.document_id, def_chunk.document_id) AS document_id
     FROM global_symbols gs
     LEFT JOIN defn_enclosing_ranges der ON der.symbol_id = gs.id
     LEFT JOIN (
       SELECT m.symbol_id, MIN(c.document_id) AS document_id
       FROM mentions m
       JOIN chunks c ON m.chunk_id = c.id
       WHERE m.role = 1
       GROUP BY m.symbol_id
     ) def_chunk ON def_chunk.symbol_id = gs.id`,
  );
  for (const r of calleeRows) {
    if (calleeInfo.has(r.symbol_id)) continue;
    calleeInfo.set(r.symbol_id, {
      symbol: r.symbol,
      file: r.document_id !== null ? (docPaths.get(r.document_id) ?? '') : '',
    });
  }

  // Match each definition against mentions in its document/range. Two passes:
  //   1. SCIP-only: chunk is fully inside the def's range — count.
  //   2. Source-text confirm: chunk *overlaps* the def's range (but isn't
  //      contained) — confirm by source-scanning the def's range for the
  //      callee's leaf identifier. This recovers calls that an indexer
  //      records via a wide chunk that straddles the function boundary, and
  //      handles fixtures / hand-built indexes whose chunks are file-wide.
  //
  // The per-def `identsInRange` set materialises every leaf appearing inside
  // the def's range once — turning per-mention source confirmation from an
  // O(lines) linear scan into an O(1) Set.has lookup. Critical for languages
  // (e.g. Rust without defn_enclosing_ranges) where chunks are file-wide and
  // every mention triggers the source-confirm path.
  const result = new Map<number, Array<{ symbol: string; file: string; chunkId: number }>>();
  const filePathById = docPaths;
  for (const def of definitions) {
    const docMentions = byDoc.get(def.documentId) ?? [];
    const seenKey = new Set<string>();
    const callees: Array<{ symbol: string; file: string; chunkId: number }> = [];
    let identsInRange: Set<string> | null = null;
    const computeIdentsInRange = (): Set<string> => {
      if (identsInRange) return identsInRange;
      const filePath = filePathById.get(def.documentId) ?? '';
      const out = new Set<string>();
      if (filePath) {
        const byLine = getIdentifiersByLine(db, filePath);
        const start = Math.max(0, def.startLine);
        const end = Math.min(byLine.length - 1, def.endLine);
        for (let i = start; i <= end; i += 1) {
          for (const name of byLine[i]!) out.add(name);
        }
      }
      identsInRange = out;
      return out;
    };

    for (const m of docMentions) {
      if (m.symbol_id === def.symbolId) continue;
      const info = calleeInfo.get(m.symbol_id);
      if (!info) continue;

      const containedInRange = m.start_line >= def.startLine && m.end_line <= def.endLine;
      if (!containedInRange) {
        const overlapsRange = m.start_line <= def.endLine && m.end_line >= def.startLine;
        if (!overlapsRange) continue;
        const leaf = leafName(info.symbol);
        if (!leaf) continue;
        if (!computeIdentsInRange().has(leaf)) continue;
      }

      const key = `${info.symbol}|${m.chunk_id}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      callees.push({ ...info, chunkId: m.chunk_id });
    }
    result.set(def.symbolId, callees);
  }

  return result;
}

/**
 * Bulk caller map: symbolId → set of distinct files that reference the
 * symbol.
 *
 * For files with tree-sitter support, callers come from AST call_expression
 * nodes — each callsite resolves to a real symbol via the global leaf index
 * with same-file preference. For non-AST files, callers come from SCIP's
 * mentions table (chunk-level) with self-reference filtering.
 *
 * If `definitions` is supplied, references that fall inside the symbol's own
 * defining file are treated as potential self-references and only counted
 * when they originate from a different document.
 */
export function buildCrossFileCallerMap(
  db: ScipDatabase,
  definitions?: ReadonlyArray<SymbolLocation>,
): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();

  // ── AST path: for every supported file with readable source, walk
  // callsites and attribute each call to the symbol whose leaf it names.
  // This is ADDITIVE to the chunk path below — call_expression nodes catch
  // functions, but types are referenced in non-call positions (annotations,
  // extends clauses, field types). The chunk-based SCIP path catches those
  // type references; AST refines callable attribution. Both paths feed the
  // same map (Set semantics dedupe duplicates).
  const docs = db.all<{ relative_path: string }>(
    `SELECT relative_path FROM documents
     WHERE 1 = 1 ${db.pathExclusionsFor('documents')}`,
  );
  const leafIndex = getGlobalLeafIndex(db);
  for (const doc of docs) {
    if (!detectAstLanguage(doc.relative_path)) continue;
    if (db.isIgnored(doc.relative_path)) continue;
    const callsites = getCallSites(db, doc.relative_path);
    if (!callsites) continue;
    for (const site of callsites) {
      const candidates = leafIndex.get(site.calleeLeaf);
      if (!candidates || candidates.length === 0) continue;
      // Same-file preference (consistent with buildAstCalleeMap).
      const sameFile = candidates.find((c) => c.file === doc.relative_path);
      const pick = sameFile ?? (candidates.length === 1 ? candidates[0]! : null);
      if (!pick) continue;
      // Cross-file caller only — self-references skipped.
      if (pick.file === doc.relative_path) continue;
      let bucket = map.get(pick.symbolId);
      if (!bucket) { bucket = new Set(); map.set(pick.symbolId, bucket); }
      bucket.add(doc.relative_path);
    }
  }

  // ── Chunk path: SCIP mentions catch references AST callsite queries miss
  // (type annotations, extends clauses, macro-mediated refs). Self-reference
  // filter via the optional `definitions` arg.
  const rows = db.all<{
    symbol_id: number;
    relative_path: string;
    document_id: number;
    chunk_start: number;
    chunk_end: number;
  }>(
    `SELECT DISTINCT m.symbol_id, d.relative_path, c.document_id,
            c.start_line AS chunk_start, c.end_line AS chunk_end
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.role != 1
       ${db.pathExclusionsFor('d')}`,
  );

  const selfRanges = new Map<number, { docId: number; startLine: number; endLine: number }>();
  if (definitions) {
    for (const def of definitions) {
      selfRanges.set(def.symbolId, {
        docId: def.documentId,
        startLine: def.startLine,
        endLine: def.endLine,
      });
    }
  }

  for (const row of rows) {
    if (db.isIgnored(row.relative_path)) continue;

    const range = selfRanges.get(row.symbol_id);
    if (range
      && range.docId === row.document_id
      && row.chunk_start >= range.startLine
      && row.chunk_end <= range.endLine) {
      continue;
    }

    let bucket = map.get(row.symbol_id);
    if (!bucket) { bucket = new Set(); map.set(row.symbol_id, bucket); }
    bucket.add(row.relative_path);
  }
  return map;
}

/**
 * Bulk source-text caller fallback. Useful when the SCIP indexer
 * under-reports references — e.g., scip-python's known gaps, Rust macro
 * expansions, or any indexer that misses dynamic-dispatch call sites.
 *
 * For each candidate whose leaf identifier is *unique* across the codebase
 * (so a textual hit can be unambiguously attributed), this scans every
 * source file once, collecting files that mention the identifier outside
 * the candidate's own definition range and outside comments/strings.
 *
 * Returns symbolId → set of caller files. Merge into the SCIP-derived
 * `buildCrossFileCallerMap` to recover the accuracy that per-symbol
 * `getCallerRowsForSymbol` used to provide, without paying its
 * O(symbols × files) cost.
 */
export function buildSourceFallbackCallerFiles(
  db: ScipDatabase,
  candidates: ReadonlyArray<IndexedDefinition>,
): Map<number, Set<string>> {
  const leafCounts = new Map<string, number>();
  for (const def of candidates) {
    if (!def.leaf) continue;
    leafCounts.set(def.leaf, (leafCounts.get(def.leaf) ?? 0) + 1);
  }
  // Unique-leaf candidates can be attributed by leaf alone — fast path.
  const leafToCandidate = new Map<string, IndexedDefinition>();
  // Ambiguous-leaf candidates (e.g. a frontend `listInventoryItems` and a
  // backend twin) get an extra index by their defining file; we then use
  // the consumer's imports to pick the right one.
  const leafToAmbiguous = new Map<string, IndexedDefinition[]>();
  for (const def of candidates) {
    if (!def.leaf) continue;
    if ((leafCounts.get(def.leaf) ?? 0) === 1) {
      leafToCandidate.set(def.leaf, def);
    } else {
      const bucket = leafToAmbiguous.get(def.leaf) ?? [];
      bucket.push(def);
      leafToAmbiguous.set(def.leaf, bucket);
    }
  }
  if (leafToCandidate.size === 0 && leafToAmbiguous.size === 0) return new Map();

  const allFiles = getSourceFiles(db);

  const result = new Map<number, Set<string>>();
  const credit = (target: IndexedDefinition, file: string): void => {
    if (file === target.relativePath) return;
    let bucket = result.get(target.symbolId);
    if (!bucket) { bucket = new Set(); result.set(target.symbolId, bucket); }
    bucket.add(file);
  };

  // Each file contributes a Set<identifierName>. We then intersect that with
  // the candidate-leaf set rather than scanning every identifier on every line.
  // Tree-sitter-backed identifier collection (when language is supported)
  // automatically excludes comments/strings; the Set lookup makes per-file
  // attribution O(unique identifiers in file) instead of O(all token matches).
  for (const file of allFiles) {
    const fileIdents = getFileIdentifiers(db, file);
    if (fileIdents.size === 0) continue;

    // For ambiguous leaves, build a per-file imports lookup once: name → set
    // of source file paths that name resolves to. We only need this when the
    // file even mentions one of the ambiguous names.
    let importsByName: Map<string, Set<string>> | null = null;
    const computeImports = (): Map<string, Set<string>> => {
      if (importsByName) return importsByName;
      importsByName = new Map();
      for (const entry of getSourceImports(db, file)) {
        if (!entry.sourcePath) continue;
        const localName = entry.localName ?? entry.importedName;
        if (localName) {
          let s = importsByName.get(localName);
          if (!s) { s = new Set(); importsByName.set(localName, s); }
          s.add(entry.sourcePath);
        }
        if (entry.kind === 'namespace') {
          for (const member of entry.usedMembers) {
            let s = importsByName.get(member);
            if (!s) { s = new Set(); importsByName.set(member, s); }
            s.add(entry.sourcePath);
          }
        }
      }
      return importsByName;
    };

    for (const name of fileIdents) {
      const candidate = leafToCandidate.get(name);
      if (candidate) {
        credit(candidate, file);
        continue;
      }
      const ambiguous = leafToAmbiguous.get(name);
      if (!ambiguous) continue;
      const imports = computeImports();
      const importedFrom = imports.get(name);
      if (!importedFrom || importedFrom.size === 0) continue;
      for (const def of ambiguous) {
        for (const sourcePath of importedFrom) {
          if (pathsResolveSame(sourcePath, def.relativePath)) {
            credit(def, file);
            break;
          }
        }
      }
    }
  }

  return result;
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

