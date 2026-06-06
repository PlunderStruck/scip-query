/**
 * reference-graph — bulk caller/callee maps and reference-site
 * resolution.
 *
 * Where to get what:
 *   Reference lines (where is this used?):
 *     - Primary:    `getSourceReferenceSites` — cross-file identifier
 *                   scan (re-exported from identifier-attribution).
 *                   Returns [] when the leaf name is ambiguous.
 *     - Fallback:   `getResolvedReferenceSites` — mention-resolved
 *                   chunks with in-chunk line refinement. Always
 *                   returns a result when the symbol has mentions.
 *   Do NOT read `chunks.start_line` as the "line of a reference"; a
 *   chunk spans many source lines.
 *
 *   Bulk graph builders:
 *     - `buildCalleeMap(db, defs)` — for each definition, the symbols
 *       it calls (AST + chunk merged).
 *     - `buildCrossFileCallerMap(db, defs?)` — reverse: symbolId →
 *       set of files that reference it.
 *     - `buildCallerRowsMap(db)` — symbolId → list of caller
 *       (symbol, file) rows, cached once per DB.
 *     - `getCalleeRowsForSymbol` / `getCallerRowsForSymbol` — narrow
 *       single-symbol views over the bulk maps.
 *
 *   File-dependency graph:
 *     - `buildFileDepGraph(db, scope?)` — file → set of files it
 *       imports/references.
 *
 * Layer position: top of the layering — uses path-resolver,
 * symbol-lookup, and definition-catalog. Identifier-attribution sits
 * alongside (re-exported here as `getSourceReferenceSites` /
 * `buildSourceFallbackCallerFiles` so callers don't have to learn a
 * second module name).
 */
import type { ScipDatabase } from '../storage/db.js';
import { detectAstLanguage, getCallSites } from '../source/ast.js';
import { getRustAttrReferencedNames } from '../analysis/framework-patterns.js';
import { createPerDbCache, createPerDbValue } from '../storage/per-db-cache.js';
import { findIdentifierLines, getIdentifiersByLine } from './identifier-index.js';
import { getSourceImports } from '../language-parsers/index.js';
import { isCallableSymbol, leafName } from './symbol-parser.js';
import { findEnclosingDefinition, getAllDefinitions, getDefinitionsForFile } from './definition-catalog.js';
import { getFullSymbolMatch } from './symbol-lookup.js';
import type { IndexedDefinition, ReferenceSite, SymbolLocation, SymbolMatch } from '../domain/types.js';
import { semanticCalleeMap, semanticCallerMap, semanticReferences } from '../semantic/shared-primitives.js';

export interface CalleeRow {
  symbol: string;
  file: string;
  chunkId: number;
}

export interface CallerRow {
  symbol: string;
  file: string;
}

interface ReferenceChunk {
  start_line: number;
  end_line: number;
}

interface ChunkMentionCallerRow {
  symbol_id: number;
  relative_path: string;
  document_id: number;
  chunk_start: number;
  chunk_end: number;
}

interface DefinitionSelfRange {
  docId: number;
  startLine: number;
  endLine: number;
}

// Re-export type for backwards-compatibility with callers that imported
// ReferenceSite from query-support.ts.
export type { ReferenceSite } from '../domain/types.js';

const FILE_DEP_GRAPH_CACHE = createPerDbCache<string, Map<string, Set<string>>>('file-dep-graph');

