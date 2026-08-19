import type { AstLanguage } from './ast-language.js';
import type { SyntaxNode } from './ast-types.js';

const RUST_CALLABLE_NODE_TYPES = new Set(['function_item', 'function_signature_item']);
const PYTHON_CALLABLE_NODE_TYPES = new Set(['function_definition']);
const JAVASCRIPT_LIKE_CALLABLE_NODE_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
]);

/**
 * Callable body nodes for AST walks that index a function-like node by range.
 *
 * This intentionally excludes variable declarators and public fields: those
 * query-shaped definitions need name binding and stay in `ast-facts.ts`.
 */
export function callableBodyNodeTypesForLanguage(lang: AstLanguage): ReadonlySet<string> {
  switch (lang) {
    case 'rust':
      return RUST_CALLABLE_NODE_TYPES;
    case 'python':
      return PYTHON_CALLABLE_NODE_TYPES;
    default:
      return JAVASCRIPT_LIKE_CALLABLE_NODE_TYPES;
  }
}

/** Visit a syntax node and every named descendant. */
export function walkNamedSyntax(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walkNamedSyntax(child, visit);
}

/** Smallest function-like node whose range covers `[startLine, endLine]`. */
export function smallestCoveringCallable(root: SyntaxNode, startLine: number, endLine: number): SyntaxNode | null {
  let match: SyntaxNode | null = null;
  walkNamedSyntax(root, (node) => {
    if (!/(?:function|method|lambda)/u.test(node.type) && node.type !== 'arrow_function') return;
    if (node.startPosition.row > startLine || node.endPosition.row < endLine) return;
    if (!match || node.endIndex - node.startIndex < match.endIndex - match.startIndex) match = node;
  });
  return match;
}

/** Innermost named node whose range covers `[startLine, endLine]`. */
export function smallestNodeCoveringLines(node: SyntaxNode, startLine: number, endLine: number): SyntaxNode | null {
  if (node.startPosition.row > startLine || node.endPosition.row < endLine) return null;
  for (const child of node.namedChildren) {
    const match = smallestNodeCoveringLines(child, startLine, endLine);
    if (match) return match;
  }
  return node;
}

export function unwrapExpression(input: SyntaxNode): SyntaxNode {
  let node = input;
  while (
    ['as_expression', 'satisfies_expression', 'type_assertion', 'parenthesized_expression'].includes(node.type) &&
    node.namedChildren.length > 0
  ) {
    node = node.namedChildren[0]!;
  }
  return node;
}

export function parameterName(node: SyntaxNode): string | null {
  if (node.type === 'identifier') return node.text;
  const named = node.childForFieldName('name') ?? node.childForFieldName('pattern');
  if (named) return parameterName(named);
  return node.namedChildren.find((child) => child.type === 'identifier')?.text ?? null;
}

export function callableParameterNames(callable: SyntaxNode): Array<string | null> {
  const parameters =
    callable.childForFieldName('parameters') ?? callable.namedChildren.find((child) => /parameters/u.test(child.type));
  return parameters?.namedChildren.map(parameterName) ?? [];
}
