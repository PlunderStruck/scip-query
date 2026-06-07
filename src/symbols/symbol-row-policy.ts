import type { SymbolQueryRow } from '../storage/scip-rows.js';
import { parentTypeName } from './symbol-parser.js';

/**
 * Mixed primary/fallback definition loads keep only fallback rows that look
 * like a top-level precise declaration when primary rows already exist. This
 * prevents broad mention-derived ranges from displacing AST-corrected ranges.
 */
export function isPreciseMixedFallbackRow(row: SymbolQueryRow): boolean {
  if (parentTypeName(row.symbol) !== null) return false;
  const documentation = row.documentation ?? '';
  const cleaned = documentation
    .replace(/^```\w*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
  return /^(?:var|let|const|function|class|interface|type|enum)\b/.test(cleaned);
}

export function mergeMixedSymbolQueryRows(
  primary: readonly SymbolQueryRow[],
  fallback: readonly SymbolQueryRow[],
  opts: { sort?: boolean } = {},
): SymbolQueryRow[] {
  const byId = new Map<number, SymbolQueryRow>();
  for (const row of fallback) {
    if (primary.length > 0 && !isPreciseMixedFallbackRow(row)) continue;
    byId.set(row.id, row);
  }
  for (const row of primary) byId.set(row.id, row);
  const rows = [...byId.values()];
  return opts.sort
    ? rows.sort((left, right) =>
      left.start_line - right.start_line
      || left.end_line - right.end_line
      || left.symbol.localeCompare(right.symbol))
    : rows;
}
