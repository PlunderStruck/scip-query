import type { ScipDatabase } from '../storage/db.js';
import type { IndexedDefinition } from '../domain/types.js';
import { classifyFile, isRootedSymbol } from '../analysis/file-classifier.js';
import { leafName, parseSymbol, shortenSymbol } from '../symbols/symbol-parser.js';
import { getSourceText } from '../source/source-text.js';
import { getTypeContainerMap } from '../source/ast.js';
import { ProjectIndex } from '../core/project-index.js';
import { runCandidateAnalysis } from './internal/candidate-scan.js';
import { definitionConsumerFileMap, isImportOnlyConsumer, partitionDefinitionConsumers } from './internal/consumer-evidence.js';
import { definitionLoc } from './query-utils.js';

export interface StaleAbstraction {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  /**
   * Cross-file consumers NOT counting files that only re-export the symbol
   * through a barrel (`export { X } from '...'`). Barrel files expand the
   * public surface; they aren't real consumers.
   */
  consumers: number;
  /** Number of files whose only reference is a passthrough re-export. */
  barrelConsumers: number;
  /** What the definition is syntactically — detected from source at the definition line. */
  kind: 'class' | 'interface' | 'type' | 'enum' | 'other';
  /**
   * Does the defining file itself reference the type outside its own declaration?
   * `false` is the strongest stale signal — the type lives in a file that never
   * uses it (misplaced types file), while another file is its only consumer.
   */
  definerUsesType: boolean;
  /**
   * Ranked confidence in the "stale" verdict:
   *   'high'   — consumers === 0, OR consumers === 1 && !definerUsesType && kind !== 'class'.
   *   'medium' — consumers <= 1 with one of the signals pointing weakly stale.
   *   'low'    — consumers === 1 but kind === 'class' (likely encapsulation, not over-abstraction).
   */
  confidence: 'high' | 'medium' | 'low';
  /** Short human-readable explanation of why this was flagged. */
  reason: string;
}

type TypeCandidateIndex = Map<string, Map<string, IndexedDefinition>>;

interface StaleCandidateRow {
  definition: IndexedDefinition;
  realConsumers: string[];
  barrelConsumers: number;
  transitivelyReachable: boolean;
}

interface SingletonBackedClass {
  singleton: IndexedDefinition;
  classId: number;
}

/**
 * Find stale abstractions: type-level symbols (classes, interfaces, type
 * aliases) that have 0 or 1 *real* cross-file consumers.
 *
 * "Real" means: after excluding barrel files whose only reference is a
 * passthrough re-export (`export { X } from '...'`). A type re-exported
 * through the public API surface isn't stale — consumers just reach it
 * through the barrel.
 *
 * Findings are ranked by confidence:
 *   - high:   0 consumers (truly unused type), OR 1 consumer where the
 *             defining file never uses the type itself (misplaced type).
 *   - medium: 1 consumer, definer uses it, kind is interface/type/enum —
 *             single-use abstraction worth questioning.
 *   - low:    1 consumer but kind === 'class' — usually encapsulation
 *             (big class owned by its single consumer), not over-abstraction.
 */
