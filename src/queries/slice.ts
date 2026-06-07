import type { ScipDatabase } from '../storage/db.js';
import { ProjectIndex } from '../core/project-index.js';
import { findExactSymbolMatch, findFirstSymbolMatch } from '../symbols/symbol-lookup.js';
import { findEnclosingDefinition } from '../symbols/definition-catalog.js';
import { getCalleeRowsForSymbol } from '../symbols/call-graph-evidence.js';
import { getResolvedReferenceSites } from '../symbols/reference-sites.js';
import { getSourceReferenceSites } from '../symbols/identifier-attribution.js';
import type { SymbolMatch } from '../domain/types.js';
import { shortenSymbol } from '../symbols/symbol-parser.js';

export interface SliceResult {
  symbol: string;
  shortName: string;
  direction: 'backward' | 'forward';
  /** Backward: symbols referenced in the same function as the target's definition (inputs) */
  /** Forward: symbols defined by functions that reference the target (outputs) */
  connectedSymbols: Array<{ symbol: string; shortName: string; file: string; relationship: string }>;
}

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
  opts: { direction?: 'backward' | 'forward'; maxDepth?: number; semantic?: boolean } = {},
): SliceResult | null {
  const { direction = 'backward', maxDepth = 3 } = opts;

  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return null;

  if (direction === 'backward') {
    return backwardSlice(db, match, maxDepth, { semantic: opts.semantic !== false });
  } else {
    return forwardSlice(db, match, { semantic: opts.semantic !== false });
  }
}


// scip-query: ignore-similar — shares callee-row helpers with forwardSlice but
// implements transitive BFS; forwardSlice does single-hop reference attribution.
// Different algorithms, intentionally split.
function backwardSlice(
  db: ScipDatabase,
  match: SymbolMatch,
  maxDepth: number,
  opts: { semantic: boolean },
): SliceResult {
  // Transitive BFS through callees: depth 1 = direct callees of the target,
  // depth 2 = callees of those callees, etc.
  const connected: SliceResult['connectedSymbols'] = [];
  const visited = new Set<string>([match.symbol]);
  let frontier: SymbolMatch[] = [match];

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.length === 0) break;

    const nextFrontier: SymbolMatch[] = [];

    for (const current of frontier) {
      const callees = getCalleeRowsForSymbol(db, current, { semantic: opts.semantic });

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

// scip-query: ignore-similar — single-hop reference + enclosing-definition
// walk; different algorithm from backwardSlice's transitive BFS even though
// they share the same callee-row + symbol-lookup primitives.
function forwardSlice(
  db: ScipDatabase,
  match: SymbolMatch,
  opts: { semantic: boolean },
): SliceResult {
  // Find where the target is referenced, then at each reference site,
  // report the enclosing consumer. A forward slice is "what this symbol
  // feeds into", not "what else is used alongside it".
  const sourceRefs = getSourceReferenceSites(db, match, { semantic: opts.semantic });
  const refs = sourceRefs.length > 0 ? sourceRefs : getResolvedReferenceSites(db, match);

  const seenConsumers = new Set<string>();
  const connected: SliceResult['connectedSymbols'] = [];
  const index = new ProjectIndex(db);

  for (const ref of refs) {
    if (connected.length >= 30) break;
    if (db.isIgnored(ref.file)) continue;

    // Enclosing symbol via corrected ranges — use the JS helper so we agree
    // with getSourceReferenceSites/getResolvedReferenceSites, which already
    // compute enclosing the same way.
    const enclosingSymbol =
      ref.enclosingSymbol ?? findEnclosingDefinition(
        index.definitionsForFile(ref.file),
        ref.line,
      )?.symbol ?? null;
    if (!enclosingSymbol || enclosingSymbol === match.symbol) continue;

    const enclosingMatch = findExactSymbolMatch(db, enclosingSymbol);
    if (!enclosingMatch || db.isIgnored(enclosingMatch.relativePath)) continue;
    if (seenConsumers.has(enclosingMatch.symbol)) continue;
    seenConsumers.add(enclosingMatch.symbol);

    connected.push({
      symbol: enclosingMatch.symbol,
      shortName: shortenSymbol(enclosingMatch.symbol),
      file: enclosingMatch.relativePath,
      relationship: `references target at ${ref.file}:${ref.line + 1}`,
    });
  }

  connected.sort((a, b) => a.file.localeCompare(b.file));

  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    direction: 'forward',
    connectedSymbols: connected,
  };
}
