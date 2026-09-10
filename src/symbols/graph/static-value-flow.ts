import { sourceBindingResolver } from '../../source/ast/source-binding-identity.js';
import { selectEffectiveObjectField } from '../../source/ast/effective-object-field.js';
import { getAst } from '../../source/ast/ast-core.js';
import { detectAstLanguage, isVueSfcPath } from '../../source/ast/ast-language.js';
import { javaScriptStringValue } from './javascript-string-value.js';
import { unwrapExpression } from '../../source/ast/ast-callables.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import type { resolveImportedDefinitions } from '../../symbols/imported-definitions.js';
import {
  callableValueWasWritten,
  definitionBinding,
  importedDefinitionContext,
  importedTarget,
  memberParts,
  resolveCallableValue,
  sharedMemberWriteIsUnproved,
  type BoundaryValueContext,
} from './imported-value-context.js';
export type { BoundaryValueContext } from './imported-value-context.js';
import type {
  EvaluatedStaticValue,
  StaticValueDerivation,
  StaticValueTerm,
  StaticValuePrecision,
} from './value-flow.js';

const MAX_EVALUATION_DEPTH = 8;

/** Resolve finite address-bearing values without assigning protocol meaning. */
export function evaluateStaticValue(
  context: BoundaryValueContext,
  node: SyntaxNode | null | undefined,
): EvaluatedStaticValue | null {
  if (!node) return null;
  return evaluateNode(context, node, 0, new Set());
}

function evaluateNode(
  context: BoundaryValueContext,
  input: SyntaxNode,
  depth: number,
  seen: Set<string>,
): EvaluatedStaticValue | null {
  if (depth > MAX_EVALUATION_DEPTH) return unknownValue(input, 'value-evaluation-depth');
  const node = unwrapExpression(input);
  const literal = stringTerm(context.file, node);
  if (literal) return directValue(context.file, node, literal.term, literal.value, literal.precision);

  if (node.type === 'binary_expression' && node.childForFieldName('operator')?.text === '+') {
    const concatenated = evaluateStaticConcatenation(context, node, depth, seen);
    if (concatenated) return concatenated;
  }

  const text = node.text.trim();
  if (['identifier', 'shorthand_property_identifier'].includes(node.type)) {
    return resolveIdentifier(context, text, node, depth, seen);
  }

  const member = memberParts(node);
  if (member) {
    return resolveMember(context, member.base, member.properties, node, depth, seen);
  }

  if (node.type === 'call_expression' || node.type === 'call') {
    return resolveBoundedCallReturn(context, node, depth, seen);
  }

  return unknownValue(node, `unsupported-expression:${node.type}`);
}

function resolveBoundedCallReturn(
  context: BoundaryValueContext,
  call: SyntaxNode,
  depth: number,
  seen: Set<string>,
): EvaluatedStaticValue | null {
  const targetNode = call.childForFieldName('function');
  if (!targetNode) return unknownValue(call, 'call-target-unresolved');
  if (call.childForFieldName('arguments')?.namedChildren.some((node) => eagerCompletionIsUnproved(context, node)))
    return unknownValue(call, 'call-argument-normal-completion-unproved');
  if (callableValueWasWritten(context, targetNode)) return unknownValue(call, 'call-target-written');
  const target = resolveCallableValue(context, targetNode);
  if (!target) return unknownValue(call, 'call-target-unresolved');
  const { context: targetContext, callable } = target;
  if (
    callable
      .childForFieldName('parameters')
      ?.namedChildren.some((node) => parameterCompletionIsUnproved(targetContext, node))
  )
    return unknownValue(call, 'call-parameter-normal-completion-unproved');
  const identity = `${targetContext.file}:${callable.startIndex}:${callable.endIndex}`;
  if (seen.has(identity)) return unknownValue(call, 'call-return-cycle');
  const returned = singleReturnedExpression(targetContext, callable);
  if (!returned) return unknownValue(call, 'call-return-not-unconditional-synchronous-expression');
  const nextSeen = new Set(seen).add(identity);
  const value = evaluateNode(targetContext, returned, depth + 1, nextSeen);
  return value ? derivedFrom(call, 'bounded-call-return', value) : unknownValue(call, 'call-return-unresolved');
}

/** A single nested return does not prove either fallthrough or finally behavior. */
function singleReturnedExpression(context: BoundaryValueContext, callable: SyntaxNode): SyntaxNode | null {
  if (
    callable.children.some((child) => child.type === 'async' || child.type === '*') ||
    callable.type.includes('generator')
  )
    return null;
  const body = callable.childForFieldName('body');
  if (!body) return null;
  if (callable.type === 'arrow_function' && body.type !== 'statement_block') return body;
  const statements = body.namedChildren.filter((child) => child.type !== 'comment');
  const last = statements.at(-1);
  if (!last || last.type !== 'return_statement') return null;
  // Only straight-line declarations before the return are evaluated here.
  if (
    statements
      .slice(0, -1)
      .some(
        (child) =>
          !['lexical_declaration', 'variable_declaration', 'function_declaration'].includes(child.type) ||
          eagerCompletionIsUnproved(context, child),
      )
  )
    return null;
  return last.childForFieldName('argument') ?? last.namedChild(0);
}

