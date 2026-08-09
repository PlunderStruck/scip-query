import { getAst } from '../ast/ast-core.js';
import type { SyntaxNode } from '../ast/ast-types.js';
import type { ScipDatabase } from '../../storage/db.js';
import type {
  ParserStateValueRelationSubtype,
  ParserTemporalRelationSubtype,
} from '../../domain/graph-relation-providers.js';

export type SourceMutationOperation = 'assign' | 'update' | 'delete';
export type SourceStateDurability = 'in-memory';
export type SourceStateDataSubtype = ParserStateValueRelationSubtype;

export interface SourceProgramConstruct {
  kind: 'event' | 'lock' | 'resource' | 'value';
  label: string;
  startLine: number;
  endLine: number;
}

export interface SourceStateMutationFact {
  event: SourceProgramConstruct;
  resource: SourceProgramConstruct;
  operation: SourceMutationOperation;
  durabilityClass: SourceStateDurability;
  recordIdentity: string | null;
  value: SourceProgramConstruct | null;
  dataSubtype: SourceStateDataSubtype | null;
}

export type SourceTemporalSubtype = ParserTemporalRelationSubtype;

export interface SourceTemporalFact {
  from: SourceProgramConstruct;
  to: SourceProgramConstruct;
  subtype: SourceTemporalSubtype;
  synchronizationScope: string | null;
  attributes: Record<string, string | boolean>;
}

export interface SourceStateTemporalAnalysis {
  mutations: SourceStateMutationFact[];
  temporal: SourceTemporalFact[];
  unsupported: Array<{
    family: 'state' | 'temporal';
    startLine: number;
    endLine: number;
    reason: string;
  }>;
}

const CALLABLE_NODE_TYPES = new Set([
  'arrow_function',
  'constructor_declaration',
  'function_declaration',
  'function_definition',
  'function_expression',
  'generator_function',
  'generator_function_declaration',
  'function_item',
  'lambda',
  'lambda_expression',
  'method',
  'method_declaration',
  'method_definition',
]);

const BLOCK_NODE_TYPES = new Set(['block', 'body', 'compound_statement', 'declaration_list', 'statement_block']);

const ASSIGNMENT_NODE_TYPES = new Set(['assignment', 'assignment_expression', 'augmented_assignment_expression']);

const UPDATE_NODE_TYPES = new Set(['update_expression']);
const SUBSCRIPT_NODE_TYPES = new Set(['array_access', 'element_access_expression', 'subscript_expression']);
const MEMBER_NODE_TYPES = new Set([
  'attribute',
  'field_access',
  'field_expression',
  'member_access_expression',
  'member_expression',
  'selector_expression',
]);
const LITERAL_NODE_TYPES = new Set([
  'false',
  'null',
  'null_literal',
  'number',
  'number_literal',
  'string',
  'string_literal',
  'template_string',
  'true',
]);
const CALL_NODE_TYPES = new Set(['call_expression', 'method_invocation', 'object_creation_expression']);
const NON_EVENT_NODE_TYPES = new Set(['comment', 'else_clause', 'formal_parameters', 'parameters', 'type_parameters']);

/**
 * Derive only relationships whose source syntax fixes their meaning. Library
 * calls named `transaction` or `lock` are intentionally not treated as proof.
 */
