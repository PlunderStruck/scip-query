import type { ScipDatabase } from '../db.js';
import {
  findEnclosingDefinition,
  findExactSymbolMatch,
  findFirstSymbolMatch,
  getCalleeRowsForSymbol,
  getDefinitionsForFile,
  getResolvedReferenceSites,
  getSourceReferenceSites,
  type SymbolMatch,
} from '../query-support.js';
import type { SliceResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Reference-level program slicing: track what affects a symbol (backward)
 * or what a symbol affects (forward).
 *
 * Backward slice: "What feeds into this?" — transitive closure of callees.
 * Depth 1 = direct callees, depth 2 = their callees, etc.
 *
 * Forward slice: "What does this feed into?" — at each site where the target
 * is referenced, find the enclosing function, then find what that function
 * exports/defines. These are the outputs/consumers.
 *
 * Language-agnostic: works with any SCIP index.
 */
export function slice(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { direction?: 'backward' | 'forward'; maxDepth?: number } = {},
): SliceResult | null {
  const { direction = 'backward', maxDepth = 3 } = opts;

  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return null;

  if (direction === 'backward') {
    return backwardSlice(db, match, maxDepth);
  } else {
    return forwardSlice(db, match);
  }
}


function backwardSlice(db: ScipDatabase, match: SymbolMatch, maxDepth: number): SliceResult {
  // Transitive BFS through callees: depth 1 = direct callees of the target,
  // depth 2 = callees of those callees, etc.
  const connected: SliceResult['connectedSymbols'] = [];
  const visited = new Set<string>([match.symbol]);
  let frontier: SymbolMatch[] = [match];

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.length === 0) break;

    const nextFrontier: SymbolMatch[] = [];

    for (const current of frontier) {
      const callees = getCalleeRowsForSymbol(db, current);

      for (const c of callees) {
        if (visited.has(c.symbol)) continue;
        visited.add(c.symbol);

        connected.push({
          symbol: c.symbol,
          shortName: shortenSymbol(c.symbol),
          file: c.file,
          relationship: depth === 1 ? 'referenced within definition (callee)' : `depth ${depth} callee`,
        });

        // Resolve the callee as a SymbolMatch for the next frontier
        const calleeMatch = findExactSymbolMatch(db, c.symbol);
        if (calleeMatch && !db.isIgnored(calleeMatch.relativePath)) {
          nextFrontier.push(calleeMatch);
        }
      }
    }

    frontier = nextFrontier;
  }

  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    direction: 'backward',
    connectedSymbols: connected,
  };
}

function forwardSlice(db: ScipDatabase, match: SymbolMatch): SliceResult {
  // Find where the target is referenced, then at each reference site,
  // find what else the enclosing function defines/exports. Goes through the
  // canonical reference-site + enclosing-definition helpers so that bounds
  // are source-corrected and attribution matches every other query that
  // does the same lookup.
  const sourceRefs = getSourceReferenceSites(db, match);
  const refs = sourceRefs.length > 0 ? sourceRefs : getResolvedReferenceSites(db, match);

  const seenOutputs = new Set<string>();
  const connected: SliceResult['connectedSymbols'] = [];

  for (const ref of refs) {
    if (connected.length >= 30) break;
    if (db.isIgnored(ref.file)) continue;

    // Enclosing symbol via corrected ranges — use the JS helper so we agree
    // with getSourceReferenceSites/getResolvedReferenceSites, which already
    // compute enclosing the same way.
    const enclosingSymbol =
      ref.enclosingSymbol ?? findEnclosingDefinition(
        getDefinitionsForFile(db, ref.file),
        ref.line,
      )?.symbol ?? null;
    if (!enclosingSymbol || enclosingSymbol === match.symbol) continue;

    const enclosingMatch = findExactSymbolMatch(db, enclosingSymbol);
    if (!enclosingMatch) continue;

    for (const callee of getCalleeRowsForSymbol(db, enclosingMatch)) {
      if (callee.symbol === match.symbol) continue;
      if (callee.symbol === enclosingSymbol) continue;
      if (callee.file === ref.file) continue; // preserve `out_d.id != ref_d.id`
      if (db.isIgnored(callee.file)) continue;
      if (seenOutputs.has(callee.symbol)) continue;
      seenOutputs.add(callee.symbol);

      connected.push({
        symbol: callee.symbol,
        shortName: shortenSymbol(callee.symbol),
        file: callee.file,
        relationship: `used alongside target in ${shortenSymbol(enclosingSymbol)}`,
      });
      if (connected.length >= 30) break;
    }
  }

  connected.sort((a, b) => a.file.localeCompare(b.file)); // preserve SQL's ORDER BY out_d.relative_path

  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    direction: 'forward',
    connectedSymbols: connected,
  };
}