/** Creating a callable is lazy; evaluating calls, accessors, and effects is not. */
function eagerCompletionIsUnproved(
  context: BoundaryValueContext,
  input: SyntaxNode,
  depth = 0,
  parameterDefault = false,
): boolean {
  if (depth > MAX_EVALUATION_DEPTH) return true;
  const node = unwrapExpression(input);
  if (
    [
      'function_declaration',
      'function_expression',
      'arrow_function',
      'generator_function_declaration',
      'generator_function',
      'number',
      'true',
      'false',
      'null',
      'regex',
      'comment',
    ].includes(node.type)
  )
    return false;
  const string = javaScriptStringValue(node);
  if (string) return string.interpolated;
  const unproved = (child: SyntaxNode) => eagerCompletionIsUnproved(context, child, depth + 1, parameterDefault);
  if (['lexical_declaration', 'variable_declaration', 'array'].includes(node.type))
    return node.namedChildren.some(unproved);
  if (node.type === 'variable_declarator') {
    const value = node.childForFieldName('value');
    return node.childForFieldName('name')?.type !== 'identifier' || (!!value && unproved(value));
  }
  if (node.type === 'object') return node.namedChildren.some((field) => objectCreationIsUnproved(field, unproved));
  if (['identifier', 'shorthand_property_identifier'].includes(node.type)) {
    return bindingReadCompletionIsUnproved(context, node, unproved, parameterDefault);
  }
  // All other evaluation needs an explicit proof: property access, iteration,
  // conversion, class initialization and unknown syntax may execute or throw.
  return true;
}

function bindingReadCompletionIsUnproved(
  context: BoundaryValueContext,
  node: SyntaxNode,
  unproved: (node: SyntaxNode) => boolean,
  parameterDefault: boolean,
): boolean {
  const bindings = sourceBindingResolver(context.file, context.root);
  if (!parameterDefault && bindings.isParameterBinding(node)) return false;
  const initializer = bindings.constantInitializer(node);
  return !initializer || initializer.endIndex >= node.startIndex || unproved(initializer);
}

function objectCreationIsUnproved(field: SyntaxNode, unproved: (node: SyntaxNode) => boolean): boolean {
  if (field.type === 'comment') return false;
  if (field.type === 'shorthand_property_identifier') return unproved(field);
  const key = field.childForFieldName('key') ?? field.childForFieldName('name');
  if (!key || key.type === 'computed_property_name') return true;
  if (field.type === 'method_definition') return false;
  const value = field.childForFieldName('value');
  return field.type !== 'pair' || !value || unproved(value);
}

function parameterCompletionIsUnproved(context: BoundaryValueContext, parameter: SyntaxNode): boolean {
  if (parameter.type === 'comment') return false;
  const name =
    parameter.childForFieldName('pattern') ??
    parameter.childForFieldName('name') ??
    parameter.namedChild(0) ??
    parameter;
  const binding = name.type === 'rest_pattern' ? name.namedChild(0) : name;
  if (binding?.type !== 'identifier') return true;
  const value = parameter.childForFieldName('value');
  return !!value && eagerCompletionIsUnproved(context, value, 0, true);
}

function resolveIdentifier(
  context: BoundaryValueContext,
  name: string,
  site: SyntaxNode,
  depth: number,
  seen: Set<string>,
): EvaluatedStaticValue | null {
  const bindings = sourceBindingResolver(context.file, context.root);
  const identity = `${context.file}:${bindings.resource(site).resourceKey}`;
  if (seen.has(identity)) return unknownValue(site, 'value-cycle');
  const nextSeen = new Set(seen).add(identity);
  const local = bindings.constantInitializer(site);
  if (local) {
    const value = evaluateNode(context, local, depth + 1, nextSeen);
    return value ? derivedFrom(site, 'local-constant', value) : unknownValue(site, 'non-foldable-local');
  }
  const target = importedTarget(context, site);
  return target
    ? evaluateImportedConstant(context, target, site, depth, nextSeen)
    : symbolicValue(site, name, 'unresolved-or-nonconstant-binding');
}