export function sourceStateTemporalAnalysis(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): SourceStateTemporalAnalysis | null {
  const tree = getAst(db, relativePath);
  if (!tree) return null;
  const root = findAnalysisRoot(tree.rootNode, startLine, endLine);
  if (!root) return null;

  const mutations: SourceStateMutationFact[] = [];
  const temporal: SourceTemporalFact[] = [];
  const unsupported: SourceStateTemporalAnalysis['unsupported'] = [];

  walk(root, (node) => {
    if (ASSIGNMENT_NODE_TYPES.has(node.type) || UPDATE_NODE_TYPES.has(node.type) || isDeleteExpression(node)) {
      const mutation = mutationFact(node);
      if (mutation) mutations.push(mutation);
      else {
        unsupported.push({
          family: 'state',
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
          reason: `Mutation target ${compact(node.text)} could not be resolved to an exact source resource.`,
        });
      }
    }
  });

  walk(root, (node) => {
    if (!BLOCK_NODE_TYPES.has(node.type)) return;
    const statements = directMaterialStatements(node);
    for (let index = 0; index < statements.length - 1; index += 1) {
      temporal.push({
        from: eventConstruct(statements[index]!),
        to: eventConstruct(statements[index + 1]!),
        subtype: 'lexical-successor',
        synchronizationScope: null,
        attributes: { sameScope: true, executionConditional: true },
      });
    }
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index]!;
      const awaits = descendantsWithinStatement(statement).filter((candidate) => candidate.type === 'await_expression');
      for (const awaited of awaits) {
        const awaitConstruct = construct('event', `await ${compact(awaited.text.replace(/^await\s+/u, ''))}`, awaited);
        temporal.push({
          from: eventConstruct(statement),
          to: awaitConstruct,
          subtype: 'awaits-completion',
          synchronizationScope: null,
          attributes: { completionRequired: true },
        });
        const successor = statements[index + 1];
        if (successor) {
          temporal.push({
            from: awaitConstruct,
            to: eventConstruct(successor),
            subtype: 'await-completion-before',
            synchronizationScope: null,
            attributes: { continuationOnly: true },
          });
        }
      }
    }
  });

  walk(root, (node) => {
    if (node.type !== 'synchronized_statement') return;
    const monitor =
      node.childForFieldName('object') ??
      node.childForFieldName('condition') ??
      node.namedChildren.find((child) => !BLOCK_NODE_TYPES.has(child.type));
    const body = node.childForFieldName('body') ?? node.namedChildren.find((child) => BLOCK_NODE_TYPES.has(child.type));
    if (!monitor || !body) {
      unsupported.push({
        family: 'temporal',
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        reason: 'Synchronized scope has no structurally resolved monitor or body.',
      });
      return;
    }
    const scope = compact(monitor.text).replace(/^\(|\)$/gu, '');
    const lock = construct('lock', scope, monitor);
    const members = descendantsIncludingSelf(body).filter(
      (candidate) => candidate.parent !== null && isMaterialStatement(candidate),
    );
    for (const member of outermostNodes(members)) {
      temporal.push({
        from: lock,
        to: eventConstruct(member),
        subtype: 'inside-lock-scope',
        synchronizationScope: scope,
        attributes: { syntaxNative: true },
      });
    }
  });

  return { mutations, temporal, unsupported };
}

function mutationFact(node: SyntaxNode): SourceStateMutationFact | null {
  const deleting = isDeleteExpression(node);
  const target =
    node.childForFieldName('left') ??
    node.childForFieldName('argument') ??
    (deleting ? (node.namedChildren.at(-1) ?? null) : (node.namedChildren[0] ?? null));
  if (!target) return null;
  const resource = resourceIdentity(target);
  if (!resource) return null;
  const operation: SourceMutationOperation = deleting
    ? 'delete'
    : UPDATE_NODE_TYPES.has(node.type) || !assignmentOperator(node, target).startsWith('=')
      ? 'update'
      : 'assign';
  const value = deleting || UPDATE_NODE_TYPES.has(node.type) ? null : node.childForFieldName('right');
  return {
    event: construct('event', compact(node.text), node),
    resource: {
      kind: 'resource',
      label: resource.name,
      startLine: target.startPosition.row,
      endLine: target.endPosition.row,
    },
    operation,
    durabilityClass: 'in-memory',
    recordIdentity: resource.recordIdentity,
    value: value ? construct('value', compact(value.text), value) : null,
    dataSubtype: value ? dataSubtype(value, node) : null,
  };
}

function resourceIdentity(node: SyntaxNode): { name: string; recordIdentity: string | null } | null {
  if (SUBSCRIPT_NODE_TYPES.has(node.type)) {
    const object = node.childForFieldName('object') ?? node.childForFieldName('array') ?? node.namedChildren[0] ?? null;
    const index =
      node.childForFieldName('index') ?? node.childForFieldName('subscript') ?? node.namedChildren[1] ?? null;
    if (!object || !index) return null;
    return { name: `${compact(object.text)}[]`, recordIdentity: compact(index.text) };
  }
  if (MEMBER_NODE_TYPES.has(node.type)) return { name: compact(node.text), recordIdentity: null };
  if (/^(?:identifier|property_identifier|field_identifier)$/u.test(node.type)) {
    return { name: compact(node.text), recordIdentity: null };
  }
  return null;
}

function dataSubtype(node: SyntaxNode, mutation: SyntaxNode): SourceStateDataSubtype {
  if (LITERAL_NODE_TYPES.has(node.type) || /(?:integer|float|decimal|boolean|character)_literal$/u.test(node.type)) {
    return 'constant-to-state';
  }
  if (CALL_NODE_TYPES.has(node.type)) return 'return-to-state';
  if (MEMBER_NODE_TYPES.has(node.type) || SUBSCRIPT_NODE_TYPES.has(node.type)) return 'property-to-state';
  if (/identifier$/u.test(node.type)) {
    return isCapturedIdentifier(node.text, mutation) ? 'captured-value-to-state' : 'value-to-state';
  }
  return 'expression-to-state';
}

