import type { ScipDatabase } from '../../storage/db.js';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { getCalleeRowsForSymbol } from '../../symbols/graph/call-graph-evidence.js';
import { getCallerRowsForSymbol } from '../../symbols/graph/call-graph-evidence.js';
import { referenceSitesForSymbol } from '../../symbols/references/reference-sites.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';
import { uniqueSymbolFileRows } from '../query-utils.js';

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

export interface ReferenceNeighborhoodResult {
  symbol: string;
  shortName: string;
  relativePath: string;
  definitionSites: Array<{ file: string; line: number }>;
  referenceSites: Array<{ file: string; line: number; enclosingSymbol: string; enclosingShort: string }>;
  outgoingCalls: Array<{ symbol: string; shortName: string; file: string }>;
  incomingCalls: Array<{ symbol: string; shortName: string; file: string }>;
}

/**
 * Compiler-identified definition/reference sites plus the static call
 * neighborhood of one symbol. This projection deliberately makes no value-flow
 * claim: an outgoing callee is not necessarily a producer and an incoming
 * caller is not necessarily a consumer of a returned value.
 */
export function referenceNeighborhood(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { semantic?: boolean } = {},
): ReferenceNeighborhoodResult | null {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return null;

  const defSites = [
    {
      file: match.relativePath,
      line: match.startLine,
    },
  ];

  const normalizedUsageSites = referenceSitesForSymbol(db, match, {
    semantic: opts.semantic,
    semanticEvidence: symbolSemanticEvidence,
  }).map((site) => ({
    file: site.file,
    line: site.line,
    enclosingSymbol: site.enclosingSymbol ?? '(top-level)',
    enclosingShort: site.enclosingSymbol ? shortenSymbol(site.enclosingSymbol) : '(top-level)',
  }));

  const { outgoingCalls, incomingCalls } = collectReferenceEndpoints(db, match, normalizedUsageSites, {
    semantic: opts.semantic !== false,
  });

  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    relativePath: match.relativePath,
    definitionSites: defSites.filter((s) => !db.isIgnored(s.file)),
    referenceSites: normalizedUsageSites,
    outgoingCalls: outgoingCalls
      .filter((p) => !db.isIgnored(p.file))
      .map((p) => ({ symbol: p.symbol, shortName: shortenSymbol(p.symbol), file: p.file })),
    incomingCalls: incomingCalls
      .filter((c) => !db.isIgnored(c.file))
      .map((c) => ({
        symbol: c.symbol,
        shortName: c.symbol === c.file ? '(top-level)' : shortenSymbol(c.symbol),
        file: c.file,
      })),
  };
}

/**
 * @deprecated This historical command returns a reference/call neighborhood,
 * not value-level data flow. Use `referenceNeighborhood` for that projection
 * and `valueFlow` for proved data-dependence edges.
 */
export function dataflow(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { semantic?: boolean } = {},
): DataflowResult | null {
  const result = referenceNeighborhood(db, symbolPattern, opts);
  if (!result) return null;
  return {
    symbol: result.symbol,
    shortName: result.shortName,
    relativePath: result.relativePath,
    definitionSites: result.definitionSites,
    usageSites: result.referenceSites,
    producers: result.outgoingCalls,
    consumers: result.incomingCalls,
  };
}

interface SymbolRow {
  symbol: string;
  file: string;
}

function collectReferenceEndpoints(
  db: ScipDatabase,
  match: Parameters<typeof getCalleeRowsForSymbol>[1],
  normalizedUsageSites: { file: string; enclosingSymbol: string }[],
  opts: { semantic: boolean },
): { outgoingCalls: SymbolRow[]; incomingCalls: SymbolRow[] } {
  const outgoingCalls = uniqueSymbolFileRows(
    getCalleeRowsForSymbol(db, match, {
      limit: 30,
      semantic: opts.semantic,
      semanticEvidence: symbolSemanticEvidence,
    }).map((row) => ({
      symbol: row.symbol,
      file: row.file,
    })),
  );
  const astConsumers = uniqueSymbolFileRows(
    getCallerRowsForSymbol(db, match, {
      limit: 30,
      semantic: opts.semantic,
      semanticEvidence: symbolSemanticEvidence,
    }),
  );
  const incomingCalls =
    astConsumers.length > 0
      ? astConsumers
      : uniqueSymbolFileRows(
          normalizedUsageSites.map((site) => ({
            symbol: site.enclosingSymbol === '(top-level)' ? site.file : site.enclosingSymbol,
            file: site.file,
          })),
        );
  return { outgoingCalls, incomingCalls };
}
