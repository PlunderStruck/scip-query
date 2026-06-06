import type { IndexedDefinition, SymbolMatch } from '../domain/types.js';
import type { ScipDatabase } from '../storage/db.js';
import type { SemanticCallee, SemanticImportUsage, SemanticProvider, SemanticReference } from './types.js';
import { getSemanticProvider } from './provider-cache.js';

export function semanticImportUsage(
  db: ScipDatabase,
  file: string,
): SemanticImportUsage[] {
  const provider = availableTypeScriptProvider(db, file);
  if (!provider) return [];
  return provider.importUsage(file);
}

export function semanticReferences(
  db: ScipDatabase,
  definition: IndexedDefinition,
): SemanticReference[] {
  const provider = availableTypeScriptProvider(db, definition.relativePath);
  if (!provider) return [];
  return provider.referencesFor(definition);
}

export function semanticCallerMap(
  db: ScipDatabase,
  definitions: ReadonlyArray<IndexedDefinition>,
): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();
  for (const definition of definitions) {
    for (const reference of semanticReferences(db, definition)) {
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
  return result;
}

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

export function semanticSignature(
  db: ScipDatabase,
  definition: IndexedDefinition,
): string | null {
  const provider = availableTypeScriptProvider(db, definition.relativePath);
  if (!provider) return null;
  return provider.signatureFor(definition);
}

function availableTypeScriptProvider(db: ScipDatabase, relativePath: string): SemanticProvider | null {
  if (!isTypeScriptLike(relativePath)) return null;
  const provider = getSemanticProvider(db, relativePath);
  return provider.availability().available ? provider : null;
}

function isTypeScriptLike(relativePath: string): boolean {
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(relativePath);
}
