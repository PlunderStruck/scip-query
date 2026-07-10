import type { IndexedDefinition, SymbolMatch } from '../domain/types.js';
import type { ScipDatabase } from '../storage/db.js';
import {
  projectEvidenceFingerprint,
  readCachedSemanticReferencesForFile,
  sha256Hex,
  writeCachedSemanticReferencesBatch,
  type SemanticReferenceCacheEntry,
} from '../storage/evidence-cache.js';
import {
  createFileEvidenceProduct,
  createProjectEvidenceProduct,
  evidenceProductInvalidation,
} from '../storage/evidence-products.js';
import type {
  SemanticAvailability,
  SemanticCallee,
  SemanticImportUsage,
  SemanticProvider,
  SemanticProviderLanguage,
  SemanticReference,
} from './types.js';
import { getSemanticProvider, semanticProviderLanguageForPath } from './provider-cache.js';
import { profileEnabled, profileSpan } from '../instrumentation/profile.js';
import { rustSemanticEngineIdentity } from './rust/engine-identity.js';
import { rustDefaultImplReferenceMap, rustDefaultImplReferencesForDefinition } from './rust/default-impl-references.js';
import {
  rustScipOccurrenceReferenceMap,
  rustScipOccurrenceReferencesForDefinition,
} from './rust/scip-occurrence-references.js';
import { createPerDbValue } from '../storage/per-db-cache.js';
import {
  materializeTypeScriptReferenceFragments,
  recordTypeScriptReferenceFragmentShadow,
} from './typescript/reference-fragment-shadow.js';
import { typeScriptSemanticIdentityForFile } from './typescript/semantic-identity-context.js';

export type SemanticEvidenceSlot =
  | 'semantic-references'
  | 'semantic-callers'
  | 'semantic-callees'
  | 'semantic-import-usage'
  | 'semantic-signatures';

export interface SemanticEvidenceCapability extends SemanticAvailability {
  slot: SemanticEvidenceSlot;
  language: SemanticProviderLanguage;
}

export interface SemanticReferenceMaterializationResult {
  definitions: number;
  inMemoryHits: number;
  incompleteInMemoryHits: number;
  cacheHits: number;
  misses: number;
  unkeyed: number;
  skippedUnsupportedLanguage: number;
  parseFailures: number;
  computed: number;
  incomplete: number;
  cacheWrites: number;
  fragmentDefinitions: number;
  fragmentCacheHits: number;
  fragmentCacheMisses: number;
  fragmentComputedFiles: number;
}

export interface SemanticReferenceMaterializationOptions {
  prefetchCallees?: boolean;
}

export interface SemanticEvidenceProduct {
  capability(slot: SemanticEvidenceSlot, relativePath?: string): SemanticEvidenceCapability;
  importUsage(file: string): SemanticImportUsage[];
  references(definition: IndexedDefinition): SemanticReference[];
  materializeReferences(
    definitions: ReadonlyArray<IndexedDefinition>,
    opts?: SemanticReferenceMaterializationOptions,
  ): SemanticReferenceMaterializationResult;
  callerMap(definitions: ReadonlyArray<IndexedDefinition>): Map<number, Set<string>>;
  calleeMap(definitions: ReadonlyArray<IndexedDefinition | SymbolMatch>): Map<number, SemanticCallee[]>;
  signature(definition: IndexedDefinition): string | null;
}

export interface PrefetchedSemanticCalleeHit<T extends Pick<IndexedDefinition, 'symbolId'>> {
  definition: T;
  callees: SemanticCallee[];
}

export interface PrefetchedSemanticCalleeLookup<T extends Pick<IndexedDefinition, 'symbolId'>> {
  hits: Array<PrefetchedSemanticCalleeHit<T>>;
  misses: T[];
}

interface CachedSemanticSignature {
  signature: string | null;
}

const TYPESCRIPT_IMPORT_USAGE_SCHEMA = 'typescript-import-usage-v1';
const TYPESCRIPT_SIGNATURE_SCHEMA = 'typescript-signatures-v1';

const PREFETCHED_SEMANTIC_CALLEES = createPerDbValue<Map<number, SemanticCallee[]>>('semantic-prefetched-callees', {
  clearGroups: ['whole-project', 'source-file', 'semantic-provider'],
});

