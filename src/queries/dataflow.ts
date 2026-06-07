import type { ScipDatabase } from '../storage/db.js';
import { findFirstSymbolMatch } from '../symbols/symbol-lookup.js';
import {
  getCalleeRowsForSymbol,
  getCallerRowsForSymbol,
} from '../symbols/call-graph-evidence.js';
import { getResolvedReferenceSites } from '../symbols/reference-sites.js';
import { getSourceReferenceSites } from '../symbols/identifier-attribution.js';
import { shortenSymbol } from '../symbols/symbol-parser.js';
import { uniqueSymbolFileRows } from './query-utils.js';

export interface DataflowResult {
  symbol: string;
  shortName: string;
  relativePath: string;
  /** Where the symbol is defined (role=1) */
  definitionSites: Array<{ file: string; line: number }>;
  /** Where the symbol is referenced (role!=1) */
  usageSites: Array<{ file: string; line: number; enclosingSymbol: string; enclosingShort: string }>;
  /** Symbols that appear in the same function that defines this symbol (producers/inputs) */
  producers: Array<{ symbol: string; shortName: string; file: string }>;
  /** Symbols defined by functions that reference this symbol (consumers/outputs) */
  consumers: Array<{ symbol: string; shortName: string; file: string }>;
}

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
  opts: { semantic?: boolean } = {},
): DataflowResult | null {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return null;

  const defSites = [{
    file: match.relativePath,
    line: match.startLine,
  }];

  // Primary: cross-file identifier scan. Fallback: mention-resolved sites
  // with in-chunk line refinement so usage lines are precise, not chunk-start.
  const sourceUsageSites = getSourceReferenceSites(db, match, { semantic: opts.semantic });
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

  const { producers, consumers } = collectFlowEndpoints(db, match, normalizedUsageSites, {
    semantic: opts.semantic !== false,
  });

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

interface SymbolRow { symbol: string; file: string }

function collectFlowEndpoints(
  db: ScipDatabase,
  match: Parameters<typeof getCalleeRowsForSymbol>[1],
  normalizedUsageSites: { file: string; enclosingSymbol: string }[],
  opts: { semantic: boolean },
): { producers: SymbolRow[]; consumers: SymbolRow[] } {
  const producers = uniqueSymbolFileRows(
    getCalleeRowsForSymbol(db, match, { limit: 30, semantic: opts.semantic }).map((row) => ({
      symbol: row.symbol,
      file: row.file,
    })),
  );
  const astConsumers = uniqueSymbolFileRows(getCallerRowsForSymbol(db, match, { limit: 30, semantic: opts.semantic }));
  const consumers = astConsumers.length > 0
    ? astConsumers
    : uniqueSymbolFileRows(
      normalizedUsageSites.map((site) => ({
        symbol: site.enclosingSymbol === '(top-level)' ? site.file : site.enclosingSymbol,
        file: site.file,
      })),
    );
  return { producers, consumers };
}
