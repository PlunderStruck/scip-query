import { basename, extname } from 'node:path';
import type { ScipDatabase } from '../db.js';
import { buildCrossFileCallerMap, buildFileDepGraph, buildSourceFallbackCallerFiles } from '../reference-graph.js';
import { findEnclosingDefinition, getDefinitionsForFile, getScopedDefinitions } from '../definition-catalog.js';
import { getIdentifierLineMap } from '../source-analysis.js';
import { leafName } from '../symbol-parser.js';
import type { WrapperCandidate } from '../types.js';
import { isFunctionLikeSymbol, shortenSymbol } from '../symbol-parser.js';

/**
 * Find wrapper candidates: symbols called by only one other symbol.
 *
 * These are premature abstractions that add indirection without
 * providing reuse. A function with fan-in = 1 whose sole caller
 * is widely used is a strong signal of unnecessary wrapping.
 */
export function wrapperCandidates(
  db: ScipDatabase,
  opts?: { scope?: string; maxLoc?: number; limit?: number },
): WrapperCandidate[] {
  const { scope, maxLoc = 15, limit = 30 } = opts ?? {};
  const reverseFanIn = buildReverseFileFanIn(buildFileDepGraph(db, scope));
  const symbols = getWrapperCandidateSymbols(db, scope, maxLoc);

  // Bulk pre-filter: only process symbols with exactly 1 distinct external
  // caller file. Source-text fallback adds back references the indexer may
  // miss (macros, dynamic dispatch); without it, a function called via a
  // missed path would falsely look like a wrapper.
  const callerFileMap = mergeCallerMaps(
    buildCrossFileCallerMap(db, symbols),
    buildSourceFallbackCallerFiles(db, symbols),
  );

  const results: WrapperCandidate[] = [];

  for (const symbol of symbols) {
    const symbolStem = basename(symbol.relativePath, extname(symbol.relativePath));

    // Cheap bulk check first: skip if not exactly 1 external caller file (excluding same stem)
    const externalFiles = [...(callerFileMap.get(symbol.symbolId) ?? [])]
      .filter((f) => f !== symbol.relativePath)
      .filter((f) => basename(f, extname(f)) !== symbolStem);
    if (externalFiles.length !== 1) continue;

    const callerFile = externalFiles[0]!;

    // SCIP gives us the chunk that contains the reference, but chunks can be
    // file-wide. Refine via source-text scan: find a line within the chunk's
    // range where the symbol's leaf identifier actually appears, then look up
    // the enclosing definition from that precise line. Falls back to the
    // chunk's start line when source isn't readable / leaf isn't unique.
    const refRow = db.get<{ start_line: number; end_line: number }>(
      `SELECT c.start_line, c.end_line
       FROM mentions m
       JOIN chunks c ON m.chunk_id = c.id
       JOIN documents d ON c.document_id = d.id
       WHERE m.symbol_id = ? AND m.role != 1 AND d.relative_path = ?
       LIMIT 1`,
      symbol.symbolId,
      callerFile,
    );
    if (!refRow) continue;

    const callerDefs = getDefinitionsForFile(db, callerFile);
    const refinedLine = refineCallSiteLine(db, callerFile, symbol.symbol, refRow.start_line, refRow.end_line);
    const enclosing = findEnclosingDefinition(callerDefs, refinedLine);

    // Fan-in: function-level from bulk map, or file-level as fallback
    let callerFanIn: number;
    const callerSymbol = enclosing?.symbol ?? '';
    const callerShort = enclosing?.isFunctionLike
      ? shortenSymbol(enclosing.symbol)
      : basename(callerFile);

    if (enclosing?.isFunctionLike && enclosing.symbolId !== symbol.symbolId) {
      const extCallers = [...(callerFileMap.get(enclosing.symbolId) ?? [])]
        .filter((f) => f !== enclosing.relativePath);
      callerFanIn = extCallers.length > 0
        ? extCallers.length
        : fallbackCallerFanIn(reverseFanIn, callerFile);
    } else {
      callerFanIn = fallbackCallerFanIn(reverseFanIn, callerFile);
    }

    if (callerFanIn <= 3) continue;

    results.push({
      symbol: symbol.symbol,
      shortName: shortenSymbol(symbol.symbol),
      file: symbol.relativePath,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      loc: definitionLoc(symbol),
      singleCaller: callerSymbol,
      singleCallerShort: callerShort,
      callerFanIn,
    });
  }

  results.sort((left, right) => right.callerFanIn - left.callerFanIn || right.loc - left.loc);
  return results.slice(0, limit);
}

function definitionLoc(
  definition: ReturnType<typeof getDefinitionsForFile>[number],
): number {
  return definition.endLine - definition.startLine + 1;
}

function getWrapperCandidateSymbols(
  db: ScipDatabase,
  scope: string | undefined,
  maxLoc: number,
): ReturnType<typeof getScopedDefinitions> {
  return getScopedDefinitions(db, scope)
    .filter((definition) => !db.isIgnored(definition.relativePath))
    .filter((definition) => isFunctionLikeSymbol(definition.symbol))
    .filter((definition) => definitionLoc(definition) <= maxLoc && definitionLoc(definition) >= 2);
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

function mergeCallerMaps(
  ...maps: Array<Map<number, Set<string>>>
): Map<number, Set<string>> {
  const merged = new Map<number, Set<string>>();
  for (const m of maps) {
    for (const [k, v] of m) {
      let bucket = merged.get(k);
      if (!bucket) {
        bucket = new Set();
        merged.set(k, bucket);
      }
      for (const f of v) bucket.add(f);
    }
  }
  return merged;
}

function buildReverseFileFanIn(
  graph: Map<string, Set<string>>,
): Map<string, number> {
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

function fallbackCallerFanIn(
  reverseFanIn: Map<string, number>,
  callerFile: string,
): number {
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