function isCapturedIdentifier(name: string, use: SyntaxNode): boolean {
  const currentCallable = nearestCallable(use.parent);
  if (!currentCallable || callableDeclares(currentCallable, name)) return false;
  let ancestor = nearestCallable(currentCallable.parent);
  while (ancestor) {
    if (callableDeclares(ancestor, name)) return true;
    ancestor = nearestCallable(ancestor.parent);
  }
  return false;
}

function nearestCallable(node: SyntaxNode | null): SyntaxNode | null {
  let current = node;
  while (current) {
    if (CALLABLE_NODE_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function callableDeclares(callable: SyntaxNode, name: string): boolean {
  const parameters =
    callable.childForFieldName('parameters') ??
    callable.namedChildren.find((child) => ['formal_parameters', 'parameters'].includes(child.type));
  if (parameters && containsIdentifier(parameters, name)) return true;
  const body =
    callable.childForFieldName('body') ?? callable.namedChildren.find((child) => BLOCK_NODE_TYPES.has(child.type));
  if (!body) return false;
  let declared = false;
  walkWithoutNestedCallables(body, callable, (node) => {
    if (declared || !/(?:declarator|declaration|parameter)$/u.test(node.type)) return;
    const binding = node.childForFieldName('name') ?? node.childForFieldName('pattern') ?? node.namedChildren[0];
    if (binding && containsIdentifier(binding, name)) declared = true;
  });
  return declared;
}

function containsIdentifier(node: SyntaxNode, name: string): boolean {
  let found = false;
  walk(node, (candidate) => {
    if (/identifier$/u.test(candidate.type) && candidate.text === name) found = true;
  });
  return found;
}

function walkWithoutNestedCallables(
  node: SyntaxNode,
  rootCallable: SyntaxNode,
  visit: (node: SyntaxNode) => void,
): void {
  visit(node);
  for (const child of node.namedChildren) {
    if (child !== rootCallable && CALLABLE_NODE_TYPES.has(child.type)) continue;
    walkWithoutNestedCallables(child, rootCallable, visit);
  }
}

function assignmentOperator(node: SyntaxNode, target: SyntaxNode): string {
  const right = node.childForFieldName('right');
  const start = Math.max(0, target.endIndex - node.startIndex);
  const end = right ? Math.max(start, right.startIndex - node.startIndex) : node.text.length;
  return node.text.slice(start, end).trim();
}

function isDeleteExpression(node: SyntaxNode): boolean {
  return (node.type === 'delete_expression' || node.type === 'unary_expression') && /^delete\b/u.test(node.text.trim());
}

function directMaterialStatements(block: SyntaxNode): SyntaxNode[] {
  return block.namedChildren.filter((child) => isMaterialStatement(child));
}

function isMaterialStatement(node: SyntaxNode): boolean {
  if (NON_EVENT_NODE_TYPES.has(node.type) || BLOCK_NODE_TYPES.has(node.type)) return false;
  return (
    /(?:statement|declaration)$/u.test(node.type) ||
    node.type === 'expression_statement' ||
    node.type === 'local_variable_declaration'
  );
}

function outermostNodes(nodes: readonly SyntaxNode[]): SyntaxNode[] {
  const selected = new Set(nodes);
  return nodes.filter((node) => {
    let parent = node.parent;
    while (parent) {
      if (selected.has(parent)) return false;
      parent = parent.parent;
    }
    return true;
  });
}

function eventConstruct(node: SyntaxNode): SourceProgramConstruct {
  return construct('event', compact(node.text), node);
}

function construct(kind: SourceProgramConstruct['kind'], label: string, node: SyntaxNode): SourceProgramConstruct {
  return { kind, label, startLine: node.startPosition.row, endLine: node.endPosition.row };
}

function findAnalysisRoot(root: SyntaxNode, startLine: number, endLine: number): SyntaxNode | null {
  const covering: SyntaxNode[] = [];
  walk(root, (node) => {
    if (node.startPosition.row <= startLine && node.endPosition.row >= endLine) covering.push(node);
  });
  const callable = covering.filter((node) => CALLABLE_NODE_TYPES.has(node.type)).sort(compareSpan)[0];
  return callable ?? covering.sort(compareSpan)[0] ?? null;
}

function compareSpan(left: SyntaxNode, right: SyntaxNode): number {
  return left.endIndex - left.startIndex - (right.endIndex - right.startIndex) || left.startIndex - right.startIndex;
}

function descendantsIncludingSelf(node: SyntaxNode): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  walk(node, (candidate) => nodes.push(candidate));
  return nodes;
}

function descendantsWithinStatement(node: SyntaxNode): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  const visit = (candidate: SyntaxNode): void => {
    nodes.push(candidate);
    for (const child of candidate.namedChildren) {
      if (child !== node && CALLABLE_NODE_TYPES.has(child.type)) continue;
      visit(child);
    }
  };
  visit(node);
  return nodes;
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

function compact(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}
