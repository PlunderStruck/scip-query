import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { ProjectIndex } from '../../core/project-index.js';
import { semanticCallerMap } from '../../semantic/shared-primitives.js';
import { isCallableSymbol, isModuleLikeSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';

export interface DiffImpactResult {
  changedFiles: string[];
  changedSymbols: Array<{
    symbol: string;
    shortName: string;
    file: string;
    startLine: number;
    endLine: number;
    fanIn: number;
  }>;
  affectedConsumers: Array<{ file: string; consumedSymbols: number }>;
  summary: {
    totalChangedFiles: number;
    totalChangedSymbols: number;
    totalAffectedFiles: number;
    note?: string;
  };
}

type ChangedSymbol = DiffImpactResult['changedSymbols'][number];
type ConsumerMap = Map<string, Set<string>>;

export interface DiffImpactPlan {
  changedFileLines: string[];
  changedFiles: string[];
  changedRanges: ChangedLineRange[];
  renamedFiles: RenamedFile[];
  note?: string;
}

/** Plan note when git itself failed (not a repo, bad ref) — vs an empty diff. */
export const GIT_DIFF_UNAVAILABLE_NOTE = 'Unable to compute git diff.';

export interface ChangedLineRange {
  file: string;
  startLine: number;
  endLine: number;
}

export interface RenamedFile {
  from: string;
  to: string;
  similarity: number;
}

export interface DiffImpactPartial {
  changedSymbols: ChangedSymbol[];
  consumerEntries: Array<{ file: string; symbols: string[] }>;
}

/**
 * Given a git diff, compute the affected symbol set.
 * Finds all symbols defined in changed files, their fan-in,
 * and the files that consume them downstream.
 */
// scip-query: ignore-extract — this is the report assembly pipeline; the
// helper calls already own the real work and the remaining body preserves
// the user-facing result order.
export function diffImpact(db: ScipDatabase, opts: { base?: string; plan?: DiffImpactPlan } = {}): DiffImpactResult {
  const plan = opts.plan ?? diffImpactPlan(db, opts);
  if (plan.note) {
    return emptyDiffImpact(plan.note, plan.changedFileLines);
  }
  if (plan.changedFiles.length === 0) {
    return unindexedChangedFilesResult(plan.changedFileLines);
  }

  return mergeDiffImpactPartials(plan.changedFiles, [
    diffImpactPartial(db, plan.changedFiles, plan.changedFiles, plan.changedRanges),
  ]);
}

export function diffImpactPlan(db: ScipDatabase, opts: { base?: string } = {}): DiffImpactPlan {
  const { base = 'HEAD' } = opts;
  try {
    const changedFileLines = getChangedFiles(db.config.projectRoot, base);
    const changedFiles = indexedChangedFiles(db, changedFileLines);
    const changedRanges = indexedChangedRanges(db, getChangedLineRanges(db.config.projectRoot, base));
    return {
      changedFileLines,
      changedFiles,
      changedRanges,
      renamedFiles: detectRenamedFiles(db.config.projectRoot, base, changedFiles),
      note: changedFileLines.length === 0 ? 'No changed files found.' : undefined,
    };
  } catch {
    return {
      changedFileLines: [],
      changedFiles: [],
      changedRanges: [],
      renamedFiles: [],
      note: GIT_DIFF_UNAVAILABLE_NOTE,
    };
  }
}

export function diffImpactPartial(
  db: ScipDatabase,
  filesToAnalyze: readonly string[],
  allChangedFiles: readonly string[],
  changedRanges: readonly ChangedLineRange[] = [],
): DiffImpactPartial {
  const index = new ProjectIndex(db);
  const changedFileSet = new Set(allChangedFiles);
  const changedRangeMap = rangesByFile(changedRanges);
  const changedSymbols: ChangedSymbol[] = [];
  const consumerMap: ConsumerMap = new Map();

  const defs = filesToAnalyze
    .flatMap((file) => index.definitionsForFile(file))
    .filter(isDiffImpactCandidate)
    .filter((def) => definitionTouchesChangedRange(def, changedRangeMap))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.startLine - b.startLine);
  const symbolIds = defs.map((def) => def.symbolId);
  // Semantic caller evidence costs a whole-project findReferences per
  // definition — spend it only where it can change an outcome: defs the SCIP
  // index shows zero consumers for. Indexed fan-in already proves liveness
  // for the rest.
  const fanInBySymbolId = scipFanInBySymbolId(db, symbolIds);
  const consumerFilesBySymbolId = scipConsumerFilesBySymbolId(db, symbolIds, allChangedFiles);
  const semanticConsumers = semanticCallerMap(
    db,
    defs.filter((def) => fanInBySymbolId.get(def.symbolId) === 0),
  );
  for (const def of defs) {
    addChangedDefinitionImpact(
      db,
      def,
      changedFileSet,
      changedSymbols,
      consumerMap,
      semanticConsumers.get(def.symbolId) ?? new Set<string>(),
      fanInBySymbolId.get(def.symbolId) ?? 0,
      consumerFilesBySymbolId.get(def.symbolId) ?? new Set<string>(),
    );
  }

  return {
    changedSymbols,
    consumerEntries: [...consumerMap.entries()].map(([file, symbols]) => ({
      file,
      symbols: [...symbols].sort(),
    })),
  };
}

