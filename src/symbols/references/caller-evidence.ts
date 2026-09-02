import type { ScipDatabase } from '../../storage/db.js';
import { createPerDbValue } from '../../storage/per-db-cache.js';
import type { IndexedDefinition, SymbolMatch } from '../../domain/types.js';
import { findCallerFiles } from '../identifier-attribution.js';
import type { SymbolSemanticEvidencePort } from '../semantic-evidence-port.js';
import { buildCrossFileCallerMap } from './reference-callers.js';

// scip-query: ignore-passthrough — caller-facing bulk evidence facade; callers
// should not depend on the reference-callers adapter directly.
/**
 * Per-symbol caller files, memoized per database. Both passes below scan the
 * whole repository once per call whatever the definition set, and their
 * per-symbol answers do not depend on which other symbols were asked for, so
 * a later call reuses what earlier calls established and scans only for the
 * symbols it has not seen. Cleared with the whole-project and source-file
 * cache groups.
 */
const INDEXED_CALLER_FILES = createPerDbValue<Map<number, Set<string>>>('cross-file-caller-files', {
  clearGroups: ['whole-project', 'source-file'],
});
const SOURCE_FALLBACK_CALLER_FILES = createPerDbValue<Map<number, Set<string>>>('source-fallback-caller-files', {
  clearGroups: ['whole-project', 'source-file'],
});

function memoizedCallerFiles<D extends { symbolId: number }>(
  memo: Map<number, Set<string>>,
  definitions: ReadonlyArray<D>,
  compute: (missing: D[]) => Map<number, Set<string>>,
): Map<number, Set<string>> {
  const missing = definitions.filter((definition) => !memo.has(definition.symbolId));
  if (missing.length > 0) {
    const computed = compute(missing);
    for (const definition of missing) memo.set(definition.symbolId, computed.get(definition.symbolId) ?? new Set());
  }
  const result = new Map<number, Set<string>>();
  for (const definition of definitions) {
    const files = memo.get(definition.symbolId);
    if (files && files.size > 0) result.set(definition.symbolId, new Set(files));
  }
  return result;
}

export function crossFileCallerEvidenceMap(
  db: ScipDatabase,
  definitions?: ReadonlyArray<SymbolMatch>,
  opts: { semantic?: boolean; semanticEvidence?: SymbolSemanticEvidencePort } = {},
): Map<number, Set<string>> {
  if (definitions === undefined) return buildCrossFileCallerMap(db, definitions, opts);
  const indexed = memoizedCallerFiles(
    INDEXED_CALLER_FILES.get(db, () => new Map()),
    definitions,
    (missing) => buildCrossFileCallerMap(db, missing, { semantic: false }),
  );
  if (opts.semantic === false || !opts.semanticEvidence) return indexed;
  return mergeSetMaps(
    indexed,
    opts.semanticEvidence.callerMap(
      db,
      definitions.filter(
        (definition): definition is IndexedDefinition =>
          'relativePath' in definition && 'symbol' in definition && 'leaf' in definition,
      ),
    ),
  );
}

// scip-query: ignore-passthrough — caller-facing source fallback facade; keeps
// inverse source attribution behind the caller-evidence module.
export function sourceFallbackCallerEvidenceMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition>,
  opts: { skipPath?: (relativePath: string) => boolean } = {},
): Map<number, Set<string>> {
  if (opts.skipPath) return findCallerFiles(db, definitions, opts);
  return memoizedCallerFiles(
    SOURCE_FALLBACK_CALLER_FILES.get(db, () => new Map()),
    definitions,
    (missing) => findCallerFiles(db, missing),
  );
}

// scip-query: ignore-wrapper — public caller evidence composition boundary:
// cross-file caller maps plus source attribution fallback are one policy.
export function callerFileEvidenceMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition>,
  opts: { semantic?: boolean; sourceFallback?: boolean; semanticEvidence?: SymbolSemanticEvidencePort } = {},
): Map<number, Set<string>> {
  const callerMap = crossFileCallerEvidenceMap(db, definitions, {
    semantic: opts.semantic,
    semanticEvidence: opts.semanticEvidence,
  });
  return opts.sourceFallback === false
    ? callerMap
    : mergeSetMaps(callerMap, sourceFallbackCallerEvidenceMap(db, definitions));
}

export function mergeSetMaps<K, V>(
  left: ReadonlyMap<K, ReadonlySet<V>>,
  right: ReadonlyMap<K, ReadonlySet<V>>,
): Map<K, Set<V>> {
  const result = new Map<K, Set<V>>();
  for (const [key, values] of left) {
    result.set(key, new Set(values));
  }
  for (const [key, values] of right) {
    const bucket = result.get(key) ?? new Set<V>();
    for (const value of values) bucket.add(value);
    result.set(key, bucket);
  }
  return result;
}