const RUST_SEMANTIC_IMPORT_USAGE_CACHE = createProjectEvidenceProduct<SemanticImportUsage[]>({
  kind: 'semantic-import-usage',
  invalidation: evidenceProductInvalidation('semantic-import-usage'),
  serialize: (value) => JSON.stringify(value),
  deserialize: parseCachedImportUsage,
});

const RUST_SEMANTIC_SIGNATURE_CACHE = createProjectEvidenceProduct<CachedSemanticSignature>({
  kind: 'semantic-signatures',
  invalidation: evidenceProductInvalidation('semantic-signatures'),
  serialize: (value) => JSON.stringify(value),
  deserialize: parseCachedSignature,
});

const TYPESCRIPT_IMPORT_USAGE_CACHE = createFileEvidenceProduct<SemanticImportUsage[]>({
  kind: 'typescript-import-usage',
  invalidation: evidenceProductInvalidation('typescript-import-usage'),
  serialize: (value) => JSON.stringify(value),
  deserialize: parseCachedImportUsage,
});

const TYPESCRIPT_SIGNATURE_CACHE = createFileEvidenceProduct<Record<string, string | null>>({
  kind: 'typescript-signatures',
  invalidation: evidenceProductInvalidation('typescript-signatures'),
  serialize: (value) => JSON.stringify(value),
  deserialize: parseCachedSignatureMap,
});

export function semanticEvidenceProduct(db: ScipDatabase): SemanticEvidenceProduct {
  const materializedReferences = new Map<number, SemanticReference[]>();
  const incompleteReferences = new Set<number>();
  return {
    capability: (slot, relativePath) => semanticEvidenceCapability(db, slot, relativePath),
    importUsage: (file) => buildSemanticImportUsage(db, file),
    references: (definition) => buildSemanticReferences(db, definition),
    materializeReferences: (definitions, opts) =>
      materializeSemanticReferenceBatch(db, definitions, materializedReferences, incompleteReferences, opts),
    callerMap: (definitions) => buildSemanticCallerMap(db, definitions, materializedReferences, incompleteReferences),
    calleeMap: (definitions) => buildSemanticCalleeMap(db, definitions),
    signature: (definition) => buildSemanticSignature(db, definition),
  };
}

export function recordPrefetchedSemanticCallees(
  db: ScipDatabase,
  rows: ReadonlyMap<number, readonly SemanticCallee[]>,
): void {
  if (rows.size === 0) return;
  const cache = PREFETCHED_SEMANTIC_CALLEES.get(db, () => new Map());
  for (const [symbolId, callees] of rows) cache.set(symbolId, [...callees]);
}

export function prefetchedSemanticCalleesForDefinitions<T extends Pick<IndexedDefinition, 'symbolId'>>(
  db: ScipDatabase,
  definitions: ReadonlyArray<T>,
): PrefetchedSemanticCalleeLookup<T> {
  if (!PREFETCHED_SEMANTIC_CALLEES.has(db)) return { hits: [], misses: [...definitions] };
  const cache = PREFETCHED_SEMANTIC_CALLEES.get(db, () => new Map());
  const hits: Array<PrefetchedSemanticCalleeHit<T>> = [];
  const misses: T[] = [];
  for (const definition of definitions) {
    if (cache.has(definition.symbolId)) {
      hits.push({ definition, callees: cache.get(definition.symbolId) ?? [] });
    } else {
      misses.push(definition);
    }
  }
  return { hits, misses };
}

// scip-query: ignore-wrapper — legacy semantic helper kept for source-compatible callers; the product owns access.
export function semanticImportUsage(db: ScipDatabase, file: string): SemanticImportUsage[] {
  return semanticEvidenceProduct(db).importUsage(file);
}

