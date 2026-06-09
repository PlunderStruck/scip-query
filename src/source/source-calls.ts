import type { AstLanguage } from './ast-language.js';
import type { SyntaxNode } from './ast-types.js';

// scip-query: ignore-wrapper — source-facts owns the single tree walk; this
// helper owns the callsite-shape policy used during that walk.
export function callSiteForNode(node: SyntaxNode, language: AstLanguage) {
  const target = callTargetForNode(node, language);
  if (!target) return null;
  const leaf = extractCallLeaf(target);
  if (!leaf) return null;
  return {
    calleeLeaf: leaf,
    memberAccess: isMemberAccessTarget(target),
    line: node.startPosition.row,
  };
}

function callTargetForNode(node: SyntaxNode, language: AstLanguage): SyntaxNode | null {
  if (language === 'rust') {
    if (node.type === 'call_expression') {
      return node.childForFieldName('function') ?? node.namedChild(0);
    }
    if (node.type === 'macro_invocation') {
      return node.childForFieldName('macro') ?? node.namedChild(0);
    }
    return null;
  }

  if (language === 'python') {
    if (node.type !== 'call') return null;
    return node.childForFieldName('function') ?? node.namedChild(0);
  }

  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    if (node.type === 'call_expression') {
      return node.childForFieldName('function') ?? node.namedChild(0);
    }
    if (node.type === 'new_expression') {
      return node.childForFieldName('constructor') ?? node.namedChild(0);
    }
  }

  return null;
}

function isMemberAccessTarget(node: SyntaxNode): boolean {
  switch (node.type) {
    case 'field_expression':
    case 'member_expression':
    case 'attribute':
      return true;
    default:
      return false;
  }
}

export function extractCallLeaf(node: SyntaxNode): string | null {
  switch (node.type) {
    case 'identifier':
    case 'type_identifier':
    case 'property_identifier':
    case 'shorthand_property_identifier':
      return node.text;
    case 'field_expression':
    case 'member_expression':
    case 'attribute': {
      const last = node.namedChild(node.namedChildCount - 1);
      return last ? extractCallLeaf(last) : null;
    }
    case 'scoped_identifier': {
      const name = node.childForFieldName('name') ?? node.namedChild(node.namedChildCount - 1);
      return name ? extractCallLeaf(name) : null;
    }
    case 'super':
    case 'self':
    case 'this':
      return null;
    default:
      return null;
  }
}
