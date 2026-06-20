import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { isEntrySurface, isRootedSymbol } from '../../analysis/file-classifier.js';
import { ProjectIndex } from '../../core/project-index.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { getResolvedReferenceSites } from '../../symbols/reference-sites.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { dead } from './dead.js';

export interface CleanupPlanEntry {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  /**
   * 'graph-fact': zero references anywhere — deletable today.
   * 'cascade':    becomes dead once earlier batches are deleted.
   */
  evidence: 'graph-fact' | 'cascade';
}

export interface CleanupBatch {
  /** 0 = deletable now; n = deletable after batch n-1 is applied. */
  depth: number;
  entries: CleanupPlanEntry[];
  loc: number;
  /** Files whose every definition is removed once this batch lands. */
  filesEmptied: string[];
}

export interface CleanupPlanResult {
  batches: CleanupBatch[];
  totalSymbols: number;
  totalLoc: number;
  /** Cascade candidates blocked by references outside the removal set. */
  blocked: Array<{ shortName: string; file: string; blockingFiles: string[] }>;
}

/**
 * Cascade cleanup plan: dead-code analysis is single-pass, but deletion
 * cascades — once batch 0 is gone, symbols referenced only from batch 0
 * become dead too. This runs the fixpoint and emits an ordered plan.
 *
 * Cascade rule (conservative): a symbol joins batch n+1 only when every
 * resolved reference site lies inside an already-removed definition's range.
 * Any reference that can't be placed inside the removal set — including
 * unattributable file-level references — blocks the cascade for that symbol.
 *
 * Apply batch by batch, re-running the project's typecheck between batches.
 */
export function cleanupPlan(
  db: ScipDatabase,
  opts: { scope?: string; minLoc?: number; maxDepth?: number; scanLimit?: number } = {},
): CleanupPlanResult {
  const { scope, minLoc = 1, maxDepth = 5, scanLimit } = opts;
  const index = new ProjectIndex(db);

  const seed = collectSeed(db, scope, minLoc, scanLimit);
  const removedRanges = new RemovedRangeIndex();
  for (const entry of seed) removedRanges.add(entry);

  const batches: CleanupBatch[] = [];
  const blocked: CleanupPlanResult['blocked'] = [];
  if (seed.length > 0) {
    batches.push(buildBatch(db, 0, seed, removedRanges));
  }

  // Worklist: cascade can only spread to symbols the removed code referenced.
  let frontier = seed.map((entry) => entry.definition).filter((definition): definition is IndexedDefinition => definition !== null);
  const visited = new Set<string>(seed.map((entry) => entry.symbol));

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const calleeMap = index.calleeMap(frontier, { semantic: false });
    const candidateNames = new Set<string>();
    for (const definition of frontier) {
      for (const callee of calleeMap.get(definition.symbolId) ?? []) {
        if (!visited.has(callee.symbol)) candidateNames.add(callee.symbol);
      }
    }

    const next: PlanEntryInternal[] = [];
    for (const name of candidateNames) {
      visited.add(name);
      const definition = resolveDefinition(db, name);
      if (!definition) continue;
      if (db.isIgnored(definition.relativePath)) continue;
      if (isEntrySurface(db, definition.relativePath)) continue;
      if (isRootedSymbol(db, definition.symbol, definition.relativePath)) continue;
      if (index.fileKind(definition.relativePath) === 'test') continue;
      if (index.hasSuppressionComment(definition)) continue;

      const verdict = cascadeVerdict(db, definition, removedRanges);
      if (verdict.removable) {
        next.push(toEntry(definition, 'cascade'));
      } else if (verdict.blockingFiles.length > 0) {
        blocked.push({
          shortName: shortenSymbol(definition.symbol),
          file: definition.relativePath,
          blockingFiles: verdict.blockingFiles.slice(0, 3),
        });
      }
    }

    if (next.length === 0) break;
    for (const entry of next) removedRanges.add(entry);
    batches.push(buildBatch(db, depth, next, removedRanges));
    frontier = next.map((entry) => entry.definition).filter((definition): definition is IndexedDefinition => definition !== null);
  }

  const totalLoc = batches.reduce((sum, batch) => sum + batch.loc, 0);
  const totalSymbols = batches.reduce((sum, batch) => sum + batch.entries.length, 0);
  return { batches, totalSymbols, totalLoc, blocked };
}

