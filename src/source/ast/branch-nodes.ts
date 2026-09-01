import type { SyntaxNode } from './ast-types.js';

/**
 * Syntax nodes that open a branch for cyclomatic estimates. Shared by the
 * source-facts extractor, which counts them once per file while it already
 * walks the tree, and by the complexity query, which uses the persisted count
 * and parses only when no fact covers a definition.
 */
export const AST_BRANCH_NODE_TYPES: ReadonlySet<string> = new Set([
  'if_statement',
  'conditional_expression',
  'ternary_expression',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'while_statement',
  'do_statement',
  'switch_case',
  'case_statement',
  'catch_clause',
  'except_clause',
  'elif_clause',
  'match_arm',
]);

export function branchContribution(current: SyntaxNode): number {
  if (AST_BRANCH_NODE_TYPES.has(current.type)) return 1;

  if (
    current.type === 'binary_expression' &&
    current.parent?.type !== 'binary_expression' &&
    (current.text.includes('&&') || current.text.includes('||'))
  ) {
    return countBooleanOperators(current.text);
  }

  return 0;
}

export function countBooleanOperators(text: string): number {
  return (text.match(/&&|\|\|/g) ?? []).length;
}
