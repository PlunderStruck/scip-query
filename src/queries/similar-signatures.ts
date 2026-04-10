import type { ScipDatabase } from '../db.js';
import type { SimilarSignatureGroup } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find functions with near-identical type signatures (same parameter types
 * and return type) but different names. These are "same shape" functions
 * that may be doing similar work even if their internal implementation differs.
 *
 * The SCIP `documentation` field often contains the full type signature
 * after a `|` delimiter. We parse it, normalize it (strip the function name,
 * whitespace, and case), then group by normalized signature.
 *
 * Groups with 2+ functions = same-shape candidates.
 */
export function similarSignatures(
  db: ScipDatabase,
  opts: { scope?: string; minLoc?: number; limit?: number } = {},
): SimilarSignatureGroup[] {
  const { scope, minLoc = 1, limit } = opts;

  const scopeFilter = scope ? `AND d.relative_path LIKE '%${scope}%'` : '';

  // Get all function-level symbols with their documentation/signature strings.
  // We use the same signature extraction pattern as symbols.ts / trace.ts.
  // Filter to symbols that have a documentation field containing '|' (the sig delimiter)
  // and whose signature contains '(' (indicating a callable).
  const rows = db.all<{
    symbol: string;
    relative_path: string;
    start_line: number;
    end_line: number;
    loc: number;
    sig: string;
  }>(
    `SELECT
      gs.symbol,
      d.relative_path,
      der.start_line,
      der.end_line,
      (der.end_line - der.start_line + 1) AS loc,
      REPLACE(SUBSTR(gs.documentation, INSTR(gs.documentation, '|') + 1), char(10), ' ') AS sig
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE gs.documentation IS NOT NULL
      AND gs.documentation != ''
      AND INSTR(gs.documentation, '|') > 0
      AND (der.end_line - der.start_line + 1) >= ?
      ${db.pathExclusionsFor('d')}
      ${db.symbolNoiseFor('gs')}
      ${scopeFilter}
    ORDER BY d.relative_path, der.start_line`,
    minLoc,
  );

  // Group by normalized signature
  const sigGroups = new Map<string, Array<{
    symbol: string;
    shortName: string;
    file: string;
    startLine: number;
    endLine: number;
    loc: number;
  }>>();

  for (const row of rows) {
    if (db.isIgnored(row.relative_path)) continue;

    const normalized = normalizeSignature(row.sig);
    if (!normalized) continue;

    const entry = {
      symbol: row.symbol,
      shortName: shortenSymbol(row.symbol),
      file: row.relative_path,
      startLine: row.start_line,
      endLine: row.end_line,
      loc: row.loc,
    };

    const existing = sigGroups.get(normalized);
    if (existing) {
      existing.push(entry);
    } else {
      sigGroups.set(normalized, [entry]);
    }
  }

  // Collect groups with 2+ functions
  const results: SimilarSignatureGroup[] = [];

  for (const [signature, functions] of sigGroups) {
    if (functions.length < 2) continue;

    results.push({ signature, functions });
  }

  // Sort by group size descending (largest groups = most duplication),
  // then by total LOC in the group
  results.sort((a, b) => {
    const sizeDiff = b.functions.length - a.functions.length;
    if (sizeDiff !== 0) return sizeDiff;
    const locA = a.functions.reduce((sum, f) => sum + f.loc, 0);
    const locB = b.functions.reduce((sum, f) => sum + f.loc, 0);
    return locB - locA;
  });

  return limit ? results.slice(0, limit) : results;
}

/**
 * Normalize a signature for comparison:
 * 1. Clean markdown fences and SCIP prefixes
 * 2. Strip everything before the first '(' (removes the function name)
 * 3. Strip whitespace and lowercase
 *
 * Returns null if the signature doesn't contain a callable form.
 */
function normalizeSignature(raw: string): string | null {
  if (!raw || !raw.trim()) return null;

  // Clean markdown and SCIP decoration (same as cleanSignature)
  let sig = raw
    .replace(/^```\w*\s*/, '')
    .replace(/\s*```$/, '')
    .replace(/^\(method\)\s*/, '')
    .replace(/^\(property\)\s*/, '')
    .replace(/^\(function\)\s*/, '')
    .replace(/^\(class\)\s*/, '')
    .replace(/^\(interface\)\s*/, '')
    .replace(/^\(enum\)\s*/, '')
    .replace(/^\(type alias\)\s*/, '')
    .replace(/^\(const\)\s*/, '')
    .replace(/^\(var\)\s*/, '')
    .trim();

  // Find the first '(' — everything from there is the parameter/return signature
  const parenIdx = sig.indexOf('(');
  if (parenIdx === -1) return null;

  sig = sig.slice(parenIdx);

  // Normalize: strip all whitespace, lowercase
  sig = sig.replace(/\s+/g, '').toLowerCase();

  // Must have meaningful content after normalization
  if (sig.length < 3) return null; // e.g. "()" alone is too generic

  return sig;
}
