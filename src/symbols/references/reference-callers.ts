import type { ScipDatabase } from '../../storage/db.js';
import { detectAstLanguage, frameworkSourceReferences, getCallSites } from '../../source/ast.js';
import { semanticCallerMap } from '../../semantic/shared-primitives.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { mentionReferenceChunkRows } from '../../storage/scip-mentions.js';
import type { IndexedDefinition, SymbolLocation } from '../../domain/types.js';
import { getAllDefinitions } from '../definition-catalog.js';
import { getGlobalLeafIndex, pickAstCallCandidate, sameLanguageCandidates } from '../leaf-symbol-index.js';
import type { GlobalLeafCandidate } from '../leaf-symbol-index.js';

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

// scip-query: ignore-extract — this assembles one caller evidence map from
// AST callsites, SCIP chunk mentions, Rust attributes, and semantic callers.
// Splitting the orchestration would hide the precedence/merge contract.
export function buildCrossFileCallerMap(
  db: ScipDatabase,
  definitions?: ReadonlyArray<SymbolLocation>,
  opts: { semantic?: boolean } = {},
): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();
  if (definitions && definitions.length === 0) {
    return map;
  }
  const docs = indexedDocumentPaths(db, { includeIgnored: false });
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
  docs: readonly string[],
  leafIndex: Map<string, GlobalLeafCandidate[]>,
  targetSymbolIds: ReadonlySet<number>,
): void {
  // For supported files, walk callsites and attribute each call to the symbol
  // whose leaf it names. This is additive to the chunk path: call_expression
  // nodes catch functions while SCIP mentions catch type-position references.
  for (const doc of docs) {
    if (!detectAstLanguage(doc)) continue;
    const callsites = getCallSites(db, doc);
    if (!callsites) continue;
    for (const site of callsites) {
      const candidates = sameLanguageCandidates(doc, leafIndex.get(site.calleeLeaf) ?? []);
      if (!candidates || candidates.length === 0) continue;
      const pick = pickAstCallCandidate(db, doc, candidates, site.memberAccess);
      if (!pick) continue;
      if (!targetSymbolIds.has(pick.symbolId)) continue;
      // Cross-file caller only — self-references skipped.
      if (pick.file === doc) continue;
      addCallerFile(map, pick.symbolId, doc);
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
  return mentionReferenceChunkRows(db, targetSymbolIds ? [...targetSymbolIds] : undefined);
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
  return (
    !!range && range.docId === row.document_id && row.chunk_start >= range.startLine && row.chunk_end <= range.endLine
  );
}

function addRustAttrCallers(
  db: ScipDatabase,
  map: Map<number, Set<string>>,
  docs: readonly string[],
  leafIndex: Map<string, GlobalLeafCandidate[]>,
  targetSymbolIds: ReadonlySet<number>,
): void {
  // String-attr helpers (`#[serde(default = "fn")]`, etc.) are framework
  // dispatches that SCIP does not connect back to the helper definition.
  for (const doc of docs) {
    if (detectAstLanguage(doc) !== 'rust') continue;
    const attrRefs = frameworkSourceReferences(db, doc, { includeRustAttributeNames: true });
    if (attrRefs.length === 0) continue;
    for (const { name } of attrRefs) {
      const candidates = leafIndex.get(name);
      if (!candidates) continue;
      for (const c of candidates) {
        if (!targetSymbolIds.has(c.symbolId)) continue;
        if (c.file === doc) continue; // self-ref, not a caller
        addCallerFile(map, c.symbolId, doc);
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
  return definitions.filter(
    (definition): definition is IndexedDefinition =>
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
