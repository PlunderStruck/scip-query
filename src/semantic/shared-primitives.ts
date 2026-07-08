import type { IndexedDefinition, SymbolMatch } from '../domain/types.js';
import type { ScipDatabase } from '../storage/db.js';
import {
  projectEvidenceFingerprint,
  readCachedSemanticReferences,
  sha256Hex,
  writeCachedSemanticReferencesBatch,
  type SemanticReferenceCacheEntry,
} from '../storage/evidence-cache.js';
import { createProjectEvidenceProduct, evidenceProductInvalidation } from '../storage/evidence-products.js';
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
  cacheHits: number;
  misses: number;
  unkeyed: number;
  skippedUnsupportedLanguage: number;
  parseFailures: number;
  computed: number;
  cacheWrites: number;
}

export interface SemanticEvidenceProduct {
  capability(slot: SemanticEvidenceSlot, relativePath?: string): SemanticEvidenceCapability;
  importUsage(file: string): SemanticImportUsage[];
  references(definition: IndexedDefinition): SemanticReference[];
  materializeReferences(definitions: ReadonlyArray<IndexedDefinition>): SemanticReferenceMaterializationResult;
  callerMap(definitions: ReadonlyArray<IndexedDefinition>): Map<number, Set<string>>;
  calleeMap(definitions: ReadonlyArray<IndexedDefinition | SymbolMatch>): Map<number, SemanticCallee[]>;
  signature(definition: IndexedDefinition): string | null;
}

interface CachedSemanticSignature {
  signature: string | null;
}

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

export function semanticEvidenceProduct(db: ScipDatabase): SemanticEvidenceProduct {
  const materializedReferences = new Map<number, SemanticReference[]>();
  return {
    capability: (slot, relativePath) => semanticEvidenceCapability(db, slot, relativePath),
    importUsage: (file) => buildSemanticImportUsage(db, file),
    references: (definition) => buildSemanticReferences(db, definition),
    materializeReferences: (definitions) => materializeSemanticReferenceBatch(db, definitions, materializedReferences),
    callerMap: (definitions) => buildSemanticCallerMap(db, definitions, materializedReferences),
    calleeMap: (definitions) => buildSemanticCalleeMap(db, definitions),
    signature: (definition) => buildSemanticSignature(db, definition),
  };
}

// scip-query: ignore-wrapper — legacy semantic helper kept for source-compatible callers; the product owns access.
export function semanticImportUsage(db: ScipDatabase, file: string): SemanticImportUsage[] {
  return semanticEvidenceProduct(db).importUsage(file);
}

function buildSemanticImportUsage(db: ScipDatabase, file: string): SemanticImportUsage[] {
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

function buildSemanticCallerMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition>,
  materializedReferences = new Map<number, SemanticReference[]>(),
): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();
  const materialization = materializeSemanticReferenceBatch(db, definitions, materializedReferences);
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

  profileSpan(
    'semantic.references.cache-scan',
    () => {
      for (const definition of definitions) {
        if (materializedReferences.has(definition.symbolId)) {
          inMemoryHits += 1;
          continue;
        }
        const cacheFingerprint = semanticReferenceCacheFingerprint(db, projectFingerprint, definition.relativePath);
        if (!cacheFingerprint) {
          if (!semanticProviderLanguageForPath(definition.relativePath)) skippedUnsupportedLanguage += 1;
          unkeyed.push(definition);
          continue;
        }
        const cached = readCachedSemanticReferences(db, definition.relativePath, definition.symbol, cacheFingerprint);
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
    },
    () => ({
      definitions: definitions.length,
      skippedUnsupportedLanguage,
      cacheHits,
      parseFailures,
      misses: misses.length,
      unkeyed: unkeyed.length,
      inMemoryHits,
    }),
  );

  if (misses.length > 0 || unkeyed.length > 0) {
    const computeInput = [...unkeyed, ...misses.map((miss) => miss.definition)];
    const computed = profileSpan(
      'semantic.references.compute-misses',
      () => {
        const rows = semanticReferenceMap(db, computeInput);
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
  return {
    definitions: definitions.length,
    inMemoryHits,
    cacheHits,
    misses: misses.length,
    unkeyed: unkeyed.length,
    skippedUnsupportedLanguage,
    parseFailures,
    computed: computedRows,
    cacheWrites: cacheWrites.length,
  };
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
): Map<number, SemanticReference[]> {
  const profiling = profileEnabled();
  const result = new Map<number, SemanticReference[]>();
  let providerHits = 0;
  let providerMisses = 0;
  let definitionsWithReferences = 0;
  let referenceCount = 0;
  return profileSpan(
    'semantic.references.provider-loop',
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
        if (provider.referencesForDefinitions) {
          const bucket = bulkGroups.get(provider);
          if (bucket) bucket.push(definition);
          else bulkGroups.set(provider, [definition]);
        } else {
          scalarDefinitions.push({ provider, definition });
        }
      }

      for (const [provider, groupedDefinitions] of bulkGroups) {
        const referenceMap = provider.referencesForDefinitions!(groupedDefinitions);
        for (const definition of groupedDefinitions) {
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