// scip-query: ignore-extract — this builds the file dependency graph from
// SCIP edges plus source-import fallback edges; the two sources intentionally
// share one normalization path.
export function buildFileDepGraph(
  db: ScipDatabase,
  scope?: string,
): Map<string, Set<string>> {
  return FILE_DEP_GRAPH_CACHE.get(db, scope ?? '', () => {
    const graph = new Map<string, Set<string>>();
    const indexedFiles = indexedDocumentPaths(db);
    const addEdge = (fromFile: string, toFile: string): void =>
      addFileDepEdge(db, graph, indexedFiles, fromFile, toFile);

    for (const edge of scipFileDepEdges(db, scope)) {
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
  });
}

function scipFileDepEdges(
  db: ScipDatabase,
  scope?: string,
): Array<{ from_file: string; to_file: string }> {
  const scopeFilter = scope ? `AND d1.relative_path LIKE '%${scope}%'` : '';
  return db.all<{ from_file: string; to_file: string }>(
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
}

function indexedDocumentPaths(db: ScipDatabase): Set<string> {
  return new Set(
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
}

function addFileDepEdge(
  db: ScipDatabase,
  graph: Map<string, Set<string>>,
  indexedFiles: ReadonlySet<string>,
  fromFile: string,
  toFile: string,
): void {
  if (fromFile === toFile) return;
  if (db.isIgnored(fromFile) || db.isIgnored(toFile)) return;
  if (!indexedFiles.has(toFile)) return;
  let bucket = graph.get(fromFile);
  if (!bucket) {
    bucket = new Set();
    graph.set(fromFile, bucket);
  }
  bucket.add(toFile);
}

export function getCalleeRowsForSymbol(
  db: ScipDatabase,
  symbol: SymbolMatch,
  opts: { limit?: number; additive?: boolean; callableOnly?: boolean } = {},
): CalleeRow[] {
  // Delegates to the shared bulk path so callers automatically benefit from
  // tree-sitter call attribution, source-confirmation, and the merged AST +
  // SCIP results. Avoids the older per-symbol mention-scan that under-
  // attributed for AST-supported languages and missed call/callee shape
  // refinements that the bulk helper already handles.
  const map = buildCalleeMap(db, [symbol], { additive: opts.additive });
  const callees = opts.callableOnly
    ? (map.get(symbol.symbolId) ?? []).filter((callee) => isCallableSymbol(callee.symbol))
    : map.get(symbol.symbolId) ?? [];
  return typeof opts.limit === 'number' ? callees.slice(0, opts.limit) : callees;
}

export function getCallerRowsForSymbol(
  db: ScipDatabase,
  symbol: SymbolMatch,
  opts: { limit?: number } = {},
): CallerRow[] {
  const callers = shouldUseTargetedCallerRows(db)
    ? targetedCallerRowsForSymbol(db, symbol)
    : buildCallerRowsMap(db).get(symbol.symbolId) ?? [];
  return typeof opts.limit === 'number' ? callers.slice(0, opts.limit) : callers;
}

const CALLER_ROWS_CACHE = createPerDbValue<Map<number, CallerRow[]>>('caller-rows');
const TARGETED_CALLER_THRESHOLD = 20_000;

function shouldUseTargetedCallerRows(db: ScipDatabase): boolean {
  const row = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM global_symbols');
  return (row?.count ?? 0) > TARGETED_CALLER_THRESHOLD;
}

/**
 * Inverse of buildCalleeMap: for every (caller, callee) edge, register the
 * caller's symbol + file under the callee's symbolId. Cached so the entire
 * inversion happens once per ScipDatabase instance.
 */
export function buildCallerRowsMap(db: ScipDatabase): Map<number, CallerRow[]> {
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

// scip-query: ignore-extract — this is the targeted single-symbol caller
// fallback: resolved reference sites, indexed definition lookup, and file-edge
// attribution intentionally form one query path.
function targetedCallerRowsForSymbol(db: ScipDatabase, symbol: SymbolMatch): CallerRow[] {
  const rows: CallerRow[] = [];
  const seen = new Set<string>();
  const add = (row: CallerRow): void => {
    if (row.symbol === symbol.symbol) return;
    const key = `${row.symbol}|${row.file}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };

  for (const site of getResolvedReferenceSites(db, symbol)) {
    if (site.file === symbol.relativePath) continue;
    add({
      symbol: site.enclosingSymbol ?? site.file,
      file: site.file,
    });
  }

  const definition = indexedDefinitionForSymbol(db, symbol);
  if (definition) {
    for (const reference of semanticReferences(db, definition)) {
      if (reference.file === symbol.relativePath || db.isIgnored(reference.file)) continue;
      const enclosing = findEnclosingDefinition(getDefinitionsForFile(db, reference.file), reference.line);
      add({
        symbol: enclosing?.symbol ?? reference.file,
        file: reference.file,
      });
    }
  }

  return rows;
}

function indexedDefinitionForSymbol(db: ScipDatabase, symbol: SymbolMatch): IndexedDefinition | null {
  return db.get<IndexedDefinition>(
    `SELECT
       d.id AS documentId,
       gs.id AS symbolId,
       gs.symbol,
       d.relative_path AS relativePath,
       COALESCE(der.start_line, c.start_line) AS startLine,
       COALESCE(der.end_line, c.end_line) AS endLine,
       COALESCE(gs.display_name, '') AS leaf,
       NULL AS parentTypeName,
       CASE WHEN gs.kind IN (6, 12, 13) OR gs.symbol LIKE '%().' THEN 1 ELSE 0 END AS isFunctionLike,
       CASE WHEN gs.kind IN (5, 8, 11) THEN 1 ELSE 0 END AS isTypeLike,
       gs.kind AS kind,
       gs.documentation AS documentation,
       gs.enclosing_symbol AS enclosingSymbol
     FROM global_symbols gs
     LEFT JOIN defn_enclosing_ranges der ON der.symbol_id = gs.id
     LEFT JOIN chunks c ON c.document_id = der.document_id
     JOIN documents d ON d.id = COALESCE(der.document_id, c.document_id)
     WHERE gs.id = ?
     LIMIT 1`,
    symbol.symbolId,
  ) ?? null;
}

// ── Reference-site resolution ──────────────────────────────────

// `findReferences` (source-text-based reference scan) and
// `findCallerFiles` (bulk source-fallback caller-file builder) live in
// `identifier-attribution.ts`. They used to be re-exported here under
// their query-support-era names (`getSourceReferenceSites` and
// `buildSourceFallbackCallerFiles`) but the back-edge created a
// reference-graph ↔ identifier-attribution cycle that the cycles
// detector flagged. Callers now import them directly from
// identifier-attribution.

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

export function resolvedCandidateLines(
  db: ScipDatabase,
  match: { symbolId: number; relativePath: string; startLine: number; endLine: number },
  identifier: string | null,
): Map<string, number[]> {
  const fileLines = new Map<string, number[]>();
  for (const [file, chunks] of referenceChunksByFile(db, match.symbolId)) {
    fileLines.set(file, resolvedLinesForFile(db, file, chunks, match, identifier));
  }
  return fileLines;
}

function referenceChunksByFile(db: ScipDatabase, symbolId: number): Map<string, ReferenceChunk[]> {
  const chunksByFile = new Map<string, ReferenceChunk[]>();
  const rows = db.all<{ relative_path: string; start_line: number; end_line: number }>(
    `SELECT DISTINCT d.relative_path, c.start_line, c.end_line
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.symbol_id = ?
       AND m.role != 1
       ${db.pathExclusionsFor('d')}
     ORDER BY d.relative_path, c.start_line`,
    symbolId,
  );
  for (const row of rows) {
    if (db.isIgnored(row.relative_path)) continue;
    let bucket = chunksByFile.get(row.relative_path);
    if (!bucket) {
      bucket = [];
      chunksByFile.set(row.relative_path, bucket);
    }
    bucket.push({ start_line: row.start_line, end_line: row.end_line });
  }
  return chunksByFile;
}

function resolvedLinesForFile(
  db: ScipDatabase,
  file: string,
  chunks: readonly ReferenceChunk[],
  match: { relativePath: string; startLine: number; endLine: number },
  identifier: string | null,
): number[] {
  const excludeOpts = file === match.relativePath
    ? { excludeStartLine: match.startLine, excludeEndLine: match.endLine }
    : {};
  const allHits = identifier
    ? findIdentifierLines(db, file, identifier, excludeOpts)
    : [];
  return chunks.flatMap((chunk) => hitsOrChunkStart(allHits, chunk));
}

function hitsOrChunkStart(allHits: readonly number[], chunk: ReferenceChunk): number[] {
  const hitsInChunk = allHits.filter((line) => line >= chunk.start_line && line <= chunk.end_line);
  return hitsInChunk.length > 0 ? hitsInChunk : [chunk.start_line];
}

interface ReferencePrelude {
  match: NonNullable<ReturnType<typeof getFullSymbolMatch>>;
  identifier: string | null;
}

export function resolveReferencePrelude(
  db: ScipDatabase,
  symbol: SymbolLocation,
): ReferencePrelude | null {
  const match = getFullSymbolMatch(db, symbol);
  if (!match) return null;
  return { match, identifier: leafName(match.symbol) || null };
}

export function buildReferenceSites(
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

// ── Callee map (bulk) ──────────────────────────────────────────

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
// scip-query: ignore-extract — this is the AST/semantic/chunk merge policy
// for callee evidence; keeping the precedence visible prevents accuracy
// regressions when one evidence source is noisy.
export function buildCalleeMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<SymbolMatch>,
  opts: { additive?: boolean } = {},
): Map<number, Array<{ symbol: string; file: string; chunkId: number }>> {
  if (definitions.length === 0) return new Map();
  const additive = opts.additive ?? false;

  const astDefs: SymbolMatch[] = [];
  const chunkOnlyDefs: SymbolMatch[] = [];
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
  addAll(toCalleeRows(semanticCalleeMap(db, definitions)));
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
// scip-query: ignore-extract — this is the AST callee fallback builder:
// per-file definitions, callsites, leaf index lookup, and innermost-caller
// attribution are one source-scan pass.
export function buildAstCalleeMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<SymbolMatch>,
): Map<number, Array<{ symbol: string; file: string; chunkId: number }>> {
  const result = new Map<number, Array<{ symbol: string; file: string; chunkId: number }>>();
  const byFile = definitionsByFile(definitions, result);
  const leafIndex = getGlobalLeafIndex(db);

  for (const [file, fileDefs] of byFile) {
    const callsites = getCallSites(db, file);
    if (!callsites) continue; // Source unreadable — defs return empty callee arrays.

    for (const site of callsites) {
      const owner = innermostDefinitionAtLine(fileDefs, site.line);
      if (!owner) continue;

      const pick = resolveAstCalleeCandidate(db, file, leafIndex, site.calleeLeaf, site.memberAccess);
      if (!pick) continue;
      if (pick.symbol === owner.symbol) continue; // skip self-recursion

      result.get(owner.symbolId)!.push({ symbol: pick.symbol, file: pick.file, chunkId: site.line });
    }
  }

  return result;
}

function definitionsByFile(
  definitions: ReadonlyArray<SymbolMatch>,
  result: Map<number, Array<{ symbol: string; file: string; chunkId: number }>>,
): Map<string, SymbolMatch[]> {
  const byFile = new Map<string, SymbolMatch[]>();
  for (const def of definitions) {
    const arr = byFile.get(def.relativePath);
    if (arr) arr.push(def);
    else byFile.set(def.relativePath, [def]);
    result.set(def.symbolId, []);
  }
  for (const defs of byFile.values()) {
    defs.sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));
  }
  return byFile;
}

function innermostDefinitionAtLine(
  definitions: readonly SymbolMatch[],
  line: number,
): SymbolMatch | null {
  return definitions.find((def) => line >= def.startLine && line <= def.endLine) ?? null;
}

function resolveAstCalleeCandidate(
  db: ScipDatabase,
  file: string,
  leafIndex: Map<string, GlobalLeafCandidate[]>,
  calleeLeaf: string,
  memberAccess: boolean,
): GlobalLeafCandidate | null {
  const candidates = sameLanguageCandidates(file, leafIndex.get(calleeLeaf) ?? []);
  if (candidates.length === 0) return null;
  return pickAstCallCandidate(db, file, candidates, memberAccess);
}

function sameLanguageCandidates<T extends { file: string }>(
  sourceFile: string,
  candidates: T[],
): T[] {
  const sourceFamily = astLanguageFamily(sourceFile);
  if (!sourceFamily) return candidates;
  return candidates.filter((candidate) => astLanguageFamily(candidate.file) === sourceFamily);
}

function pickAstCallCandidate<T extends { symbol: string; file: string }>(
  db: ScipDatabase,
  sourceFile: string,
  candidates: T[],
  memberAccess: boolean,
): T | null {
  const sameFile = candidates.find((candidate) => candidate.file === sourceFile);
  if (sameFile) return sameFile;

  if (memberAccess) {
    const importedSourcePaths = new Set(
      getSourceImports(db, sourceFile)
        .map((entry) => entry.sourcePath)
        .filter((path): path is string => Boolean(path)),
    );
    return candidates.find((candidate) =>
      [...importedSourcePaths].some((sourcePath) => pathsResolveSame(sourcePath, candidate.file)),
    ) ?? null;
  }

  return candidates.length === 1 ? candidates[0]! : null;
}

function pathsResolveSame(a: string, b: string): boolean {
  const norm = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '');
  return norm(a) === norm(b);
}

function astLanguageFamily(relativePath: string): string | null {
  const language = detectAstLanguage(relativePath);
  if (!language) return null;
  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    return 'javascript-family';
  }
  return language;
}

type GlobalLeafCandidate = { symbol: string; symbolId: number; file: string };

const GLOBAL_LEAF_INDEX_CACHE = createPerDbValue<Map<string, GlobalLeafCandidate[]>>('global-leaf-index');
// scip-query: ignore-extract — this builds the global leaf-name candidate
// index; SQL loading, ignore filtering, noise filtering, and language tagging
// define one cache value.
export function getGlobalLeafIndex(
  db: ScipDatabase,
): Map<string, GlobalLeafCandidate[]> {
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

    const index = new Map<string, GlobalLeafCandidate[]>();
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

export function buildChunkCalleeMap(
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
// scip-query: ignore-extract — this is the bulk caller-map merge policy:
// SCIP mentions, AST callsites, Rust attribute calls, and TypeScript semantics
// intentionally contribute to one cross-file reference map.
export function buildCrossFileCallerMap(
  db: ScipDatabase,
  definitions?: ReadonlyArray<SymbolLocation>,
): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();
  const docs = db.all<{ relative_path: string }>(
    `SELECT relative_path FROM documents
     WHERE 1 = 1 ${db.pathExclusionsFor('documents')}`,
  );
  const leafIndex = getGlobalLeafIndex(db);
  const effectiveDefinitions = definitions ?? getAllDefinitions(db);

  addAstCallsiteCallers(db, map, docs, leafIndex);
  addChunkMentionCallers(db, map, effectiveDefinitions);
  addRustAttrCallers(db, map, docs, leafIndex);
  mergeCallerSets(map, semanticCallerMap(db, indexedDefinitions(effectiveDefinitions)));

  return map;
}

// scip-query: ignore-extract — this is the AST callsite caller pass:
// language filtering, callsite extraction, candidate picking, and self-call
// suppression are one fallback path.
function addAstCallsiteCallers(
  db: ScipDatabase,
  map: Map<number, Set<string>>,
  docs: ReadonlyArray<{ relative_path: string }>,
  leafIndex: Map<string, GlobalLeafCandidate[]>,
): void {
  // For supported files, walk callsites and attribute each call to the symbol
  // whose leaf it names. This is additive to the chunk path: call_expression
  // nodes catch functions while SCIP mentions catch type-position references.
  for (const doc of docs) {
    if (!detectAstLanguage(doc.relative_path)) continue;
    if (db.isIgnored(doc.relative_path)) continue;
    const callsites = getCallSites(db, doc.relative_path);
    if (!callsites) continue;
    for (const site of callsites) {
      const candidates = sameLanguageCandidates(doc.relative_path, leafIndex.get(site.calleeLeaf) ?? []);
      if (!candidates || candidates.length === 0) continue;
      const pick = pickAstCallCandidate(db, doc.relative_path, candidates, site.memberAccess);
      if (!pick) continue;
      // Cross-file caller only — self-references skipped.
      if (pick.file === doc.relative_path) continue;
      addCallerFile(map, pick.symbolId, doc.relative_path);
    }
  }
}

function addChunkMentionCallers(
  db: ScipDatabase,
  map: Map<number, Set<string>>,
  definitions: ReadonlyArray<SymbolLocation>,
): void {
  const selfRanges = definitionSelfRanges(definitions);
  for (const row of loadChunkMentionCallerRows(db)) {
    if (db.isIgnored(row.relative_path)) continue;
    if (isSelfChunkMention(row, selfRanges.get(row.symbol_id))) continue;
    addCallerFile(map, row.symbol_id, row.relative_path);
  }
}

function loadChunkMentionCallerRows(db: ScipDatabase): ChunkMentionCallerRow[] {
  return db.all<ChunkMentionCallerRow>(
    `SELECT DISTINCT m.symbol_id, d.relative_path, c.document_id,
            c.start_line AS chunk_start, c.end_line AS chunk_end
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.role != 1
       ${db.pathExclusionsFor('d')}`,
  );
}

function definitionSelfRanges(definitions: ReadonlyArray<SymbolLocation>): Map<number, DefinitionSelfRange> {
  const selfRanges = new Map<number, DefinitionSelfRange>();
  for (const def of definitions) {
    selfRanges.set(def.symbolId, {
      docId: def.documentId,
      startLine: def.startLine,
      endLine: def.endLine,
    });
  }
  return selfRanges;
}

function isSelfChunkMention(row: ChunkMentionCallerRow, range: DefinitionSelfRange | undefined): boolean {
  return !!range
    && range.docId === row.document_id
    && row.chunk_start >= range.startLine
    && row.chunk_end <= range.endLine;
}

function addRustAttrCallers(
  db: ScipDatabase,
  map: Map<number, Set<string>>,
  docs: ReadonlyArray<{ relative_path: string }>,
  leafIndex: Map<string, GlobalLeafCandidate[]>,
): void {
  // String-attr helpers (`#[serde(default = "fn")]`, etc.) are framework
  // dispatches that SCIP does not connect back to the helper definition.
  for (const doc of docs) {
    if (db.isIgnored(doc.relative_path)) continue;
    if (detectAstLanguage(doc.relative_path) !== 'rust') continue;
    const attrRefs = getRustAttrReferencedNames(db, doc.relative_path);
    if (attrRefs.size === 0) continue;
    for (const name of attrRefs) {
      const candidates = leafIndex.get(name);
      if (!candidates) continue;
      for (const c of candidates) {
        if (c.file === doc.relative_path) continue; // self-ref, not a caller
        addCallerFile(map, c.symbolId, doc.relative_path);
      }
    }
  }
}

function addCallerFile(map: Map<number, Set<string>>, symbolId: number, file: string): void {
  let bucket = map.get(symbolId);
  if (!bucket) {
    bucket = new Set();
    map.set(symbolId, bucket);
  }
  bucket.add(file);
}

function indexedDefinitions(definitions: ReadonlyArray<SymbolLocation>): IndexedDefinition[] {
  return definitions.filter((definition): definition is IndexedDefinition =>
    'relativePath' in definition && 'symbol' in definition && 'leaf' in definition,
  );
}

function toCalleeRows(
  semantic: Map<number, Array<{ symbol: string; file: string }>>,
): Map<number, Array<{ symbol: string; file: string; chunkId: number }>> {
  const out = new Map<number, Array<{ symbol: string; file: string; chunkId: number }>>();
  for (const [symbolId, callees] of semantic) {
    out.set(symbolId, callees.map((callee) => ({ ...callee, chunkId: -1 })));
  }
  return out;
}

function mergeCallerSets(target: Map<number, Set<string>>, source: Map<number, Set<string>>): void {
  for (const [symbolId, files] of source) {
    let bucket = target.get(symbolId);
    if (!bucket) {
      bucket = new Set();
      target.set(symbolId, bucket);
    }
    for (const file of files) bucket.add(file);
  }
}
