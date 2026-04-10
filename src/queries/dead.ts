import type { ScipDatabase } from '../db.js';
import type { DeadOptions, DeadSymbolResult, DeadSummary } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find dead exports: symbols defined locally with no cross-file references.
 * Language-agnostic — works with any SCIP index.
 */
export function dead(db: ScipDatabase, opts: DeadOptions = {}): DeadSummary {
  const {
    scope,
    minLoc = 1,
    includeTests = false,
    skipBarrels = false,
    includeMembers = false,
  } = opts;

  // Build dynamic WHERE clauses
  const conditions: string[] = [
    `d.relative_path NOT LIKE 'node_modules/%'`,
    `d.relative_path NOT LIKE '.git/%'`,
    `gs.symbol NOT LIKE '%().(%'`,
    `gs.symbol NOT LIKE '%typeLiteral%'`,
    `(der.end_line - der.start_line + 1) >= ?`,
  ];
  const params: unknown[] = [minLoc];

  if (scope) {
    conditions.push(`d.relative_path LIKE ?`);
    params.push(`%${scope}%`);
  }

  if (!includeTests) {
    conditions.push(`d.relative_path NOT LIKE '%/__tests__/%'`);
    conditions.push(`d.relative_path NOT LIKE '%.test.%'`);
    conditions.push(`d.relative_path NOT LIKE '%.spec.%'`);
    conditions.push(`d.relative_path NOT LIKE '%/test-utils/%'`);
    // Python test conventions
    conditions.push(`d.relative_path NOT LIKE '%/tests/%'`);
    // Rust test conventions
    conditions.push(`d.relative_path NOT LIKE '%/test/%'`);
  }

  if (!includeMembers) {
    // # is the SCIP type-member delimiter (works across all languages)
    conditions.push(`gs.symbol NOT LIKE '%#%'`);
  }

  // Barrel file exclusion for the NOT EXISTS subquery
  const barrelExclusions = skipBarrels
    ? `AND ref_d.relative_path NOT LIKE '%/index.ts'
       AND ref_d.relative_path NOT LIKE '%/index.js'
       AND ref_d.relative_path NOT LIKE '%/mod.rs'
       AND ref_d.relative_path NOT LIKE '%/__init__.py'`
    : '';

  const sql = `
    SELECT
      d.relative_path,
      der.start_line,
      der.end_line,
      (der.end_line - der.start_line + 1) AS loc,
      gs.symbol,
      (SELECT COUNT(*) FROM mentions m2
       JOIN chunks c2 ON m2.chunk_id = c2.id
       WHERE m2.symbol_id = gs.id AND m2.role = 0 AND c2.document_id = d.id
      ) AS same_file_refs
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE ${conditions.join('\n      AND ')}
      AND NOT EXISTS (
        SELECT 1
        FROM mentions ref_m
        JOIN chunks ref_c ON ref_m.chunk_id = ref_c.id
        JOIN documents ref_d ON ref_c.document_id = ref_d.id
        WHERE ref_m.symbol_id = gs.id
          AND ref_m.role = 0
          AND ref_d.id != d.id
          ${barrelExclusions}
      )
    ORDER BY (der.end_line - der.start_line + 1) DESC, d.relative_path, der.start_line
  `;

  const rows = db.all<{
    relative_path: string;
    start_line: number;
    end_line: number;
    loc: number;
    symbol: string;
    same_file_refs: number;
  }>(sql, ...params);

  let deadCodeCount = 0;
  let deadExportCount = 0;
  let totalLoc = 0;

  const symbols: DeadSymbolResult[] = rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => {
      const kind = r.same_file_refs === 0 ? 'dead-code' : 'dead-export';
      if (kind === 'dead-code') deadCodeCount++;
      else deadExportCount++;
      totalLoc += r.loc;

      return {
        relativePath: r.relative_path,
        startLine: r.start_line,
        endLine: r.end_line,
        loc: r.loc,
        symbol: r.symbol,
        shortName: shortenSymbol(r.symbol),
        sameFileRefs: r.same_file_refs,
        kind,
      };
    });

  return {
    symbols,
    totalCount: symbols.length,
    deadCodeCount,
    deadExportCount,
    totalLoc,
  };
}
