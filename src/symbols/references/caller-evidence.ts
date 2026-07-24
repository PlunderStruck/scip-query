import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition, SymbolMatch } from '../../domain/types.js';
import { findCallerFiles } from '../identifier-attribution.js';
import type { SymbolSemanticEvidencePort } from '../semantic-evidence-port.js';
import { buildCrossFileCallerMap } from './reference-callers.js';

// scip-query: ignore-passthrough — caller-facing bulk evidence facade; callers
// should not depend on the reference-callers adapter directly.
export function crossFileCallerEvidenceMap(
  db: ScipDatabase,
  definitions?: ReadonlyArray<SymbolMatch>,
  opts: { semantic?: boolean; semanticEvidence?: SymbolSemanticEvidencePort } = {},
): Map<number, Set<string>> {
  return buildCrossFileCallerMap(db, definitions, opts);
}

// scip-query: ignore-passthrough — caller-facing source fallback facade; keeps
// inverse source attribution behind the caller-evidence module.
export function sourceFallbackCallerEvidenceMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition>,
  opts: { skipPath?: (relativePath: string) => boolean } = {},
): Map<number, Set<string>> {
  return findCallerFiles(db, definitions, opts);
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
