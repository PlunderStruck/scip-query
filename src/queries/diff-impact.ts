import { execFileSync } from 'node:child_process';
import type { ScipDatabase } from '../storage/db.js';
import type { DiffImpactResult, IndexedDefinition } from '../domain/types.js';
import { ProjectIndex } from '../core/project-index.js';
import { semanticCallerMap } from '../semantic/shared-primitives.js';
import { isCallableSymbol, isModuleLikeSymbol, shortenSymbol } from '../symbols/symbol-parser.js';

type ChangedSymbol = DiffImpactResult['changedSymbols'][number];
type ConsumerMap = Map<string, Set<string>>;

/**
 * Given a git diff, compute the affected symbol set.
 * Finds all symbols defined in changed files, their fan-in,
 * and the files that consume them downstream.
 */
// scip-query: ignore-extract — this is the report assembly pipeline; the
// helper calls already own the real work and the remaining body preserves
// the user-facing result order.
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
    return emptyDiffImpact('Unable to compute git diff.');
  }

  if (changedFileLines.length === 0) {
    return emptyDiffImpact('No changed files found.');
  }

  const changedFiles = indexedChangedFiles(db, changedFileLines);

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
  const defs = changedDefinitions(index, changedFiles);

  const changedSymbols: ChangedSymbol[] = [];
  const consumerMap: ConsumerMap = new Map();

  for (const def of defs) {
    addChangedDefinitionImpact(db, def, changedFiles, changedFileSet, changedSymbols, consumerMap);
  }

  const affectedConsumers = affectedConsumerRows(consumerMap);
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

function emptyDiffImpact(note: string): DiffImpactResult {
  return {
    changedFiles: [],
    changedSymbols: [],
    affectedConsumers: [],
    summary: {
      totalChangedFiles: 0,
      totalChangedSymbols: 0,
      totalAffectedFiles: 0,
      note,
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

function indexedChangedFiles(
  db: ScipDatabase,
  changedFileLines: readonly string[],
): string[] {
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
  return changedFiles;
}

function changedDefinitions(
  index: ProjectIndex,
  changedFiles: readonly string[],
): IndexedDefinition[] {
  return changedFiles.flatMap((file) => index.definitionsForFile(file))
    .filter(isDiffImpactCandidate)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.startLine - b.startLine);
}

// scip-query: ignore-extract — this adds one changed-definition impact row:
// reportability, SCIP fan-in, source consumers, and dedupe all feed the same
// changed-file evidence set.
function addChangedDefinitionImpact(
  db: ScipDatabase,
  definition: IndexedDefinition,
  changedFiles: readonly string[],
  changedFileSet: ReadonlySet<string>,
  changedSymbols: ChangedSymbol[],
  consumerMap: ConsumerMap,
): void {
  const semanticConsumers = semanticCallerMap(db, [definition]).get(definition.symbolId) ?? new Set<string>();
  const fanIn = Math.max(scipFanIn(db, definition.symbolId), semanticConsumers.size);
  if (!shouldReportChangedDefinition(definition, fanIn)) return;

  const shortName = shortenSymbol(definition.symbol);
  changedSymbols.push({
    symbol: definition.symbol,
    shortName,
    file: definition.relativePath,
    fanIn,
  });

  for (const file of scipConsumerFiles(db, definition.symbolId, changedFiles)) {
    addConsumerFile(db, changedFileSet, consumerMap, file, shortName);
  }
  for (const file of semanticConsumers) {
    addConsumerFile(db, changedFileSet, consumerMap, file, shortName);
  }
}

function scipFanIn(
  db: ScipDatabase,
  symbolId: number,
): number {
  const fanInRow = db.get<{ fan_in: number }>(
    `SELECT COUNT(DISTINCT c.document_id) AS fan_in
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     WHERE m.symbol_id = ?
       AND m.role != 1`,
    symbolId,
  );
  return fanInRow?.fan_in ?? 0;
}

function scipConsumerFiles(
  db: ScipDatabase,
  symbolId: number,
  changedFiles: readonly string[],
): string[] {
  if (changedFiles.length === 0) return [];
  const consumers = db.all<{ relative_path: string }>(
    `SELECT DISTINCT ref_d.relative_path
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents ref_d ON c.document_id = ref_d.id
     WHERE m.symbol_id = ?
       AND m.role != 1
       AND ref_d.relative_path NOT IN (${changedFiles.map(() => '?').join(',')})
       ${db.pathExclusionsFor('ref_d')}`,
    symbolId,
    ...changedFiles,
  );
  return consumers.map((consumer) => consumer.relative_path);
}

function addConsumerFile(
  db: ScipDatabase,
  changedFileSet: ReadonlySet<string>,
  consumerMap: ConsumerMap,
  file: string,
  shortName: string,
): void {
  if (db.isIgnored(file)) return;
  if (changedFileSet.has(file)) return;
  let consumedSymbols = consumerMap.get(file);
  if (!consumedSymbols) {
    consumedSymbols = new Set<string>();
    consumerMap.set(file, consumedSymbols);
  }
  consumedSymbols.add(shortName);
}

function affectedConsumerRows(
  consumerMap: ConsumerMap,
): DiffImpactResult['affectedConsumers'] {
  return [...consumerMap.entries()]
    .map(([file, symbols]) => ({ file, consumedSymbols: symbols.size }))
    .sort((a, b) => b.consumedSymbols - a.consumedSymbols);
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