function resolveMember(
  context: BoundaryValueContext,
  base: SyntaxNode,
  properties: readonly string[],
  site: SyntaxNode,
  depth: number,
  seen: Set<string>,
): EvaluatedStaticValue | null {
  const resolved = memberBase(context, base, properties);
  if (typeof resolved === 'string') return unknownValue(site, resolved);
  const { context: targetContext } = resolved;
  let current = resolved.node;
  for (const property of resolved.properties) {
    current = objectAliasInitializer(targetContext, current);
    const field = selectEffectiveObjectField(current, property, (key) => {
      const value = evaluateNode(targetContext, unwrapComputedKey(key), depth + 1, new Set(seen));
      return value?.precision === 'literal' && ['literal', 'constant'].includes(value.evidence) ? value.value : null;
    });
    if (field.kind !== 'value') return unknownValue(site, `member-property-${field.kind}:${property}`);
    current = field.node;
  }
  const value = evaluateNode(targetContext, current, depth + 1, new Set(seen));
  return value ? derivedFrom(site, 'member-constant', value) : unknownValue(site, 'member-value-unresolved');
}

function memberBase(
  context: BoundaryValueContext,
  base: SyntaxNode,
  properties: readonly string[],
): { context: BoundaryValueContext; node: SyntaxNode; properties: readonly string[] } | string {
  const bindings = sourceBindingResolver(context.file, context.root);
  if (bindings.hasObservedWrite(base, true, properties)) return 'member-base-observed-write';
  const local = bindings.constantInitializer(base);
  if (local)
    return sharedMemberWriteIsUnproved(context, base, properties)
      ? 'member-shared-write-or-coverage-unproved'
      : { context, node: local, properties };
  const target = importedTarget(context, base, properties[0]);
  if (!target) return 'member-binding-unresolved';
  const resolved = importedDefinitionContext(context, target);
  if (!resolved) return 'member-definition-unparsed';
  const imported = sourceBindingResolver(resolved.context.file, resolved.context.root);
  const importedProperties = bindings.importedValue(base)?.member === null ? properties.slice(1) : properties;
  if (imported.hasObservedWrite(resolved.declaration, true, importedProperties)) return 'member-base-observed-write';
  if (sharedMemberWriteIsUnproved(resolved.context, resolved.declaration, importedProperties))
    return 'member-shared-write-or-coverage-unproved';
  const node = imported.constantInitializer(resolved.declaration);
  if (!node) return 'member-base-nonconstant';
  return {
    context: resolved.context,
    node,
    properties: importedProperties,
  };
}

function objectAliasInitializer(context: BoundaryValueContext, node: SyntaxNode): SyntaxNode {
  let current = unwrapExpression(node);
  const seen = new Set<number>();
  const bindings = sourceBindingResolver(context.file, context.root);
  while (current.type === 'identifier' && !seen.has(current.startIndex)) {
    seen.add(current.startIndex);
    const initializer = bindings.constantInitializer(current);
    if (!initializer) break;
    current = unwrapExpression(initializer);
  }
  return current;
}

function unwrapComputedKey(node: SyntaxNode): SyntaxNode {
  return node.type === 'computed_property_name' ? (node.namedChild(0) ?? node) : node;
}

function stringTerm(
  file: string,
  node: SyntaxNode,
): { term: StaticValueTerm; value: string; precision: StaticValuePrecision } | null {
  const language = detectAstLanguage(file);
  if (language === 'typescript' || language === 'tsx' || language === 'javascript' || isVueSfcPath(file))
    return javaScriptStringTerm(node);
  return otherLanguageStringTerm(node);
}

function javaScriptStringTerm(node: SyntaxNode): ReturnType<typeof stringTerm> {
  const decoded = javaScriptStringValue(node);
  if (!decoded) return null;
  return decoded.interpolated
    ? {
        term: { kind: 'pattern', language: 'template', value: decoded.value },
        value: decoded.value,
        precision: 'constrained-pattern',
      }
    : { term: { kind: 'literal', value: decoded.value }, value: decoded.value, precision: 'literal' };
}

function otherLanguageStringTerm(node: SyntaxNode): ReturnType<typeof stringTerm> {
  if (node.type !== 'string' && node.type !== 'string_literal') return null;
  const text = node.text.trim();
  const quote = text[0];
  if ((quote !== "'" && quote !== '"' && quote !== '`') || text.at(-1) !== quote) return null;
  const raw = text.slice(1, -1);
  // Generic quote stripping cannot decode escapes, multiline delimiters or language-specific interpolation.
  if (text.startsWith(quote.repeat(3)) || ['\\', '$', '#', '\n', '\r'].some((marker) => raw.includes(marker)))
    return null;
  return { term: { kind: 'literal', value: raw }, value: raw, precision: 'literal' };
}

