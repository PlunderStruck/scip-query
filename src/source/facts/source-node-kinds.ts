import type { SyntaxNode } from '../ast/ast-types.js';

// scip-query: ignore-wrapper — parsers expose three compatible comment node kinds behind this shared predicate.
export function isCommentNode(node: SyntaxNode): boolean {
  return node.type === 'comment' || node.type === 'line_comment' || node.type === 'block_comment';
}
