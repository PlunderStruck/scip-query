import type { AstLanguage } from '../ast/ast-language.js';
import type { SyntaxNode } from '../ast/ast-types.js';

// scip-query: ignore-wrapper — source-facts owns the single tree walk; this
// helper owns the callsite-shape policy used during that walk.
export function callSiteForNode(node: SyntaxNode, language: AstLanguage) {
  const target = callTargetForNode(node, language);
  if (!target) return null;
  const leaf = extractCallLeaf(target);
  if (!leaf) return null;
  const memberAccess = isMemberAccessTarget(target);
  return {
    calleeLeaf: leaf,
    calleeQualifier: memberAccess ? memberAccessQualifier(target) : undefined,
    calleeText: target.text,
    memberAccess,
    line: node.startPosition.row,
  };
}

function memberAccessQualifier(node: SyntaxNode): string | undefined {
  const receiver =
    node.childForFieldName('object') ?? node.childForFieldName('value') ?? node.namedChild(0) ?? undefined;
  return receiver?.text || undefined;
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
    case 'field_identifier':
    case 'property_identifier':
    case 'private_property_identifier':
    case 'shorthand_property_identifier':
      return node.text.replace(/^#/u, '');
    case 'field_expression':
    case 'member_expression':
    case 'attribute': {
      const last = node.namedChild(node.namedChildCount - 1);
      return last ? extractCallLeaf(last) : null;
    }
    case 'generic_function': {
      const target = node.childForFieldName('function') ?? node.namedChild(0);
      return target ? extractCallLeaf(target) : null;
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