function buildSemanticImportUsage(db: ScipDatabase, file: string): SemanticImportUsage[] {
  if (semanticProviderLanguageForPath(file) === 'typescript') {
    let state = 'fallback';
    let eligible = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    let fallbacks = 0;
    return profileSpan(
      'typescript.import-usage.materialize',
      () => {
        const identity = typeScriptSemanticIdentityForFile(db, file, TYPESCRIPT_IMPORT_USAGE_SCHEMA);
        if (identity?.key) {
          eligible = 1;
          const cached = TYPESCRIPT_IMPORT_USAGE_CACHE.read(db, file, identity.key);
          if (cached) {
            state = 'hit';
            cacheHits = 1;
            return cached;
          }
          cacheMisses = 1;
          const provider = availableSemanticProvider(db, file);
          if (!provider) {
            state = 'unavailable';
            return [];
          }
          const usage = provider.importUsage(file);
          TYPESCRIPT_IMPORT_USAGE_CACHE.write(db, file, identity.key, usage);
          state = 'computed';
          return usage;
        }
        fallbacks = 1;
        const provider = availableSemanticProvider(db, file);
        if (!provider) {
          state = 'unavailable';
          return [];
        }
        state = 'direct-fallback';
        return provider.importUsage(file);
      },
      () => ({ state, eligible, cacheHits, cacheMisses, fallbacks }),
    );
  }
  const cacheFingerprint = semanticProjectSlotCacheFingerprint(db, 'semantic-import-usage', file);
  if (cacheFingerprint) {
    const cached = RUST_SEMANTIC_IMPORT_USAGE_CACHE.read(db, file, cacheFingerprint);
    if (cached) return cached;
  }
  const provider = availableSemanticProvider(db, file);
  if (!provider) return [];
  const usage = provider.importUsage(file);
  if (cacheFingerprint) RUST_SEMANTIC_IMPORT_USAGE_CACHE.write(db, file, cacheFingerprint, usage);
  return usage;
}

// scip-query: ignore-wrapper — legacy semantic helper kept for source-compatible callers; the product owns access.
export function semanticReferences(db: ScipDatabase, definition: IndexedDefinition): SemanticReference[] {
  return semanticEvidenceProduct(db).references(definition);
}

function buildSemanticReferences(db: ScipDatabase, definition: IndexedDefinition): SemanticReference[] {
  const rustDefaultReferences = rustDefaultImplReferencesForDefinition(db, definition);
  if (rustDefaultReferences) return rustDefaultReferences;
  const rustScipOccurrenceReferences = rustScipOccurrenceReferencesForDefinition(db, definition);
  if (rustScipOccurrenceReferences) return rustScipOccurrenceReferences;
  const provider = availableSemanticProvider(db, definition.relativePath);
  if (!provider) return [];
  return provider.referencesFor(definition);
}

// scip-query: ignore-wrapper — legacy semantic helper kept for source-compatible callers; the product owns access.
export function semanticCallerMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition>,
): Map<number, Set<string>> {
  return semanticEvidenceProduct(db).callerMap(definitions);
}

/**
 * Preserve scalar reference semantics while batching TypeScript transport.
 * Unlike semanticCallerMap, this path intentionally bypasses fragment and
 * persistent reference caches because those use the approximate inverted scan.
 */
export function exactSemanticCallerMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition>,
): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();
  const typescriptGroups = new Map<SemanticProvider, IndexedDefinition[]>();
  for (const definition of definitions) {
    if (semanticProviderLanguageForPath(definition.relativePath) === 'typescript') {
      const provider = availableSemanticProvider(db, definition.relativePath);
      if (!provider) continue;
      const bucket = typescriptGroups.get(provider) ?? [];
      bucket.push(definition);
      typescriptGroups.set(provider, bucket);
      continue;
    }
    recordCallerFilesFromReferences(db, result, definition, buildSemanticReferences(db, definition));
  }
  for (const [provider, groupedDefinitions] of typescriptGroups) {
    const references = provider.referencesForDefinitions
      ? provider.referencesForDefinitions(groupedDefinitions, { exact: true })
      : new Map(groupedDefinitions.map((definition) => [definition.symbolId, provider.referencesFor(definition)]));
    for (const definition of groupedDefinitions) {
      recordCallerFilesFromReferences(db, result, definition, references.get(definition.symbolId) ?? []);
    }
  }
  return result;
}

function buildSemanticCallerMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition>,
  materializedReferences = new Map<number, SemanticReference[]>(),
  incompleteReferences = new Set<number>(),
): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();
  const materialization = materializeSemanticReferenceBatch(
    db,
    definitions,
    materializedReferences,
    incompleteReferences,
  );
  let callerFiles = 0;
  profileSpan(
    'semantic.callers.from-references',
    () => {
      for (const definition of definitions) {
        callerFiles += recordCallerFilesFromReferences(
          db,
          result,
          definition,
          materializedReferences.get(definition.symbolId) ?? [],
        );
      }
    },
    () => ({
      definitions: definitions.length,
      materialized: materialization.definitions,
      inMemoryHits: materialization.inMemoryHits,
      incompleteInMemoryHits: materialization.incompleteInMemoryHits,
      resultRows: result.size,
      callerFiles,
    }),
  );
  return result;
}

function materializeSemanticReferenceBatch(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition>,
  materializedReferences: Map<number, SemanticReference[]>,
  incompleteReferences: Set<number>,
  opts: SemanticReferenceMaterializationOptions = {},
): SemanticReferenceMaterializationResult {
  const projectFingerprint = projectEvidenceFingerprint(db);
  const cacheWrites: SemanticReferenceCacheEntry[] = [];
  const misses: Array<{ definition: IndexedDefinition; cacheFingerprint: string }> = [];
  const unkeyed: IndexedDefinition[] = [];
  let skippedUnsupportedLanguage = 0;
  let inMemoryHits = 0;
  let cacheHits = 0;
  let parseFailures = 0;
  let computedRows = 0;
  let cacheReadFiles = 0;
  let fullyInMemoryFiles = 0;
  let incompleteInMemoryHits = 0;
  let fragmentDefinitions = 0;
  let fragmentCacheHits = 0;
  let fragmentCacheMisses = 0;
  let fragmentComputedFiles = 0;
  let computeInput: IndexedDefinition[] = [];
  let computed = new Map<number, SemanticReference[]>();

  const fragmentCandidates = definitions.filter(
    (definition) =>
      semanticProviderLanguageForPath(definition.relativePath) === 'typescript' &&
      !materializedReferences.has(definition.symbolId) &&
      !incompleteReferences.has(definition.symbolId),
  );
  const fragmentMaterialization = materializeTypeScriptReferenceFragments(db, fragmentCandidates);
  if (fragmentMaterialization) {
    fragmentDefinitions = fragmentCandidates.length;
    fragmentCacheHits = fragmentMaterialization.cacheHits;
    fragmentCacheMisses = fragmentMaterialization.cacheMisses;
    fragmentComputedFiles = fragmentMaterialization.computedFiles;
    for (const definition of fragmentCandidates) {
      materializedReferences.set(
        definition.symbolId,
        fragmentMaterialization.references.get(definition.symbolId) ?? [],
      );
    }
  }

  profileSpan(
    'semantic.references.cache-scan',
    () => {
      for (const [relativePath, fileDefinitions] of semanticDefinitionsByFile(definitions)) {
        const pendingDefinitions: IndexedDefinition[] = [];
        for (const definition of fileDefinitions) {
          if (materializedReferences.has(definition.symbolId)) {
            inMemoryHits += 1;
          } else if (incompleteReferences.has(definition.symbolId)) {
            incompleteInMemoryHits += 1;
          } else {
            pendingDefinitions.push(definition);
          }
        }
        if (pendingDefinitions.length === 0) {
          fullyInMemoryFiles += 1;
          continue;
        }

        const cacheFingerprint = semanticReferenceCacheFingerprint(db, projectFingerprint, relativePath);
        if (!cacheFingerprint) {
          for (const definition of pendingDefinitions) {
            if (!semanticProviderLanguageForPath(definition.relativePath)) skippedUnsupportedLanguage += 1;
            unkeyed.push(definition);
          }
          continue;
        }

        cacheReadFiles += 1;
        const cachedBySymbol = readCachedSemanticReferencesForFile(db, relativePath, cacheFingerprint);
        for (const definition of pendingDefinitions) {
          const cached = cachedBySymbol.get(definition.symbol) ?? null;
          if (cached !== null) {
            const references = parseCachedReferences(cached);
            if (references) {
              cacheHits += 1;
              materializedReferences.set(definition.symbolId, references);
              continue;
            }
            parseFailures += 1;
          }
          misses.push({ definition, cacheFingerprint });
        }
      }
    },
    () => ({
      definitions: definitions.length,
      skippedUnsupportedLanguage,
      cacheHits,
      parseFailures,
      misses: misses.length,
      unkeyed: unkeyed.length,
      inMemoryHits,
      incompleteInMemoryHits,
      fullyInMemoryFiles,
      cacheReadFiles,
    }),
  );

  if (misses.length > 0 || unkeyed.length > 0) {
    computeInput = [...unkeyed, ...misses.map((miss) => miss.definition)];
    computed = profileSpan(
      'semantic.references.compute-misses',
      () => {
        const rows = semanticReferenceMap(db, computeInput, opts);
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
    for (const definition of computeInput) {
      if (computed.has(definition.symbolId)) {
        materializedReferences.set(definition.symbolId, computed.get(definition.symbolId) ?? []);
        incompleteReferences.delete(definition.symbolId);
      } else {
        incompleteReferences.add(definition.symbolId);
      }
    }
    for (const { definition, cacheFingerprint } of misses) {
      if (
        computed.has(definition.symbolId) &&
        semanticEvidenceCapability(db, 'semantic-references', definition.relativePath).available
      ) {
        cacheWrites.push({
          relativePath: definition.relativePath,
          symbol: definition.symbol,
          projectFingerprint: cacheFingerprint,
          payload: JSON.stringify(computed.get(definition.symbolId) ?? []),
        });
      }
    }
  }

  if (cacheWrites.length > 0) {
    profileSpan(
      'semantic.references.cache-write',
      () => writeCachedSemanticReferencesBatch(db, cacheWrites),
      () => ({ entries: cacheWrites.length }),
    );
  }
  if (computed.size > 0) {
    recordTypeScriptReferenceFragmentShadow(db, computeInput, computed);
  }
  return {
    definitions: definitions.length,
    inMemoryHits,
    incompleteInMemoryHits,
    cacheHits,
    misses: misses.length,
    unkeyed: unkeyed.length,
    skippedUnsupportedLanguage,
    parseFailures,
    computed: computedRows,
    incomplete: incompleteReferences.size,
    cacheWrites: cacheWrites.length,
    fragmentDefinitions,
    fragmentCacheHits,
    fragmentCacheMisses,
    fragmentComputedFiles,
  };
}

function semanticDefinitionsByFile<T extends Pick<IndexedDefinition, 'relativePath'>>(
  definitions: ReadonlyArray<T>,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const definition of definitions) {
    const bucket = result.get(definition.relativePath) ?? [];
    bucket.push(definition);
    result.set(definition.relativePath, bucket);
  }
  return result;
}

function semanticReferenceCacheFingerprint(
  db: ScipDatabase,
  projectFingerprint: string | null,
  relativePath: string,
): string | null {
  if (!projectFingerprint) return null;
  const language = semanticProviderLanguageForPath(relativePath);
  if (language === 'typescript') return projectFingerprint;
  if (language === 'rust') {
    return sha256Hex(
      JSON.stringify({
        kind: 'semantic-references',
        language,
        engine: rustSemanticEngineIdentity(db.config.projectRoot),
        projectFingerprint,
      }),
    );
  }
  return null;
}

function semanticReferenceMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition>,
  opts: SemanticReferenceMaterializationOptions = {},
): Map<number, SemanticReference[]> {
  const profiling = profileEnabled();
  const result = new Map<number, SemanticReference[]>();
  let providerHits = 0;
  let providerMisses = 0;
  let rustDefaultFastPathRows = 0;
  let rustDefaultFastPathReferences = 0;
  let rustScipOccurrenceFastPathRows = 0;
  let rustScipOccurrenceFastPathReferences = 0;
  let definitionsWithReferences = 0;
  let referenceCount = 0;
  let prefetchCalleeDefinitions = 0;
  return profileSpan(
    'semantic.references.provider-loop',
    () => {
      const rustDefaultReferences = rustDefaultImplReferenceMap(db, definitions);
      const rustScipOccurrenceReferences = rustScipOccurrenceReferenceMap(db, definitions);
      const bulkGroups = new Map<SemanticProvider, IndexedDefinition[]>();
      const prefetchCalleeGroups = opts.prefetchCallees ? new Map<SemanticProvider, IndexedDefinition[]>() : null;
      const scalarDefinitions: Array<{ provider: SemanticProvider; definition: IndexedDefinition }> = [];
      for (const definition of definitions) {
        let provider: SemanticProvider | null | undefined;
        const getProvider = (): SemanticProvider | null => {
          provider ??= availableSemanticProvider(db, definition.relativePath);
          return provider;
        };
        if (prefetchCalleeGroups) {
          const prefetchProvider = getProvider();
          if (prefetchProvider?.referencesAndCalleesForDefinitions) {
            const bucket = prefetchCalleeGroups.get(prefetchProvider);
            if (bucket) bucket.push(definition);
            else prefetchCalleeGroups.set(prefetchProvider, [definition]);
            prefetchCalleeDefinitions += 1;
          }
        }
        const defaultReferences = rustDefaultReferences.get(definition.symbolId);
        if (defaultReferences) {
          rustDefaultFastPathRows += 1;
          rustDefaultFastPathReferences += defaultReferences.length;
          recordSemanticReferences(result, definition.symbolId, defaultReferences, profiling, (count) => {
            definitionsWithReferences += 1;
            referenceCount += count;
          });
          continue;
        }
        const scipOccurrenceReferences = rustScipOccurrenceReferences.get(definition.symbolId);
        if (scipOccurrenceReferences) {
          rustScipOccurrenceFastPathRows += 1;
          rustScipOccurrenceFastPathReferences += scipOccurrenceReferences.length;
          recordSemanticReferences(result, definition.symbolId, scipOccurrenceReferences, profiling, (count) => {
            definitionsWithReferences += 1;
            referenceCount += count;
          });
          continue;
        }
        const referenceProvider = getProvider();
        if (!referenceProvider) {
          if (profiling) providerMisses += 1;
          continue;
        }
        if (profiling) providerHits += 1;
        if (referenceProvider.referencesForDefinitions) {
          const bucket = bulkGroups.get(referenceProvider);
          if (bucket) bucket.push(definition);
          else bulkGroups.set(referenceProvider, [definition]);
        } else {
          scalarDefinitions.push({ provider: referenceProvider, definition });
        }
      }

      const combinedProviders = new Set<SemanticProvider>();
      if (prefetchCalleeGroups) {
        for (const [provider, calleeDefinitions] of prefetchCalleeGroups) {
          if (!provider.referencesAndCalleesForDefinitions) continue;
          const groupedDefinitions = bulkGroups.get(provider) ?? [];
          const maps = provider.referencesAndCalleesForDefinitions(groupedDefinitions, calleeDefinitions);
          combinedProviders.add(provider);
          recordPrefetchedSemanticCallees(db, maps.callees);
          for (const definition of groupedDefinitions) {
            if (!maps.references.has(definition.symbolId)) continue;
            const references = maps.references.get(definition.symbolId) ?? [];
            recordSemanticReferences(result, definition.symbolId, references, profiling, (count) => {
              definitionsWithReferences += 1;
              referenceCount += count;
            });
          }
        }
      }

      for (const [provider, groupedDefinitions] of bulkGroups) {
        if (combinedProviders.has(provider)) continue;
        const referenceMap = provider.referencesForDefinitions!(groupedDefinitions);
        for (const definition of groupedDefinitions) {
          if (!referenceMap.has(definition.symbolId)) continue;
          const references = referenceMap.get(definition.symbolId) ?? [];
          recordSemanticReferences(result, definition.symbolId, references, profiling, (count) => {
            definitionsWithReferences += 1;
            referenceCount += count;
          });
        }
      }

      for (const { provider, definition } of scalarDefinitions) {
        const references = provider.referencesFor(definition);
        recordSemanticReferences(result, definition.symbolId, references, profiling, (count) => {
          definitionsWithReferences += 1;
          referenceCount += count;
        });
      }
      return result;
    },
    () => ({
      definitions: definitions.length,
      providerHits,
      providerMisses,
      rustDefaultFastPathRows,
      rustDefaultFastPathReferences,
      rustScipOccurrenceFastPathRows,
      rustScipOccurrenceFastPathReferences,
      prefetchCalleeDefinitions,
      definitionsWithReferences,
      referenceCount,
      rows: result.size,
    }),
  );
}

