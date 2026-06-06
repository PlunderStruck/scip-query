import { execFileSync } from 'node:child_process';
import type { ScipDatabase } from '../storage/db.js';
import type { DiffImpactResult, IndexedDefinition } from '../domain/types.js';
import { ProjectIndex } from '../core/project-index.js';
import { semanticCallerMap } from '../semantic/shared-primitives.js';
import { isCallableSymbol, isModuleLikeSymbol, shortenSymbol } from '../symbols/symbol-parser.js';

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

  for (const file of changedFileLines) {
    const doc = db.get<{ relative_path: string }>(
      `SELECT relative_path FROM documents
       WHERE relative_path LIKE ?
       LIMIT 1`,
      `%${file}`,
    );
    if (doc && !db.isIgnored(doc.relative_path)) {
      changedFiles.push(doc.relative_path);
    }
  }

  if (changedFiles.length === 0) {
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

  const index = new ProjectIndex(db);
  const changedFileSet = new Set(changedFiles);
  const defs = changedFiles.flatMap((file) => index.definitionsForFile(file))
    .filter(isDiffImpactCandidate)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.startLine - b.startLine);

  // For each symbol, compute fan-in (distinct referencing documents)
  const changedSymbols: DiffImpactResult['changedSymbols'] = [];
  const consumerMap = new Map<string, Set<string>>(); // file -> set of consumed symbol shortNames

  for (const def of defs) {
    // Fan-in: distinct files that reference this symbol
    const fanInRow = db.get<{ fan_in: number }>(
      `SELECT COUNT(DISTINCT c.document_id) AS fan_in
      FROM mentions m
      JOIN chunks c ON m.chunk_id = c.id
      WHERE m.symbol_id = ?
        AND m.role != 1`,
      def.symbolId,
    );

    const semanticConsumers = semanticCallerMap(db, [def]).get(def.symbolId) ?? new Set<string>();
    const fanIn = Math.max(fanInRow?.fan_in ?? 0, semanticConsumers.size);
    if (!shouldReportChangedDefinition(def, fanIn)) continue;

    const shortName = shortenSymbol(def.symbol);

    changedSymbols.push({
      symbol: def.symbol,
      shortName,
      file: def.relativePath,
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
      def.symbolId,
      ...changedFiles,
    );

    for (const consumer of consumers) {
      if (db.isIgnored(consumer.relative_path)) continue;
      if (changedFileSet.has(consumer.relative_path)) continue;
      if (!consumerMap.has(consumer.relative_path)) {
        consumerMap.set(consumer.relative_path, new Set());
      }
      consumerMap.get(consumer.relative_path)!.add(shortName);
    }
    for (const file of semanticConsumers) {
      if (db.isIgnored(file)) continue;
      if (changedFileSet.has(file)) continue;
      if (!consumerMap.has(file)) {
        consumerMap.set(file, new Set());
      }
      consumerMap.get(file)!.add(shortName);
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

function isDiffImpactCandidate(definition: IndexedDefinition): boolean {
  if (isModuleLikeSymbol(definition.symbol)) return false;
  if (definition.parentTypeName !== null && !isCallableSymbol(definition.symbol)) return false;
  return true;
}

function shouldReportChangedDefinition(definition: IndexedDefinition, fanIn: number): boolean {
  if (isCallableSymbol(definition.symbol)) return true;
  if (definition.isTypeLike) return true;
  return definition.parentTypeName === null && fanIn > 0;
}
