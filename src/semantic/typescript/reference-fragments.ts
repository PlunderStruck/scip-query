import type { IndexedDefinition } from '../../domain/types.js';
import type { SemanticReference, SemanticReferenceFragment } from '../types.js';

export interface ReferenceFragmentParity {
  passed: boolean;
  expectedCount: number;
  actualCount: number;
  missing: string[];
  extra: string[];
  callerFiles: ReferenceCallerFileParity;
}

export interface ReferenceCallerFileParity {
  passed: boolean;
  expectedCount: number;
  actualCount: number;
  missing: string[];
  extra: string[];
}

export function assembleReferenceFragments(
  definitions: readonly IndexedDefinition[],
  fragmentsByFile: ReadonlyMap<string, readonly SemanticReferenceFragment[]>,
): Map<number, SemanticReference[]> {
  const definitionsBySymbol = new Map(definitions.map((definition) => [definition.symbol, definition]));
  const result = new Map(definitions.map((definition) => [definition.symbolId, [] as SemanticReference[]]));
  for (const fragments of fragmentsByFile.values()) {
    for (const fragment of fragments) {
      const definition = definitionsBySymbol.get(fragment.targetSymbol);
      if (!definition) continue;
      result.get(definition.symbolId)!.push(fragment.location);
    }
  }
  for (const [symbolId, references] of result) result.set(symbolId, dedupeSortedReferences(references));
  return result;
}

export function compareReferenceFragmentMaps(
  definitions: readonly IndexedDefinition[],
  expected: ReadonlyMap<number, readonly SemanticReference[]>,
  actual: ReadonlyMap<number, readonly SemanticReference[]>,
): ReferenceFragmentParity {
  const expectedFacts = referenceFactSet(definitions, expected);
  const actualFacts = referenceFactSet(definitions, actual);
  const missing = [...expectedFacts].filter((fact) => !actualFacts.has(fact)).sort();
  const extra = [...actualFacts].filter((fact) => !expectedFacts.has(fact)).sort();
  const expectedCallerFiles = referenceCallerFileFactSet(definitions, expected);
  const actualCallerFiles = referenceCallerFileFactSet(definitions, actual);
  const missingCallerFiles = [...expectedCallerFiles].filter((fact) => !actualCallerFiles.has(fact)).sort();
  const extraCallerFiles = [...actualCallerFiles].filter((fact) => !expectedCallerFiles.has(fact)).sort();
  return {
    passed: missing.length === 0 && extra.length === 0,
    expectedCount: expectedFacts.size,
    actualCount: actualFacts.size,
    missing,
    extra,
    callerFiles: {
      passed: missingCallerFiles.length === 0 && extraCallerFiles.length === 0,
      expectedCount: expectedCallerFiles.size,
      actualCount: actualCallerFiles.size,
      missing: missingCallerFiles,
      extra: extraCallerFiles,
    },
  };
}

function referenceCallerFileFactSet(
  definitions: readonly IndexedDefinition[],
  references: ReadonlyMap<number, readonly SemanticReference[]>,
): Set<string> {
  const facts = new Set<string>();
  for (const definition of definitions) {
    for (const reference of references.get(definition.symbolId) ?? []) {
      if (reference.file === definition.relativePath) continue;
      facts.add(`${definition.symbol}\0${reference.file}`);
    }
  }
  return facts;
}

export function referenceFragmentsFromDefinitionMap(
  definitions: readonly IndexedDefinition[],
  references: ReadonlyMap<number, readonly SemanticReference[]>,
  files: readonly string[],
): Map<string, SemanticReferenceFragment[]> {
  const requestedFiles = new Set(files);
  const result = new Map(files.map((file) => [file, [] as SemanticReferenceFragment[]]));
  for (const definition of definitions) {
    for (const location of references.get(definition.symbolId) ?? []) {
      if (!requestedFiles.has(location.file)) continue;
      result.get(location.file)!.push({ targetSymbol: definition.symbol, location });
    }
  }
  for (const [file, fragments] of result) result.set(file, dedupeSortedFragments(fragments));
  return result;
}

function referenceFactSet(
  definitions: readonly IndexedDefinition[],
  references: ReadonlyMap<number, readonly SemanticReference[]>,
): Set<string> {
  const facts = new Set<string>();
  for (const definition of definitions) {
    for (const reference of references.get(definition.symbolId) ?? []) {
      facts.add(`${definition.symbol}\0${reference.file}\0${reference.line}\0${reference.column}`);
    }
  }
  return facts;
}

function dedupeSortedReferences(references: readonly SemanticReference[]): SemanticReference[] {
  const byKey = new Map<string, SemanticReference>();
  for (const reference of references) {
    byKey.set(`${reference.file}\0${reference.line}\0${reference.column}`, reference);
  }
  return [...byKey.values()].sort(compareReferences);
}

function dedupeSortedFragments(fragments: readonly SemanticReferenceFragment[]): SemanticReferenceFragment[] {
  const byKey = new Map<string, SemanticReferenceFragment>();
  for (const fragment of fragments) {
    const { location } = fragment;
    byKey.set(`${fragment.targetSymbol}\0${location.file}\0${location.line}\0${location.column}`, fragment);
  }
  return [...byKey.values()].sort((left, right) => {
    const symbolOrder = left.targetSymbol.localeCompare(right.targetSymbol);
    return symbolOrder || compareReferences(left.location, right.location);
  });
}

function compareReferences(left: SemanticReference, right: SemanticReference): number {
  const fileOrder = left.file.localeCompare(right.file);
  return fileOrder || left.line - right.line || left.column - right.column;
}
