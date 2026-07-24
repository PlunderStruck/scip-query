import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { ProjectIndex } from '../internal/project-index.js';
import { semanticCallerMap } from '../../semantic/shared-primitives.js';
import { sourceFallbackCallerEvidenceMap } from '../../symbols/references/caller-evidence.js';
import { isCallableSymbol, isModuleLikeSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';
import { getAst, type SyntaxNode } from '../../source/ast.js';
import { rangesByFile } from './diff-ranges.js';

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
  attributionNotes: AttributionNote[];
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

interface GitDiffSnapshot {
  changedFileLines: string[];
  changedRanges: ChangedLineRange[];
  renamedFiles: RenamedFile[];
  deletedFiles: string[];
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

export type BaseContentReader = (relativePath: string) => string | null;

export interface DiffImpactPartial {
  changedSymbols: ChangedSymbol[];
  consumerEntries: Array<{ file: string; symbols: string[] }>;
  attributionNotes: AttributionNote[];
}

export interface AttributionNote {
  file: string;
  startLine: number;
  endLine: number;
  method: 'ast-widened' | 'nearest-preceding' | 'unattributed';
}

export interface DeclarationSpan {
  file: string;
  startLine: number;
  endLine: number;
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
    const snapshot = getGitDiffSnapshot(db.config.projectRoot, base);
    const changedFileLines = snapshot.changedFileLines;
    const changedFiles = indexedChangedFiles(db, changedFileLines);
    const changedRanges = indexedChangedRanges(db, snapshot.changedRanges);
    return {
      changedFileLines,
      changedFiles,
      changedRanges,
      renamedFiles: detectRenamedFiles(db.config.projectRoot, base, changedFiles, snapshot),
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

  const candidates = filesToAnalyze.flatMap((file) => index.definitionsForFile(file)).filter(isDiffImpactCandidate);
  const touchedDefs = candidates.filter((def) => definitionTouchesChangedRange(def, changedRangeMap));
  const residueAttribution = attributeChangedRangeResidue(db, candidates, touchedDefs, changedRangeMap);
  const defs = uniqueDefinitionsBySymbolId([...touchedDefs, ...residueAttribution.definitions]).sort(
    (a, b) => a.relativePath.localeCompare(b.relativePath) || a.startLine - b.startLine,
  );
  const symbolIds = defs.map((def) => def.symbolId);
  // Semantic caller evidence costs a whole-project findReferences per
  // definition — spend it only where it can change an outcome: defs the SCIP
  // index shows zero consumers for. Indexed fan-in already proves liveness
  // for the rest.
  const fanInBySymbolId = scipFanInBySymbolId(db, symbolIds);
  const consumerFilesBySymbolId = scipConsumerFilesBySymbolId(db, symbolIds, allChangedFiles);
  const stillZeroAfterScip = defs.filter((def) => (fanInBySymbolId.get(def.symbolId) ?? 0) === 0);
  // ts-morph's checker can throw on pathological files (observed: an
  // internal `resolveErrorCall`/`getTypeOfSymbol` crash in a large
  // generated-contract file) — an enrichment tier failing must degrade to
  // "found nothing from this tier", never take the whole gate down.
  const semanticConsumers = safeConsumerMap(() => semanticCallerMap(db, stillZeroAfterScip));
  // Semantic (ts-morph) resolves most cross-file gaps the raw SCIP index
  // misses, but shares the same tsconfig-alias/workspace-package resolution
  // surface as everything else in this tool — when it also comes up empty,
  // fall through to the same source-fallback layer `dead`/`isolated`/
  // `stale-abstractions`/`production-callables` already lean on
  // (sourceImportPathsByLocalName -> resolveImportPath), instead of letting
  // `new-dead` report a symbol whose only real gap is index/resolution
  // coverage, not liveness. Scoped to the same shrinking candidate set for
  // the same reason semantic already is: this is a per-definition
  // whole-project scan, worth paying only where the cheaper tiers found
  // nothing.
  const stillZeroAfterSemantic = stillZeroAfterScip.filter(
    (def) => (semanticConsumers.get(def.symbolId)?.size ?? 0) === 0,
  );
  const sourceFallbackConsumers = safeConsumerMap(() => sourceFallbackCallerEvidenceMap(db, stillZeroAfterSemantic));
  for (const def of defs) {
    addChangedDefinitionImpact(
      db,
      def,
      changedFileSet,
      changedSymbols,
      consumerMap,
      semanticConsumers.get(def.symbolId) ?? new Set<string>(),
      sourceFallbackConsumers.get(def.symbolId) ?? new Set<string>(),
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
    attributionNotes: residueAttribution.notes,
  };
}

export function mergeDiffImpactPartials(
  changedFiles: readonly string[],
  partials: readonly DiffImpactPartial[],
): DiffImpactResult {
  const consumerMap: ConsumerMap = new Map();
  const changedSymbols = partials.flatMap((partial) => partial.changedSymbols);
  const attributionNotes = partials.flatMap((partial) => partial.attributionNotes ?? []);

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
    attributionNotes,
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
    attributionNotes: [],
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
    attributionNotes: [],
    summary: {
      totalChangedFiles: changedFiles.length,
      totalChangedSymbols: 0,
      totalAffectedFiles: 0,
      note: 'Changed files are not present in the current SCIP index.',
    },
  };
}

function getGitDiffSnapshot(projectRoot: string, base: string): GitDiffSnapshot {
  const diffNames = execFileSync('git', ['diff', '--name-status', '--find-renames', base], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stagedNames = execFileSync('git', ['diff', '--name-status', '--find-renames', '--cached', base], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const diff = execFileSync('git', ['diff', '--unified=0', base], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const staged = execFileSync('git', ['diff', '--unified=0', '--cached', base], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });

  const nameStatuses = parseGitNameStatuses([diffNames, stagedNames]);
  return {
    changedFileLines: [...new Set([...nameStatuses.changedFiles, ...lines(untracked)])],
    changedRanges: dedupeRanges([...parseChangedLineRanges(diff), ...parseChangedLineRanges(staged)]),
    renamedFiles: nameStatuses.renamedFiles,
    deletedFiles: nameStatuses.deletedFiles,
  };
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

export function createBaseContentReader(
  projectRoot: string,
  base: string,
  preloadPaths: readonly string[] = [],
): BaseContentReader {
  const cache = fileContentsAtBase(projectRoot, base, preloadPaths);
  return (relativePath) => {
    if (!cache.has(relativePath)) {
      cache.set(relativePath, fileContentAtBase(projectRoot, base, relativePath));
    }
    return cache.get(relativePath) ?? null;
  };
}

export function baseContentPathsForDiffPlan(
  diffPlan: DiffImpactPlan,
  changedFiles: readonly string[] = diffPlan.changedFiles,
): string[] {
  const renamedFromByFile = new Map(diffPlan.renamedFiles.map((rename) => [rename.to, rename.from]));
  return [...new Set(changedFiles.map((file) => renamedFromByFile.get(file) ?? file))];
}

export function fileContentsAtBase(
  projectRoot: string,
  base: string,
  relativePaths: readonly string[],
): Map<string, string | null> {
  const uniquePaths = [...new Set(relativePaths)];
  const out = new Map<string, string | null>();
  if (uniquePaths.length === 0) return out;

  try {
    const input = uniquePaths.map((path) => `${base}:./${path}\n`).join('');
    const output = execFileSync('git', ['cat-file', '--batch'], {
      cwd: projectRoot,
      input,
      maxBuffer: 256 * 1024 * 1024,
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }) as Buffer;
    return parseCatFileBatchOutput(output, uniquePaths);
  } catch {
    for (const path of uniquePaths) {
      out.set(path, fileContentAtBase(projectRoot, base, path));
    }
    return out;
  }
}

function parseCatFileBatchOutput(output: Buffer, relativePaths: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let offset = 0;
  for (const path of relativePaths) {
    const newline = output.indexOf(10, offset);
    if (newline < 0) throw new Error('git cat-file batch output ended before object header');
    const header = output.subarray(offset, newline).toString('utf-8');
    offset = newline + 1;
    if (header.endsWith(' missing')) {
      out.set(path, null);
      continue;
    }
    const match = /^[0-9a-f]+ ([^ ]+) (\d+)$/.exec(header);
    if (!match) throw new Error(`unexpected git cat-file batch header: ${header}`);
    const [, objectType, rawSize] = match;
    const size = Number(rawSize);
    if (!Number.isFinite(size) || size < 0) throw new Error(`unexpected git cat-file batch size: ${header}`);
    if (offset + size > output.length) {
      throw new Error('git cat-file batch output ended before blob payload');
    }
    const payload = output.subarray(offset, offset + size);
    out.set(path, objectType === 'blob' ? payload.toString('utf-8') : null);
    offset += size;
    if (output[offset] === 10) offset += 1;
  }
  return out;
}

function detectRenamedFiles(
  projectRoot: string,
  base: string,
  changedFiles: readonly string[],
  snapshot: GitDiffSnapshot,
): RenamedFile[] {
  if (changedFiles.length === 0) return [];

  const renamed = new Map<string, RenamedFile>();
  const claimedSources = new Set<string>();
  for (const rename of snapshot.renamedFiles) {
    if (!changedFiles.includes(rename.to)) continue;
    renamed.set(rename.to, rename);
    claimedSources.add(rename.from);
  }

  const deletedFiles = snapshot.deletedFiles;
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

function parseGitNameStatuses(chunks: readonly string[]): {
  changedFiles: string[];
  renamedFiles: RenamedFile[];
  deletedFiles: string[];
} {
  const changedFiles = new Set<string>();
  const renamedFiles = new Map<string, RenamedFile>();
  const deletedFiles = new Set<string>();
  for (const line of chunks.flatMap((chunk) => lines(chunk))) {
    const [status, firstPath, secondPath] = line.split('\t');
    if (!status || !firstPath) continue;
    if (status.startsWith('R') && secondPath) {
      changedFiles.add(secondPath);
      renamedFiles.set(secondPath, {
        from: firstPath,
        to: secondPath,
        similarity: Number(status.slice(1)) / 100,
      });
      continue;
    }
    changedFiles.add(firstPath);
    if (status.startsWith('D')) deletedFiles.add(firstPath);
  }
  return {
    changedFiles: [...changedFiles],
    renamedFiles: [...renamedFiles.values()],
    deletedFiles: [...deletedFiles],
  };
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

export function attributeResidue(
  definitions: readonly IndexedDefinition[],
  changedRanges: readonly ChangedLineRange[],
  declarationSpans: readonly DeclarationSpan[],
): { definitions: IndexedDefinition[]; notes: AttributionNote[] } {
  const out = new Map<number, IndexedDefinition>();
  const notes: AttributionNote[] = [];
  const definitionsByFile = groupDefinitionsByFile(definitions);
  const spansByFile = groupDeclarationSpansByFile(declarationSpans);

  for (const range of changedRanges) {
    const fileDefinitions = definitionsByFile.get(range.file) ?? [];
    if (
      fileDefinitions.some((definition) =>
        rangesOverlap(definition.startLine, definition.endLine, range.startLine, range.endLine),
      )
    ) {
      continue;
    }

    const spans = spansByFile.get(range.file) ?? [];
    const containingSpan = smallestContainingSpan(spans, range);
    if (containingSpan) {
      const definition = fileDefinitions.find(
        (candidate) => candidate.startLine >= containingSpan.startLine && candidate.startLine <= containingSpan.endLine,
      );
      if (definition) {
        out.set(definition.symbolId, definition);
        notes.push(noteForRange(range, 'ast-widened'));
        continue;
      }
    }

    if (spans.length === 0) {
      const nearest = [...fileDefinitions]
        .filter((definition) => definition.startLine <= range.startLine)
        .sort((left, right) => right.startLine - left.startLine || left.endLine - right.endLine)[0];
      if (nearest) {
        out.set(nearest.symbolId, nearest);
        notes.push(noteForRange(range, 'nearest-preceding'));
        continue;
      }
    }

    notes.push(noteForRange(range, 'unattributed'));
  }

  return { definitions: [...out.values()], notes };
}

function attributeChangedRangeResidue(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
  touchedDefinitions: readonly IndexedDefinition[],
  changedRangeMap: ReadonlyMap<string, readonly ChangedLineRange[]>,
): { definitions: IndexedDefinition[]; notes: AttributionNote[] } {
  const touchedByFile = groupDefinitionsByFile(touchedDefinitions);
  const residueRanges: ChangedLineRange[] = [];
  const declarationSpans: DeclarationSpan[] = [];
  const files = [...new Set(definitions.map((definition) => definition.relativePath))];

  for (const file of files) {
    const ranges = changedRangeMap.get(file) ?? [];
    if (ranges.length === 0) continue;
    const touched = touchedByFile.get(file) ?? [];
    for (const range of ranges) {
      if (
        touched.some((definition) =>
          rangesOverlap(definition.startLine, definition.endLine, range.startLine, range.endLine),
        )
      ) {
        continue;
      }
      residueRanges.push(range);
    }
    if (residueRanges.some((range) => range.file === file)) {
      declarationSpans.push(...topLevelDeclarationSpans(db, file));
    }
  }

  return attributeResidue(definitions, residueRanges, declarationSpans);
}

function topLevelDeclarationSpans(db: ScipDatabase, file: string): DeclarationSpan[] {
  const tree = getAst(db, file);
  if (!tree) return [];
  return tree.rootNode.namedChildren
    .filter(isTopLevelDeclarationNode)
    .map((node) => ({
      file,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
    }))
    .filter((span) => span.endLine >= span.startLine);
}

function isTopLevelDeclarationNode(node: SyntaxNode): boolean {
  if (node.endPosition.row < node.startPosition.row) return false;
  return !new Set(['import_statement', 'comment']).has(node.type);
}

function uniqueDefinitionsBySymbolId(definitions: readonly IndexedDefinition[]): IndexedDefinition[] {
  const byId = new Map<number, IndexedDefinition>();
  for (const definition of definitions) byId.set(definition.symbolId, definition);
  return [...byId.values()];
}

function groupDefinitionsByFile(definitions: readonly IndexedDefinition[]): Map<string, IndexedDefinition[]> {
  const grouped = new Map<string, IndexedDefinition[]>();
  for (const definition of definitions) {
    const bucket = grouped.get(definition.relativePath) ?? [];
    bucket.push(definition);
    grouped.set(definition.relativePath, bucket);
  }
  return grouped;
}

function groupDeclarationSpansByFile(spans: readonly DeclarationSpan[]): Map<string, DeclarationSpan[]> {
  const grouped = new Map<string, DeclarationSpan[]>();
  for (const span of spans) {
    const bucket = grouped.get(span.file) ?? [];
    bucket.push(span);
    grouped.set(span.file, bucket);
  }
  return grouped;
}

function smallestContainingSpan(
  spans: readonly DeclarationSpan[],
  range: ChangedLineRange,
): DeclarationSpan | undefined {
  return spans
    .filter((span) => span.startLine <= range.startLine && span.endLine >= range.endLine)
    .sort((left, right) => left.endLine - left.startLine - (right.endLine - right.startLine))[0];
}

function noteForRange(range: ChangedLineRange, method: AttributionNote['method']): AttributionNote {
  return {
    file: range.file,
    startLine: range.startLine,
    endLine: range.endLine,
    method,
  };
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
  sourceFallbackConsumers: ReadonlySet<string>,
  indexedFanIn: number,
  indexedConsumers: ReadonlySet<string>,
): void {
  const fanIn = Math.max(indexedFanIn, semanticConsumers.size, sourceFallbackConsumers.size);
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
  for (const file of sourceFallbackConsumers) {
    addConsumerFile(db, changedFileSet, consumerMap, file, shortName);
  }
}

// scip-query: ignore-wrapper — one place to convert "an evidence tier
// threw" into "this tier found nothing" for the two whole-project
// enrichment scans (semantic, source-fallback) that changed-symbol impact
// leans on; callers must not crash the gate over a best-effort tier.
function safeConsumerMap<T>(compute: () => Map<number, T>): Map<number, T> {
  try {
    return compute();
  } catch (err) {
    console.error(
      `warning: diff-impact enrichment scan failed, continuing without it: ${err instanceof Error ? err.message : err}`,
    );
    return new Map();
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
