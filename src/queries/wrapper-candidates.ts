import { basename, extname } from 'node:path';
import type { ScipDatabase } from '../db.js';
import { buildFileDepGraph, getCallerRowsForSymbol, getDefinitionsForFile, getScopedDefinitions } from '../query-support.js';
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
  const symbols = getScopedDefinitions(db, scope)
    .filter((definition) => definitionLoc(definition) <= maxLoc && definitionLoc(definition) >= 2);

  const results: WrapperCandidate[] = [];

  for (const symbol of symbols) {
    if (db.isIgnored(symbol.relativePath) || !isFunctionLikeSymbol(symbol.symbol)) continue;
    const symbolStem = basename(symbol.relativePath, extname(symbol.relativePath));

    const callerRows = dedupeRows(
      getCallerRowsForSymbol(db, symbol, { limit: 200 })
        .filter((row) => row.file !== symbol.relativePath),
    ).filter((row) => basename(row.file, extname(row.file)) !== symbolStem);

    if (callerRows.length !== 1) continue;

    const caller = callerRows[0]!;
    const callerDefinition = getDefinitionsForFile(db, caller.file)
      .find((definition) => definition.symbol === caller.symbol);
    const useDefinitionFanIn = callerDefinition?.isFunctionLike ?? false;
    let callerFanIn: number;
    if (useDefinitionFanIn && callerDefinition) {
      callerFanIn = new Set(
        getCallerRowsForSymbol(db, callerDefinition, { limit: 500 })
          .filter((row) => row.file !== callerDefinition.relativePath)
          .map((row) => row.file),
      ).size;
    } else {
      callerFanIn = fallbackCallerFanIn(db, reverseFanIn, caller.file);
    }
    if (callerFanIn <= 3) continue;

    results.push({
      symbol: symbol.symbol,
      shortName: shortenSymbol(symbol.symbol),
      file: symbol.relativePath,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      loc: definitionLoc(symbol),
      singleCaller: caller.symbol,
      singleCallerShort: useDefinitionFanIn ? shortenSymbol(caller.symbol) : basename(caller.file),
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

function dedupeRows<T extends { symbol: string; file: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const row of rows) {
    const key = `${row.symbol}|${row.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
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
  db: ScipDatabase,
  reverseFanIn: Map<string, number>,
  callerFile: string,
): number {
  const functionLikeFanIn = getDefinitionsForFile(db, callerFile)
    .filter((definition) => definition.isFunctionLike)
    .map((definition) => new Set(
      getCallerRowsForSymbol(db, definition, { limit: 500 })
        .filter((row) => row.file !== definition.relativePath)
        .map((row) => row.file),
    ).size)
    .sort((left, right) => right - left)[0] ?? 0;
  if (functionLikeFanIn > 0) {
    return functionLikeFanIn;
  }

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
