import { execFileSync } from 'node:child_process';
import type { ScipDatabase } from '../db.js';
import { TEST_FILE_PATTERNS, testFileMatchSql } from '../query-support.js';
import type { DiffImpactResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Given a git diff, compute the affected symbol set.
 * Finds all symbols defined in changed files, their fan-in,
 * the files that consume them, and test coverage gaps.
 */
export function diffImpact(
  db: ScipDatabase,
  opts: { base?: string } = {},
): DiffImpactResult {
  const { base = 'HEAD' } = opts;

  // Get changed files from git
  let changedFileLines: string[];
  try {
    const stdout = execFileSync('git', ['diff', '--name-only', base], {
      encoding: 'utf-8',
      cwd: db.config.projectRoot,
      timeout: 10_000,
    });
    changedFileLines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    // Not in a git repo or git not available — return empty result
    return {
      changedFiles: [],
      changedSymbols: [],
      affectedConsumers: [],
      uncoveredSymbols: [],
      summary: {
        totalChangedFiles: 0,
        totalChangedSymbols: 0,
        totalAffectedFiles: 0,
        testCoveragePercent: 0,
      },
    };
  }

  if (changedFileLines.length === 0) {
    return {
      changedFiles: [],
      changedSymbols: [],
      affectedConsumers: [],
      uncoveredSymbols: [],
      summary: {
        totalChangedFiles: 0,
        totalChangedSymbols: 0,
        totalAffectedFiles: 0,
        testCoveragePercent: 0,
      },
    };
  }

  // Match changed files against the index
  const changedFiles: string[] = [];
  const changedDocIds: number[] = [];

  for (const file of changedFileLines) {
    const doc = db.get<{ id: number; relative_path: string }>(
      `SELECT id, relative_path FROM documents
       WHERE relative_path LIKE ?
       LIMIT 1`,
      `%${file}`,
    );
    if (doc && !db.isIgnored(doc.relative_path)) {
      changedFiles.push(doc.relative_path);
      changedDocIds.push(doc.id);
    }
  }

  if (changedDocIds.length === 0) {
    return {
      changedFiles: changedFileLines,
      changedSymbols: [],
      affectedConsumers: [],
      uncoveredSymbols: [],
      summary: {
        totalChangedFiles: changedFileLines.length,
        totalChangedSymbols: 0,
        totalAffectedFiles: 0,
        testCoveragePercent: 0,
      },
    };
  }

  // Get all symbols defined in changed files
  const docPlaceholders = changedDocIds.map(() => '?').join(',');
  const syms = db.all<{
    symbol_id: number;
    symbol: string;
    relative_path: string;
  }>(
    `SELECT DISTINCT gs.id AS symbol_id, gs.symbol, d.relative_path
    FROM defn_enclosing_ranges der
    JOIN global_symbols gs ON der.symbol_id = gs.id
    JOIN documents d ON der.document_id = d.id
    WHERE der.document_id IN (${docPlaceholders})
      ${db.symbolNoiseFor('gs')}
    ORDER BY d.relative_path`,
    ...changedDocIds,
  );

  // For each symbol, compute fan-in (distinct referencing documents)
  const testPatternSql = testFileMatchSql('ref_d', TEST_FILE_PATTERNS);
  const changedSymbols: DiffImpactResult['changedSymbols'] = [];
  const consumerMap = new Map<string, Set<string>>(); // file -> set of consumed symbol shortNames
  const uncoveredSymbols: DiffImpactResult['uncoveredSymbols'] = [];
  let coveredCount = 0;

  for (const sym of syms) {
    // Fan-in: distinct files that reference this symbol
    const fanInRow = db.get<{ fan_in: number }>(
      `SELECT COUNT(DISTINCT c.document_id) AS fan_in
      FROM mentions m
      JOIN chunks c ON m.chunk_id = c.id
      WHERE m.symbol_id = ?
        AND m.role = 0`,
      sym.symbol_id,
    );

    const fanIn = fanInRow?.fan_in ?? 0;
    const shortName = shortenSymbol(sym.symbol);

    changedSymbols.push({
      symbol: sym.symbol,
      shortName,
      file: sym.relative_path,
      fanIn,
    });

    // Collect consumer files (excluding the changed files themselves)
    const consumers = db.all<{ relative_path: string }>(
      `SELECT DISTINCT ref_d.relative_path
      FROM mentions m
      JOIN chunks c ON m.chunk_id = c.id
      JOIN documents ref_d ON c.document_id = ref_d.id
      WHERE m.symbol_id = ?
        AND m.role = 0
        AND ref_d.relative_path NOT IN (${changedFiles.map(() => '?').join(',')})
        ${db.pathExclusionsFor('ref_d')}`,
      sym.symbol_id,
      ...changedFiles,
    );

    for (const consumer of consumers) {
      if (db.isIgnored(consumer.relative_path)) continue;
      if (!consumerMap.has(consumer.relative_path)) {
        consumerMap.set(consumer.relative_path, new Set());
      }
      consumerMap.get(consumer.relative_path)!.add(shortName);
    }

    // Check test coverage
    const hasTest = db.get<{ c: number }>(
      `SELECT COUNT(*) AS c
      FROM mentions m
      JOIN chunks c ON m.chunk_id = c.id
      JOIN documents ref_d ON c.document_id = ref_d.id
      WHERE m.symbol_id = ?
        AND m.role = 0
        AND (${testPatternSql})`,
      sym.symbol_id,
    );

    if (hasTest && hasTest.c > 0) {
      coveredCount++;
    } else {
      uncoveredSymbols.push({
        symbol: sym.symbol,
        shortName,
        file: sym.relative_path,
      });
    }
  }

  // Build affected consumers list
  const affectedConsumers = [...consumerMap.entries()]
    .map(([file, symbols]) => ({ file, consumedSymbols: symbols.size }))
    .sort((a, b) => b.consumedSymbols - a.consumedSymbols);

  const totalSymbols = changedSymbols.length;
  const testCoveragePercent =
    totalSymbols > 0 ? Math.round((coveredCount / totalSymbols) * 100) : 0;

  return {
    changedFiles,
    changedSymbols,
    affectedConsumers,
    uncoveredSymbols,
    summary: {
      totalChangedFiles: changedFiles.length,
      totalChangedSymbols: totalSymbols,
      totalAffectedFiles: affectedConsumers.length,
      testCoveragePercent,
    },
  };
}