interface PlanEntryInternal extends CleanupPlanEntry {
  definition: IndexedDefinition | null;
}

function collectSeed(
  db: ScipDatabase,
  scope: string | undefined,
  minLoc: number,
  scanLimit: number | undefined,
): PlanEntryInternal[] {
  const summary = dead(db, { scope, minLoc, skipBarrels: true, deadCodeOnly: true, scanLimit, semantic: false });
  const entries: PlanEntryInternal[] = [];
  for (const symbol of summary.symbols) {
    if (symbol.kind !== 'dead-code') continue;
    if (isEntrySurface(db, symbol.relativePath)) continue;
    if (isRootedSymbol(db, symbol.symbol, symbol.relativePath)) continue;
    entries.push({
      symbol: symbol.symbol,
      shortName: symbol.shortName,
      file: symbol.relativePath,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      loc: symbol.loc,
      evidence: 'graph-fact',
      definition: resolveDefinition(db, symbol.symbol),
    });
  }
  return entries;
}

function toEntry(definition: IndexedDefinition, evidence: CleanupPlanEntry['evidence']): PlanEntryInternal {
  return {
    symbol: definition.symbol,
    shortName: shortenSymbol(definition.symbol),
    file: definition.relativePath,
    startLine: definition.startLine,
    endLine: definition.endLine,
    loc: definition.endLine - definition.startLine + 1,
    evidence,
    definition,
  };
}

function resolveDefinition(db: ScipDatabase, symbol: string): IndexedDefinition | null {
  const row = db.get<{ relative_path: string }>(
    `SELECT d.relative_path
     FROM global_symbols gs
     JOIN defn_enclosing_ranges der ON der.symbol_id = gs.id
     JOIN documents d ON d.id = der.document_id
     WHERE gs.symbol = ?
     LIMIT 1`,
    symbol,
  );
  if (!row) return null;
  return getDefinitionsForFile(db, row.relative_path)
    .find((definition) => definition.symbol === symbol) ?? null;
}

function cascadeVerdict(
  db: ScipDatabase,
  definition: IndexedDefinition,
  removedRanges: RemovedRangeIndex,
): { removable: boolean; blockingFiles: string[] } {
  const sites = getResolvedReferenceSites(db, definition);
  if (sites.length === 0) {
    // No resolvable references at all — but it wasn't in the dead seed, so
    // some evidence path disagrees. Stay conservative: don't cascade.
    return { removable: false, blockingFiles: [] };
  }
  const blockingFiles = new Set<string>();
  for (const site of sites) {
    if (site.file === definition.relativePath
      && site.line >= definition.startLine && site.line <= definition.endLine) continue; // self
    if (removedRanges.contains(site.file, site.line)) continue;
    blockingFiles.add(site.file);
  }
  return { removable: blockingFiles.size === 0, blockingFiles: [...blockingFiles] };
}

function buildBatch(
  db: ScipDatabase,
  depth: number,
  entries: PlanEntryInternal[],
  removedRanges: RemovedRangeIndex,
): CleanupBatch {
  const sorted = [...entries].sort((left, right) =>
    left.file.localeCompare(right.file) || left.startLine - right.startLine);
  const candidateFiles = new Set(sorted.map((entry) => entry.file));
  const filesEmptied: string[] = [];
  for (const file of candidateFiles) {
    const definitions = getDefinitionsForFile(db, file);
    if (definitions.length > 0 && definitions.every((definition) =>
      removedRanges.contains(file, definition.startLine))) {
      filesEmptied.push(file);
    }
  }
  return {
    depth,
    entries: sorted.map(({ definition: _definition, ...entry }) => entry),
    loc: sorted.reduce((sum, entry) => sum + entry.loc, 0),
    filesEmptied: filesEmptied.sort(),
  };
}

/** Line-range membership for the removal set, per file. */
export class RemovedRangeIndex {
  private readonly ranges = new Map<string, Array<{ start: number; end: number }>>();

  add(entry: { file: string; startLine: number; endLine: number }): void {
    const bucket = this.ranges.get(entry.file) ?? [];
    bucket.push({ start: entry.startLine, end: entry.endLine });
    this.ranges.set(entry.file, bucket);
  }

  contains(file: string, line: number): boolean {
    const bucket = this.ranges.get(file);
    if (!bucket) return false;
    return bucket.some((range) => line >= range.start && line <= range.end);
  }
}
