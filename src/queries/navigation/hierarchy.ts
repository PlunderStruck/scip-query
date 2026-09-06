import type { ScipDatabase } from '../../storage/db.js';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { isAncestorSymbol, parseSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';

export interface HierarchyNode {
  symbol: string;
  shortName: string;
  depth: number;
}

/**
 * Walk the enclosing_symbol chain upward to show a symbol's ancestry.
 * e.g., method → class → module → file
 *
 * Falls back to indexed owners in the SCIP descriptor chain. Unindexed
 * descriptor prefixes are omitted; display labels are never symbol identities.
 */
export function hierarchy(db: ScipDatabase, symbolPattern: string): HierarchyNode[] {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return [];

  const sym = db.get<{ symbol: string; enclosing_symbol: string | null }>(
    `SELECT symbol, enclosing_symbol FROM global_symbols
     WHERE id = ? LIMIT 1`,
    match.symbolId,
  );
  if (!sym) return [];

  const chain: HierarchyNode[] = [{ symbol: sym.symbol, shortName: shortenSymbol(sym.symbol), depth: 0 }];

  // Walk enclosing_symbol chain if available
  let current = sym.enclosing_symbol;
  let depth = 1;
  const seen = new Set<string>([sym.symbol]);

  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = db.get<{ symbol: string; enclosing_symbol: string | null }>(
      `SELECT symbol, enclosing_symbol FROM global_symbols WHERE symbol = ?`,
      current,
    );
    if (!parent) break;

    chain.push({
      symbol: parent.symbol,
      shortName: shortenSymbol(parent.symbol),
      depth,
    });
    current = parent.enclosing_symbol;
    depth++;
  }

  if (chain.length > 1) {
    return chain;
  }

  const parsed = parseSymbol(sym.symbol);
  if ('kind' in parsed) {
    return chain;
  }

  const descriptors = parsed.descriptors;
  if (descriptors.length <= 1) {
    return chain;
  }

  const owners = getDefinitionsForFile(db, match.relativePath)
    .filter((definition) => sym.symbol.startsWith(definition.symbol) && isAncestorSymbol(definition.symbol, sym.symbol))
    .sort((left, right) => right.symbol.length - left.symbol.length);
  return [
    ...chain,
    ...owners.map((owner, index) => ({
      symbol: owner.symbol,
      shortName: shortenSymbol(owner.symbol),
      depth: index + 1,
    })),
  ];
}

/** Name-preserving projection of lexical/compiler ownership, not type inheritance. */
// scip-query: ignore-passthrough — public name states that this projection is ownership rather than inheritance.
export function ownershipChain(db: ScipDatabase, symbolPattern: string): HierarchyNode[] {
  return hierarchy(db, symbolPattern);
}
