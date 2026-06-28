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
  const result = new Map<number, SemanticCallee[]>();
  for (const definition of definitions) {
    const provider = availableTypeScriptProvider(db, definition.relativePath);
    if (!provider) continue;
    const callees = provider.calleesFor(definition as IndexedDefinition);
    if (callees.length > 0) result.set(definition.symbolId, callees);
  }
  return result;
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
