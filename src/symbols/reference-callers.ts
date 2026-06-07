import type { ScipDatabase } from '../storage/db.js';
import { detectAstLanguage, getCallSites } from '../source/ast.js';
import { getRustAttrReferencedNames } from '../analysis/framework-patterns.js';
import { semanticCallerMap } from '../semantic/shared-primitives.js';
import type { IndexedDefinition, SymbolLocation } from '../domain/types.js';
import { getAllDefinitions } from './definition-catalog.js';
import { getGlobalLeafIndex, pickAstCallCandidate, sameLanguageCandidates } from './reference-graph.js';
import type { GlobalLeafCandidate } from './reference-graph.js';

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

export function buildCrossFileCallerMap(
  db: ScipDatabase,
  definitions?: ReadonlyArray<SymbolLocation>,
  opts: { semantic?: boolean } = {},
): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();
  if (definitions && definitions.length === 0) {
    return map;
  }
  const docs = db.all<{ relative_path: string }>(
    `SELECT relative_path FROM documents
     WHERE 1 = 1 ${db.pathExclusionsFor('documents')}`,
  );
  const leafIndex = getGlobalLeafIndex(db);
  const effectiveDefinitions = definitions ?? getAllDefinitions(db);
  const targetSymbolIds = new Set(effectiveDefinitions.map((definition) => definition.symbolId));

  addAstCallsiteCallers(db, map, docs, leafIndex, targetSymbolIds);
  addChunkMentionCallers(db, map, effectiveDefinitions, targetSymbolIds);
  addRustAttrCallers(db, map, docs, leafIndex, targetSymbolIds);
  if (opts.semantic !== false) {
    mergeCallerSets(map, semanticCallerMap(db, indexedDefinitions(effectiveDefinitions)));
  }

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
  targetSymbolIds: ReadonlySet<number>,
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
      if (!targetSymbolIds.has(pick.symbolId)) continue;
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
  targetSymbolIds: ReadonlySet<number>,
): void {
  const selfRanges = definitionSelfRanges(definitions);
  for (const row of loadChunkMentionCallerRows(db, targetSymbolIds)) {
    if (db.isIgnored(row.relative_path)) continue;
    if (isSelfChunkMention(row, selfRanges.get(row.symbol_id))) continue;
    addCallerFile(map, row.symbol_id, row.relative_path);
  }
}

function loadChunkMentionCallerRows(
  db: ScipDatabase,
  targetSymbolIds: ReadonlySet<number> | undefined,
): ChunkMentionCallerRow[] {
  if (!targetSymbolIds) {
    return loadChunkMentionCallerRowsBatch(db);
  }

  const ids = [...targetSymbolIds];
  if (ids.length === 0) return [];
  const rows: ChunkMentionCallerRow[] = [];
  for (let offset = 0; offset < ids.length; offset += SQLITE_PARAM_BATCH_SIZE) {
    rows.push(...loadChunkMentionCallerRowsBatch(db, ids.slice(offset, offset + SQLITE_PARAM_BATCH_SIZE)));
  }
  return rows;
}

const SQLITE_PARAM_BATCH_SIZE = 750;

function loadChunkMentionCallerRowsBatch(
  db: ScipDatabase,
  symbolIds?: readonly number[],
): ChunkMentionCallerRow[] {
  const symbolFilter = symbolIds && symbolIds.length > 0
    ? `AND m.symbol_id IN (${symbolIds.map(() => '?').join(',')})`
    : '';
  return db.all<ChunkMentionCallerRow>(
    `SELECT DISTINCT m.symbol_id, d.relative_path, c.document_id,
            c.start_line AS chunk_start, c.end_line AS chunk_end
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.role != 1
       ${symbolFilter}
       ${db.pathExclusionsFor('d')}`,
    ...(symbolIds ?? []),
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
  targetSymbolIds: ReadonlySet<number>,
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
        if (!targetSymbolIds.has(c.symbolId)) continue;
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
