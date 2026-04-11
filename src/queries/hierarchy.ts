import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch } from '../query-support.js';
import { parseSymbol, shortenSymbol } from '../symbol-parser.js';
import type { HierarchyNode } from '../types.js';

/**
 * Walk the enclosing_symbol chain upward to show a symbol's ancestry.
 * e.g., method → class → module → file
 *
 * Falls back to parsing the SCIP symbol descriptor chain when
 * enclosing_symbol is not populated by the indexer.
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

  const chain: HierarchyNode[] = [
    { symbol: sym.symbol, shortName: shortenSymbol(sym.symbol), depth: 0 },
  ];

  // Walk enclosing_symbol chain if available
  let current = sym.enclosing_symbol;
  let depth = 1;
  const seen = new Set<string>([sym.symbol]);

  while (current && !seen.has(current) && depth < 20) {
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

  const syntheticChain = [chain[0]!];
  for (let i = descriptors.length - 2, syntheticDepth = 1; i >= 0; i--, syntheticDepth++) {
    const partial = descriptors.slice(0, i + 1);
    const shortName = partial.map((descriptor) =>
      descriptor.suffix === 'method' ? `${descriptor.name}()` : descriptor.name.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|rs|java|scala|kt|kts|rb|go|cs|vb|dart|php|c|cc|cpp|cxx|h|hpp)$/, ''),
    ).join(':');
    syntheticChain.push({
      symbol: shortName,
      shortName,
      depth: syntheticDepth,
    });
  }

  return syntheticChain;
}
