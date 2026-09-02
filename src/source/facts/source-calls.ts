import type { AstLanguage } from '../ast/ast-language.js';
import type { SyntaxNode } from '../ast/ast-types.js';
import type { CallSiteKind } from './source-fact-types.js';

// scip-query: ignore-wrapper — source-facts owns the single tree walk; this
// helper owns the callsite-shape policy used during that walk.
export function callSiteForNode(node: SyntaxNode, language: AstLanguage) {
  const target = callTargetForNode(node, language);
  if (!target) return null;
  const leaf = extractCallLeaf(target);
  if (!leaf) return null;
  const memberAccess = isMemberAccessTarget(target);
  return {
    kind: callSiteKindForNode(node),
    calleeLeaf: leaf,
    calleeQualifier: memberAccess ? memberAccessQualifier(target) : undefined,
    calleeText: target.text,
    memberAccess,
    line: node.startPosition.row,
  };
}

function callSiteKindForNode(node: SyntaxNode): CallSiteKind {
  if (JSX_ELEMENT_NODE_TYPES.has(node.type)) return 'jsx-render';
  return node.type === 'new_expression' ? 'new' : 'call';
}

const JSX_ELEMENT_NODE_TYPES = new Set(['jsx_opening_element', 'jsx_self_closing_element']);

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
    if (JSX_ELEMENT_NODE_TYPES.has(node.type)) {
      return jsxComponentTarget(node);
    }
  }

  return null;
}

/**
 * The name of a JSX element when it denotes a component the framework will
 * invoke: a capitalized identifier (`<Child />`) or a member expression
 * (`<Menu.Item />`). Lowercase tags are host elements and namespaced tags
 * (`<svg:rect />`) are never components.
 */
function jsxComponentTarget(node: SyntaxNode): SyntaxNode | null {
  const name = node.childForFieldName('name') ?? node.namedChild(0);
  if (!name) return null;
  if (name.type === 'member_expression' || name.type === 'nested_identifier') return name;
  if (name.type === 'identifier' || name.type === 'jsx_identifier') {
    return /^[A-Z]/.test(name.text) ? name : null;
  }
  return null;
}

function isMemberAccessTarget(node: SyntaxNode): boolean {
  switch (node.type) {
    case 'field_expression':
    case 'member_expression':
    case 'nested_identifier':
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
    case 'nested_identifier':
    case 'attribute': {
      const last = node.namedChild(node.namedChildCount - 1);
      return last ? extractCallLeaf(last) : null;
    }
    case 'jsx_identifier':
      return node.text;
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