// scip-query: ignore-extract — this is the stale-abstraction scoring
// pipeline; helper functions already own candidate loading, consumer maps,
// singleton correction, and per-row scoring.
export function staleAbstractions(
  db: ScipDatabase,
  opts?: {
    scope?: string;
    minLoc?: number;
    maxLoc?: number;
    limit?: number;
    includeLowConfidence?: boolean;
    scanLimit?: number;
    semantic?: boolean;
  },
): StaleAbstraction[] {
  const { scope, minLoc = 3, maxLoc = 80, limit = 30, includeLowConfidence = false, scanLimit } = opts ?? {};
  const includeSemantic = opts?.semantic !== false;
  const index = new ProjectIndex(db);
  const scopedDefinitions = index.scopedDefinitions(scope);
  const filesWithFunctions = getFilesWithFunctions(index, scope);
  const confOrder = { high: 0, medium: 1, low: 2 } as const;

  return runCandidateAnalysis({
    candidates: () => staleTypeCandidates(db, index, scopedDefinitions, { minLoc, maxLoc }),
    orderCandidates: (left, right) =>
      definitionLoc(right) - definitionLoc(left) || left.relativePath.localeCompare(right.relativePath),
    scanLimit,
    // Consumer map = SCIP mentions (with self-references filtered) ∪ source-text
    // fallback for unique-named types. Without the fallback, a type used only in
    // string-templated contexts or via paths the indexer missed would falsely
    // appear unconsumed.
    prepare: (typeCandidates) => ({
      consumerFileMap: consumerMapForTypeCandidates(index, typeCandidates, { semantic: includeSemantic }),
      singletonBackedClassIds: getSingletonBackedClassIds(db, index, scopedDefinitions, typeCandidates, {
        semantic: includeSemantic,
      }),
      candidateIndex: buildTypeCandidateIndex(typeCandidates),
    }),
    evaluate: (definition, evidence) => {
      if (evidence.singletonBackedClassIds.has(definition.symbolId)) return null;
      const row = staleCandidateRow(db, definition, evidence.consumerFileMap, evidence.candidateIndex);
      if (row.transitivelyReachable) return null;
      if (row.realConsumers.length > 1) return null;
      // A type whose only observable use is a public-API re-export is not stale —
      // it's part of the surface the library exposes to external consumers we
      // can't see in the index. Skip those entirely.
      if (row.realConsumers.length === 0 && row.barrelConsumers > 0) return null;
      if (!isTrueStaleAbstraction(row.definition, row.realConsumers.length, filesWithFunctions)) return null;
      const scored = scoreStaleCandidate(db, row);
      if (!includeLowConfidence && scored.confidence === 'low') return null;
      return scored;
    },
    orderResults: (left, right) =>
      confOrder[left.confidence] - confOrder[right.confidence]
      || right.loc - left.loc
      || left.file.localeCompare(right.file)
      || left.startLine - right.startLine,
    limit,
  });
}

function staleTypeCandidates(
  db: ScipDatabase,
  index: ProjectIndex,
  scopedDefinitions: readonly IndexedDefinition[],
  opts: { minLoc: number; maxLoc: number },
): IndexedDefinition[] {
  return scopedDefinitions
    .filter((definition) => definition.isTypeLike && definitionLoc(definition) >= opts.minLoc)
    // Cap candidate LOC. Types over ~80 lines are substantive abstractions
    // (engine state, request envelopes, etc.) — even if cross-file consumers
    // are sparse, calling them "stale" is wrong. The cap also protects
    // against rust-analyzer's chunk-fallback ranges (whole-file ranges that
    // appear when a real `defn_enclosing_range` isn't emitted), which would
    // otherwise dominate the report.
    .filter((definition) => definitionLoc(definition) <= opts.maxLoc)
    .filter((definition) => !db.isIgnored(definition.relativePath))
    // Test fixtures aren't abstractions; types in test files are noise here.
    .filter((definition) => classifyFile(definition.relativePath) !== 'test')
    // Externally-live types (package surface / entryRoots) are published
    // contracts: consumers outside the index reach them, so a low in-index
    // consumer count says nothing about staleness.
    .filter((definition) => !isRootedSymbol(db, definition.symbol, definition.relativePath))
    // Enum variants encode as `Type#Variant#` (parent descriptor also `type`).
    // The variant isn't an "abstraction" on its own — the enum is. Without
    // this filter every enum variant gets a separate stale-abstraction
    // entry, which is noise.
    .filter((definition) => !isNestedTypeMember(definition.symbol))
    .filter((definition) => !index.hasSuppressionComment(definition));
}

function consumerMapForTypeCandidates(
  index: ProjectIndex,
  typeCandidates: readonly IndexedDefinition[],
  opts: { semantic: boolean },
): Map<number, Set<string>> {
  return definitionConsumerFileMap(index, typeCandidates, { semantic: opts.semantic });
}

function buildTypeCandidateIndex(
  typeCandidates: readonly IndexedDefinition[],
): TypeCandidateIndex {
  // Pre-index type candidates by (file, leaf) so the transitive-reachability
  // check is O(1) per container instead of O(typeCandidates) linear scan.
  const candidateIndex: TypeCandidateIndex = new Map();
  for (const candidate of typeCandidates) {
    let perFile = candidateIndex.get(candidate.relativePath);
    if (!perFile) {
      perFile = new Map();
      candidateIndex.set(candidate.relativePath, perFile);
    }
    const leaf = leafName(candidate.symbol);
    if (leaf) perFile.set(leaf, candidate);
  }
  return candidateIndex;
}

