import type { ScipDatabase } from '../../storage/db.js';
import { detectAstLanguage, getCallSites } from '../../source/ast.js';
import { getSourceImports } from '../../language-parsers/index.js';
import { createPerDbValue } from '../../storage/per-db-cache.js';
import { getIdentifiersByLine } from '../identifier-index.js';
import { isCallableSymbol, leafName } from '../symbol-parser.js';
import {
  createDefinitionLineIndex,
  findEnclosingDefinition,
  getAllDefinitions,
  getDefinitionsForFile,
} from '../definition-catalog.js';
import { getResolvedReferenceSitesMap } from '../references/reference-sites.js';
import type { IndexedDefinition, SymbolLocation, SymbolMatch } from '../../domain/types.js';
import { getGlobalLeafIndex, pickAstCallCandidate, sameLanguageCandidates } from '../leaf-symbol-index.js';
import type { GlobalLeafCandidate } from '../leaf-symbol-index.js';
import { scipFunctionLikeKindNumbers, scipTypeLikeKindNumbers } from '../symbol-kind.js';
import { pathsResolveSame } from '../../domain/path-normalization.js';
import type { SymbolSemanticEvidencePort } from '../semantic-evidence-port.js';

export type CalleeEvidenceSource = 'ast-callsite' | 'semantic-callee' | 'scip-chunk';
export type CallerEvidenceSource = 'caller-map-inversion' | 'resolved-reference' | 'semantic-reference';

// scip-query: ignore-stale — reviewed S1 owned contract; graph construction materializes this callee evidence row.
export interface CalleeRow {
  symbol: string;
  file: string;
  chunkId: number;
  source: CalleeEvidenceSource;
}

// scip-query: ignore-stale — exported caller evidence record shared through
// caller-evidence; provenance is part of the cross-query evidence contract.
export interface CallerRow {
  symbol: string;
  file: string;
  source: CallerEvidenceSource;
}

export function getCalleeRowsForSymbol(
  db: ScipDatabase,
  symbol: SymbolMatch,
  opts: {
    limit?: number;
    additive?: boolean;
    callableOnly?: boolean;
    semantic?: boolean;
    semanticEvidence?: SymbolSemanticEvidencePort;
  } = {},
): CalleeRow[] {
  // Delegates to the shared bulk path so callers automatically benefit from
  // tree-sitter call attribution, source-confirmation, and the merged AST +
  // SCIP results. Avoids the older per-symbol mention-scan that under-
  // attributed for AST-supported languages and missed call/callee shape
  // refinements that the bulk helper already handles.
  const map = buildCalleeMap(db, [symbol], {
    additive: opts.additive,
    semantic: opts.semantic,
    semanticEvidence: opts.semanticEvidence,
  });
  const callees = opts.callableOnly
    ? (map.get(symbol.symbolId) ?? []).filter(
        (callee) => isCallableSymbol(callee.symbol) || callee.source === 'ast-callsite',
      )
    : (map.get(symbol.symbolId) ?? []);
  return typeof opts.limit === 'number' ? callees.slice(0, opts.limit) : callees;
}

// scip-query: ignore-wrapper — caller row lookup owns targeted-vs-inverted
// evidence selection; query modules reach it through caller-evidence.
export function getCallerRowsForSymbol(
  db: ScipDatabase,
  symbol: SymbolMatch,
  opts: { limit?: number; semantic?: boolean; semanticEvidence: SymbolSemanticEvidencePort },
): CallerRow[] {
  return getCallerRowsMapForSymbols(db, [symbol], opts).get(symbol.symbolId) ?? [];
}

// scip-query: ignore-wrapper — bulk graph implementation stays behind the
// caller-evidence facade, parallel to the scalar boundary above.
export function getCallerRowsMapForSymbols(
  db: ScipDatabase,
  symbols: ReadonlyArray<SymbolMatch>,
  opts: { limit?: number; semantic?: boolean; semanticEvidence: SymbolSemanticEvidencePort },
): Map<number, CallerRow[]> {
  const rows = shouldUseTargetedCallerRows(db)
    ? targetedCallerRowsMapForSymbols(db, symbols, {
        semantic: opts.semantic !== false,
        semanticEvidence: opts.semanticEvidence,
      })
    : buildCallerRowsMap(db, opts.semanticEvidence);
  if (typeof opts.limit !== 'number') {
    return new Map(symbols.map((symbol) => [symbol.symbolId, rows.get(symbol.symbolId) ?? []]));
  }
  return new Map(symbols.map((symbol) => [symbol.symbolId, (rows.get(symbol.symbolId) ?? []).slice(0, opts.limit)]));
}

