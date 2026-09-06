import type { ScipDatabase } from '../../storage/db.js';
import { ProjectIndex } from '../internal/project-index.js';
import { findExactSymbolMatch, findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { findEnclosingDefinition } from '../../symbols/definition-catalog.js';
import { getCalleeRowsForSymbol } from '../../symbols/graph/call-graph-evidence.js';
import { referenceSitesForSymbol } from '../../symbols/references/reference-sites.js';
import type { SymbolMatch } from '../../domain/types.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';

export interface ReferenceReachabilityResult {
  symbol: string;
  shortName: string;
  direction: 'backward' | 'forward';
  /** Backward: transitive callees. Forward: definitions enclosing references to the target. */
  connectedSymbols: Array<{ symbol: string; shortName: string; file: string; relationship: string }>;
}

/**
 * Reference/call reachability around a symbol.
 *
 * Backward traversal follows static callees up to maxDepth.
 * Depth 1 returns direct callees; depth 2 also includes their callees.
 *
 * Forward traversal returns up to 30 distinct definitions enclosing references
 * to the target. It does not follow transitive references.
 *
 * These relationships establish calls and reference containment. A value-transfer
 * or control-dependence claim requires separate analysis.
 */
export function referenceReachability(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { direction?: 'backward' | 'forward'; maxDepth?: number; semantic?: boolean } = {},
): ReferenceReachabilityResult | null {
  const { direction = 'backward', maxDepth = 3 } = opts;

  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return null;

  if (direction === 'backward') {
    return transitiveCallees(db, match, maxDepth, { semantic: opts.semantic !== false });
  } else {
    return referencingOwners(db, match, { semantic: opts.semantic !== false });
  }
}

// scip-query: ignore-similar — shares callee-row helpers with referencingOwners but
// implements transitive BFS; referencingOwners does single-hop reference attribution.
// Different algorithms, intentionally split.
function transitiveCallees(
  db: ScipDatabase,
  match: SymbolMatch,
  maxDepth: number,
  opts: { semantic: boolean },
): ReferenceReachabilityResult {
  // Transitive BFS through callees: depth 1 = direct callees of the target,
  // depth 2 = callees of those callees, etc.
  const connected: ReferenceReachabilityResult['connectedSymbols'] = [];
  const visited = new Set<string>([match.symbol]);
  let frontier: SymbolMatch[] = [match];

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.length === 0) break;

    const nextFrontier: SymbolMatch[] = [];

    for (const current of frontier) {
      const callees = getCalleeRowsForSymbol(db, current, {
        semantic: opts.semantic,
        semanticEvidence: symbolSemanticEvidence,
      });

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
// walk; different algorithm from transitiveCallees's transitive BFS even though
// they share the same callee-row + symbol-lookup primitives.
function referencingOwners(
  db: ScipDatabase,
  match: SymbolMatch,
  opts: { semantic: boolean },
): ReferenceReachabilityResult {
  // Find where the target is referenced, then at each reference site,
  // report the enclosing consumer. This identifies owners of references, not consumers of a value.
  const seenConsumers = new Set<string>();
  const connected: ReferenceReachabilityResult['connectedSymbols'] = [];
  const index = new ProjectIndex(db);

  for (const ref of referenceSitesForSymbol(db, match, {
    semantic: opts.semantic,
    semanticEvidence: symbolSemanticEvidence,
  })) {
    if (connected.length >= 30) break;

    // Enclosing symbol via corrected ranges. Reference-site evidence usually
    // already includes this; this fallback handles older mention-only sites.
    const enclosingSymbol =
      ref.enclosingSymbol ?? findEnclosingDefinition(index.definitionsForFile(ref.file), ref.line)?.symbol ?? null;
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
