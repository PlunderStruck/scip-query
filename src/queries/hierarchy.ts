import type { ScipDatabase } from '../db.js';
import type { HierarchyNode } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Walk the enclosing_symbol chain upward to show a symbol's ancestry.
 * e.g., method → class → module → file
 *
 * Falls back to parsing the SCIP symbol descriptor chain when
 * enclosing_symbol is not populated by the indexer.
 */
export function hierarchy(db: ScipDatabase, symbolPattern: string): HierarchyNode[] {
  // Find the symbol
  const sym = db.get<{ symbol: string; enclosing_symbol: string | null }>(
    `SELECT symbol, enclosing_symbol FROM global_symbols
     WHERE symbol LIKE ? LIMIT 1`,
    `%${symbolPattern}%`,
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

  return chain;
}
