import type { IndexedDefinition } from '../../domain/types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { leafName } from '../../symbols/symbol-parser.js';
import { lineOf } from './semantic-locations.js';
import type { TsMorphModule } from './ts-morph-runtime.js';
import type { Node, SourceFile } from 'ts-morph';

export function definitionNodesForSourceFile(
  tsMorph: TsMorphModule,
  db: ScipDatabase,
  sourceFile: SourceFile,
  relativePath: string,
): Map<number, Node> {
  const definitionsByLeaf = definitionsByLeafForFile(db, relativePath);
  if (definitionsByLeaf.size === 0) return new Map();
  return matchDefinitionNodes(tsMorph, sourceFile, definitionsByLeaf);
}

function definitionsByLeafForFile(db: ScipDatabase, relativePath: string): Map<string, IndexedDefinition[]> {
  const definitionsByLeaf = new Map<string, IndexedDefinition[]>();
  for (const definition of getDefinitionsForFile(db, relativePath)) {
    const leaf = leafName(definition.symbol) ?? definition.leaf;
    if (!leaf) continue;
    let bucket = definitionsByLeaf.get(leaf);
    if (!bucket) {
      bucket = [];
      definitionsByLeaf.set(leaf, bucket);
    }
    bucket.push(definition);
  }
  return definitionsByLeaf;
}

function matchDefinitionNodes(
  tsMorph: TsMorphModule,
  sourceFile: SourceFile,
  definitionsByLeaf: ReadonlyMap<string, readonly IndexedDefinition[]>,
): Map<number, Node> {
  const nodes = new Map<number, Node>();
  const distanceBySymbolId = new Map<number, number>();
  sourceFile.forEachDescendant((node) => {
    for (const name of nodeNames(tsMorph, node)) {
      const definitions = definitionsByLeaf.get(name);
      if (!definitions) continue;
      const line = lineOf(sourceFile, node);
      for (const definition of definitions) {
        if (line < definition.startLine - 1 || line > definition.endLine + 1) continue;
        const distance = Math.abs(line - definition.startLine);
        const previous = distanceBySymbolId.get(definition.symbolId);
        if (previous !== undefined && previous <= distance) continue;
        distanceBySymbolId.set(definition.symbolId, distance);
        nodes.set(definition.symbolId, node);
      }
    }
  });
  return nodes;
}

function nodeNames(tsMorph: TsMorphModule, node: Node): string[] {
  const names: string[] = [];
  const add = (name: string | undefined): void => {
    if (name && !names.includes(name)) names.push(name);
  };
  if ('getNameNode' in node && typeof node.getNameNode === 'function') {
    const nameNode = (node as { getNameNode(): Node | undefined }).getNameNode();
    add(nameNode?.getText());
  }
  if ('getName' in node && typeof node.getName === 'function') {
    const got = (node as { getName(): string | undefined }).getName();
    add(got);
  }
  if (tsMorph.Node.isIdentifier(node)) add(node.getText());
  return names;
}
