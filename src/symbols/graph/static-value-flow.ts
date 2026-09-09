import { sourceBindingResolver } from '../../source/ast/source-binding-identity.js';
import { selectEffectiveObjectField } from '../../source/ast/effective-object-field.js';
import { resolveImportPath } from '../../source/primitives/import-path-resolver.js';
import { getAst } from '../../source/ast/ast-core.js';
import { detectAstLanguage, isVueSfcPath } from '../../source/ast/ast-language.js';
import { javaScriptStringValue } from './javascript-string-value.js';
import { unwrapExpression, walkNamedSyntax as walk } from '../../source/ast/ast-callables.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { resolveImportedDefinitions } from '../../symbols/imported-definitions.js';
import type {
  EvaluatedStaticValue,
  StaticValueDerivation,
  StaticValueTerm,
  StaticValuePrecision,
} from './value-flow.js';

const MAX_EVALUATION_DEPTH = 8;

export interface BoundaryValueContext {
  db: ScipDatabase;
  file: string;
  root: SyntaxNode;
}

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
  const bindings = sourceBindingResolver(context.file, context.root);
  if (bindings.hasObservedWrite(targetNode)) return unknownValue(call, 'call-target-written');
  const target = boundedCallTarget(context, targetNode);
  if (!target) return unknownValue(call, 'call-target-unresolved');
  const { context: targetContext, callable } = target;
  const identity = `${targetContext.file}:${callable.startIndex}:${callable.endIndex}`;
  if (seen.has(identity)) return unknownValue(call, 'call-return-cycle');
  const returned = singleReturnedExpression(callable);
  if (!returned) return unknownValue(call, 'call-return-not-unconditional-synchronous-expression');
  const nextSeen = new Set(seen).add(identity);
  const value = evaluateNode(targetContext, returned, depth + 1, nextSeen);
  return value ? derivedFrom(call, 'bounded-call-return', value) : unknownValue(call, 'call-return-unresolved');
}

function boundedCallTarget(
  context: BoundaryValueContext,
  targetNode: SyntaxNode,
): { context: BoundaryValueContext; callable: SyntaxNode } | null {
  const callable = sourceBindingResolver(context.file, context.root).callableValue(targetNode);
  if (callable) return { context, callable };
  const target = importedTarget(context, targetNode);
  const resolved = target && importedDefinitionContext(context, target);
  if (!resolved) return null;
  const imported = sourceBindingResolver(resolved.context.file, resolved.context.root).callableValue(
    resolved.declaration,
  );
  return imported ? { context: resolved.context, callable: imported } : null;
}

function importedDefinitionContext(
  context: BoundaryValueContext,
  target: NonNullable<ReturnType<typeof importedTarget>>,
) {
  const root = getAst(context.db, target.relativePath)?.rootNode;
  const declaration = root && definitionBinding(root, target);
  return root && declaration ? { context: { ...context, file: target.relativePath, root }, declaration } : null;
}

/** A single nested return does not prove either fallthrough or finally behavior. */
function singleReturnedExpression(callable: SyntaxNode): SyntaxNode | null {
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
      .some((child) => !['lexical_declaration', 'variable_declaration', 'function_declaration'].includes(child.type))
  )
    return null;
  return last.childForFieldName('argument') ?? last.namedChild(0);
}

function importedTarget(context: BoundaryValueContext, node: SyntaxNode, namespaceMember?: string) {
  const imported = sourceBindingResolver(context.file, context.root).importedValue(node);
  const member = imported?.member ?? namespaceMember;
  if (!imported || !member) return null;
  const file = resolveImportPath(context.db, context.file, imported.module);
  const targets = file ? resolveImportedDefinitions(context.db, file, member) : [];
  return targets.length === 1 ? targets[0]! : null;
}

function definitionBinding(
  root: SyntaxNode,
  target: ReturnType<typeof resolveImportedDefinitions>[number],
): SyntaxNode | null {
  const candidates: SyntaxNode[] = [];
  walk(root, (node) => {
    if (!['variable_declarator', 'function_declaration', 'generator_function_declaration'].includes(node.type)) return;
    const name = node.childForFieldName('name');
    if (
      name?.text !== target.leaf ||
      node.startPosition.row !== target.startLine ||
      node.endPosition.row > target.endLine
    )
      return;
    if (node.startPosition.column < (target.startChar ?? 0)) return;
    if (node.endPosition.row === target.endLine && target.endChar && node.endPosition.column > target.endChar) return;
    candidates.push(name);
  });
  return candidates.length === 1 ? candidates[0]! : null;
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
  if (bindings.hasObservedWrite(base, true)) return 'member-base-observed-write';
  const local = bindings.constantInitializer(base);
  if (local) return { context, node: local, properties };
  const target = importedTarget(context, base, properties[0]);
  if (!target) return 'member-binding-unresolved';
  const resolved = importedDefinitionContext(context, target);
  if (!resolved) return 'member-definition-unparsed';
  const imported = sourceBindingResolver(resolved.context.file, resolved.context.root);
  if (imported.hasObservedWrite(resolved.declaration, true)) return 'member-base-observed-write';
  const node = imported.constantInitializer(resolved.declaration);
  if (!node) return 'member-base-nonconstant';
  return {
    context: resolved.context,
    node,
    properties: bindings.importedValue(base)?.member === null ? properties.slice(1) : properties,
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

function memberParts(node: SyntaxNode): { base: SyntaxNode; properties: string[] } | null {
  if (node.type !== 'member_expression') return null;
  const object = node.childForFieldName('object');
  const property = node.childForFieldName('property');
  if (!object || property?.type !== 'property_identifier') return null;
  const parent = memberParts(object);
  if (parent) return { base: parent.base, properties: [...parent.properties, property.text] };
  return object.type === 'identifier' ? { base: object, properties: [property.text] } : null;
}

function evaluateStaticConcatenation(
  context: BoundaryValueContext,
  node: SyntaxNode,
  depth: number,
  seen: Set<string>,
): EvaluatedStaticValue | null {
  const parts = node.namedChildren.map((child) => evaluateNode(context, child, depth + 1, new Set(seen)));
  if (parts.length >= 2 && parts.every((part): part is EvaluatedStaticValue => part !== null)) {
    const term: StaticValueTerm = { kind: 'concat', parts: parts.map((part) => part.term) };
    const value = parts.map((part) => part.value).join('');
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