function staleCandidateRow(
  db: ScipDatabase,
  definition: IndexedDefinition,
  consumerFileMap: Map<number, Set<string>>,
  candidateIndex: TypeCandidateIndex,
): StaleCandidateRow {
  const allFiles = consumerFileMap.get(definition.symbolId) ?? new Set<string>();
  const consumerFiles = [...allFiles].filter(
    (file) => file !== definition.relativePath && !db.isIgnored(file),
  );
  const { realConsumers, barrelConsumers, importOnlyConsumers } = partitionDefinitionConsumers(
    db,
    definition,
    consumerFiles,
  );

  // Transitive: if this type is referenced by a container type in the
  // SAME file (e.g. `interface Outer { field: This }`) and that container
  // has cross-file consumers, this type is reachable through the
  // container's public API — not stale, even with 0 direct consumers.
  const transitivelyReachable = isTransitivelyConsumed(
    db,
    definition,
    consumerFileMap,
    candidateIndex,
  );

  return {
    definition,
    realConsumers,
    barrelConsumers: barrelConsumers + importOnlyConsumers,
    transitivelyReachable,
  };
}

// scip-query: ignore-extract — this is the final stale-abstraction scoring
// projection; definition kind, definer usage, confidence, and result shape are
// one report decision.
function scoreStaleCandidate(
  db: ScipDatabase,
  row: StaleCandidateRow,
): StaleAbstraction {
  const kind = detectDefinitionKind(db, row.definition.relativePath, row.definition.startLine);
  // For type-only files the definer is *expected* not to use what it
  // defines (their job is exporting types for downstream consumption),
  // so pretend the definer uses it — that avoids the "1 consumer +
  // defining file never uses it = high confidence" branch firing on
  // every type in a `protocol/common.rs`-style module.
  const definerUsesType = isTypeOnlyFile(row.definition.relativePath)
    ? true
    : detectDefinerUsesType(db, row.definition);
  const { confidence, reason } = scoreConfidence(row.realConsumers.length, kind, definerUsesType);

  return {
    symbol: row.definition.symbol,
    shortName: shortenSymbol(row.definition.symbol),
    file: row.definition.relativePath,
    startLine: row.definition.startLine,
    endLine: row.definition.endLine,
    loc: definitionLoc(row.definition),
    consumers: row.realConsumers.length,
    barrelConsumers: row.barrelConsumers,
    kind,
    definerUsesType,
    confidence,
    reason,
  };
}

function getSingletonBackedClassIds(
  db: ScipDatabase,
  index: ProjectIndex,
  scopedDefinitions: readonly IndexedDefinition[],
  typeCandidates: readonly IndexedDefinition[],
  opts: { semantic: boolean },
): Set<number> {
  const singletonBackedClasses = singletonBackedClassesForCandidates(
    db,
    scopedDefinitionsByFileAndLeaf(scopedDefinitions),
    typeCandidates,
  );
  const singletonVars = singletonBackedClasses.map((entry) => entry.singleton);
  if (singletonBackedClasses.length === 0) return new Set();

  const singletonConsumers = definitionConsumerFileMap(index, singletonVars, { semantic: opts.semantic });
  const liveClassIds = new Set<number>();
  for (const { singleton, classId } of singletonBackedClasses) {
    if (singletonHasRealConsumer(db, singleton, singletonConsumers)) {
      liveClassIds.add(classId);
    }
  }
  return liveClassIds;
}

function scopedDefinitionsByFileAndLeaf(scopedDefinitions: readonly IndexedDefinition[]): Map<string, IndexedDefinition> {
  const byFileAndLeaf = new Map<string, IndexedDefinition>();
  for (const definition of scopedDefinitions) {
    const leaf = leafName(definition.symbol);
    if (leaf) byFileAndLeaf.set(fileLeafKey(definition.relativePath, leaf), definition);
  }
  return byFileAndLeaf;
}

function singletonBackedClassesForCandidates(
  db: ScipDatabase,
  byFileAndLeaf: ReadonlyMap<string, IndexedDefinition>,
  typeCandidates: readonly IndexedDefinition[],
): SingletonBackedClass[] {
  const classes: SingletonBackedClass[] = [];
  for (const definition of typeCandidates) {
    const singleton = singletonForClassDefinition(db, byFileAndLeaf, definition);
    if (singleton) classes.push({ singleton, classId: definition.symbolId });
  }
  return classes;
}

