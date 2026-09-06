import type { ts } from 'ts-morph';
import type { IndexedDefinition } from '../../domain/types.js';

/** Match declarations once, then stop each invocation at its nearest function. */
export function compilerCallOwnerLookup(
  compiler: typeof ts,
  sourceFile: ts.SourceFile,
  definitions: readonly IndexedDefinition[],
): (node: ts.Node) => IndexedDefinition | undefined {
  const owners = new Map<ts.Node, IndexedDefinition>();
  const assigned = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (compiler.isFunctionLike(node)) {
      const declaration = callableDeclaration(compiler, node);
      const nameNode = (declaration as ts.NamedDeclaration).name;
      const name =
        nameNode?.getText(sourceFile) ?? (compiler.isConstructorDeclaration(node) ? 'constructor' : undefined);
      const position = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile));
      const matches = definitions.filter(
        (definition) =>
          !assigned.has(definition.symbolId) && definition.leaf === name && containsPosition(definition, position),
      );
      if (matches.length === 1) {
        owners.set(node, matches[0]!);
        assigned.add(matches[0]!.symbolId);
      }
    }
    compiler.forEachChild(node, visit);
  };
  visit(sourceFile);
  return (node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (compiler.isFunctionLike(parent)) return owners.get(parent);
    }
    return undefined;
  };
}

/** A function value inherits a name only from its direct binding or property. */
function callableDeclaration(compiler: typeof ts, node: ts.Node): ts.Node {
  if (!compiler.isArrowFunction(node) && !compiler.isFunctionExpression(node)) return node;
  let declaration: ts.Node = node;
  while (declaration.parent && isDeclarationWrapper(compiler, declaration.parent)) declaration = declaration.parent;
  const parent = declaration.parent;
  if (
    parent &&
    (compiler.isVariableDeclaration(parent) ||
      compiler.isPropertyDeclaration(parent) ||
      compiler.isPropertyAssignment(parent)) &&
    parent.initializer === declaration
  )
    return parent;
  return node;
}

function isDeclarationWrapper(compiler: typeof ts, node: ts.Node): boolean {
  return (
    compiler.isParenthesizedExpression(node) || compiler.isAsExpression(node) || compiler.isSatisfiesExpression(node)
  );
}

function containsPosition(definition: IndexedDefinition, position: ts.LineAndCharacter): boolean {
  if (position.line < definition.startLine || position.line > definition.endLine) return false;
  if (position.line === definition.startLine && position.character < (definition.startChar ?? 0)) return false;
  return position.line !== definition.endLine || position.character <= (definition.endChar ?? Infinity);
}
