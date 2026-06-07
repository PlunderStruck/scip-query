import type { ScipDatabase } from '../storage/db.js';
import { findFirstSymbolMatch } from '../symbols/symbol-lookup.js';
import { getCalleeRowsForSymbol, getCallerRowsForSymbol } from '../symbols/reference-graph.js';
import { shortenSymbol } from '../symbols/symbol-parser.js';

export interface CallGraphResult {
  symbol: string;
  shortName: string;
  /** Symbols that call this one (incoming) */
  callers: Array<{ symbol: string; shortName: string; file: string }>;
  /** Symbols called by this one (outgoing) */
  callees: Array<{ symbol: string; shortName: string; file: string }>;
}

/**
 * Build a call graph for a symbol: who calls it (incoming) and
 * what it calls (outgoing).
 *
 * Incoming: other symbols whose definition ranges contain a reference to this symbol.
 * Outgoing: symbols referenced within this symbol's definition range.
 */
export function callGraph(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { semantic?: boolean } = {},
): CallGraphResult | null {
  // Find the target symbol and its definition range
  const target = findFirstSymbolMatch(db, symbolPattern);

  if (!target) return null;

  const includeSemantic = opts.semantic !== false;
  const callerRows = getCallerRowsForSymbol(db, target, { limit: 50, semantic: includeSemantic });

  // CALLEES: symbols referenced within our target's definition range.
  const calleeRows = uniqueRows(getCalleeRowsForSymbol(db, target, {
    limit: 50,
    additive: true,
    callableOnly: true,
    semantic: includeSemantic,
  }));

  return {
    symbol: target.symbol,
    shortName: shortenSymbol(target.symbol),
    callers: callerRows
      .map((r) => ({
        symbol: r.symbol,
        shortName: shortenSymbol(r.symbol),
        file: r.file,
      })),
    callees: calleeRows
      .map((r) => ({
        symbol: r.symbol,
        shortName: shortenSymbol(r.symbol),
        file: r.file,
      })),
  };
}

function uniqueRows<T extends { symbol: string; file: string }>(rows: T[]): T[] {
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