export function mergeDiffImpactPartials(
  changedFiles: readonly string[],
  partials: readonly DiffImpactPartial[],
): DiffImpactResult {
  const consumerMap: ConsumerMap = new Map();
  const changedSymbols = partials.flatMap((partial) => partial.changedSymbols);

  for (const partial of partials) {
    for (const entry of partial.consumerEntries) {
      let bucket = consumerMap.get(entry.file);
      if (!bucket) {
        bucket = new Set();
        consumerMap.set(entry.file, bucket);
      }
      for (const symbol of entry.symbols) bucket.add(symbol);
    }
  }

  const affectedConsumers = affectedConsumerRows(consumerMap);
  return {
    changedFiles: [...changedFiles],
    changedSymbols,
    affectedConsumers,
    summary: {
      totalChangedFiles: changedFiles.length,
      totalChangedSymbols: changedSymbols.length,
      totalAffectedFiles: affectedConsumers.length,
    },
  };
}

function emptyDiffImpact(note: string, changedFiles: string[] = []): DiffImpactResult {
  return {
    changedFiles,
    changedSymbols: [],
    affectedConsumers: [],
    summary: {
      totalChangedFiles: changedFiles.length,
      totalChangedSymbols: 0,
      totalAffectedFiles: 0,
      note,
    },
  };
}

function unindexedChangedFilesResult(changedFiles: string[]): DiffImpactResult {
  return {
    changedFiles,
    changedSymbols: [],
    affectedConsumers: [],
    summary: {
      totalChangedFiles: changedFiles.length,
      totalChangedSymbols: 0,
      totalAffectedFiles: 0,
      note: 'Changed files are not present in the current SCIP index.',
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

  return [
    ...new Set(
      [diff, staged, untracked]
        .flatMap((chunk) => chunk.split('\n'))
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ];
}

function getChangedLineRanges(projectRoot: string, base: string): ChangedLineRange[] {
  const diff = execFileSync('git', ['diff', '--unified=0', base], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 10_000,
  });
  const staged = execFileSync('git', ['diff', '--unified=0', '--cached', base], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 10_000,
  });

  return dedupeRanges([...parseChangedLineRanges(diff), ...parseChangedLineRanges(staged)]);
}

export function fileContentAtBase(projectRoot: string, base: string, relativePath: string): string | null {
  try {
    // `ref:./path` resolves the path against cwd, so index-relative paths
    // work even when the project root is not the git root.
    return execFileSync('git', ['show', `${base}:./${relativePath}`], {
      encoding: 'utf-8',
      cwd: projectRoot,
      timeout: 10_000,
      // A missing path at base is the expected "file is new" signal — keep
      // git's fatal message off the user's terminal.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function detectRenamedFiles(projectRoot: string, base: string, changedFiles: readonly string[]): RenamedFile[] {
  if (changedFiles.length === 0) return [];

  const renamed = new Map<string, RenamedFile>();
  const claimedSources = new Set<string>();
  for (const rename of gitReportedRenames(projectRoot, base)) {
    if (!changedFiles.includes(rename.to)) continue;
    renamed.set(rename.to, rename);
    claimedSources.add(rename.from);
  }

  const deletedFiles = getDeletedFiles(projectRoot, base);
  if (deletedFiles.length === 0) {
    return [...renamed.values()].sort((left, right) => left.to.localeCompare(right.to));
  }

  for (const to of changedFiles) {
    if (renamed.has(to) || !existsSync(`${projectRoot}/${to}`)) continue;
    const candidates = deletedFiles
      .filter((from) => !claimedSources.has(from))
      .filter((from) => basename(from) === basename(to));
    if (candidates.length === 0) continue;

    const current = readFileSync(`${projectRoot}/${to}`, 'utf-8');
    const best = candidates
      .map((from) => ({
        from,
        to,
        similarity: sourceMoveSimilarity(fileContentAtBase(projectRoot, base, from) ?? '', current),
      }))
      .sort((left, right) => right.similarity - left.similarity)[0];

    if (best && best.similarity >= 0.45) {
      renamed.set(to, best);
      claimedSources.add(best.from);
    }
  }

  return [...renamed.values()].sort((left, right) => left.to.localeCompare(right.to));
}

function getDeletedFiles(projectRoot: string, base: string): string[] {
  const diff = execFileSync('git', ['diff', '--name-only', '--diff-filter=D', base], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 10_000,
  });
  const staged = execFileSync('git', ['diff', '--name-only', '--diff-filter=D', '--cached', base], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 10_000,
  });
  return [...new Set([...lines(diff), ...lines(staged)])];
}

function gitReportedRenames(projectRoot: string, base: string): RenamedFile[] {
  const unstaged = execFileSync('git', ['diff', '--name-status', '--find-renames', base], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 10_000,
  });
  const staged = execFileSync('git', ['diff', '--name-status', '--find-renames', '--cached', base], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 10_000,
  });
  return [...unstaged.split('\n'), ...staged.split('\n')]
    .map((line) => line.trim())
    .filter((line) => line.startsWith('R'))
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string, string] => parts.length >= 3)
    .map(([status, from, to]) => ({
      from,
      to,
      similarity: Number(status.slice(1)) / 100,
    }));
}

