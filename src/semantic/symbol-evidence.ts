import type { IndexedDefinition, SymbolMatch } from '../domain/types.js';
import { profileEnabled, profileSpan } from '../instrumentation/profile.js';
import { getSourceText } from '../source/source-text.js';
import type { ScipDatabase } from '../storage/db.js';
import {
  fileContentHash,
  readCachedSemanticCalleesForFile,
  sha256Hex,
  writeCachedSemanticCalleesBatch,
  type SemanticCalleeCacheEntry,
} from '../storage/evidence-cache.js';
import { createPerDbCache } from '../storage/per-db-cache.js';
import { buildFileDepGraph } from '../symbols/graph/file-dep-graph.js';
import type { SymbolSemanticEvidencePort } from '../symbols/semantic-evidence-port.js';
import { semanticDefinitionsByFile } from './definition-groups.js';
import { semanticProviderLanguageForPath } from './provider-cache.js';
import { rustSemanticEngineIdentity } from './rust/engine-identity.js';
import {
  prefetchedSemanticCalleesForDefinitions,
  semanticCalleeMap,
  semanticEvidenceProduct,
  semanticReferenceMap,
  semanticReferences,
} from './shared-primitives.js';
import type { SemanticCallee } from './types.js';
import { typeScriptSemanticIdentityForFile } from './typescript/semantic-identity-context.js';

export const symbolSemanticEvidence: SymbolSemanticEvidencePort = {
  references: semanticReferences,
  referenceMap: semanticReferenceMap,
  callerMap: (db, definitions) => semanticEvidenceProduct(db).callerMap(definitions),
  calleeMap: materializeSemanticCalleeCache,
};

/**
 * Persistent-cache wrapper around `semanticCalleeMap`. A full-hit batch is
 * served without touching the provider at all — provider construction (an
 * eager ts-morph project load) is the dominant cost this avoids on warm runs.
 * TypeScript rows are keyed by the same transitive semantic identity as the
 * other compiler-derived fragments. Rust retains its engine-qualified direct
 * dependency key. Results are only written when the provider is available, so
 * "provider missing" is never frozen into the cache as an empty result.
 */
export function materializeSemanticCalleeCache(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition | SymbolMatch>,
): Map<number, SemanticCallee[]> {
  const profiling = profileEnabled();
  const result = new Map<number, SemanticCallee[]>();
  const prefetched = prefetchedSemanticCalleesForDefinitions(db, definitions);
  const misses: Array<{ def: IndexedDefinition | SymbolMatch; contentHash: string; depsDigest: string }> = [];
  const unkeyed: Array<IndexedDefinition | SymbolMatch> = [];
  let skippedUnsupportedLanguage = 0;
  let sourceMissing = 0;
  let cacheHits = 0;
  let parseFailures = 0;
  let inMemoryHits = 0;
  let inMemoryRows = 0;
  let inMemoryCalleeCount = 0;

  for (const { definition, callees } of prefetched.hits) {
    inMemoryHits += 1;
    if (callees.length > 0) {
      inMemoryRows += 1;
      inMemoryCalleeCount += callees.length;
      result.set(definition.symbolId, callees);
    }
  }

  const prefetchedCacheEntries = semanticCalleeCacheEntriesForPrefetchedRows(db, prefetched.hits);
  if (prefetchedCacheEntries.entries.length > 0) {
    profileSpan(
      'semantic.callees.prefetch-cache-write',
      () => writeCachedSemanticCalleesBatch(db, prefetchedCacheEntries.entries),
      () => ({
        entries: prefetchedCacheEntries.entries.length,
        sourceMissing: prefetchedCacheEntries.sourceMissing,
        skippedUnsupportedLanguage: prefetchedCacheEntries.skippedUnsupportedLanguage,
      }),
    );
  }

  profileSpan(
    'semantic.callees.cache-scan',
    () => {
      for (const [relativePath, fileDefinitions] of semanticDefinitionsByFile(prefetched.misses)) {
        if (!semanticProviderLanguageForPath(relativePath)) {
          if (profiling) skippedUnsupportedLanguage += fileDefinitions.length;
          continue;
        }
        const source = getSourceText(db, relativePath);
        if (!source) {
          if (profiling) sourceMissing += fileDefinitions.length;
          unkeyed.push(...fileDefinitions);
          continue;
        }
        const contentHash = fileContentHash(db, relativePath, source);
        const depsDigest = semanticCalleeDepsDigest(db, relativePath);
        if (!depsDigest) {
          unkeyed.push(...fileDefinitions);
          continue;
        }
        const cachedBySymbol = readCachedSemanticCalleesForFile(db, relativePath, contentHash, depsDigest);
        for (const def of fileDefinitions) {
          const cached = cachedBySymbol.get(def.symbol) ?? null;
          if (cached !== null) {
            const callees = parseCachedCallees(cached);
            if (callees) {
              if (profiling) cacheHits += 1;
              if (callees.length > 0) result.set(def.symbolId, callees);
              continue;
            }
            if (profiling) parseFailures += 1;
          }
          misses.push({ def, contentHash, depsDigest });
        }
      }
    },
    () => ({
      definitions: definitions.length,
      skippedUnsupportedLanguage,
      sourceMissing,
      cacheHits,
      parseFailures,
      misses: misses.length,
      unkeyed: unkeyed.length,
      inMemoryHits,
      inMemoryRows,
      inMemoryCalleeCount,
      resultRows: result.size,
    }),
  );
  if (misses.length === 0 && unkeyed.length === 0) return result;

  const computeInput = [...unkeyed, ...misses.map((miss) => miss.def)];
  let computedRows = 0;
  const computed = profileSpan(
    'semantic.callees.compute-misses',
    () => {
      const rows = semanticCalleeMap(db, computeInput);
      computedRows = rows.size;
      return rows;
    },
    () => ({
      definitions: computeInput.length,
      misses: misses.length,
      unkeyed: unkeyed.length,
      rows: computedRows,
    }),
  );
  for (const [symbolId, callees] of computed) result.set(symbolId, callees);
  const entries = misses
    .filter((miss) => semanticEvidenceProduct(db).capability('semantic-callees', miss.def.relativePath).available)
    .map((miss) => ({
      relativePath: miss.def.relativePath,
      symbol: miss.def.symbol,
      contentHash: miss.contentHash,
      depsDigest: miss.depsDigest,
      payload: JSON.stringify(computed.get(miss.def.symbolId) ?? []),
    }));
  if (entries.length > 0) {
    profileSpan(
      'semantic.callees.cache-write',
      () => writeCachedSemanticCalleesBatch(db, entries),
      () => ({
        entries: entries.length,
      }),
    );
  } else {
    profileSpan(
      'semantic.callees.cache-write-skip',
      () => undefined,
      () => ({
        reason: 'provider-unavailable',
        misses: misses.length,
      }),
    );
  }
  return result;
}