const CALLER_ROWS_CACHE = createPerDbValue<Map<number, CallerRow[]>>('caller-rows', {
  clearGroups: ['whole-project'],
});
const TARGETED_CALLER_STRATEGY_CACHE = createPerDbValue<boolean>('targeted-caller-strategy', {
  clearGroups: ['whole-project'],
});
const TARGETED_CALLER_THRESHOLD = 20_000;

function shouldUseTargetedCallerRows(db: ScipDatabase): boolean {
  return TARGETED_CALLER_STRATEGY_CACHE.get(db, () => {
    const row = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM global_symbols');
    return (row?.count ?? 0) > TARGETED_CALLER_THRESHOLD;
  });
}

/**
 * Inverse of buildCalleeMap: for every (caller, callee) edge, register the
 * caller's symbol + file under the callee's symbolId. Cached so the entire
 * inversion happens once per ScipDatabase instance.
 */
export function buildCallerRowsMap(
  db: ScipDatabase,
  semanticEvidence: SymbolSemanticEvidencePort,
): Map<number, CallerRow[]> {
  return CALLER_ROWS_CACHE.get(db, () => {
    const allDefs = getAllDefinitions(db);
    const calleeMap = buildCalleeMap(db, allDefs, { semanticEvidence });

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
        bucket.push({
          symbol: callerDef.symbol,
          file: callerDef.relativePath,
          source: 'caller-map-inversion',
        });
      }
    }

    return result;
  });
}