function recordSemanticReferences(
  result: Map<number, SemanticReference[]>,
  symbolId: number,
  references: SemanticReference[],
  profiling: boolean,
  recordProfileHit: (referenceCount: number) => void,
): void {
  result.set(symbolId, references);
  if (profiling && references.length > 0) recordProfileHit(references.length);
}

function recordCallerFilesFromReferences(
  db: ScipDatabase,
  result: Map<number, Set<string>>,
  definition: IndexedDefinition,
  references: readonly SemanticReference[],
): number {
  let added = 0;
  for (const reference of references) {
    if (reference.file === definition.relativePath) continue;
    if (db.isIgnored(reference.file)) continue;
    let bucket = result.get(definition.symbolId);
    if (!bucket) {
      bucket = new Set();
      result.set(definition.symbolId, bucket);
    }
    const before = bucket.size;
    bucket.add(reference.file);
    if (bucket.size !== before) added += 1;
  }
  return added;
}

function parseCachedReferences(payload: string): SemanticReference[] | null {
  try {
    return JSON.parse(payload) as SemanticReference[];
  } catch {
    return null;
  }
}

// scip-query: ignore-wrapper — public semantic graph primitive; even when only
// symbol evidence modules consume it internally, this is the query-facing
// boundary documented by the TypeScript semantic provider plan.
export function semanticCalleeMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition | SymbolMatch>,
): Map<number, SemanticCallee[]> {
  return semanticEvidenceProduct(db).calleeMap(definitions);
}

function buildSemanticCalleeMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition | SymbolMatch>,
): Map<number, SemanticCallee[]> {
  const profiling = profileEnabled();
  const result = new Map<number, SemanticCallee[]>();
  let providerHits = 0;
  let providerMisses = 0;
  let definitionsWithCallees = 0;
  let calleeCount = 0;
  return profileSpan(
    'semantic.callees.provider-loop',
    () => {
      const bulkGroups = new Map<SemanticProvider, IndexedDefinition[]>();
      const scalarDefinitions: Array<{ provider: SemanticProvider; definition: IndexedDefinition }> = [];
      for (const definition of definitions) {
        const provider = availableSemanticProvider(db, definition.relativePath);
        if (!provider) {
          if (profiling) providerMisses += 1;
          continue;
        }
        if (profiling) providerHits += 1;
        const indexedDefinition = definition as IndexedDefinition;
        if (provider.calleesForDefinitions) {
          const bucket = bulkGroups.get(provider);
          if (bucket) bucket.push(indexedDefinition);
          else bulkGroups.set(provider, [indexedDefinition]);
        } else {
          scalarDefinitions.push({ provider, definition: indexedDefinition });
        }
      }

      for (const [provider, groupedDefinitions] of bulkGroups) {
        const calleeMap = provider.calleesForDefinitions!(groupedDefinitions);
        for (const definition of groupedDefinitions) {
          const callees = calleeMap.get(definition.symbolId) ?? [];
          recordSemanticCallees(result, definition.symbolId, callees, profiling, (count) => {
            definitionsWithCallees += 1;
            calleeCount += count;
          });
        }
      }

      for (const { provider, definition } of scalarDefinitions) {
        const callees = provider.calleesFor(definition);
        recordSemanticCallees(result, definition.symbolId, callees, profiling, (count) => {
          definitionsWithCallees += 1;
          calleeCount += count;
        });
      }
      return result;
    },
    () => ({
      definitions: definitions.length,
      providerHits,
      providerMisses,
      definitionsWithCallees,
      calleeCount,
      rows: result.size,
    }),
  );
}

