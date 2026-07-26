import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { Identifier, Node, ReferencedSymbol, SourceFile } from 'ts-morph';
import type { IndexedDefinition } from '../../domain/types.js';
import { escapeRegex as escapeRegExp } from '../../source/primitives/regex-utils.js';
import type { SemanticLocation, SemanticReference } from '../types.js';

function referenceLocations(ref: ReferencedSymbol, projectRoot: string): SemanticReference[] {
  return ref.getReferences().map((entry) => {
    const node = entry.getNode();
    return toSemanticLocation(node, projectRoot);
  });
}

function findReferencesForNode(node: Node): ReferencedSymbol[] {
  const maybeReferenceable = node as Node & { findReferences?: () => ReferencedSymbol[] };
  if (typeof maybeReferenceable.findReferences === 'function') {
    return maybeReferenceable.findReferences();
  }
  return [];
}

export function semanticReferencesForNode(
  node: Node,
  definition: IndexedDefinition,
  packageRefs: readonly SemanticReference[],
  projectRoot: string,
): SemanticReference[] {
  const locations: SemanticReference[] = [];
  for (const ref of findReferencesForNode(node)) {
    for (const location of referenceLocations(ref, projectRoot)) {
      if (
        location.file === definition.relativePath &&
        location.line >= definition.startLine &&
        location.line <= definition.endLine
      ) {
        continue;
      }
      locations.push(location);
    }
  }
  for (const location of packageRefs) locations.push(location);
  return dedupeLocations(locations);
}

export function referenceLocationsWithoutDeclaration(
  ref: ReferencedSymbol,
  importer: string,
  declarationIdentifier: Identifier | null,
  projectRoot: string,
): Array<{ location: SemanticLocation; node: Node }> {
  const out: Array<{ location: SemanticLocation; node: Node }> = [];
  const declarationStart = declarationIdentifier?.getStart();
  for (const entry of ref.getReferences()) {
    const node = entry.getNode();
    if (toRelative(projectRoot, node.getSourceFile().getFilePath()) !== importer) continue;
    if (declarationStart !== undefined && node.getStart() === declarationStart) continue;
    out.push({ location: toSemanticLocation(node, projectRoot), node });
  }
  return out;
}

export function toSemanticLocation(node: Node, projectRoot: string): SemanticLocation {
  const sourceFile = node.getSourceFile();
  const pos = sourceFile.getLineAndColumnAtPos(node.getStart());
  return {
    file: toRelative(projectRoot, sourceFile.getFilePath()) ?? sourceFile.getBaseName(),
    line: pos.line - 1,
    column: pos.column - 1,
  };
}

export function textualIdentifierLocations(
  identifier: Identifier,
  importer: string,
  projectRoot: string,
): SemanticReference[] {
  const sourceFile = identifier.getSourceFile();
  const declarationLine = lineOf(sourceFile, identifier);
  const name = identifier.getText();
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
  const lines = sourceFile.getFullText().split('\n');
  const locations: SemanticReference[] = [];

  for (let line = 0; line < lines.length; line++) {
    if (line === declarationLine) continue;
    const text = lines[line] ?? '';
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      locations.push({
        file: importer,
        line,
        column: match.index,
      });
    }
  }

  return dedupeLocations(
    locations.filter((location) => toRelative(projectRoot, path.join(projectRoot, location.file)) === importer),
  );
}

export function isTypeOnlyLocation(node: Node): boolean {
  for (let current: Node | undefined = node; current; current = current.getParent()) {
    const kind = current.getKindName();
    if (kind.includes('Type') || kind === 'InterfaceDeclaration' || kind === 'TypeAliasDeclaration') return true;
    if (kind === 'CallExpression' || kind === 'NewExpression' || kind === 'ExpressionStatement') return false;
  }
  return false;
}

export function lineOf(sourceFile: SourceFile, node: Node): number {
  return sourceFile.getLineAndColumnAtPos(node.getStart()).line - 1;
}

export function dedupeLocations(locations: SemanticReference[]): SemanticReference[] {
  const seen = new Set<string>();
  const out: SemanticReference[] = [];
  for (const location of locations) {
    const key = `${location.file}:${location.line}:${location.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(location);
  }
  return out;
}

export function toRelative(root: string, fullPath: string): string | null {
  const anchor = root || process.cwd();
  const direct = safeRelativePath(anchor, fullPath);
  if (direct) return direct;
  try {
    return safeRelativePath(realpathSync(anchor), realpathSync(fullPath));
  } catch {
    return null;
  }
}

function safeRelativePath(root: string, fullPath: string): string | null {
  const relative = path.relative(root, fullPath).replace(/\\/g, '/');
  return !relative || relative === '..' || relative.startsWith('../') ? null : relative;
}
