import type { AstLanguage } from '../ast/ast-language.js';
import type { SyntaxNode } from '../ast/ast-types.js';
import type { CallSiteKind } from './source-fact-types.js';
import { callSiteOwner } from './source-callables.js';

// scip-query: ignore-wrapper — source-facts owns the single tree walk; this
// helper owns the callsite-shape policy used during that walk.
export function callSiteForNode(node: SyntaxNode, language: AstLanguage) {
  const target = callTargetForNode(node, language);
  if (!target) return null;
  const leafNode = callLeafNode(target);
  if (!leafNode) return null;
  const leaf = leafNode.text.replace(/^#/u, '');
  const memberAccess = isMemberAccessTarget(target);
  return {
    kind: callSiteKindForNode(node),
    calleeLeaf: leaf,
    calleeQualifier: memberAccess ? memberAccessQualifier(target) : undefined,
    calleeText: target.text,
    memberAccess,
    line: node.startPosition.row,
    targetRange: {
      startLine: leafNode.startPosition.row,
      startColumn: leafNode.startPosition.column,
      endLine: leafNode.endPosition.row,
      endColumn: leafNode.endPosition.column,
    },
    owner: callSiteOwner(node, language),
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
      return unwrapCallTarget(node.childForFieldName('function') ?? node.namedChild(0));
    }
    if (node.type === 'new_expression') {
      return unwrapCallTarget(node.childForFieldName('constructor') ?? node.namedChild(0));
    }
    if (JSX_ELEMENT_NODE_TYPES.has(node.type)) {
      return jsxComponentTarget(node);
    }
  }

  return null;
}

/**
 * Wrappers the grammar can put around a call target without changing what is
 * called: `await client.get<T>(x)` parses with the `await` bound to the member
 * expression, and `(a as B).run()`, `a!.run()`, and `(fn)()` wrap the target
 * the same way. Read through them so the call site keeps its leaf.
 */
const CALL_TARGET_WRAPPERS = new Set([
  'await_expression',
  'parenthesized_expression',
  'non_null_expression',
  'as_expression',
  'satisfies_expression',
]);

function unwrapCallTarget(node: SyntaxNode | null): SyntaxNode | null {
  let current = node;
  while (current && CALL_TARGET_WRAPPERS.has(current.type)) {
    const inner = current.namedChild(0);
    if (!inner) return current;
    current = inner;
  }
  return current;
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
  return callLeafNode(node)?.text.replace(/^#/u, '') ?? null;
}

const CALL_IDENTIFIER_KINDS = new Set([
  'identifier',
  'type_identifier',
  'field_identifier',
  'property_identifier',
  'private_property_identifier',
  'shorthand_property_identifier',
  'jsx_identifier',
]);

function callLeafNode(node: SyntaxNode): SyntaxNode | null {
  if (CALL_IDENTIFIER_KINDS.has(node.type)) return node;
  let target: SyntaxNode | null = null;
  if (isMemberAccessTarget(node)) {
    target = node.namedChild(node.namedChildCount - 1);
  } else if (node.type === 'generic_function') {
    target = node.childForFieldName('function') ?? node.namedChild(0);
  } else if (node.type === 'scoped_identifier') {
    target = node.childForFieldName('name') ?? node.namedChild(node.namedChildCount - 1);
  }
  return target ? callLeafNode(target) : null;
}
