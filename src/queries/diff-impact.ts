import { execFileSync } from 'node:child_process';
import type { ScipDatabase } from '../db.js';
import type { DiffImpactResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Given a git diff, compute the affected symbol set.
 * Finds all symbols defined in changed files, their fan-in,
 * and the files that consume them downstream.
 */
export function diffImpact(
  db: ScipDatabase,
  opts: { base?: string } = {},
): DiffImpactResult {
  const { base = 'HEAD' } = opts;

  // Get changed files from git
  let changedFileLines: string[];
  try {
    changedFileLines = getChangedFiles(db.config.projectRoot, base);
  } catch {
    // Not in a git repo or git not available — return empty result
    return {
      changedFiles: [],
      changedSymbols: [],
      affectedConsumers: [],
      summary: {
        totalChangedFiles: 0,
        totalChangedSymbols: 0,
        totalAffectedFiles: 0,
        note: 'Unable to compute git diff.',
      },
    };
  }

  if (changedFileLines.length === 0) {
    return {
      changedFiles: [],
      changedSymbols: [],
      affectedConsumers: [],
      summary: {
        totalChangedFiles: 0,
        totalChangedSymbols: 0,
        totalAffectedFiles: 0,
        note: 'No changed files found.',
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
      summary: {
        totalChangedFiles: changedFileLines.length,
        totalChangedSymbols: 0,
        totalAffectedFiles: 0,
        note: 'Changed files are not present in the current SCIP index.',
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
  const changedSymbols: DiffImpactResult['changedSymbols'] = [];
  const consumerMap = new Map<string, Set<string>>(); // file -> set of consumed symbol shortNames

  for (const sym of syms) {
    // Fan-in: distinct files that reference this symbol
    const fanInRow = db.get<{ fan_in: number }>(
      `SELECT COUNT(DISTINCT c.document_id) AS fan_in
      FROM mentions m
      JOIN chunks c ON m.chunk_id = c.id
      WHERE m.symbol_id = ?
        AND m.role != 1`,
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
        AND m.role != 1
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
  }

  // Build affected consumers list
  const affectedConsumers = [...consumerMap.entries()]
    .map(([file, symbols]) => ({ file, consumedSymbols: symbols.size }))
    .sort((a, b) => b.consumedSymbols - a.consumedSymbols);

  return {
    changedFiles,
    changedSymbols,
    affectedConsumers,
    summary: {
      totalChangedFiles: changedFiles.length,
      totalChangedSymbols: changedSymbols.length,
      totalAffectedFiles: affectedConsumers.length,
    },
  };
}

function getChangedFiles(projectRoot: string, base: string): string[] {
  const diff = execFileSync('git', ['diff', '--name-only', base], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 10_000,
  });
  const staged = execFileSync('git', ['diff', '--name-only', '--cached', base], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 10_000,
  });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 10_000,
  });

  return [...new Set(
    [diff, staged, untracked]
      .flatMap((chunk) => chunk.split('\n'))
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  )];
}