function sourceMoveSimilarity(left: string, right: string): number {
  const leftTokens = new Set(sourceMoveTokens(left));
  const rightTokens = new Set(sourceMoveTokens(right));
  if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return (2 * shared) / (leftTokens.size + rightTokens.size);
}

function sourceMoveTokens(text: string): string[] {
  return text.match(/[A-Za-z_$][\w$]*|[{}()[\].,]/g) ?? [];
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function indexedChangedFiles(db: ScipDatabase, changedFileLines: readonly string[]): string[] {
  const resolver = indexedDocumentResolver(db);
  const changedFiles: string[] = [];
  for (const file of changedFileLines) {
    const relativePath = resolver(file);
    if (relativePath && !db.isIgnored(relativePath)) {
      changedFiles.push(relativePath);
    }
  }
  return changedFiles;
}

function indexedChangedRanges(db: ScipDatabase, changedRanges: readonly ChangedLineRange[]): ChangedLineRange[] {
  const resolver = indexedDocumentResolver(db);
  const ranges: ChangedLineRange[] = [];
  for (const range of changedRanges) {
    const relativePath = resolver(range.file);
    if (relativePath && !db.isIgnored(relativePath)) {
      ranges.push({ ...range, file: relativePath });
    }
  }
  return dedupeRanges(ranges);
}

function indexedDocumentResolver(db: ScipDatabase): (file: string) => string | null {
  const docs = db
    .all<{ relative_path: string }>(
      `SELECT relative_path FROM documents
     ORDER BY id`,
    )
    .map((doc) => doc.relative_path);
  const exact = new Map(docs.map((path) => [path, path]));
  return (file: string) => {
    const normalized = file.replace(/\\/g, '/');
    const exactMatch = exact.get(normalized);
    if (exactMatch) return exactMatch;
    return docs.find((path) => path.endsWith(normalized)) ?? null;
  };
}

function parseChangedLineRanges(diff: string): ChangedLineRange[] {
  const ranges: ChangedLineRange[] = [];
  let currentFile: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      currentFile = normalizeDiffPath(line.slice(4).trim());
      continue;
    }
    if (!currentFile || !line.startsWith('@@ ')) continue;
    const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Math.max(0, Number(match[1]) - 1);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    ranges.push({
      file: currentFile,
      startLine: start,
      endLine: Math.max(start, start + Math.max(count, 1) - 1),
    });
  }
  return ranges;
}