function recordSemanticCallees(
  result: Map<number, SemanticCallee[]>,
  symbolId: number,
  callees: SemanticCallee[],
  profiling: boolean,
  recordProfileHit: (calleeCount: number) => void,
): void {
  if (callees.length > 0) {
    result.set(symbolId, callees);
    if (profiling) recordProfileHit(callees.length);
  }
}

// scip-query: ignore-wrapper — legacy semantic helper kept for source-compatible callers; the product owns access.
export function semanticSignature(db: ScipDatabase, definition: IndexedDefinition): string | null {
  return semanticEvidenceProduct(db).signature(definition);
}

function buildSemanticSignature(db: ScipDatabase, definition: IndexedDefinition): string | null {
  if (semanticProviderLanguageForPath(definition.relativePath) === 'typescript') {
    let state = 'fallback';
    let eligible = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    let fallbacks = 0;
    return profileSpan(
      'typescript.signature.materialize',
      () => {
        const identity = typeScriptSemanticIdentityForFile(db, definition.relativePath, TYPESCRIPT_SIGNATURE_SCHEMA);
        if (identity?.key) {
          eligible = 1;
          const cached = TYPESCRIPT_SIGNATURE_CACHE.read(db, definition.relativePath, identity.key) ?? {};
          if (Object.prototype.hasOwnProperty.call(cached, definition.symbol)) {
            state = 'hit';
            cacheHits = 1;
            return cached[definition.symbol] ?? null;
          }
          cacheMisses = 1;
          const provider = availableSemanticProvider(db, definition.relativePath);
          if (!provider) {
            state = 'unavailable';
            return null;
          }
          const signature = provider.signatureFor(definition);
          TYPESCRIPT_SIGNATURE_CACHE.write(db, definition.relativePath, identity.key, {
            ...cached,
            [definition.symbol]: signature,
          });
          state = 'computed';
          return signature;
        }
        fallbacks = 1;
        const provider = availableSemanticProvider(db, definition.relativePath);
        if (!provider) {
          state = 'unavailable';
          return null;
        }
        state = 'direct-fallback';
        return provider.signatureFor(definition);
      },
      () => ({ state, eligible, cacheHits, cacheMisses, fallbacks }),
    );
  }
  const cacheFingerprint = semanticProjectSlotCacheFingerprint(db, 'semantic-signatures', definition.relativePath);
  const cacheKey = semanticSignatureCacheKey(definition);
  if (cacheFingerprint) {
    const cached = RUST_SEMANTIC_SIGNATURE_CACHE.read(db, cacheKey, cacheFingerprint);
    if (cached) return cached.signature;
  }
  const provider = availableSemanticProvider(db, definition.relativePath);
  if (!provider) return null;
  const signature = provider.signatureFor(definition);
  if (cacheFingerprint) RUST_SEMANTIC_SIGNATURE_CACHE.write(db, cacheKey, cacheFingerprint, { signature });
  return signature;
}