function singletonForClassDefinition(
  db: ScipDatabase,
  byFileAndLeaf: ReadonlyMap<string, IndexedDefinition>,
  definition: IndexedDefinition,
): IndexedDefinition | null {
  if (detectDefinitionKind(db, definition.relativePath, definition.startLine) !== 'class') return null;
  const classLeaf = leafName(definition.symbol);
  if (!classLeaf) return null;
  const varName = exportedSingletonVarName(db, definition.relativePath, classLeaf);
  return varName ? byFileAndLeaf.get(fileLeafKey(definition.relativePath, varName)) ?? null : null;
}

function singletonHasRealConsumer(
  db: ScipDatabase,
  singleton: IndexedDefinition,
  singletonConsumers: ReadonlyMap<number, Set<string>>,
): boolean {
  const singletonLeaf = leafName(singleton.symbol);
  const consumers = singletonConsumers.get(singleton.symbolId);
  if (!singletonLeaf || !consumers) return false;
  return [...consumers].some((file) =>
    file !== singleton.relativePath
    && !db.isIgnored(file)
    && !isImportOnlyConsumer(db, file, singletonLeaf),
  );
}

function fileLeafKey(relativePath: string, leaf: string): string {
  return `${relativePath}\0${leaf}`;
}

function exportedSingletonVarName(
  db: ScipDatabase,
  relativePath: string,
  className: string,
): string | null {
  const source = getSourceText(db, relativePath);
  if (!source) return null;
  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\bexport\\s+const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+${escapedClassName}\\s*\\(`,
  );
  return source.match(pattern)?.[1] ?? null;
}

function getFilesWithFunctions(
  index: ProjectIndex,
  scope?: string,
): Set<string> {
  return new Set(index.scopedDefinitions(scope)
    .filter((definition) => definition.isFunctionLike)
    .map((definition) => definition.relativePath));
}

// True when a `type`-suffix symbol's parent descriptor is also a type — i.e.
// the symbol is a member nested inside another type (enum variant or inner
// class). For stale-abstraction purposes only the outer type matters.
function isNestedTypeMember(symbol: string): boolean {
  const parsed = parseSymbol(symbol);
  if ('kind' in parsed) return false;
  const descriptors = parsed.descriptors;
  if (descriptors.length < 2) return false;
  const leaf = descriptors[descriptors.length - 1];
  const parent = descriptors[descriptors.length - 2];
  return leaf?.suffix === 'type' && parent?.suffix === 'type';
}

// File-name heuristic for "this file is meant to define types for other
// modules to consume" — `types.rs`, `models/...`, `protocol/common.rs`,
// `dto.ts`, `schema.rs`, etc. The "1 consumer + definer never uses it"
// signal is meaningless for these: by design they don't use what they
// define, and most exports legitimately have a single (or few) downstream
// consumers without that being a code-smell.
function isTypeOnlyFile(relativePath: string): boolean {
  const basename = relativePath.split('/').pop() ?? '';
  const stem = basename.replace(/\.[^.]+$/, '');
  if (stem === 'types' || stem.endsWith('-types')
      || stem === 'models' || stem === 'schema'
      || stem === 'common' || stem === 'protocol' || stem === 'proto'
      || stem === 'dto' || stem === 'mod' || stem === 'contracts') return true;
  if (/(^|\/)types(\/|\.)/.test(relativePath)) return true;
  if (/(^|\/)models?(\/|\.)/.test(relativePath)) return true;
  if (/(^|\/)proto(?:col)?(\/|\.)/.test(relativePath)) return true;
  if (/(^|\/)schema(\/|\.)/.test(relativePath)) return true;
  // Shared contract packages (monorepo `shared/contracts/*`, `api-contracts/`)
  // exist to define types for other workspaces — "definer never uses it" is
  // their normal state, not a stale signal.
  if (/(^|\/)contracts?(\/|\.)/.test(relativePath)) return true;
  return false;
}

function isTrueStaleAbstraction(
  definition: { relativePath: string },
  consumers: number,
  filesWithFunctions: ReadonlySet<string>,
): boolean {
  if (isTypeOnlyFile(definition.relativePath) && consumers > 0) {
    return false;
  }

  // 0-consumer types in files that also export functions are often parameter/
  // return-only shapes that the SCIP graph does not model as direct mentions.
  if (consumers === 0 && filesWithFunctions.has(definition.relativePath)) {
    return false;
  }

  return true;
}

/**
 * True when this type isn't referenced cross-file directly, but a container
 * type in the same file references it AND the container HAS cross-file
 * consumers. The container's public API transitively exposes this type, so
 * it's not really stale.
 *
 * Example (TS):
 *   interface Inner { ... }                       // 0 direct cross-file refs
 *   interface Outer { items: Inner[]; }           // referenced cross-file
 * Without transitive tracking, `Inner` shows as "unused" even though every
 * consumer of `Outer` is a consumer of `Inner` too.
 */
function isTransitivelyConsumed(
  db: ScipDatabase,
  definition: { relativePath: string; symbol: string; symbolId: number },
  consumerFileMap: Map<number, Set<string>>,
  candidateIndex: Map<string, Map<string, { symbolId: number }>>,
): boolean {
  const containerMap = getTypeContainerMap(db, definition.relativePath);
  const myLeaf = leafName(definition.symbol);
  if (!myLeaf) return false;
  const containers = containerMap.get(myLeaf);
  if (!containers || containers.size === 0) return false;

  const perFile = candidateIndex.get(definition.relativePath);
  if (!perFile) return false;

  for (const containerName of containers) {
    const container = perFile.get(containerName);
    if (!container) continue;
    const containerConsumers = consumerFileMap.get(container.symbolId);
    if (!containerConsumers) continue;
    for (const f of containerConsumers) {
      if (f !== definition.relativePath && !db.isIgnored(f)) return true;
    }
  }
  return false;
}

/**
 * Detect whether the definition is a class, interface, type alias, or
 * enum by inspecting the source line where the definition starts. If the
 * source can't be read, return 'other' rather than guessing.
 */
function detectDefinitionKind(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
): 'class' | 'interface' | 'type' | 'enum' | 'other' {
  const source = getSourceText(db, relativePath);
  if (!source) return 'other';
  const lines = source.split('\n');
  // Scan a few lines around the start (handles decorators / comments).
  const begin = Math.max(0, startLine - 2);
  const end = Math.min(lines.length - 1, startLine + 2);
  for (let i = begin; i <= end; i++) {
    const line = lines[i] ?? '';
    // Strip line-comment prefixes so `// class Foo` doesn't false-positive.
    const stripped = line.replace(/^\s*\/\/.*$/g, '');
    if (/\b(?:export\s+)?(?:abstract\s+)?class\s+\w/.test(stripped)) return 'class';
    if (/\b(?:export\s+)?interface\s+\w/.test(stripped)) return 'interface';
    if (/\b(?:export\s+)?type\s+\w/.test(stripped)) return 'type';
    if (/\b(?:export\s+)?(?:const\s+)?enum\s+\w/.test(stripped)) return 'enum';
  }
  return 'other';
}

/**
 * Does the defining file reference the type anywhere outside the declaration
 * range itself? A `false` result means the file is effectively just a types
 * module for one external consumer — the classic "defined in the wrong place"
 * signal.
 *
 * We scan the source text instead of the mentions/chunks tables because
 * chunk boundaries in SCIP are coarse (often a single chunk covers the
 * whole file or a large block), which makes the "is this mention outside
 * the declaration range" check unreliable at the chunk granularity.
 */
function detectDefinerUsesType(
  db: ScipDatabase,
  definition: { symbol: string; relativePath: string; startLine: number; endLine: number },
): boolean {
  const source = getSourceText(db, definition.relativePath);
  if (!source) return false;
  const leaf = leafName(definition.symbol);
  if (!leaf) return false;

  const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRegex = new RegExp(`\\b${escaped}\\b`);
  const lines = source.split('\n');

  // IndexedDefinition ranges are 0-indexed, inclusive. Treat anything
  // outside [startLine, endLine] with the leaf word as external usage.
  for (let i = 0; i < lines.length; i++) {
    if (i >= definition.startLine && i <= definition.endLine) continue;
    if (wordRegex.test(lines[i] ?? '')) return true;
  }
  return false;
}

function scoreConfidence(
  consumers: number,
  kind: StaleAbstraction['kind'],
  definerUsesType: boolean,
): { confidence: StaleAbstraction['confidence']; reason: string } {
  if (consumers === 0) {
    return {
      confidence: 'high',
      reason: 'unused — no consumers and defining file has no real usage',
    };
  }
  if (consumers === 1 && kind === 'class') {
    return {
      confidence: 'low',
      reason: '1 consumer + class kind — likely 1:1 encapsulation, not over-abstraction',
    };
  }
  if (consumers === 1 && !definerUsesType) {
    return {
      confidence: 'high',
      reason: '1 consumer + defining file never uses it — type belongs with its consumer',
    };
  }
  return {
    confidence: 'medium',
    reason: '1 consumer — single-use abstraction',
  };
}
