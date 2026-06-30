import type { IndexedDefinition, SymbolMatch } from '../domain/types.js';
import type { ScipDatabase } from '../storage/db.js';
import {
  projectEvidenceFingerprint,
  readCachedSemanticReferences,
  writeCachedSemanticReferencesBatch,
  type SemanticReferenceCacheEntry,
} from '../storage/evidence-cache.js';
import type {
  SemanticAvailability,
  SemanticCallee,
  SemanticImportUsage,
  SemanticProvider,
  SemanticReference,
} from './types.js';
import { getSemanticProvider } from './provider-cache.js';
import { isTypeScriptLike } from './typescript/source-kinds.js';
import { profileEnabled, profileSpan } from '../instrumentation/profile.js';

export type SemanticEvidenceSlot =
  | 'semantic-references'
  | 'semantic-callers'
  | 'semantic-callees'
  | 'semantic-import-usage'
  | 'semantic-signatures';

export interface SemanticEvidenceCapability extends SemanticAvailability {
  slot: SemanticEvidenceSlot;
  language: 'typescript';
}

export interface SemanticEvidenceProduct {
  capability(slot: SemanticEvidenceSlot, relativePath?: string): SemanticEvidenceCapability;
  importUsage(file: string): SemanticImportUsage[];
  references(definition: IndexedDefinition): SemanticReference[];
  callerMap(definitions: ReadonlyArray<IndexedDefinition>): Map<number, Set<string>>;
  calleeMap(definitions: ReadonlyArray<IndexedDefinition | SymbolMatch>): Map<number, SemanticCallee[]>;
  signature(definition: IndexedDefinition): string | null;
}

export function semanticEvidenceProduct(db: ScipDatabase): SemanticEvidenceProduct {
  return {
    capability: (slot, relativePath) => semanticEvidenceCapability(db, slot, relativePath),
    importUsage: (file) => buildSemanticImportUsage(db, file),
    references: (definition) => buildSemanticReferences(db, definition),
    callerMap: (definitions) => buildSemanticCallerMap(db, definitions),
    calleeMap: (definitions) => buildSemanticCalleeMap(db, definitions),
    signature: (definition) => buildSemanticSignature(db, definition),
  };
}

// scip-query: ignore-wrapper — legacy semantic helper kept for source-compatible callers; the product owns access.
export function semanticImportUsage(db: ScipDatabase, file: string): SemanticImportUsage[] {
  return semanticEvidenceProduct(db).importUsage(file);
}

function buildSemanticImportUsage(db: ScipDatabase, file: string): SemanticImportUsage[] {
  const provider = availableTypeScriptProvider(db, file);
  if (!provider) return [];
  return provider.importUsage(file);
}

// scip-query: ignore-wrapper — legacy semantic helper kept for source-compatible callers; the product owns access.
export function semanticReferences(db: ScipDatabase, definition: IndexedDefinition): SemanticReference[] {
  return semanticEvidenceProduct(db).references(definition);
}

function buildSemanticReferences(db: ScipDatabase, definition: IndexedDefinition): SemanticReference[] {
  const provider = availableTypeScriptProvider(db, definition.relativePath);
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
): Map<number, Set<string>> {
  const profiling = profileEnabled();
  const result = new Map<number, Set<string>>();
  const projectFingerprint = projectEvidenceFingerprint(db);
  const cacheWrites: SemanticReferenceCacheEntry[] = [];
  const misses: IndexedDefinition[] = [];
  const unkeyed: IndexedDefinition[] = [];
  let skippedNonTs = 0;
  let cacheHits = 0;
  let parseFailures = 0;
  let callerFiles = 0;

  profileSpan(
    'semantic.references.cache-scan',
    () => {
      for (const definition of definitions) {
        if (!projectFingerprint || !isTypeScriptLike(definition.relativePath)) {
          if (profiling && !isTypeScriptLike(definition.relativePath)) skippedNonTs += 1;
          unkeyed.push(definition);
          continue;
        }
        const cached = readCachedSemanticReferences(db, definition.relativePath, definition.symbol, projectFingerprint);
        if (cached !== null) {
          const references = parseCachedReferences(cached);
          if (references) {
            if (profiling) cacheHits += 1;
            callerFiles += recordCallerFilesFromReferences(db, result, definition, references);
            continue;
          }
          if (profiling) parseFailures += 1;
        }
        misses.push(definition);
      }
    },
    () => ({
      definitions: definitions.length,
      skippedNonTs,
      cacheHits,
      parseFailures,
      misses: misses.length,
      unkeyed: unkeyed.length,
      resultRows: result.size,
      callerFiles,
    }),
  );

  if (misses.length > 0 || unkeyed.length > 0) {
    const computeInput = [...unkeyed, ...misses];
    let computedRows = 0;
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
      callerFiles += recordCallerFilesFromReferences(db, result, definition, computed.get(definition.symbolId) ?? []);
    }
    if (projectFingerprint) {
      for (const definition of misses) {
        cacheWrites.push({
          relativePath: definition.relativePath,
          symbol: definition.symbol,
          projectFingerprint,
          payload: JSON.stringify(computed.get(definition.symbolId) ?? []),
        });
      }
    }
  }

  if (cacheWrites.length > 0) {
    const providerAvailable = semanticEvidenceCapability(db, 'semantic-references').available;
    if (providerAvailable) {
      profileSpan(
        'semantic.references.cache-write',
        () => writeCachedSemanticReferencesBatch(db, cacheWrites),
        () => ({ entries: cacheWrites.length }),
      );
    } else {
      profileSpan(
        'semantic.references.cache-write-skip',
        () => undefined,
        () => ({ reason: 'provider-unavailable', entries: cacheWrites.length }),
      );
    }
  }
  return result;
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
        const provider = availableTypeScriptProvider(db, definition.relativePath);
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
        const provider = availableTypeScriptProvider(db, definition.relativePath);
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
  const provider = availableTypeScriptProvider(db, definition.relativePath);
  if (!provider) return null;
  return provider.signatureFor(definition);
}

function semanticEvidenceCapability(
  db: ScipDatabase,
  slot: SemanticEvidenceSlot,
  relativePath?: string,
): SemanticEvidenceCapability {
  if (relativePath !== undefined && !isTypeScriptLike(relativePath)) {
    return {
      slot,
      language: 'typescript',
      available: false,
      reason: 'semantic evidence is only available for TypeScript files',
    };
  }
  try {
    return {
      slot,
      language: 'typescript',
      ...getSemanticProvider(db, relativePath).availability(),
    };
  } catch (error) {
    return {
      slot,
      language: 'typescript',
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function availableTypeScriptProvider(db: ScipDatabase, relativePath: string): SemanticProvider | null {
  if (!isTypeScriptLike(relativePath)) return null;
  const provider = getSemanticProvider(db, relativePath);
  return provider.availability().available ? provider : null;
}
