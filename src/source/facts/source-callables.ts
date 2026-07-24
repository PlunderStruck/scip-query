import type { AstLanguage } from '../ast/ast-language.js';
import type { SyntaxNode } from '../ast/ast-types.js';
import { isCommentNode } from './source-node-kinds.js';

const JAVASCRIPT_NAMED_CALLABLE_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'method_signature',
  'function_signature',
]);

export interface CallableParamFact {
  name: string;
  /** False when the parameter is a pattern/rest/this — not a simple identifier. */
  simple: boolean;
}

// scip-query: ignore-extract — reviewed E3 feature-local pipeline; the helper cluster has no separate owner or consumer.
export function callableFactForNode(node: SyntaxNode, language: AstLanguage) {
  const named = namedCallableNode(node, language);
  if (named) {
    return {
      name: named.name,
      startLine: named.definitionNode.startPosition.row,
      endLine: named.definitionNode.endPosition.row,
      paramCount: parameterCount(named.functionNode),
      params: parameterFacts(named.functionNode),
      paramsEndLine: parametersEndLine(named.functionNode),
      isLiteralPassthrough: isPassthroughBody(named.functionNode, language),
    };
  }

  if (!isNamedCallableType(node.type, language)) return null;
  const nameNode =
    node.childForFieldName('name') ??
    node.namedChildren.find((child) => child.type === 'identifier' || child.type === 'property_identifier');
  if (!nameNode) return null;

  return {
    name: nameNode.text,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    paramCount: parameterCount(node),
    params: parameterFacts(node),
    paramsEndLine: parametersEndLine(node),
    isLiteralPassthrough: isPassthroughBody(node, language),
  };
}

function parametersNode(fnNode: SyntaxNode): SyntaxNode | undefined {
  return fnNode.namedChildren.find((child) => child.type === 'parameters' || child.type === 'formal_parameters');
}

/** Ordered parameter facts; patterns/rest params are marked non-simple. */
function parameterFacts(fnNode: SyntaxNode): CallableParamFact[] {
  const paramsNode = parametersNode(fnNode);
  if (!paramsNode) return [];
  const facts: CallableParamFact[] = [];
  for (const param of paramsNode.namedChildren) {
    if (isCommentNode(param)) continue;
    if (param.type === 'identifier') {
      facts.push({ name: param.text, simple: true });
      continue;
    }
    // TS parameter properties (constructor(private readonly bucket: ...))
    // declare class fields — their use sites live outside the constructor.
    const isParameterProperty =
      param.namedChildren.some((child) => child.type.endsWith('_modifier')) ||
      /^\s*(?:public|private|protected|readonly|override)\b/.test(param.text);
    // required_parameter / optional_parameter wrap the identifier in TS.
    const pattern = param.childForFieldName('pattern');
    if (!isParameterProperty && pattern && pattern.type === 'identifier') {
      facts.push({ name: pattern.text, simple: true });
      continue;
    }
    const id = param.namedChildren.find((child) => child.type === 'identifier');
    facts.push({ name: pattern?.type === 'identifier' ? pattern.text : (id?.text ?? ''), simple: false });
  }
  return facts;
}

function parametersEndLine(fnNode: SyntaxNode): number {
  const paramsNode = parametersNode(fnNode);
  return paramsNode ? paramsNode.endPosition.row : fnNode.startPosition.row;
}

function isNamedCallableType(nodeType: string, language: AstLanguage): boolean {
  if (language === 'rust') return nodeType === 'function_item' || nodeType === 'function_signature_item';
  if (language === 'python') return nodeType === 'function_definition';
  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    return JAVASCRIPT_NAMED_CALLABLE_TYPES.has(nodeType);
  }
  return false;
}

function namedCallableNode(
  node: SyntaxNode,
  language: AstLanguage,
): { name: string; definitionNode: SyntaxNode; functionNode: SyntaxNode } | null {
  if (language !== 'typescript' && language !== 'tsx' && language !== 'javascript') return null;

  if (node.type === 'variable_declarator') {
    const name = node.childForFieldName('name') ?? node.namedChild(0);
    const value = node.childForFieldName('value') ?? node.namedChild(1);
    if (!name || !value) return null;
    if (value.type !== 'arrow_function' && value.type !== 'function_expression') return null;
    return { name: name.text, definitionNode: node, functionNode: value };
  }

  if (node.type === 'public_field_definition') {
    const name = node.childForFieldName('name') ?? node.namedChild(0);
    const value = node.childForFieldName('value') ?? node.namedChild(1);
    if (!name || !value) return null;
    if (value.type !== 'arrow_function' && value.type !== 'function_expression') return null;
    return { name: name.text, definitionNode: node, functionNode: value };
  }

  return null;
}

function parameterCount(fnNode: SyntaxNode): number {
  const paramsNode = fnNode.namedChildren.find(
    (child) => child.type === 'parameters' || child.type === 'formal_parameters',
  );
  if (!paramsNode) return 0;

  let count = 0;
  for (const param of paramsNode.namedChildren) {
    if (isCommentNode(param)) continue;
    count += 1;
  }
  return count;
}

function isPassthroughBody(fnNode: SyntaxNode, language: AstLanguage): boolean {
  const body = fnNode.namedChildren.find((child) => child.type === 'block' || child.type === 'statement_block');
  if (!body) return false;

  const statements = body.namedChildren.filter((child) => !isCommentNode(child));
  if (statements.length !== 1) return false;
  const only = statements[0]!;

  let callNode: SyntaxNode | null = null;
  if (only.type === 'return_statement') {
    callNode = only.namedChild(0) ?? null;
  } else if (only.type === 'expression_statement') {
    callNode = only.namedChild(0) ?? null;
  } else if (language === 'rust' && (only.type === 'call_expression' || only.type === 'macro_invocation')) {
    callNode = only;
  }
  if (!callNode) return false;

  const callType = language === 'python' ? 'call' : 'call_expression';
  if (callNode.type !== callType) return false;

  const argsNode = callNode.namedChildren.find((child) => child.type === 'arguments' || child.type === 'argument_list');
  if (!argsNode) return false;
  const callArgs = argsNode.namedChildren.filter((child) => !isCommentNode(child));

  const paramsNode = fnNode.namedChildren.find(
    (child) => child.type === 'parameters' || child.type === 'formal_parameters',
  );
  if (!paramsNode) return false;

  const paramNames: string[] = [];
  for (const param of paramsNode.namedChildren) {
    if (param.type === 'identifier') {
      paramNames.push(param.text);
      continue;
    }
    const id = param.namedChildren.find((child) => child.type === 'identifier');
    if (id) paramNames.push(id.text);
  }

  if (callArgs.length !== paramNames.length) return false;
  for (let index = 0; index < paramNames.length; index += 1) {
    const arg = callArgs[index]!;
    if (arg.type !== 'identifier') return false;
    if (arg.text !== paramNames[index]) return false;
  }
  return true;
}
