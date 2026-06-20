import type { SyntaxNode } from './ast/ast-types.js';

export function isCommentNode(node: SyntaxNode): boolean {
  return node.type === 'comment' || node.type === 'line_comment' || node.type === 'block_comment';
}
