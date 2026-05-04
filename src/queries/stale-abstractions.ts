import type { ScipDatabase } from '../db.js';
import {
  buildCrossFileCallerMap,
  buildSourceFallbackCallerFiles,
  getDefinitionsForFile,
  getScopedDefinitions,
} from '../query-support.js';
import type { StaleAbstraction } from '../types.js';
import { leafName, shortenSymbol } from '../symbol-parser.js';
import { getReExports, getSourceText } from '../source-analysis.js';

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
  opts?: { scope?: string; minLoc?: number; limit?: number; includeLowConfidence?: boolean },
): StaleAbstraction[] {
  const { scope, minLoc = 3, limit = 30, includeLowConfidence = false } = opts ?? {};

  const filesWithFunctions = getFilesWithFunctions(db, scope);

  const typeCandidates = getScopedDefinitions(db, scope)
    .filter((definition) => definition.isTypeLike && definitionLoc(definition) >= minLoc)
    .filter((definition) => !db.isIgnored(definition.relativePath));

  // Consumer map = SCIP mentions (with self-references filtered) ∪ source-text
  // fallback for unique-named types. Without the fallback, a type used only in
  // string-templated contexts or via paths the indexer missed would falsely
  // appear unconsumed.
  const scipConsumers = buildCrossFileCallerMap(db, typeCandidates);
  const sourceConsumers = buildSourceFallbackCallerFiles(db, typeCandidates);
  const consumerFileMap = mergeConsumerMaps(scipConsumers, sourceConsumers);

  const rows = typeCandidates
    .map((definition) => {
      const allFiles = consumerFileMap.get(definition.symbolId) ?? new Set<string>();
      const consumerFiles = [...allFiles].filter(
        (f) => f !== definition.relativePath && !db.isIgnored(f),
      );
      const { realConsumers, barrelConsumers } = partitionConsumers(
        db,
        definition.relativePath,
        definition.symbol,
        consumerFiles,
      );
      return {
        definition,
        realConsumers,
        barrelConsumers,
      };
    })
    .filter((row) => row.realConsumers.length <= 1)
    // A type whose only observable use is a public-API re-export is not stale —
    // it's part of the surface the library exposes to external consumers we
    // can't see in the index. Skip those entirely.
    .filter((row) => !(row.realConsumers.length === 0 && row.barrelConsumers > 0));

  const scored = rows
    .filter((row) => isTrueStaleAbstraction(row.definition, row.realConsumers.length, filesWithFunctions))
    .map((row) => {
      const kind = detectDefinitionKind(db, row.definition.relativePath, row.definition.startLine);
      const definerUsesType = detectDefinerUsesType(db, row.definition);
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
      } satisfies StaleAbstraction;
    })
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

function getFilesWithFunctions(
  db: ScipDatabase,
  scope?: string,
): Set<string> {
  return new Set(getScopedDefinitions(db, scope)
    .filter((definition) => definition.isFunctionLike)
    .map((definition) => definition.relativePath));
}

function isTrueStaleAbstraction(
  definition: { relativePath: string },
  consumers: number,
  filesWithFunctions: ReadonlySet<string>,
): boolean {
  const basename = definition.relativePath.split('/').pop() ?? '';
  const isTypeFile = basename.includes('types') || definition.relativePath.includes('/types/');
  if (isTypeFile && consumers > 0) {
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
    } else {
      realConsumers.push(consumer);
    }
  }

  return { realConsumers, barrelConsumers };
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
  definition: ReturnType<typeof getDefinitionsForFile>[number],
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
