import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch } from '../query-support.js';
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

  // Definition sites (role=1)
  const defSites = db.all<{ file: string; line: number }>(
    `SELECT d.relative_path AS file, c.start_line AS line
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
    WHERE m.symbol_id = ? AND m.role = 1
    ORDER BY d.relative_path, c.start_line`,
    match.symbolId,
  );

  // Usage sites (role=0) with enclosing symbol
  const usageSites = db.all<{
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

  // Producers: other symbols referenced within the same function that defines our target
  const producers = db.all<{ symbol: string; file: string }>(
    `SELECT DISTINCT other_gs.symbol, other_d.relative_path AS file
    FROM mentions other_m
    JOIN chunks other_c ON other_m.chunk_id = other_c.id
    JOIN global_symbols other_gs ON other_m.symbol_id = other_gs.id
    JOIN defn_enclosing_ranges other_der ON other_gs.id = other_der.symbol_id
    JOIN documents other_d ON other_der.document_id = other_d.id
    WHERE other_c.document_id = ?
      AND other_c.start_line >= ? AND other_c.end_line <= ?
      AND other_m.role != 1
      AND other_gs.id != ?
      ${db.symbolNoiseFor('other_gs')}
      ${db.pathExclusionsFor('other_d')}
    ORDER BY other_d.relative_path
    LIMIT 30`,
    match.documentId, match.startLine, match.endLine, match.symbolId,
  );

  // Consumers: symbols exported/defined by functions that reference our target
  // (what does the data flow into after being used)
  const consumers = db.all<{ symbol: string; file: string }>(
    `SELECT DISTINCT consumer_gs.symbol, consumer_d.relative_path AS file
    FROM mentions ref_m
    JOIN chunks ref_c ON ref_m.chunk_id = ref_c.id
    JOIN documents ref_d ON ref_c.document_id = ref_d.id
    -- Find the enclosing function at each usage site
    JOIN defn_enclosing_ranges enc_der
      ON enc_der.document_id = ref_d.id
      AND enc_der.start_line <= ref_c.start_line
      AND enc_der.end_line >= ref_c.end_line
    JOIN global_symbols enc_gs ON enc_der.symbol_id = enc_gs.id
    -- Find other symbols defined by that enclosing function's file
    JOIN mentions consumer_m ON consumer_m.symbol_id = enc_gs.id AND consumer_m.role != 1
    JOIN chunks consumer_c ON consumer_m.chunk_id = consumer_c.id
    JOIN documents consumer_d ON consumer_c.document_id = consumer_d.id
    JOIN global_symbols consumer_gs ON consumer_m.symbol_id = consumer_gs.id
    WHERE ref_m.symbol_id = ? AND ref_m.role != 1
      AND consumer_d.id != ref_d.id
      ${db.symbolNoiseFor('consumer_gs')}
      ${db.pathExclusionsFor('consumer_d')}
    ORDER BY consumer_d.relative_path
    LIMIT 30`,
    match.symbolId,
  );

  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    relativePath: match.relativePath,
    definitionSites: defSites.filter((s) => !db.isIgnored(s.file)),
    usageSites: usageSites
      .filter((s) => !db.isIgnored(s.file))
      .map((s) => ({
        file: s.file,
        line: s.line,
        enclosingSymbol: s.enclosing_symbol ?? '(top-level)',
        enclosingShort: s.enclosing_symbol ? shortenSymbol(s.enclosing_symbol) : '(top-level)',
      })),
    producers: producers
      .filter((p) => !db.isIgnored(p.file))
      .map((p) => ({ symbol: p.symbol, shortName: shortenSymbol(p.symbol), file: p.file })),
    consumers: consumers
      .filter((c) => !db.isIgnored(c.file))
      .map((c) => ({ symbol: c.symbol, shortName: shortenSymbol(c.symbol), file: c.file })),
  };
}
