import type { ScipDatabase } from '../storage/db.js';
import { createPerDbCache } from '../storage/per-db-cache.js';
import type { IndexedDefinition, StaleAbstraction } from '../domain/types.js';
import { leafName, parseSymbol, shortenSymbol } from '../symbols/symbol-parser.js';
import { getReExports } from '../language-parsers/index.js';
import { getSourceText } from '../source/source-text.js';
import { detectAstLanguage, getAst, getTypeContainerMap, type SyntaxNode } from '../source/ast.js';
import { ProjectIndex } from '../core/project-index.js';

type TypeCandidateIndex = Map<string, Map<string, IndexedDefinition>>;

interface StaleCandidateRow {
  definition: IndexedDefinition;
  realConsumers: string[];
  barrelConsumers: number;
  transitivelyReachable: boolean;
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
export function staleAbstractions(
  db: ScipDatabase,
  opts?: { scope?: string; minLoc?: number; maxLoc?: number; limit?: number; includeLowConfidence?: boolean },
): StaleAbstraction[] {
  const { scope, minLoc = 3, maxLoc = 80, limit = 30, includeLowConfidence = false } = opts ?? {};
  const index = new ProjectIndex(db);
  const scopedDefinitions = index.scopedDefinitions(scope);
  const filesWithFunctions = getFilesWithFunctions(index, scope);
  const typeCandidates = staleTypeCandidates(db, index, scopedDefinitions, { minLoc, maxLoc });

  // Consumer map = SCIP mentions (with self-references filtered) ∪ source-text
  // fallback for unique-named types. Without the fallback, a type used only in
  // string-templated contexts or via paths the indexer missed would falsely
  // appear unconsumed.
  const consumerFileMap = consumerMapForTypeCandidates(index, typeCandidates);
  const singletonBackedClassIds = getSingletonBackedClassIds(db, index, scopedDefinitions, typeCandidates);
  const candidateIndex = buildTypeCandidateIndex(typeCandidates);
  const rows = staleCandidateRows(db, typeCandidates, consumerFileMap, candidateIndex)
    .filter((row) => !singletonBackedClassIds.has(row.definition.symbolId))
    .filter((row) => !row.transitivelyReachable)
    .filter((row) => row.realConsumers.length <= 1)
    // A type whose only observable use is a public-API re-export is not stale —
    // it's part of the surface the library exposes to external consumers we
    // can't see in the index. Skip those entirely.
    .filter((row) => !(row.realConsumers.length === 0 && row.barrelConsumers > 0));

  const scored = rows
    .filter((row) => isTrueStaleAbstraction(row.definition, row.realConsumers.length, filesWithFunctions))
    .map((row) => scoreStaleCandidate(db, row))
    .filter((row) => includeLowConfidence || row.confidence !== 'low')
    .sort((left, right) => {
      const confOrder = { high: 0, medium: 1, low: 2 } as const;
      return confOrder[left.confidence] - confOrder[right.confidence]
        || right.loc - left.loc
        || left.file.localeCompare(right.file)
        || left.startLine - right.startLine;
    });

  return scored.slice(0, limit);
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
): Map<number, Set<string>> {
  return mergeConsumerMaps(
    index.crossFileCallerMap(typeCandidates),
    index.sourceFallbackCallerFiles(typeCandidates),
  );
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

function staleCandidateRows(
  db: ScipDatabase,
  typeCandidates: readonly IndexedDefinition[],
  consumerFileMap: Map<number, Set<string>>,
  candidateIndex: TypeCandidateIndex,
): StaleCandidateRow[] {
  return typeCandidates.map((definition) => {
    const allFiles = consumerFileMap.get(definition.symbolId) ?? new Set<string>();
    const consumerFiles = [...allFiles].filter(
      (file) => file !== definition.relativePath && !db.isIgnored(file),
    );
    const { realConsumers, barrelConsumers } = partitionConsumers(
      db,
      definition.relativePath,
      definition.symbol,
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
      barrelConsumers,
      transitivelyReachable,
    };
  });
}

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
): Set<number> {
  const byFileAndLeaf = new Map<string, IndexedDefinition>();
  for (const definition of scopedDefinitions) {
    const leaf = leafName(definition.symbol);
    if (!leaf) continue;
    byFileAndLeaf.set(`${definition.relativePath}\0${leaf}`, definition);
  }

  const singletonVars: IndexedDefinition[] = [];
  const classBySingletonVarId = new Map<number, number>();
  for (const definition of typeCandidates) {
    if (detectDefinitionKind(db, definition.relativePath, definition.startLine) !== 'class') continue;
    const classLeaf = leafName(definition.symbol);
    if (!classLeaf) continue;
    const varName = exportedSingletonVarName(db, definition.relativePath, classLeaf);
    if (!varName) continue;
    const singleton = byFileAndLeaf.get(`${definition.relativePath}\0${varName}`);
    if (!singleton) continue;
    singletonVars.push(singleton);
    classBySingletonVarId.set(singleton.symbolId, definition.symbolId);
  }

  if (singletonVars.length === 0) return new Set();

  const singletonConsumers = mergeConsumerMaps(
    index.crossFileCallerMap(singletonVars),
    index.sourceFallbackCallerFiles(singletonVars),
  );
  const liveClassIds = new Set<number>();
  for (const singleton of singletonVars) {
    const singletonLeaf = leafName(singleton.symbol);
    if (!singletonLeaf) continue;
    const consumers = singletonConsumers.get(singleton.symbolId);
    if (!consumers) continue;
    const hasRealConsumer = [...consumers].some((file) =>
      file !== singleton.relativePath
      && !db.isIgnored(file)
      && !isImportOnlyConsumer(db, file, singletonLeaf),
    );
    if (!hasRealConsumer) continue;
    const classId = classBySingletonVarId.get(singleton.symbolId);
    if (classId !== undefined) liveClassIds.add(classId);
  }
  return liveClassIds;
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
  if (stem === 'types' || stem === 'models' || stem === 'schema'
      || stem === 'common' || stem === 'protocol' || stem === 'proto'
      || stem === 'dto' || stem === 'mod') return true;
  if (/(^|\/)types(\/|\.)/.test(relativePath)) return true;
  if (/(^|\/)models?(\/|\.)/.test(relativePath)) return true;
  if (/(^|\/)proto(?:col)?(\/|\.)/.test(relativePath)) return true;
  if (/(^|\/)schema(\/|\.)/.test(relativePath)) return true;
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
 * Split consumers into "real" (actually use the type) vs "barrel" (their only
 * reference to the type is a passthrough re-export like
 * `export { X } from './defFile'` or `export * from './defFile'`).
 */
function partitionConsumers(
  db: ScipDatabase,
  definitionFile: string,
  symbol: string,
  consumerFiles: string[],
): { realConsumers: string[]; barrelConsumers: number } {
  const realConsumers: string[] = [];
  let barrelConsumers = 0;
  const leaf = leafName(symbol);

  for (const consumer of consumerFiles) {
    if (isReExportOnlyConsumer(db, consumer, definitionFile, leaf)) {
      barrelConsumers++;
    } else if (isImportOnlyConsumer(db, consumer, leaf)) {
      // File imports the type but never references it outside the import.
      // Counts as phantom consumer (the import itself is dead too).
      barrelConsumers++;
    } else {
      realConsumers.push(consumer);
    }
  }

  return { realConsumers, barrelConsumers };
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
 * True when the only occurrences of `leaf` in `consumerFile` are inside
 * import statements — i.e. the consumer imports the type but never uses it.
 *
 * Uses per-file caches: one walk per file produces (a) the set of leaves
 * mentioned ONLY inside imports and (b) the set of leaves mentioned
 * elsewhere. Repeat checks for different leaves on the same file then
 * become O(1) Set lookups.
 */
const FILE_USAGE_CACHE = createPerDbCache<string, { importedLeaves: Set<string>; usedLeaves: Set<string> }>('stale-abs-file-usage');
function isImportOnlyConsumer(
  db: ScipDatabase,
  consumerFile: string,
  leaf: string,
): boolean {
  if (!leaf) return false;
  const lang = detectAstLanguage(consumerFile);
  if (!lang) return false;
  const usage = FILE_USAGE_CACHE.get(db, consumerFile, () =>
    computeFileLeafUsage(db, consumerFile, lang),
  );
  return usage.importedLeaves.has(leaf) && !usage.usedLeaves.has(leaf);
}

function computeFileLeafUsage(
  db: ScipDatabase,
  file: string,
  lang: string,
): { importedLeaves: Set<string>; usedLeaves: Set<string> } {
  const importedLeaves = new Set<string>();
  const usedLeaves = new Set<string>();
  const tree = getAst(db, file);
  if (!tree) return { importedLeaves, usedLeaves };

  const importTypes = lang === 'rust'
    ? new Set(['use_declaration'])
    : lang === 'python'
      ? new Set(['import_statement', 'import_from_statement'])
      : new Set(['import_statement']); // TS/JS — value exports are NOT included

  const walk = (node: SyntaxNode, insideImport: boolean): void => {
    const nowInside = insideImport || importTypes.has(node.type);
    if (node.type === 'identifier' || node.type === 'type_identifier'
        || node.type === 'property_identifier' || node.type === 'field_identifier') {
      if (nowInside) importedLeaves.add(node.text);
      else usedLeaves.add(node.text);
    }
    for (const child of node.children) walk(child, nowInside);
  };
  walk(tree.rootNode, false);
  return { importedLeaves, usedLeaves };
}

/**
 * True when every mention of `leaf` in `consumerFile` sits inside a
 * re-export statement (`export { X } from '...'` or `export * from '...'`).
 * That makes the file a public-API passthrough, not a real consumer.
 *
 * We intentionally do NOT require the re-export's resolved path to equal
 * `definitionFile`: re-exports sometimes point at the wrong file (e.g.
 * pointing at a sibling module whose compiler-resolved types route back
 * to the real definition). What matters is that the consumer file never
 * *uses* the type — if every occurrence of the leaf is on a re-export
 * line, the file is forwarding the type to downstream consumers.
 */
function isReExportOnlyConsumer(
  db: ScipDatabase,
  consumerFile: string,
  _definitionFile: string,
  leaf: string,
): boolean {
  if (!leaf) return false;
  const source = getSourceText(db, consumerFile);
  if (!source) return false;

  const reExports = getReExports(db, consumerFile);
  if (reExports.length === 0) return false;

  const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRegex = new RegExp(`\\b${escaped}\\b`);
  const lines = source.split('\n');

  let occurrenceCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!wordRegex.test(lines[i] ?? '')) continue;
    occurrenceCount++;
    const coveredBy = reExports.find((r) => r.startLine <= i && i <= r.endLine);
    if (!coveredBy) return false;
  }

  // If the leaf never appears in source but SCIP records a mention, there's
  // nothing to attribute — treat as not a passthrough (defensive fallback).
  return occurrenceCount > 0;
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

function definitionLoc(
  definition: IndexedDefinition,
): number {
  return definition.endLine - definition.startLine + 1;
}

function mergeConsumerMaps(
  ...maps: Array<Map<number, Set<string>>>
): Map<number, Set<string>> {
  const merged = new Map<number, Set<string>>();
  for (const m of maps) {
    for (const [k, v] of m) {
      let bucket = merged.get(k);
      if (!bucket) {
        bucket = new Set();
        merged.set(k, bucket);
      }
      for (const f of v) bucket.add(f);
    }
  }
  return merged;
}
