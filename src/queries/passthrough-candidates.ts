import type { ScipDatabase } from '../db.js';
import { getCalleeRowsForSymbol, testFileExclusionSql } from '../query-support.js';
import type { PassthroughCandidate } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find passthrough candidates: functions that just forward to one
 * other function.
 *
 * A function with exactly 1 callee and small LOC is likely a thin
 * wrapper that adds no value — it just passes arguments through to
 * the real implementation.
 */
export function passthroughCandidates(
  db: ScipDatabase,
  opts?: { scope?: string; maxLoc?: number; limit?: number },
): PassthroughCandidate[] {
  const { scope, maxLoc = 15, limit = 30 } = opts ?? {};
  const scopeFilter = scope ? `AND d.relative_path LIKE '%${scope}%'` : '';

  // 1. Find all non-trivial symbols with definition ranges (>= 3 LOC)
  const symbols = db.all<{
    id: number;
    symbol: string;
    document_id: number;
    start_line: number;
    end_line: number;
    loc: number;
    relative_path: string;
  }>(
    `SELECT
      gs.id,
      gs.symbol,
      der.document_id,
      der.start_line,
      der.end_line,
      (der.end_line - der.start_line + 1) AS loc,
      d.relative_path
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE 1 = 1
      ${db.pathExclusionsFor('d')}
      AND ${testFileExclusionSql('d')}
      ${db.symbolNoiseFor('gs')}
      AND (der.end_line - der.start_line + 1) >= 3
      AND (der.end_line - der.start_line + 1) <= ?
      ${scopeFilter}
    ORDER BY d.relative_path`,
    maxLoc,
  );

  const results: PassthroughCandidate[] = [];

  for (const sym of symbols) {
    if (db.isIgnored(sym.relative_path)) continue;

    // 2. Count callees for this symbol
    const callees = getCalleeRowsForSymbol(db, {
      documentId: sym.document_id,
      startLine: sym.start_line,
      endLine: sym.end_line,
      symbolId: sym.id,
    });

    // Deduplicate by symbol (same callee may appear in multiple chunks)
    const uniqueCallees = new Map<string, { symbol: string; file: string }>();
    for (const c of callees) {
      if (!uniqueCallees.has(c.symbol)) {
        uniqueCallees.set(c.symbol, { symbol: c.symbol, file: c.file });
      }
    }

    // 3. Passthrough = exactly 1 unique callee
    if (uniqueCallees.size !== 1) continue;

    const [, callee] = [...uniqueCallees.entries()][0]!;

    results.push({
      symbol: sym.symbol,
      shortName: shortenSymbol(sym.symbol),
      file: sym.relative_path,
      startLine: sym.start_line,
      endLine: sym.end_line,
      loc: sym.loc,
      forwardsTo: callee.symbol,
      forwardsToShort: shortenSymbol(callee.symbol),
      forwardsToFile: callee.file,
    });
  }

  results.sort((a, b) => a.loc - b.loc || a.file.localeCompare(b.file));
  return results.slice(0, limit);
}
