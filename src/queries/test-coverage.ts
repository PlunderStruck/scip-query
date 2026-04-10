import type { ScipDatabase } from '../db.js';
import { TEST_FILE_PATTERNS, testFileExclusionSql, testFileMatchSql } from '../query-support.js';
import type { TestCoverageResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Check if a symbol is referenced by any test file.
 * Reports which test files cover (reference) each matching symbol.
 */
export function testCoverage(
  db: ScipDatabase,
  symbolPattern: string,
): TestCoverageResult[] {
  // Find matching symbols
  const syms = db.all<{
    id: number;
    symbol: string;
    relative_path: string;
  }>(
    `SELECT gs.id, gs.symbol, d.relative_path
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE gs.symbol LIKE ?
      ${db.pathExclusionsFor('d')}
      ${db.symbolNoiseFor('gs')}
    ORDER BY d.relative_path`,
    `%${symbolPattern}%`,
  );

  const testPatternSql = testFileMatchSql('ref_d', TEST_FILE_PATTERNS);

  return syms
    .filter((s) => !db.isIgnored(s.relative_path))
    .map((s) => {
      // Find test files that reference this symbol
      const testFiles = db.all<{ relative_path: string }>(
        `SELECT DISTINCT ref_d.relative_path
        FROM mentions m
        JOIN chunks c ON m.chunk_id = c.id
        JOIN documents ref_d ON c.document_id = ref_d.id
        WHERE m.symbol_id = ?
          AND m.role != 1
          AND (${testPatternSql})
        ORDER BY ref_d.relative_path`,
        s.id,
      ).map((r) => r.relative_path);

      return {
        symbol: s.symbol,
        shortName: shortenSymbol(s.symbol),
        definedIn: s.relative_path,
        testFiles,
        covered: testFiles.length > 0,
      };
    });
}

/**
 * Summary: what percentage of symbols in scope are referenced by test files?
 */
export function testCoverageSummary(
  db: ScipDatabase,
  opts: { scope?: string; minLoc?: number } = {},
): { total: number; covered: number; uncovered: number; percent: number } {
  const { scope, minLoc = 3 } = opts;
  const scopeFilter = scope ? `AND d.relative_path LIKE '%${scope}%'` : '';
  const testPatternSql = testFileExclusionSql('d');

  const symbols = db.all<{ id: number }>(
    `SELECT gs.id
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE 1 = 1
      ${db.pathExclusionsFor('d')}
      AND ${testPatternSql}
      ${db.symbolNoiseFor('gs')}
      AND gs.symbol NOT LIKE '%#%'
      AND (der.end_line - der.start_line + 1) >= ?
      ${scopeFilter}`,
    minLoc,
  );

  const testRefSql = testFileMatchSql('ref_d', TEST_FILE_PATTERNS);

  let covered = 0;
  for (const s of symbols) {
    const hasTest = db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM mentions m
       JOIN chunks c ON m.chunk_id = c.id
       JOIN documents ref_d ON c.document_id = ref_d.id
       WHERE m.symbol_id = ? AND m.role != 1 AND (${testRefSql})`,
      s.id,
    );
    if (hasTest && hasTest.c > 0) covered++;
  }

  const total = symbols.length;
  return {
    total,
    covered,
    uncovered: total - covered,
    percent: total > 0 ? Math.round((covered / total) * 100) : 0,
  };
}
