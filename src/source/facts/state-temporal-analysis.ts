import { getAst } from '../ast/ast-core.js';
import {
  sourceAnalysisRoot,
  type SourceRangeColumns,
  ANALYSIS_CALLABLE_NODE_TYPES as CALLABLE_NODE_TYPES,
} from '../ast/ast-callables.js';
import type { SyntaxNode } from '../ast/ast-types.js';
import { sourceBindingResolver, type SourceBindingResolver } from '../ast/source-binding-identity.js';
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
  startColumn?: number;
  endColumn?: number;
  resourceKey?: string;
  identityBasis?: 'compiler-binding-access-path' | 'source-access-occurrence';
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
  columns: SourceRangeColumns = {},
): SourceStateTemporalAnalysis | null {
  const tree = getAst(db, relativePath);
  if (!tree) return null;
  const root = sourceAnalysisRoot(tree.rootNode, startLine, endLine, CALLABLE_NODE_TYPES, columns);
  if (!root) return null;

  const mutations: SourceStateMutationFact[] = [];
  const temporal: SourceTemporalFact[] = [];
  const unsupported: SourceStateTemporalAnalysis['unsupported'] = [];
  const bindings = sourceBindingResolver(relativePath, tree.rootNode);

  walk(root, (node) => {
    if (ASSIGNMENT_NODE_TYPES.has(node.type) || UPDATE_NODE_TYPES.has(node.type) || isDeleteExpression(node)) {
      const mutation = mutationFact(node, bindings);
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
          attributes: { completionRequired: true, executionConditional: true },
        });
        const successor = statements[index + 1];
        if (successor && awaitHasLocalContinuation(awaited, statement)) {
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

function mutationFact(node: SyntaxNode, bindings: SourceBindingResolver): SourceStateMutationFact | null {
  const deleting = isDeleteExpression(node);
  const target = mutationTarget(node, deleting);
  if (!target) return null;
  const resource = resourceIdentity(target);
  if (!resource) return null;
  const operation = mutationOperation(node, target, deleting);
  const value = deleting || UPDATE_NODE_TYPES.has(node.type) ? null : node.childForFieldName('right');
  return {
    event: construct('event', compact(node.text), node),
    resource: {
      ...construct('resource', resource.name, target),
      ...bindings.resource(target),
    },
    operation,
    durabilityClass: 'in-memory',
    recordIdentity: resource.recordIdentity,
    value: value ? construct('value', compact(value.text), value) : null,
    dataSubtype: value ? dataSubtype(value, bindings) : null,
  };
}

function mutationTarget(node: SyntaxNode, deleting: boolean): SyntaxNode | null {
  return (
    node.childForFieldName('left') ??
    node.childForFieldName('argument') ??
    (deleting ? (node.namedChildren.at(-1) ?? null) : (node.namedChildren[0] ?? null))
  );
}

function mutationOperation(node: SyntaxNode, target: SyntaxNode, deleting: boolean): SourceMutationOperation {
  return deleting
    ? 'delete'
    : UPDATE_NODE_TYPES.has(node.type) || !assignmentOperator(node, target).startsWith('=')
      ? 'update'
      : 'assign';
}

function resourceIdentity(node: SyntaxNode): { name: string; recordIdentity: string | null } | null {
  if (SUBSCRIPT_NODE_TYPES.has(node.type)) {
    return subscriptResourceIdentity(node);
  }
  if (MEMBER_NODE_TYPES.has(node.type)) return { name: compact(node.text), recordIdentity: null };
  if (/^(?:identifier|property_identifier|field_identifier)$/u.test(node.type)) {
    return { name: compact(node.text), recordIdentity: null };
  }
  return null;
}

function dataSubtype(node: SyntaxNode, bindings: SourceBindingResolver): SourceStateDataSubtype {
  if (node.type === 'template_string' && node.namedChildren.some((child) => child.type === 'template_substitution'))
    return 'expression-to-state';
  if (LITERAL_NODE_TYPES.has(node.type) || /(?:integer|float|decimal|boolean|character)_literal$/u.test(node.type)) {
    return 'constant-to-state';
  }
  if (CALL_NODE_TYPES.has(node.type)) return 'return-to-state';
  if (MEMBER_NODE_TYPES.has(node.type) || SUBSCRIPT_NODE_TYPES.has(node.type)) return 'property-to-state';
  if (/identifier$/u.test(node.type)) {
    return bindings.isCaptured(node) ? 'captured-value-to-state' : 'value-to-state';
  }
  return 'expression-to-state';
}

/** Only a statement's own expression evaluation establishes its immediate continuation.
 * Nested branches and abrupt completions require control-flow analysis, not source order.
 */
function awaitHasLocalContinuation(awaited: SyntaxNode, statement: SyntaxNode): boolean {
  if (
    !['expression_statement', 'lexical_declaration', 'variable_declaration', 'local_variable_declaration'].includes(
      statement.type,
    )
  )
    return false;
  for (
    let parent = awaited.parent;
    parent &&
    (parent.startIndex !== statement.startIndex ||
      parent.endIndex !== statement.endIndex ||
      parent.type !== statement.type);
    parent = parent.parent
  ) {
    if (BLOCK_NODE_TYPES.has(parent.type) || /(?:statement|clause)$/u.test(parent.type)) return false;
  }
  return true;
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
  return {
    kind,
    label,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
  };
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
  for (const child of node.namedChildren) {
    if (!CALLABLE_NODE_TYPES.has(child.type)) walk(child, visit);
  }
}

function compact(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

function subscriptResourceIdentity(node: SyntaxNode): { name: string; recordIdentity: string | null } | null {
  const object = node.childForFieldName('object') ?? node.childForFieldName('array') ?? node.namedChildren[0] ?? null;
  const index = node.childForFieldName('index') ?? node.childForFieldName('subscript') ?? node.namedChildren[1] ?? null;
  if (!object || !index) return null;
  return { name: `${compact(object.text)}[]`, recordIdentity: compact(index.text) };
}
