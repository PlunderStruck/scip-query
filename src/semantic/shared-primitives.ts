import type { IndexedDefinition, SymbolMatch } from '../domain/types.js';
import type { ScipDatabase } from '../storage/db.js';
import {
  projectEvidenceFingerprint,
  readCachedSemanticReferences,
  writeCachedSemanticReferencesBatch,
  type SemanticReferenceCacheEntry,
} from '../storage/evidence-cache.js';
import type { SemanticCallee, SemanticImportUsage, SemanticProvider, SemanticReference } from './types.js';
import { getSemanticProvider } from './provider-cache.js';
import { isTypeScriptLike } from './typescript/source-kinds.js';
import { profileEnabled, profileSpan } from '../runtime/profile.js';

export function semanticImportUsage(db: ScipDatabase, file: string): SemanticImportUsage[] {
  const provider = availableTypeScriptProvider(db, file);
  if (!provider) return [];
  return provider.importUsage(file);
}

export function semanticReferences(db: ScipDatabase, definition: IndexedDefinition): SemanticReference[] {
  const provider = availableTypeScriptProvider(db, definition.relativePath);
  if (!provider) return [];
  return provider.referencesFor(definition);
}

export function semanticCallerMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition>,
): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();
  const projectFingerprint = projectEvidenceFingerprint(db);
  const cacheWrites: SemanticReferenceCacheEntry[] = [];
  for (const definition of definitions) {
    const references = semanticReferencesForCallerMap(db, definition, projectFingerprint, cacheWrites);
    for (const reference of references) {
      if (reference.file === definition.relativePath) continue;
      if (db.isIgnored(reference.file)) continue;
      let bucket = result.get(definition.symbolId);
      if (!bucket) {
        bucket = new Set();
        result.set(definition.symbolId, bucket);
      }
      bucket.add(reference.file);
    }
  }
  if (cacheWrites.length > 0 && getSemanticProvider(db).availability().available) {
    writeCachedSemanticReferencesBatch(db, cacheWrites);
  }
  return result;
}

function semanticReferencesForCallerMap(
  db: ScipDatabase,
  definition: IndexedDefinition,
  projectFingerprint: string | null,
  cacheWrites: SemanticReferenceCacheEntry[],
): SemanticReference[] {
  if (!projectFingerprint || !isTypeScriptLike(definition.relativePath)) {
    return semanticReferences(db, definition);
  }
  const cached = readCachedSemanticReferences(db, definition.relativePath, definition.symbol, projectFingerprint);
  if (cached !== null) {
    const references = parseCachedReferences(cached);
    if (references) return references;
  }
  const references = semanticReferences(db, definition);
  cacheWrites.push({
    relativePath: definition.relativePath,
    symbol: definition.symbol,
    projectFingerprint,
    payload: JSON.stringify(references),
  });
  return references;
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

export function semanticSignature(db: ScipDatabase, definition: IndexedDefinition): string | null {
  const provider = availableTypeScriptProvider(db, definition.relativePath);
  if (!provider) return null;
  return provider.signatureFor(definition);
}

function availableTypeScriptProvider(db: ScipDatabase, relativePath: string): SemanticProvider | null {
  if (!isTypeScriptLike(relativePath)) return null;
  const provider = getSemanticProvider(db, relativePath);
  return provider.availability().available ? provider : null;
}