// scip-query: ignore-extract — this is the targeted single-symbol caller
// fallback: resolved reference sites, indexed definition lookup, and file-edge
// attribution intentionally form one query path.
function targetedCallerRowsMapForSymbols(
  db: ScipDatabase,
  symbols: ReadonlyArray<SymbolMatch>,
  opts: { semantic: boolean; semanticEvidence?: SymbolSemanticEvidencePort },
): Map<number, CallerRow[]> {
  const definitions =
    opts.semantic && opts.semanticEvidence
      ? symbols.flatMap((symbol) => {
          const definition = indexedDefinitionForSymbol(db, symbol);
          return definition ? [definition] : [];
        })
      : [];
  const definitionBySymbolId = new Map(definitions.map((definition) => [definition.symbolId, definition]));
  const semanticReferences = opts.semanticEvidence?.referenceMap(db, definitions) ?? new Map();
  const resolvedReferences = getResolvedReferenceSitesMap(db, symbols);
  const result = new Map<number, CallerRow[]>();

  for (const symbol of symbols) {
    const rows: CallerRow[] = [];
    const seen = new Set<string>();
    const add = (row: CallerRow): void => {
      if (row.symbol === symbol.symbol) return;
      const key = `${row.symbol}|${row.file}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(row);
    };

    for (const site of resolvedReferences.get(symbol.symbolId) ?? []) {
      if (site.file === symbol.relativePath) continue;
      add({
        symbol: site.enclosingSymbol ?? site.file,
        file: site.file,
        source: 'resolved-reference',
      });
    }

    const definition = definitionBySymbolId.get(symbol.symbolId);
    if (definition) {
      for (const reference of semanticReferences.get(definition.symbolId) ?? []) {
        if (reference.file === symbol.relativePath || db.isIgnored(reference.file)) continue;
        const enclosing = findEnclosingDefinition(getDefinitionsForFile(db, reference.file), reference.line);
        add({
          symbol: enclosing?.symbol ?? reference.file,
          file: reference.file,
          source: 'semantic-reference',
        });
      }
    }

    result.set(symbol.symbolId, rows);
  }

  return result;
}

function indexedDefinitionForSymbol(db: ScipDatabase, symbol: SymbolMatch): IndexedDefinition | null {
  const functionLikeKinds = scipFunctionLikeKindNumbers().join(', ');
  const typeLikeKinds = scipTypeLikeKindNumbers().join(', ');
  return (
    db.get<IndexedDefinition>(
      `SELECT
       d.id AS documentId,
       gs.id AS symbolId,
       gs.symbol,
       d.relative_path AS relativePath,
       COALESCE(der.start_line, c.start_line) AS startLine,
       COALESCE(der.end_line, c.end_line) AS endLine,
       COALESCE(gs.display_name, '') AS leaf,
       NULL AS parentTypeName,
       CASE WHEN gs.kind IN (${functionLikeKinds}) OR gs.symbol LIKE '%().' THEN 1 ELSE 0 END AS isFunctionLike,
       CASE WHEN gs.kind IN (${typeLikeKinds}) THEN 1 ELSE 0 END AS isTypeLike,
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
    ) ?? null
  );
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
  opts: { additive?: boolean; semantic?: boolean; semanticEvidence?: SymbolSemanticEvidencePort } = {},
): Map<number, CalleeRow[]> {
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

  const merged = new Map<number, CalleeRow[]>();
  const seenBySymbolId = new Map<number, Set<string>>();
  const addAll = (src: Map<number, CalleeRow[]>): void => {
    for (const [id, list] of src) {
      let bucket = merged.get(id);
      if (!bucket) {
        bucket = [];
        merged.set(id, bucket);
      }
      let seen = seenBySymbolId.get(id);
      if (!seen) {
        seen = new Set();
        seenBySymbolId.set(id, seen);
      }
      for (const c of list) {
        const key = `${c.symbol}|${c.chunkId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bucket.push(c);
      }
    }
  };

  if (astDefs.length > 0) addAll(buildAstCalleeMap(db, astDefs));
  if (opts.semantic !== false && opts.semanticEvidence) {
    addAll(toCalleeRows(opts.semanticEvidence.calleeMap(db, definitions)));
  }
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
export function buildAstCalleeMap(db: ScipDatabase, definitions: ReadonlyArray<SymbolMatch>): Map<number, CalleeRow[]> {
  const result = new Map<number, CalleeRow[]>();
  const byFile = definitionsByFile(definitions, result);
  const leafIndex = getGlobalLeafIndex(db);

  for (const [file, fileDefs] of byFile) {
    const callsites = getCallSites(db, file);
    if (!callsites) continue; // Source unreadable — defs return empty callee arrays.
    const ownerByLine = createDefinitionLineIndex(fileDefs);

    for (const site of callsites) {
      const owner = ownerByLine.get(site.line);
      if (!owner) continue;

      const pick = resolveAstCalleeCandidate(db, file, leafIndex, site);
      if (!pick) continue;
      if (pick.symbol === owner.symbol) continue; // skip self-recursion

      result.get(owner.symbolId)!.push({
        symbol: pick.symbol,
        file: pick.file,
        chunkId: site.line,
        source: 'ast-callsite',
      });
    }
  }

  return result;
}

function definitionsByFile(
  definitions: ReadonlyArray<SymbolMatch>,
  result: Map<number, CalleeRow[]>,
): Map<string, SymbolMatch[]> {
  const byFile = new Map<string, SymbolMatch[]>();
  for (const def of definitions) {
    const arr = byFile.get(def.relativePath);
    if (arr) arr.push(def);
    else byFile.set(def.relativePath, [def]);
    result.set(def.symbolId, []);
  }
  for (const defs of byFile.values()) {
    defs.sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine));
  }
  return byFile;
}

function resolveAstCalleeCandidate(
  db: ScipDatabase,
  file: string,
  leafIndex: Map<string, GlobalLeafCandidate[]>,
  site: { calleeLeaf: string; calleeQualifier?: string; memberAccess: boolean },
): GlobalLeafCandidate | null {
  const candidates = sameLanguageCandidates(file, leafIndex.get(site.calleeLeaf) ?? []);
  if (candidates.length === 0) return null;
  const clojurePick = pickClojureQualifiedCandidate(db, file, candidates, site.calleeQualifier);
  if (clojurePick) return clojurePick;
  return pickAstCallCandidate(db, file, candidates, site.memberAccess);
}

function pickClojureQualifiedCandidate<T extends { symbol: string; file: string }>(
  db: ScipDatabase,
  sourceFile: string,
  candidates: T[],
  qualifier: string | undefined,
): T | null {
  if (!qualifier || detectAstLanguage(sourceFile) !== 'clojure') return null;
  const imports = getSourceImports(db, sourceFile);
  const importedSourcePaths = imports
    .filter((entry) => entry.kind === 'namespace' && entry.localName === qualifier && entry.sourcePath)
    .map((entry) => entry.sourcePath!);

  for (const sourcePath of importedSourcePaths) {
    const imported = candidates.find((candidate) => pathsResolveSame(sourcePath, candidate.file));
    if (imported) return imported;
  }

  return candidates.find((candidate) => /`([^`]+)`\//.exec(candidate.symbol)?.[1] === qualifier) ?? null;
}

// scip-query: ignore-extract - this pass keeps SQL fetches, range matching, and source confirmation together.
export function buildChunkCalleeMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<SymbolLocation>,
): Map<number, CalleeRow[]> {
  if (definitions.length === 0) return new Map();
  const definitionDocumentIds = uniqueNumbers(definitions.map((def) => def.documentId));

  type ChunkMentionRow = {
    document_id: number;
    chunk_id: number;
    start_line: number;
    end_line: number;
    symbol_id: number;
  };
  const refRows = definitionDocumentIds.flatMap((documentIds) =>
    db.all<ChunkMentionRow>(
      `SELECT c.document_id, c.id AS chunk_id, c.start_line, c.end_line, m.symbol_id
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     WHERE m.role != 1
       AND c.document_id IN (${documentIds.map(() => '?').join(',')})`,
      ...documentIds,
    ),
  );

  // Group by document
  const byDoc = new Map<number, ChunkMentionRow[]>();
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
  const mentionedSymbolIds = uniqueNumbers(refRows.map((row) => row.symbol_id));
  const calleeRows = mentionedSymbolIds.flatMap((symbolIds) =>
    db.all<{ symbol_id: number; symbol: string; document_id: number | null }>(
      `SELECT gs.id AS symbol_id, gs.symbol,
            COALESCE(der.document_id, def_chunk.document_id) AS document_id
     FROM global_symbols gs
     LEFT JOIN defn_enclosing_ranges der ON der.symbol_id = gs.id
     LEFT JOIN (
       SELECT m.symbol_id, MIN(c.document_id) AS document_id
       FROM mentions m
       JOIN chunks c ON m.chunk_id = c.id
       WHERE m.role = 1
         AND m.symbol_id IN (${symbolIds.map(() => '?').join(',')})
       GROUP BY m.symbol_id
     ) def_chunk ON def_chunk.symbol_id = gs.id
     WHERE gs.id IN (${symbolIds.map(() => '?').join(',')})`,
      ...symbolIds,
      ...symbolIds,
    ),
  );
  const documentIdsForPaths = uniqueNumbers([
    ...definitions.map((def) => def.documentId),
    ...calleeRows.flatMap((row) => (row.document_id === null ? [] : [row.document_id])),
  ]);
  const docPaths = new Map<number, string>(
    documentIdsForPaths.flatMap((documentIds) =>
      db
        .all<{ id: number; relative_path: string }>(
          `SELECT id, relative_path FROM documents
       WHERE id IN (${documentIds.map(() => '?').join(',')})`,
          ...documentIds,
        )
        .map((r) => [r.id, r.relative_path] as const),
    ),
  );
  const calleeInfo = new Map<number, { symbol: string; file: string }>();
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
  const result = new Map<number, CalleeRow[]>();
  const filePathById = docPaths;
  const definitionsByDoc = symbolLocationsByDocument(definitions);
  for (const [documentId, docDefinitions] of definitionsByDoc) {
    const docMentions = byDoc.get(documentId) ?? [];
    const orderedMentions = [...docMentions].sort(
      (left, right) => left.start_line - right.start_line || left.end_line - right.end_line,
    );
    const orderedDefinitions = [...docDefinitions].sort(
      (left, right) => left.startLine - right.startLine || left.endLine - right.endLine,
    );
    const activeMentions = new Set<ChunkMentionRow>();
    let mentionCursor = 0;

    for (const def of orderedDefinitions) {
      while (mentionCursor < orderedMentions.length && orderedMentions[mentionCursor]!.start_line <= def.endLine) {
        activeMentions.add(orderedMentions[mentionCursor]!);
        mentionCursor += 1;
      }
      for (const mention of activeMentions) {
        if (mention.end_line < def.startLine) activeMentions.delete(mention);
      }

      const seenKey = new Set<string>();
      const callees: CalleeRow[] = [];
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

      for (const m of activeMentions) {
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
        callees.push({ ...info, chunkId: m.chunk_id, source: 'scip-chunk' });
      }
      result.set(def.symbolId, callees);
    }
  }

  return result;
}

const SQLITE_IN_BATCH_SIZE = 500;

function uniqueNumbers(values: Iterable<number>): number[][] {
  const unique = [...new Set(values)];
  const batches: number[][] = [];
  for (let i = 0; i < unique.length; i += SQLITE_IN_BATCH_SIZE) {
    batches.push(unique.slice(i, i + SQLITE_IN_BATCH_SIZE));
  }
  return batches;
}

function symbolLocationsByDocument(definitions: ReadonlyArray<SymbolLocation>): Map<number, SymbolLocation[]> {
  const byDocument = new Map<number, SymbolLocation[]>();
  for (const definition of definitions) {
    const bucket = byDocument.get(definition.documentId);
    if (bucket) bucket.push(definition);
    else byDocument.set(definition.documentId, [definition]);
  }
  return byDocument;
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
function toCalleeRows(semantic: Map<number, Array<{ symbol: string; file: string }>>): Map<number, CalleeRow[]> {
  const out = new Map<number, CalleeRow[]>();
  for (const [symbolId, callees] of semantic) {
    const rows: CalleeRow[] = [];
    for (const callee of callees) {
      rows.push({ symbol: callee.symbol, file: callee.file, chunkId: -1, source: 'semantic-callee' });
    }
    out.set(symbolId, rows);
  }
  return out;
}