function semanticProjectSlotCacheFingerprint(
  db: ScipDatabase,
  slot: 'semantic-import-usage' | 'semantic-signatures',
  relativePath: string,
): string | null {
  const projectFingerprint = projectEvidenceFingerprint(db);
  if (!projectFingerprint) return null;
  const language = semanticProviderLanguageForPath(relativePath);
  if (language !== 'rust') return null;
  return sha256Hex(
    JSON.stringify({
      kind: slot,
      language,
      engine: rustSemanticEngineIdentity(db.config.projectRoot),
      projectFingerprint,
    }),
  );
}

function semanticSignatureCacheKey(definition: IndexedDefinition): string {
  return `${definition.relativePath}\0${definition.symbol}`;
}

function parseCachedImportUsage(payload: string): SemanticImportUsage[] | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return Array.isArray(parsed) ? (parsed as SemanticImportUsage[]) : null;
  } catch {
    return null;
  }
}

function parseCachedSignature(payload: string): CachedSemanticSignature | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const signature = (parsed as { signature?: unknown }).signature;
    if (signature !== null && typeof signature !== 'string') return null;
    return { signature };
  } catch {
    return null;
  }
}

function parseCachedSignatureMap(payload: string): Record<string, string | null> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    for (const value of Object.values(parsed)) {
      if (value !== null && typeof value !== 'string') return null;
    }
    return parsed as Record<string, string | null>;
  } catch {
    return null;
  }
}

function semanticEvidenceCapability(
  db: ScipDatabase,
  slot: SemanticEvidenceSlot,
  relativePath?: string,
): SemanticEvidenceCapability {
  const language = semanticProviderLanguageForPath(relativePath);
  if (!language) {
    return {
      slot,
      language: 'typescript',
      available: false,
      reason: 'semantic evidence is only available for TypeScript or Rust files',
    };
  }
  try {
    return {
      slot,
      language,
      ...getSemanticProvider(db, relativePath).availability(),
    };
  } catch (error) {
    return {
      slot,
      language,
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function availableSemanticProvider(db: ScipDatabase, relativePath: string): SemanticProvider | null {
  if (!semanticProviderLanguageForPath(relativePath)) return null;
  const provider = getSemanticProvider(db, relativePath);
  return provider.availability().available ? provider : null;
}