function semanticCalleeCacheEntriesForPrefetchedRows(
  db: ScipDatabase,
  hits: ReadonlyArray<{
    definition: IndexedDefinition | SymbolMatch;
    callees: readonly SemanticCallee[];
  }>,
): { entries: SemanticCalleeCacheEntry[]; sourceMissing: number; skippedUnsupportedLanguage: number } {
  const entries: SemanticCalleeCacheEntry[] = [];
  const keyByPath = new Map<string, { contentHash: string; depsDigest: string } | null>();
  let sourceMissing = 0;
  let skippedUnsupportedLanguage = 0;

  for (const { definition, callees } of hits) {
    if (!semanticProviderLanguageForPath(definition.relativePath)) {
      skippedUnsupportedLanguage += 1;
      continue;
    }
    if (!keyByPath.has(definition.relativePath)) {
      const source = getSourceText(db, definition.relativePath);
      const depsDigest = source ? semanticCalleeDepsDigest(db, definition.relativePath) : null;
      keyByPath.set(
        definition.relativePath,
        source && depsDigest
          ? {
              contentHash: fileContentHash(db, definition.relativePath, source),
              depsDigest,
            }
          : null,
      );
    }
    const key = keyByPath.get(definition.relativePath);
    if (!key) {
      sourceMissing += 1;
      continue;
    }
    entries.push({
      relativePath: definition.relativePath,
      symbol: definition.symbol,
      contentHash: key.contentHash,
      depsDigest: key.depsDigest,
      payload: JSON.stringify(callees),
    });
  }

  return { entries, sourceMissing, skippedUnsupportedLanguage };
}

const TYPESCRIPT_CALLEE_SCHEMA = 'typescript-callees-v1';

function semanticCalleeDepsDigest(db: ScipDatabase, relativePath: string): string | null {
  const language = semanticProviderLanguageForPath(relativePath);
  if (language === 'typescript') {
    return typeScriptSemanticIdentityForFile(db, relativePath, TYPESCRIPT_CALLEE_SCHEMA)?.key ?? null;
  }
  const depsDigest = depsDigestFor(db, relativePath);
  if (language === 'rust') {
    return sha256Hex(
      JSON.stringify({
        kind: 'semantic-callees',
        language,
        engine: rustSemanticEngineIdentity(db.config.projectRoot),
        positionMapping: 'nearby-leaf-v1',
        depsDigest,
      }),
    );
  }
  return depsDigest;
}

function parseCachedCallees(payload: string): SemanticCallee[] | null {
  try {
    return JSON.parse(payload) as SemanticCallee[];
  } catch {
    return null; // corrupt payload — treat as a miss and recompute
  }
}

const DEPS_DIGEST_CACHE = createPerDbCache<string, string>('semantic-deps-digest', {
  clearGroups: ['whole-project', 'source-file'],
});

function depsDigestFor(db: ScipDatabase, relativePath: string): string {
  return DEPS_DIGEST_CACHE.get(db, relativePath, () => {
    const deps = [...(buildFileDepGraph(db).get(relativePath) ?? [])].sort();
    const parts = deps.map((dep) => `${dep}:${fileContentHash(db, dep, getSourceText(db, dep))}`);
    return sha256Hex(parts.join('|'));
  });
}
