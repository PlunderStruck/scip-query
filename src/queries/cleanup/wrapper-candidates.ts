import { basename, extname } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { findEnclosingDefinition } from '../../symbols/definition-catalog.js';
import { getIdentifierLineMap } from '../../symbols/identifier-index.js';
import { leafName } from '../../symbols/symbol-parser.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { isInRustTestModule, shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../../core/project-index.js';
import { compareDefinitionsBySmallestLoc, definitionLoc } from '../query-utils.js';
import { runCandidateAnalysis } from '../internal/candidate-scan.js';
import { definitionConsumerFileMap, partitionDefinitionConsumers } from '../internal/consumer-evidence.js';

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
  return runCandidateAnalysis({
    candidates: () => getWrapperCandidateSymbols(index, scope, maxLoc),
    orderCandidates: compareDefinitionsBySmallestLoc,
    scanLimit,
    prepare: (symbols) => ({
      // Source-text fallback adds back references the indexer may miss; without
      // it, dynamic dispatch or macro-style calls can falsely look like wrappers.
      callerFileMap: definitionConsumerFileMap(index, symbols, { semantic: opts?.semantic !== false }),
      reverseFanIn,
    }),
    evaluate: (symbol, maps) => wrapperCandidateForSymbol(db, index, symbol, maps),
    orderResults: (left, right) => right.callerFanIn - left.callerFanIn || right.loc - left.loc,
    limit,
  });
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
  };
}

function getWrapperCandidateSymbols(
  index: ProjectIndex,
  scope: string | undefined,
  maxLoc: number,
): IndexedDefinition[] {
  return index.productionCallableDefinitions({
    scope,
    minLoc: 2,
    maxLoc,
    requireFunctionLikeSymbol: true,
    // "Inline this wrapper" is wrong advice for published API — external
    // consumers the index can't see depend on the wrapper staying put.
    excludeRootedSymbols: true,
  });
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
  // file-wide. Refine via source-text scan: find a line within the chunk's
  // range where the symbol's leaf identifier actually appears, then look up
  // the enclosing definition from that precise line. Falls back to the
  // chunk's start line when source isn't readable / leaf isn't unique.
  const callerDefs = index.definitionsForFile(callerFile);
  const refinedLine = refineCallSiteLine(db, callerFile, symbol, refRow.start_line, refRow.end_line);
  return findEnclosingDefinition(callerDefs, refinedLine);
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
