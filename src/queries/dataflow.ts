import type { ScipDatabase } from '../db.js';
import {
  findFirstSymbolMatch,
  getCalleeRowsForSymbol,
  getResolvedReferenceSites,
  getSourceReferenceSites,
} from '../query-support.js';
import type { DataflowResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Reference-level dataflow analysis: where does data around this symbol
 * come from and where does it go?
 *
 * This is not value-level dataflow (we can't trace x = foo(); bar(x);
 * as a chain). Instead it shows:
 * - Where the symbol is defined and used
 * - What other symbols appear in the same enclosing scope (co-occurring data)
 * - What feeds into the function that defines it (producers)
 * - What consumes the function that uses it (consumers)
 *
 * Language-agnostic: works with any SCIP index.
 */
export function dataflow(
  db: ScipDatabase,
  symbolPattern: string,
): DataflowResult | null {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return null;

  const defSites = [{
    file: match.relativePath,
    line: match.startLine,
  }];

  // Primary: cross-file identifier scan. Fallback: mention-resolved sites
  // with in-chunk line refinement so usage lines are precise, not chunk-start.
  const sourceUsageSites = getSourceReferenceSites(db, match);
  const resolvedSites = sourceUsageSites.length > 0
    ? sourceUsageSites
    : getResolvedReferenceSites(db, match);

  const normalizedUsageSites = resolvedSites
    .filter((site) => !db.isIgnored(site.file))
    .map((site) => ({
      file: site.file,
      line: site.line,
      enclosingSymbol: site.enclosingSymbol ?? '(top-level)',
      enclosingShort: site.enclosingSymbol ? shortenSymbol(site.enclosingSymbol) : '(top-level)',
    }));

  // Producers: other symbols referenced within the same function that defines our target
  const producers = uniqueSymbolRows(getCalleeRowsForSymbol(db, match, { limit: 30 }).map((row) => ({
    symbol: row.symbol,
    file: row.file,
  })));

  // Consumers: the enclosing scopes that reference this symbol.
  const consumers = uniqueSymbolRows(
    normalizedUsageSites.map((site) => ({
      symbol: site.enclosingSymbol === '(top-level)' ? site.file : site.enclosingSymbol,
      file: site.file,
    })),
  );

  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    relativePath: match.relativePath,
    definitionSites: defSites.filter((s) => !db.isIgnored(s.file)),
    usageSites: normalizedUsageSites,
    producers: producers
      .filter((p) => !db.isIgnored(p.file))
      .map((p) => ({ symbol: p.symbol, shortName: shortenSymbol(p.symbol), file: p.file })),
    consumers: consumers
      .filter((c) => !db.isIgnored(c.file))
      .map((c) => ({
        symbol: c.symbol,
        shortName: c.symbol === c.file ? '(top-level)' : shortenSymbol(c.symbol),
        file: c.file,
      })),
  };
}

function uniqueSymbolRows<T extends { symbol: string; file: string }>(rows: T[]): T[] {
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
