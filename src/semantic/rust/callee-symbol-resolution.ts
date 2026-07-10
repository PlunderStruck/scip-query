import type { IndexedDefinition } from '../../domain/types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import type { SemanticCallee } from '../types.js';

export function resolveRustCalleeSymbol(db: ScipDatabase, callee: SemanticCallee): string {
  return resolveRustCalleeSymbolFromIndex(createRustCalleeFileIndex(getDefinitionsForFile(db, callee.file)), callee);
}

export function createRustCalleeSymbolResolver(db: ScipDatabase): (callee: SemanticCallee) => string {
  const indexesByFile = new Map<string, RustCalleeFileIndex>();
  const projectDocuments = loadCalleeResolutionDocumentSet(db);
  const resolvedSymbolsByCallee = new Map<string, string>();
  return (callee) => {
    const key = calleeCacheKey(callee);
    const cached = resolvedSymbolsByCallee.get(key);
    if (cached !== undefined) return cached;

    if (!projectDocuments.has(callee.file)) {
      resolvedSymbolsByCallee.set(key, callee.symbol);
      return callee.symbol;
    }

    let index = indexesByFile.get(callee.file);
    if (!index) {
      index = createRustCalleeFileIndex(getDefinitionsForFile(db, callee.file));
      indexesByFile.set(callee.file, index);
    }
    const resolved = resolveRustCalleeSymbolFromIndex(index, callee);
    resolvedSymbolsByCallee.set(key, resolved);
    return resolved;
  };
}

function calleeCacheKey(callee: SemanticCallee): string {
  return `${callee.file}\0${callee.symbol}\0${callee.line}`;
}

function loadCalleeResolutionDocumentSet(db: ScipDatabase): ReadonlySet<string> {
  return new Set(
    db.all<{ relative_path: string }>('SELECT relative_path FROM documents').map((row) => row.relative_path),
  );
}

interface RustCalleeFileIndex {
  definitions: IndexedDefinition[];
  byLeaf: Map<string, IndexedDefinition[]>;
  byStartLine: Map<number, IndexedDefinition[]>;
}

function createRustCalleeFileIndex(definitions: IndexedDefinition[]): RustCalleeFileIndex {
  const byLeaf = new Map<string, IndexedDefinition[]>();
  const byStartLine = new Map<number, IndexedDefinition[]>();
  for (const definition of definitions) {
    const leafBucket = byLeaf.get(definition.leaf);
    if (leafBucket) leafBucket.push(definition);
    else byLeaf.set(definition.leaf, [definition]);

    const lineBucket = byStartLine.get(definition.startLine);
    if (lineBucket) lineBucket.push(definition);
    else byStartLine.set(definition.startLine, [definition]);
  }
  return { definitions, byLeaf, byStartLine };
}

function resolveRustCalleeSymbolFromIndex(index: RustCalleeFileIndex, callee: SemanticCallee): string {
  if (index.definitions.length === 0) return callee.symbol;
  const nameCandidates = rustCalleeNameCandidates(callee.symbol);
  const sameNameDefinitions = definitionsForNames(index.byLeaf, nameCandidates);
  const namedLineMatch = pickDefinitionAtLine(sameNameDefinitions, callee.line);
  if (namedLineMatch) return namedLineMatch.symbol;

  const sameLineDefinitions = index.byStartLine.get(callee.line) ?? [];
  if (sameLineDefinitions.length === 1) return sameLineDefinitions[0]!.symbol;

  return callee.symbol;
}

function definitionsForNames(
  byLeaf: ReadonlyMap<string, readonly IndexedDefinition[]>,
  names: ReadonlySet<string>,
): IndexedDefinition[] {
  const definitions: IndexedDefinition[] = [];
  const seen = new Set<number>();
  for (const name of names) {
    for (const definition of byLeaf.get(name) ?? []) {
      if (seen.has(definition.symbolId)) continue;
      seen.add(definition.symbolId);
      definitions.push(definition);
    }
  }
  return definitions;
}

function pickDefinitionAtLine(definitions: readonly IndexedDefinition[], line: number): IndexedDefinition | null {
  let smallestContaining: IndexedDefinition | null = null;
  for (const definition of definitions) {
    if (definition.startLine > line || definition.endLine < line) continue;
    if (definition.startLine === line) return definition;
    if (
      !smallestContaining ||
      definition.endLine - definition.startLine < smallestContaining.endLine - smallestContaining.startLine
    ) {
      smallestContaining = definition;
    }
  }
  return smallestContaining;
}

function rustCalleeNameCandidates(name: string): Set<string> {
  const candidates = new Set([name]);
  const parts = name.split(/::|\.|#/).filter(Boolean);
  const last = parts.at(-1);
  if (last) candidates.add(last);
  return candidates;
}
