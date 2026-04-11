import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch, getCalleeRowsForSymbol, type SymbolMatch } from '../query-support.js';
import type { SliceResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Reference-level program slicing: track what affects a symbol (backward)
 * or what a symbol affects (forward).
 *
 * Backward slice: "What feeds into this?" — symbols referenced in the same
 * function that defines the target. These are the direct tracked inputs.
 *
 * Forward slice: "What does this feed into?" — at each site where the target
 * is referenced, find the enclosing function, then find what that function
 * exports/defines. These are the outputs/consumers.
 *
 * Language-agnostic: works with any SCIP index.
 */
export function slice(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { direction?: 'backward' | 'forward' } = {},
): SliceResult | null {
  const { direction = 'backward' } = opts;

  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return null;

  if (direction === 'backward') {
    return backwardSlice(db, match);
  } else {
    return forwardSlice(db, match);
  }
}


function backwardSlice(db: ScipDatabase, match: SymbolMatch): SliceResult {
  // Find all symbols referenced within the definition range of the target.
  // These are what "feeds into" the target — the inputs.
  const callees = getCalleeRowsForSymbol(db, match);

  const seen = new Set<string>();
  const connected: SliceResult['connectedSymbols'] = [];

  for (const c of callees) {
    if (seen.has(c.symbol)) continue;
    seen.add(c.symbol);
    connected.push({
      symbol: c.symbol,
      shortName: shortenSymbol(c.symbol),
      file: c.file,
      relationship: 'referenced within definition (callee)',
    });
  }

  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    direction: 'backward',
    connectedSymbols: connected,
  };
}

function forwardSlice(db: ScipDatabase, match: SymbolMatch): SliceResult {
  // Find where the target is referenced, then at each reference site,
  // find what else the enclosing function defines/exports.
  const rows = db.all<{
    enclosing_symbol: string;
    enclosing_file: string;
    output_symbol: string;
    output_file: string;
  }>(
    `SELECT DISTINCT
      enc_gs.symbol AS enclosing_symbol,
      enc_d.relative_path AS enclosing_file,
      out_gs.symbol AS output_symbol,
      out_d.relative_path AS output_file
    FROM mentions ref_m
    JOIN chunks ref_c ON ref_m.chunk_id = ref_c.id
    JOIN documents ref_d ON ref_c.document_id = ref_d.id
    -- Find enclosing function at each reference site
    JOIN defn_enclosing_ranges enc_der
      ON enc_der.document_id = ref_d.id
      AND enc_der.start_line <= ref_c.start_line
      AND enc_der.end_line >= ref_c.end_line
    JOIN global_symbols enc_gs ON enc_der.symbol_id = enc_gs.id
    JOIN documents enc_d ON enc_der.document_id = enc_d.id
    -- Find other symbols referenced within that enclosing function
    JOIN mentions out_m ON out_m.role != 1
    JOIN chunks out_c ON out_m.chunk_id = out_c.id
      AND out_c.document_id = enc_der.document_id
      AND out_c.start_line >= enc_der.start_line
      AND out_c.end_line <= enc_der.end_line
    JOIN global_symbols out_gs ON out_m.symbol_id = out_gs.id
    JOIN defn_enclosing_ranges out_der ON out_gs.id = out_der.symbol_id
    JOIN documents out_d ON out_der.document_id = out_d.id
    WHERE ref_m.symbol_id = ? AND ref_m.role != 1
      AND out_gs.id != ? AND out_gs.id != enc_gs.id
      AND out_d.id != ref_d.id
      ${db.symbolNoiseFor('out_gs')}
      ${db.pathExclusionsFor('out_d')}
    ORDER BY out_d.relative_path
    LIMIT 30`,
    match.symbolId, match.symbolId,
  );

  const seen = new Set<string>();
  const connected: SliceResult['connectedSymbols'] = [];

  for (const r of rows) {
    if (seen.has(r.output_symbol) || db.isIgnored(r.output_file)) continue;
    seen.add(r.output_symbol);
    connected.push({
      symbol: r.output_symbol,
      shortName: shortenSymbol(r.output_symbol),
      file: r.output_file,
      relationship: `used alongside target in ${shortenSymbol(r.enclosing_symbol)}`,
    });
  }

  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    direction: 'forward',
    connectedSymbols: connected,
  };
}