function normalizeDiffPath(path: string): string | null {
  if (path === '/dev/null') return null;
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

function dedupeRanges(ranges: readonly ChangedLineRange[]): ChangedLineRange[] {
  const seen = new Set<string>();
  const unique: ChangedLineRange[] = [];
  for (const range of ranges) {
    const key = `${range.file}:${range.startLine}:${range.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(range);
  }
  return unique;
}

function rangesByFile(ranges: readonly ChangedLineRange[]): ReadonlyMap<string, readonly ChangedLineRange[]> {
  const map = new Map<string, ChangedLineRange[]>();
  for (const range of ranges) {
    let bucket = map.get(range.file);
    if (!bucket) {
      bucket = [];
      map.set(range.file, bucket);
    }
    bucket.push(range);
  }
  return map;
}

function definitionTouchesChangedRange(
  definition: IndexedDefinition,
  changedRanges: ReadonlyMap<string, readonly ChangedLineRange[]>,
): boolean {
  const ranges = changedRanges.get(definition.relativePath);
  if (!ranges || ranges.length === 0) return true;
  return ranges.some((range) =>
    rangesOverlap(definition.startLine, definition.endLine, range.startLine, range.endLine),
  );
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA <= endB && startB <= endA;
}

// scip-query: ignore-extract — this adds one changed-definition impact row:
// reportability, SCIP fan-in, source consumers, and dedupe all feed the same
// changed-file evidence set.
function addChangedDefinitionImpact(
  db: ScipDatabase,
  definition: IndexedDefinition,
  changedFileSet: ReadonlySet<string>,
  changedSymbols: ChangedSymbol[],
  consumerMap: ConsumerMap,
  semanticConsumers: ReadonlySet<string>,
  indexedFanIn: number,
  indexedConsumers: ReadonlySet<string>,
): void {
  const fanIn = Math.max(indexedFanIn, semanticConsumers.size);
  if (!shouldReportChangedDefinition(definition, fanIn)) return;

  const shortName = shortenSymbol(definition.symbol);
  changedSymbols.push({
    symbol: definition.symbol,
    shortName,
    file: definition.relativePath,
    startLine: definition.startLine,
    endLine: definition.endLine,
    fanIn,
  });

  for (const file of indexedConsumers) {
    addConsumerFile(db, changedFileSet, consumerMap, file, shortName);
  }
  for (const file of semanticConsumers) {
    addConsumerFile(db, changedFileSet, consumerMap, file, shortName);
  }
}

function scipFanInBySymbolId(db: ScipDatabase, symbolIds: readonly number[]): Map<number, number> {
  if (symbolIds.length === 0) return new Map();
  const rows = db.all<{ symbol_id: number; fan_in: number }>(
    `SELECT m.symbol_id, COUNT(DISTINCT c.document_id) AS fan_in
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     WHERE m.symbol_id IN (${symbolIds.map(() => '?').join(',')})
       AND m.role != 1
     GROUP BY m.symbol_id`,
    ...symbolIds,
  );
  return new Map(rows.map((row) => [row.symbol_id, row.fan_in]));
}

function scipConsumerFilesBySymbolId(
  db: ScipDatabase,
  symbolIds: readonly number[],
  changedFiles: readonly string[],
): Map<number, Set<string>> {
  if (symbolIds.length === 0 || changedFiles.length === 0) return new Map();
  const rows = db.all<{ symbol_id: number; relative_path: string }>(
    `SELECT DISTINCT m.symbol_id, ref_d.relative_path
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents ref_d ON c.document_id = ref_d.id
     WHERE m.symbol_id IN (${symbolIds.map(() => '?').join(',')})
       AND m.role != 1
       AND ref_d.relative_path NOT IN (${changedFiles.map(() => '?').join(',')})
     ${db.pathExclusionsFor('ref_d')}`,
    ...symbolIds,
    ...changedFiles,
  );
  const consumersBySymbolId = new Map<number, Set<string>>();
  for (const row of rows) {
    let consumers = consumersBySymbolId.get(row.symbol_id);
    if (!consumers) {
      consumers = new Set();
      consumersBySymbolId.set(row.symbol_id, consumers);
    }
    consumers.add(row.relative_path);
  }
  return consumersBySymbolId;
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

function affectedConsumerRows(consumerMap: ConsumerMap): DiffImpactResult['affectedConsumers'] {
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
