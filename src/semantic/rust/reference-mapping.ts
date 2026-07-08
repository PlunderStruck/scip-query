import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { IndexedDefinition } from '../../domain/types.js';
import type { SemanticReference } from '../types.js';
import type { LspLocation, LspPosition, LspReferenceParams } from './lsp-types.js';

export function filePathToDocumentUri(projectRoot: string, relativePath: string): string {
  return pathToFileURL(resolve(projectRoot, relativePath)).href;
}

export function documentUriToRelativePath(projectRoot: string, uri: string): string {
  const absolutePath = fileURLToPath(uri);
  return relative(projectRoot, absolutePath).split(sep).join('/');
}

export function definitionToReferenceParams(
  projectRoot: string,
  definition: IndexedDefinition,
  includeDeclaration: boolean,
): LspReferenceParams {
  return {
    textDocument: { uri: filePathToDocumentUri(projectRoot, definition.relativePath) },
    position: referencePositionForDefinition(projectRoot, definition),
    context: { includeDeclaration },
  };
}

export function referencePositionForDefinition(projectRoot: string, definition: IndexedDefinition): LspPosition {
  const fallback = {
    line: definition.startLine,
    character: definition.startChar ?? 0,
  };
  const sourcePath = resolve(projectRoot, definition.relativePath);
  if (!existsSync(sourcePath)) return fallback;

  try {
    return referencePositionFromSource(readFileSync(sourcePath, 'utf8'), definition, fallback);
  } catch {
    return fallback;
  }
}

export function referencePositionFromSource(
  source: string,
  definition: IndexedDefinition,
  fallback: LspPosition = { line: definition.startLine, character: definition.startChar ?? 0 },
): LspPosition {
  const lines = source.split(/\r?\n/);
  const line = lines[definition.startLine];
  if (line === undefined || definition.leaf.length === 0) return fallback;

  const startAt = Math.max(0, Math.min(fallback.character, line.length));
  const leafColumn = line.indexOf(definition.leaf, startAt);
  if (leafColumn >= 0)
    return { line: definition.startLine, character: characterInsideLeaf(leafColumn, definition.leaf) };

  const anyLeafColumn = line.indexOf(definition.leaf);
  if (anyLeafColumn >= 0)
    return { line: definition.startLine, character: characterInsideLeaf(anyLeafColumn, definition.leaf) };

  const nearby = nearbyLeafPosition(lines, definition.startLine, definition.leaf);
  if (nearby) return nearby;

  return fallback;
}

function characterInsideLeaf(leafColumn: number, leaf: string): number {
  return leafColumn + Math.max(0, leaf.length - 2);
}

function nearbyLeafPosition(lines: readonly string[], startLine: number, leaf: string): LspPosition | null {
  for (const offset of [-1, 1, -2, 2]) {
    const lineNumber = startLine + offset;
    if (lineNumber < 0 || lineNumber >= lines.length) continue;
    const leafColumn = lines[lineNumber]!.indexOf(leaf);
    if (leafColumn >= 0) return { line: lineNumber, character: characterInsideLeaf(leafColumn, leaf) };
  }
  return null;
}

export function locationsToSemanticReferences(
  projectRoot: string,
  locations: readonly LspLocation[],
): SemanticReference[] {
  return locations.map((location) => ({
    file: documentUriToRelativePath(projectRoot, location.uri),
    line: location.range.start.line,
    column: location.range.start.character,
  }));
}

export function dedupeSemanticReferences(references: readonly SemanticReference[]): SemanticReference[] {
  const byKey = new Map<string, SemanticReference>();
  for (const reference of references) {
    byKey.set(`${reference.file}\0${reference.line}\0${reference.column}`, reference);
  }
  return [...byKey.values()].sort((a, b) => {
    const fileOrder = a.file.localeCompare(b.file);
    if (fileOrder !== 0) return fileOrder;
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });
}
