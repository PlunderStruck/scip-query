import { basename, extname } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { findEnclosingDefinition } from '../../symbols/definition-catalog.js';
import { getIdentifierLineMap } from '../../symbols/identifier-index.js';
import { leafName } from '../../symbols/symbol-parser.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { isInRustTestModule, ownerQualifiedLeafName, shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../internal/project-index.js';
import { compareDefinitionsBySmallestLoc, definitionLoc } from '../query-utils.js';
import { runCandidateAnalysis } from '../internal/candidate-scan.js';
import {
  consumerEvidenceProduct,
  consumerFileMapFromEvidence,
  partitionDefinitionConsumers,
} from '../internal/consumer-evidence.js';
import { mergeSetMaps } from '../../symbols/references/caller-evidence.js';
import { boundaryEvidenceForSurfaces } from './boundary-evidence.js';
import { definitionSourceSnippet, extractImplementationBody } from './duplicate-bodies.js';
import { stripCommentsAndStrings } from '../../source/primitives/source-stripper.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import { isSingleForwardingCallBody } from './twin-drift.js';
import { profileSpan } from '../../instrumentation/profile.js';
import { isClojureMacroDefinition } from '../../source/ast.js';

export type WrapperActionTier = 'direct' | 'signal';
/**
 * `forwarding`: the body is exactly one call (optionally returned or awaited)
 * whose arguments are plain values — the shape the wrapper claim describes.
 * `helper`: the body prepares something first, passes a callback, a nested
 * call, or a literal it builds, or branches; it merely has one consumer.
 */
export type WrapperBodyShape = 'forwarding' | 'helper';

export interface WrapperCandidate {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  singleCaller: string;
  singleCallerShort: string;
  callerFanIn: number;
  actionTier: WrapperActionTier;
  bodyShape: WrapperBodyShape;
  boundaryEvidence: string[];
}

interface MentionChunk {
  start_line: number;
  end_line: number;
}

/**
 * Find wrapper candidates: symbols called by only one other symbol.
 *
 * These are premature abstractions that add indirection without
 * providing reuse. A function with fan-in = 1 whose sole caller
 * is widely used is a strong signal of unnecessary wrapping.
 */
