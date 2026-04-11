import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch, getCalleeRowsForSymbol, getSourceReferenceSites } from '../query-support.js';
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

  const sourceUsageSites = getSourceReferenceSites(db, match);
  const usageSites = sourceUsageSites.length > 0
    ? sourceUsageSites.map((site) => ({
      file: site.file,
      line: site.line,
      enclosing_symbol: site.enclosingSymbol,
    }))
    : db.all<{
      file: string;
      line: number;
      enclosing_symbol: string | null;
    }>(
      `SELECT d.relative_path AS file, c.start_line AS line,
        (SELECT enc_gs.symbol
         FROM defn_enclosing_ranges enc_der
         JOIN global_symbols enc_gs ON enc_der.symbol_id = enc_gs.id
         WHERE enc_der.document_id = d.id
           AND enc_der.start_line <= c.start_line
           AND enc_der.end_line >= c.end_line
         ORDER BY (enc_der.end_line - enc_der.start_line) ASC
         LIMIT 1
        ) AS enclosing_symbol
      FROM mentions m
      JOIN chunks c ON m.chunk_id = c.id
      JOIN documents d ON c.document_id = d.id
      WHERE m.symbol_id = ? AND m.role != 1
        ${db.pathExclusionsFor('d')}
      ORDER BY d.relative_path, c.start_line`,
      match.symbolId,
    );

  const normalizedUsageSites = usageSites
    .filter((site) => !db.isIgnored(site.file))
    .map((site) => ({
      file: site.file,
      line: site.line,
      enclosingSymbol: site.enclosing_symbol ?? '(top-level)',
      enclosingShort: site.enclosing_symbol ? shortenSymbol(site.enclosing_symbol) : '(top-level)',
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
