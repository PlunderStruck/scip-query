import { getReExports, getSourceImports } from '../../language-parsers/index.js';
import { getAst } from '../../source/ast/ast-core.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import type { IndexedDefinition } from '../../domain/types.js';

const MAX_OBJECT_RESOLUTION_DEPTH = 8;

/** Resolve a callable value through imports, re-exports, object members, and object spreads. */
export function resolveCallableExpression(
  db: ScipDatabase,
  sourceFile: string,
  expression: string,
): IndexedDefinition[] {
  return deduplicateDefinitions(resolveExpression(db, sourceFile, compactExpression(expression), 0, new Set()));
}

/** Resolve an object binding to its defining initializer. */
export function resolveObjectBinding(
  db: ScipDatabase,
  sourceFile: string,
  binding: string,
): Array<{ definition: IndexedDefinition; initializer: SyntaxNode }> {
  return resolveObject(db, sourceFile, binding, 0, new Set());
}

function resolveExpression(
  db: ScipDatabase,
  sourceFile: string,
  expression: string,
  depth: number,
  seen: Set<string>,
): IndexedDefinition[] {
  if (depth > MAX_OBJECT_RESOLUTION_DEPTH) return [];
  const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/u.exec(expression);
  if (member) return resolveMember(db, sourceFile, member[1]!, member[2]!, depth, seen);
  if (!/^[A-Za-z_$][\w$]*$/u.test(expression)) return [];
  return resolveExportedBinding(db, sourceFile, expression, depth, seen);
}

function resolveMember(
  db: ScipDatabase,
  sourceFile: string,
  base: string,
  member: string,
  depth: number,
  seen: Set<string>,
): IndexedDefinition[] {
  const results: IndexedDefinition[] = [];
  for (const object of resolveObject(db, sourceFile, base, depth + 1, new Set(seen))) {
    const initializer = unwrapExpression(object.initializer);
    for (const child of initializer.namedChildren) {
      if (child.type === 'pair') {
        const key = child.childForFieldName('key') ?? child.namedChild(0);
        if (propertyName(key) !== member) continue;
        const value = child.childForFieldName('value') ?? child.namedChild(1);
        if (value)
          results.push(
            ...resolveExpression(
              db,
              object.definition.relativePath,
              compactExpression(value.text),
              depth + 1,
              new Set(seen),
            ),
          );
        continue;
      }
      if (/(?:method|function)/u.test(child.type)) {
        const name = child.childForFieldName('name') ?? child.namedChild(0);
        if (name?.text !== member) continue;
        const indexed = definitionsCoveringNode(db, object.definition.relativePath, member, child);
        results.push(...(indexed.length > 0 ? indexed : [sourceCallableDefinition(object.definition, member, child)]));
        continue;
      }
      if (child.type === 'spread_element') {
        const spread = child.namedChild(0);
        if (!spread) continue;
        for (const spreadObject of resolveObject(
          db,
          object.definition.relativePath,
          compactExpression(spread.text),
          depth + 1,
          new Set(seen),
        )) {
          results.push(
            ...resolveMember(
              db,
              spreadObject.definition.relativePath,
              spreadObject.definition.leaf,
              member,
              depth + 1,
              new Set(seen),
            ),
          );
        }
      }
    }
  }
  return deduplicateDefinitions(results);
}

function sourceCallableDefinition(owner: IndexedDefinition, leaf: string, node: SyntaxNode): IndexedDefinition {
  return {
    documentId: owner.documentId,
    symbolId: -1,
    symbol: `source-callable:${owner.relativePath}:${node.startPosition.row}:${leaf}`,
    relativePath: owner.relativePath,
    startLine: node.startPosition.row,
    startChar: node.startPosition.column,
    endLine: node.endPosition.row,
    endChar: node.endPosition.column,
    leaf,
    parentTypeName: owner.leaf,
    isFunctionLike: true,
    isTypeLike: false,
    kind: null,
    documentation: null,
    enclosingSymbol: owner.symbol,
  };
}