// scip-query: ignore-extract — this is the wrapper-candidate scoring pipeline:
// production symbols, indexed callers, source fallback callers, and reverse
// file fan-in are the evidence model for this command.
export function wrapperCandidates(
  db: ScipDatabase,
  opts?: { scope?: string; maxLoc?: number; limit?: number; scanLimit?: number; semantic?: boolean },
): WrapperCandidate[] {
  const { scope, maxLoc = 15, limit = 30, scanLimit } = opts ?? {};
  const index = new ProjectIndex(db);
  const reverseFanIn = buildReverseFileFanIn(index.fileDependencyGraph(scope));
  const receivers = new Map<string, string>();
  const results = runCandidateAnalysis({
    candidates: () => getWrapperCandidateSymbols(db, index, scope, maxLoc),
    orderCandidates: compareDefinitionsBySmallestLoc,
    scanLimit,
    profile: { name: 'wrapper-candidates' },
    prepare: (symbols) => ({
      // Source-text fallback adds back references the indexer may miss; without
      // it, dynamic dispatch or macro-style calls can falsely look like wrappers.
      callerFileMap: consumerMapForWrapperCandidates(db, index, symbols, { semantic: opts?.semantic !== false }),
      reverseFanIn,
      receivers,
    }),
    evaluate: (symbol, maps) => wrapperCandidateForSymbol(db, index, symbol, maps),
    orderResults: (left, right) => right.callerFanIn - left.callerFanIn || right.loc - left.loc,
    limit,
  });
  return applyWrapperFacadeEvidence(results, receivers);
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function consumerMapForWrapperCandidates(
  db: ScipDatabase,
  index: ProjectIndex,
  symbols: readonly IndexedDefinition[],
  opts: { semantic: boolean },
): Map<number, Set<string>> {
  const product = consumerEvidenceProduct(db, index);
  const indexedConsumerFileMap = consumerFileMapFromEvidence(
    product.forDefinitions(symbols, {
      semantic: false,
      sourceFallback: false,
    }),
  );
  let semanticCandidates: IndexedDefinition[] = [];
  if (opts.semantic) {
    profileSpan(
      'wrapper.semantic-candidates',
      () => {
        semanticCandidates = symbols.filter(
          (symbol) => externalCallerFiles(db, index, symbol, indexedConsumerFileMap).length <= 1,
        );
      },
      () => ({ symbols: symbols.length, semanticCandidates: semanticCandidates.length }),
    );
  }
  const semanticConsumerFileMap =
    semanticCandidates.length === 0
      ? new Map<number, Set<string>>()
      : consumerFileMapFromEvidence(
          product.forDefinitions(semanticCandidates, {
            semantic: true,
            sourceFallback: false,
          }),
        );
  const consumerFileMap =
    semanticConsumerFileMap.size === 0
      ? indexedConsumerFileMap
      : mergeSetMaps(indexedConsumerFileMap, semanticConsumerFileMap);
  const symbolById = new Map(symbols.map((symbol) => [symbol.symbolId, symbol]));
  const fallbackCandidatesById = new Map<number, IndexedDefinition>();
  for (const symbol of symbols) {
    const externalFiles = externalCallerFiles(db, index, symbol, consumerFileMap);
    if (externalFiles.length > 1) continue;
    fallbackCandidatesById.set(symbol.symbolId, symbol);
    if (externalFiles.length !== 1) continue;

    const callerFile = externalFiles[0]!;
    const refRow = mentionChunkForCaller(db, symbol.symbolId, callerFile);
    if (!refRow) continue;
    const enclosing = enclosingCaller(index, db, callerFile, symbol.symbol, refRow);
    if (enclosing?.isFunctionLike && symbolById.has(enclosing.symbolId)) {
      fallbackCandidatesById.set(enclosing.symbolId, symbolById.get(enclosing.symbolId)!);
    }
  }
  const fallbackCandidates = [...fallbackCandidatesById.values()];
  return fallbackCandidates.length === 0
    ? consumerFileMap
    : mergeSetMaps(
        consumerFileMap,
        consumerFileMapFromEvidence(
          product.forDefinitions(fallbackCandidates, {
            semantic: false,
            sourceFallback: true,
          }),
        ),
      );
}

// scip-query: ignore-extract — this is the single-symbol wrapper decision:
// external caller count, enclosing caller, test-module guard, and fan-in
// threshold must be read together to understand the finding.
function wrapperCandidateForSymbol(
  db: ScipDatabase,
  index: ProjectIndex,
  symbol: IndexedDefinition,
  maps: {
    callerFileMap: Map<number, Set<string>>;
    reverseFanIn: Map<string, number>;
    /** Root identifier each forwarding wrapper calls through, by wrapper symbol; feeds the facade post-pass. */
    receivers: Map<string, string>;
  },
): WrapperCandidate | null {
  const externalFiles = externalCallerFiles(db, index, symbol, maps.callerFileMap);
  if (externalFiles.length !== 1) return null;

  const callerFile = externalFiles[0]!;
  const refRow = mentionChunkForCaller(db, symbol.symbolId, callerFile);
  if (!refRow) return null;

  const enclosing = enclosingCaller(index, db, callerFile, symbol.symbol, refRow);
  // If the only caller is a function inside a `#[cfg(test)] mod tests`
  // block (regardless of whether the file itself is classified as a test
  // file), the wrapper metric isn't useful — that's a "used only in
  // tests" signal, distinct from production over-abstraction.
  if (enclosing && isInRustTestModule(enclosing.symbol)) return null;

  const { fanIn: callerFanIn, source: fanInSource } = wrapperCallerFanIn(
    maps.callerFileMap,
    maps.reverseFanIn,
    callerFile,
    enclosing,
  );
  // Function-level fan-in is precise evidence. File-level fan-in is a proxy
  // that a single new importer can bump — require a margin so one added
  // import doesn't flip a whole family of borderline findings at once.
  if (fanInSource === 'function' ? callerFanIn <= 3 : callerFanIn <= 5) return null;

  const boundaryEvidence = wrapperBoundaryEvidence(db, symbol, callerFile, enclosing);
  const bodyShape = wrapperBodyShape(db, symbol);
  if (bodyShape === 'helper') boundaryEvidence.push('body computes or branches rather than forwarding one call');
  const receiver = bodyShape === 'forwarding' ? forwardReceiver(db, symbol) : null;
  if (receiver) maps.receivers.set(symbol.symbol, receiver);
  const privateState = receiver && isModulePrivateVariable(db, symbol.relativePath, receiver) ? receiver : null;
  if (privateState) boundaryEvidence.push(`forwards through module-private state: ${privateState}`);
  return {
    symbol: symbol.symbol,
    shortName: shortenSymbol(symbol.symbol),
    file: symbol.relativePath,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    loc: definitionLoc(symbol),
    singleCaller: enclosing?.symbol ?? '',
    singleCallerShort: enclosing?.isFunctionLike ? shortenSymbol(enclosing.symbol) : basename(callerFile),
    callerFanIn,
    // Direct advice ("inline this wrapper") needs a wrapper-shaped body and no
    // boundary evidence; a single-consumer helper is a review signal only.
    actionTier: boundaryEvidence.length > 0 ? 'signal' : 'direct',
    bodyShape,
    boundaryEvidence,
  };
}

/** The root identifier a forwarding wrapper calls through (`loadedLanguages` in `loadedLanguages.has(lang)`, `copy` in `copy.deals.title(x)`). */
function forwardReceiver(db: ScipDatabase, symbol: IndexedDefinition): string | null {
  const snippet = definitionSourceSnippet(db, symbol);
  if (!snippet) return null;
  const body = stripCommentsAndStrings(extractImplementationBody(snippet)).trim();
  const receiver = /^(?:return\s+)?(?:await\s+)?([A-Za-z_$][\w$]*)\s*[.(]/.exec(body)?.[1];
  if (!receiver || receiver === 'this' || receiver === 'super') return null;
  return receiver;
}

/**
 * `isLanguageLoaded(lang) { return loadedLanguages.has(lang); }` forwards one
 * call, but the receiver is a module-private variable: inlining the wrapper
 * into its consumer would export the state the wrapper exists to hide.
 */
function isModulePrivateVariable(db: ScipDatabase, relativePath: string, receiver: string): boolean {
  const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const privateDeclaration = new RegExp(`^(?:const|let|var)\\s+${escaped}\\b`);
  return getSourceLines(db, relativePath).some((line) => privateDeclaration.test(line));
}

/** Sibling forwards from one file through one receiver that make the file a facade over it. */
const WRAPPER_FACADE_SIBLING_FORWARDS = 3;

/**
 * A file of wrappers that all forward through one receiver (`copy.ts`
 * building notification copy from one catalog object) is a facade over that
 * collaborator: inlining any one of them would breach the surface the file
 * keeps, so the family is a boundary signal rather than inline advice.
 */
export function applyWrapperFacadeEvidence(
  candidates: readonly WrapperCandidate[],
  receivers: ReadonlyMap<string, string>,
): WrapperCandidate[] {
  const siblings = new Map<string, number>();
  const keyFor = (candidate: WrapperCandidate): string | null => {
    const receiver = receivers.get(candidate.symbol);
    return receiver && candidate.bodyShape === 'forwarding' ? `${candidate.file}\u0000${receiver}` : null;
  };
  for (const candidate of candidates) {
    const key = keyFor(candidate);
    if (key) siblings.set(key, (siblings.get(key) ?? 0) + 1);
  }
  return candidates.map((candidate) => {
    const key = keyFor(candidate);
    const count = key ? (siblings.get(key) ?? 0) : 0;
    if (count < WRAPPER_FACADE_SIBLING_FORWARDS) return candidate;
    const receiver = receivers.get(candidate.symbol)!;
    return {
      ...candidate,
      actionTier: 'signal',
      boundaryEvidence: [
        ...candidate.boundaryEvidence,
        `facade: ${count} sibling forwards from this file through ${receiver}`,
      ],
    };
  });
}

function wrapperBodyShape(db: ScipDatabase, symbol: IndexedDefinition): WrapperBodyShape {
  const snippet = definitionSourceSnippet(db, symbol);
  if (!snippet) return 'helper';
  return isSingleForwardingCallBody(snippet) ? 'forwarding' : 'helper';
}

function getWrapperCandidateSymbols(
  db: ScipDatabase,
  index: ProjectIndex,
  scope: string | undefined,
  maxLoc: number,
): IndexedDefinition[] {
  return (
    index
      .productionCallableDefinitions({
        scope,
        minLoc: 2,
        maxLoc,
        requireFunctionLikeSymbol: true,
        // "Inline this wrapper" is wrong advice for published API — external
        // consumers the index can't see depend on the wrapper staying put.
        excludeRootedSymbols: true,
        // Trait-required methods are contract implementations, not removable
        // wrappers, even when only one repository caller invokes them directly.
        excludeRustTraitImplMembers: true,
      })
      .filter((definition) => !isClojureMacroDefinition(db, definition))
      // A constructor is instantiated, not wrapped; scip names it `<constructor>`
      // and every class has exactly one, so it can never be inlined.
      .filter((definition) => !isSyntheticLeaf(definition.leaf))
  );
}

function isSyntheticLeaf(leaf: string | null | undefined): boolean {
  return typeof leaf === 'string' && leaf.startsWith('<') && leaf.endsWith('>');
}

function externalCallerFiles(
  db: ScipDatabase,
  index: ProjectIndex,
  symbol: IndexedDefinition,
  callerFileMap: Map<number, Set<string>>,
): string[] {
  const symbolStem = basename(symbol.relativePath, extname(symbol.relativePath));
  // Cheap bulk check first: skip if not exactly 1 external caller file
  // (excluding same stem). Also exclude entry/barrel/test files —
  // entries and barrels are re-export / bootstrap surfaces, not real
  // wrapping callers. Test files indicate the function is exercised
  // from tests; the wrapper signal is supposed to flag production
  // indirection, not "only used in tests" (which is a different
  // signal — likely dead production code, surfaced by `dead`).
  const consumerFiles = [...(callerFileMap.get(symbol.symbolId) ?? [])]
    .filter((f) => f !== symbol.relativePath)
    .filter((f) => basename(f, extname(f)) !== symbolStem)
    .filter((f) => {
      const kind = index.fileKind(f);
      return kind !== 'barrel' && kind !== 'entry' && kind !== 'test';
    });
  return partitionDefinitionConsumers(db, symbol, consumerFiles).realConsumers;
}

function mentionChunkForCaller(db: ScipDatabase, symbolId: number, callerFile: string): MentionChunk | undefined {
  return db.get<MentionChunk>(
    `SELECT c.start_line, c.end_line
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents d ON c.document_id = d.id
     WHERE m.symbol_id = ? AND m.role != 1 AND d.relative_path = ?
     LIMIT 1`,
    symbolId,
    callerFile,
  );
}

function enclosingCaller(
  index: ProjectIndex,
  db: ScipDatabase,
  callerFile: string,
  symbol: string,
  refRow: MentionChunk,
): IndexedDefinition | null {
  // SCIP gives us the chunk that contains the reference, but chunks can be
  // file-wide. Refine via source-text scan: find the lines within the chunk's
  // range where the symbol's leaf identifier appears, and prefer the first
  // one that sits inside a callable — the import line names the symbol too,
  // and choosing it would lose the function-level caller and its fan-in.
  const callerDefs = index.definitionsForFile(callerFile);
  for (const line of candidateCallSiteLines(db, callerFile, symbol, refRow.start_line, refRow.end_line)) {
    const enclosing = findEnclosingDefinition(callerDefs, line);
    if (enclosing?.isFunctionLike) return enclosing;
  }
  return findEnclosingDefinition(
    callerDefs,
    refineCallSiteLine(db, callerFile, symbol, refRow.start_line, refRow.end_line),
  );
}

function candidateCallSiteLines(
  db: ScipDatabase,
  file: string,
  symbol: string,
  chunkStart: number,
  chunkEnd: number,
): number[] {
  const leaf = leafName(symbol);
  if (!leaf) return [];
  return (getIdentifierLineMap(db, file).get(leaf) ?? []).filter((line) => line >= chunkStart && line <= chunkEnd);
}

function wrapperCallerFanIn(
  callerFileMap: Map<number, Set<string>>,
  reverseFanIn: Map<string, number>,
  callerFile: string,
  enclosing: IndexedDefinition | null,
): { fanIn: number; source: 'function' | 'file' } {
  // Fan-in: function-level from bulk map, or file-level as fallback.
  if (enclosing?.isFunctionLike) {
    const extCallers = [...(callerFileMap.get(enclosing.symbolId) ?? [])].filter((f) => f !== enclosing.relativePath);
    if (extCallers.length > 0) return { fanIn: extCallers.length, source: 'function' };
  }
  return { fanIn: fallbackCallerFanIn(reverseFanIn, callerFile), source: 'file' };
}

/**
 * Refine a SCIP chunk's start line to the actual line where the symbol's
 * leaf identifier appears, scanning the chunk's range only. Uses the cached
 * AST/regex identifier-line map. Falls back to the chunk start when the leaf
 * isn't present (defensive — shouldn't happen if the SCIP mention is real).
 */
function refineCallSiteLine(
  db: ScipDatabase,
  file: string,
  symbol: string,
  chunkStart: number,
  chunkEnd: number,
): number {
  const leaf = leafName(symbol);
  if (!leaf) return chunkStart;
  const lines = getIdentifierLineMap(db, file).get(leaf);
  if (!lines || lines.length === 0) return chunkStart;
  for (const line of lines) {
    if (line >= chunkStart && line <= chunkEnd) return line;
  }
  return chunkStart;
}

function buildReverseFileFanIn(graph: Map<string, Set<string>>): Map<string, number> {
  const reverse = new Map<string, number>();
  for (const [fromFile, deps] of graph) {
    if (!reverse.has(fromFile)) {
      reverse.set(fromFile, reverse.get(fromFile) ?? 0);
    }
    for (const dep of deps) {
      reverse.set(dep, (reverse.get(dep) ?? 0) + 1);
    }
  }
  return reverse;
}

function fallbackCallerFanIn(reverseFanIn: Map<string, number>, callerFile: string): number {
  const direct = reverseFanIn.get(callerFile) ?? 0;
  if (direct > 0) {
    return direct;
  }

  const stem = basename(callerFile, extname(callerFile));
  let best = 0;
  for (const [file, fanIn] of reverseFanIn) {
    if (file === callerFile) continue;
    if (basename(file, extname(file)) !== stem) continue;
    if (fanIn > best) {
      best = fanIn;
    }
  }

  return best;
}

function wrapperBoundaryEvidence(
  db: ScipDatabase,
  symbol: IndexedDefinition,
  callerFile: string,
  enclosing: IndexedDefinition | null,
): string[] {
  return boundaryEvidenceForSurfaces(
    db,
    symbol.relativePath,
    symbol.startLine,
    'wrapper',
    'explicit ignore-wrapper comment',
    [
      { label: 'wrapper name', value: ownerQualifiedLeafName(symbol.symbol), side: 'self' },
      {
        label: 'caller name',
        value: enclosing?.symbol ? ownerQualifiedLeafName(enclosing.symbol) : basename(callerFile),
        side: 'other',
      },
      { label: 'wrapper path', value: symbol.relativePath, side: 'self' },
      { label: 'caller path', value: callerFile, side: 'other' },
    ],
  );
}
