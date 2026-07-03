import type { SymbolQueryRow } from '../storage/scip-rows.js';
import { parentTypeName } from './symbol-parser.js';

export interface MixedFallbackRowOptions {
  /**
   * Opt-in (default false / today's behavior): also treat class-member
   * fallback rows (SCIP `ClassName#field.` symbols) as precise, so they
   * survive alongside primary rows instead of being dropped whenever the
   * file has any primary-indexed definition. These rows always carry a real
   * definition mention (role=1) — the fallback query only ever selects rows
   * with one — so there is no separate "confidence" check to add beyond the
   * class-member shape itself. See docs/plans/2026-07-02-catalog-class-members.md.
   */
  includeClassMemberFallbacks?: boolean;
}

/**
 * Mixed primary/fallback definition loads keep only fallback rows that look
 * like a top-level precise declaration when primary rows already exist. This
 * prevents broad mention-derived ranges from displacing AST-corrected ranges.
 */
export function isPreciseMixedFallbackRow(row: SymbolQueryRow, opts: MixedFallbackRowOptions = {}): boolean {
  const parentType = parentTypeName(row.symbol);
  if (parentType !== null) return opts.includeClassMemberFallbacks === true;
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
  opts: { sort?: boolean } & MixedFallbackRowOptions = {},
): SymbolQueryRow[] {
  const byId = new Map<number, SymbolQueryRow>();
  for (const row of fallback) {
    if (
      primary.length > 0 &&
      !isPreciseMixedFallbackRow(row, { includeClassMemberFallbacks: opts.includeClassMemberFallbacks })
    ) {
      continue;
    }
    byId.set(row.id, row);
  }
  for (const row of primary) byId.set(row.id, row);
  const rows = [...byId.values()];
  return opts.sort
    ? rows.sort(
        (left, right) =>
          left.start_line - right.start_line ||
          left.end_line - right.end_line ||
          left.symbol.localeCompare(right.symbol),
      )
    : rows;
}