function resolveObject(
  db: ScipDatabase,
  sourceFile: string,
  binding: string,
  depth: number,
  seen: Set<string>,
): Array<{ definition: IndexedDefinition; initializer: SyntaxNode }> {
  if (depth > MAX_OBJECT_RESOLUTION_DEPTH || !/^[A-Za-z_$][\w$]*$/u.test(binding)) return [];
  return resolveExportedBinding(db, sourceFile, binding, depth, seen).flatMap((definition) => {
    const root = getAst(db, definition.relativePath)?.rootNode;
    const initializer = root ? findVariableInitializer(root, definition.leaf) : null;
    return initializer ? [{ definition, initializer }] : [];
  });
}

function resolveExportedBinding(
  db: ScipDatabase,
  sourceFile: string,
  binding: string,
  depth: number,
  seen: Set<string>,
): IndexedDefinition[] {
  if (depth > MAX_OBJECT_RESOLUTION_DEPTH) return [];
  const identity = `${sourceFile}\0${binding}`;
  if (seen.has(identity)) return [];
  seen.add(identity);

  const local = getDefinitionsForFile(db, sourceFile).filter((definition) => definition.leaf === binding);
  if (local.length > 0) return local;

  const imported = getSourceImports(db, sourceFile).find((item) => item.localName === binding && item.sourcePath);
  if (imported?.sourcePath) {
    const importedName =
      imported.kind === 'namespace' ? binding : imported.importedName === 'default' ? binding : imported.importedName;
    return resolveExportFromFile(db, imported.sourcePath, importedName, depth + 1, new Set(seen));
  }

  return resolveExportFromFile(db, sourceFile, binding, depth + 1, new Set(seen));
}

function resolveExportFromFile(
  db: ScipDatabase,
  sourceFile: string,
  exportedName: string,
  depth: number,
  seen: Set<string>,
): IndexedDefinition[] {
  if (depth > MAX_OBJECT_RESOLUTION_DEPTH) return [];
  const direct = getDefinitionsForFile(db, sourceFile).filter((definition) => definition.leaf === exportedName);
  if (direct.length > 0) return direct;
  return deduplicateDefinitions(
    getReExports(db, sourceFile).flatMap((reexport) => {
      if (!reexport.sourcePath) return [];
      if (reexport.kind === 'named' && !reexport.names.includes(exportedName)) return [];
      return resolveExportFromFile(db, reexport.sourcePath, exportedName, depth + 1, new Set(seen));
    }),
  );
}

function definitionsCoveringNode(db: ScipDatabase, file: string, leaf: string, node: SyntaxNode): IndexedDefinition[] {
  return getDefinitionsForFile(db, file).filter(
    (definition) =>
      definition.leaf === leaf &&
      definition.startLine <= node.startPosition.row &&
      definition.endLine >= node.endPosition.row,
  );
}

function findVariableInitializer(root: SyntaxNode, name: string): SyntaxNode | null {
  let result: SyntaxNode | null = null;
  walk(root, (node) => {
    if (result || node.type !== 'variable_declarator') return;
    const declared = node.childForFieldName('name') ?? node.namedChild(0);
    if (declared?.text.trim() !== name) return;
    result = node.childForFieldName('value') ?? node.namedChild(1);
  });
  return result;
}

function unwrapExpression(input: SyntaxNode): SyntaxNode {
  let node = input;
  while (
    ['as_expression', 'satisfies_expression', 'type_assertion', 'parenthesized_expression'].includes(node.type) &&
    node.namedChildren.length > 0
  ) {
    node = node.namedChildren[0]!;
  }
  return node;
}

function propertyName(node: SyntaxNode | null | undefined): string | null {
  return node?.text.replace(/^['"`]|['"`]$/gu, '') ?? null;
}

function compactExpression(value: string): string {
  return value.replace(/\s+/gu, '').replace(/^\.\.\./u, '');
}

function deduplicateDefinitions(values: readonly IndexedDefinition[]): IndexedDefinition[] {
  return [...new Map(values.map((value) => [value.symbol, value])).values()];
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}