function directValue(
  file: string,
  node: SyntaxNode,
  term: StaticValueTerm,
  value: string,
  precision: StaticValuePrecision,
): EvaluatedStaticValue {
  return {
    value,
    evidence: 'literal',
    term,
    precision,
    derivation: derivation('direct-literal', 'direct', file, node),
  };
}

function derivedValue(
  file: string,
  node: SyntaxNode,
  term: StaticValueTerm,
  value: string,
  precision: StaticValuePrecision,
  inputs: readonly EvaluatedStaticValue[],
): EvaluatedStaticValue {
  return {
    value,
    evidence: 'constant',
    term,
    precision,
    derivation: {
      ...derivation('constant-concatenation', 'mechanically-derived', file, node),
      inputFactIds: inputs.flatMap((input) => input.derivation.inputFactIds),
      sourceSpans: inputs.flatMap((input) => input.derivation.sourceSpans),
    },
  };
}

function derivedFrom(
  site: SyntaxNode,
  rule: string,
  value: EvaluatedStaticValue,
  symbol?: string,
): EvaluatedStaticValue {
  if (value.evidence === 'expression') {
    return {
      ...value,
      derivation: {
        kind: 'heuristic',
        rule,
        ruleVersion: '1',
        inputFactIds: [...value.derivation.inputFactIds, ...(symbol ? [symbol] : [])],
        sourceSpans: value.derivation.sourceSpans,
      },
    };
  }
  return {
    ...value,
    evidence: 'constant',
    derivation: {
      kind: 'mechanically-derived',
      rule,
      ruleVersion: '1',
      inputFactIds: [...value.derivation.inputFactIds, ...(symbol ? [symbol] : [])],
      sourceSpans: value.derivation.sourceSpans,
    },
  };
}

function symbolicValue(node: SyntaxNode, symbol: string, reason: string): EvaluatedStaticValue {
  return {
    value: node.text.trim(),
    evidence: 'expression',
    term: { kind: 'symbol', symbol },
    precision: 'symbolic',
    derivation: derivation(reason, 'heuristic', '', node),
  };
}

function unknownValue(node: SyntaxNode, reason: string): EvaluatedStaticValue {
  return {
    value: node.text.trim(),
    evidence: 'expression',
    term: { kind: 'unknown', reason },
    precision: 'unknown',
    derivation: derivation(reason, 'heuristic', '', node),
  };
}

function derivation(
  rule: string,
  kind: StaticValueDerivation['kind'],
  file: string,
  node: SyntaxNode,
): StaticValueDerivation {
  return {
    kind,
    rule,
    ruleVersion: '1',
    inputFactIds: [],
    sourceSpans: file ? [{ file, startLine: node.startPosition.row, endLine: node.endPosition.row }] : [],
  };
}

function evaluateStaticConcatenation(
  context: BoundaryValueContext,
  node: SyntaxNode,
  depth: number,
  seen: Set<string>,
): EvaluatedStaticValue | null {
  const parts = node.namedChildren.map((child) => evaluateNode(context, child, depth + 1, new Set(seen)));
  if (parts.length >= 2 && parts.every((part): part is EvaluatedStaticValue => part !== null)) {
    // JavaScript + also performs numeric addition. Only a proved string operand
    // establishes concatenation; source text for an unknown operand is not its value.
    const stringPart = (part: EvaluatedStaticValue) =>
      part.precision === 'literal' || part.precision === 'constrained-pattern';
    if (!parts.some(stringPart)) return unknownValue(node, 'addition-operands-unproved');
    const term: StaticValueTerm = { kind: 'concat', parts: parts.map((part) => part.term) };
    const value = parts.map((part) => (stringPart(part) ? part.value : '{}')).join('');
    return derivedValue(
      context.file,
      node,
      term,
      value,
      parts.some((part) => part.precision !== 'literal') ? 'constrained-pattern' : 'literal',
      parts,
    );
  }
  return null;
}

function evaluateImportedConstant(
  context: BoundaryValueContext,
  target: ReturnType<typeof resolveImportedDefinitions>[number],
  site: SyntaxNode,
  depth: number,
  seen: Set<string>,
): EvaluatedStaticValue | null {
  const targetRoot = getAst(context.db, target.relativePath)?.rootNode;
  if (!targetRoot) return symbolicValue(site, target.symbol, 'import-definition-unparsed');
  const binding = definitionBinding(targetRoot, target);
  const initializer = binding && sourceBindingResolver(target.relativePath, targetRoot).constantInitializer(binding);
  if (!initializer) return symbolicValue(site, target.symbol, 'import-definition-non-value');
  const value = evaluateNode(
    { db: context.db, file: target.relativePath, root: targetRoot },
    initializer,
    depth + 1,
    seen,
  );
  return value
    ? derivedFrom(site, 'imported-constant', value, target.symbol)
    : symbolicValue(site, target.symbol, 'import-value-unresolved');
}
