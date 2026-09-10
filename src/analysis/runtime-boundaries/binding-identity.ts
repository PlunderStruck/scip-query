import { sourceCallableBindings } from './object-members.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { scipOccurrenceTargetsForFile } from '../../symbols/graph/scip-occurrence-call-targets.js';
import { sameOccurrenceRange } from '../../symbols/graph/scip-chunk-occurrences.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { sourceBindingResolver } from '../../source/ast/source-binding-identity.js';
import { callableValueWasWritten } from '../../symbols/graph/imported-value-context.js';
import { resolveImportedDefinitions } from '../../symbols/imported-definitions.js';
import { resolveImportPath } from '../../source/primitives/import-path-resolver.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import type { BoundaryFileContext, BoundaryKeyPart } from './types.js';

export function runtimeBindingIdentity(context: BoundaryFileContext, node: SyntaxNode): Omit<BoundaryKeyPart, 'name'> {
  const bindings = sourceBindingResolver(context.file, context.root);
  if (bindings.hasObservedWrite(node))
    return { value: node.text, evidence: 'expression', term: { kind: 'unknown', reason: 'binding-observed-write' } };
  const declared = bindings.valueDeclaration(node);
  if (declared) {
    const owners = getDefinitionsForFile(context.db, context.file).filter(
      (definition) =>
        definition.leaf === declared.name &&
        definition.startLine === declared.startLine &&
        (definition.startChar ?? 0) <= declared.startColumn &&
        definition.endLine >= declared.endLine,
    );
    if (owners.length === 1)
      return { value: node.text, evidence: 'identifier', term: { kind: 'symbol', symbol: owners[0]!.symbol } };
    return {
      value: node.text,
      evidence: 'identifier',
      term: {
        kind: 'symbol',
        symbol: `${context.file}:${declared.startLine}:${declared.startColumn}:${declared.endLine}:${declared.endColumn}`,
      },
    };
  }
  const range = {
    startLine: node.startPosition.row,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row,
    endColumn: node.endPosition.column,
  };
  const targets =
    scipOccurrenceTargetsForFile(context.db, context.file)?.targets.filter((target) =>
      sameOccurrenceRange(target.sourceRange, range),
    ) ?? [];
  const symbols = new Set(targets.map((target) => target.definition.symbol));
  if (symbols.size === 1)
    return { value: node.text, evidence: 'identifier', term: { kind: 'symbol', symbol: [...symbols][0]! } };
  const definitions = getDefinitionsForFile(context.db, context.file).filter(
    (definition) =>
      definition.leaf === node.text &&
      definition.startLine === range.startLine &&
      (definition.startChar ?? 0) <= range.startColumn &&
      definition.endLine >= range.endLine,
  );
  if (definitions.length === 1)
    return { value: node.text, evidence: 'identifier', term: { kind: 'symbol', symbol: definitions[0]!.symbol } };
  const imported = bindings.importedValue(node);
  if (imported?.member) {
    const file = resolveImportPath(context.db, context.file, imported.module);
    const targets = file ? resolveImportedDefinitions(context.db, file, imported.member) : [];
    if (targets.length === 1)
      return { value: node.text, evidence: 'identifier', term: { kind: 'symbol', symbol: targets[0]!.symbol } };
  }
  const identity = bindings.resource(node);
  return {
    value: node.text,
    term: { kind: 'symbol', symbol: `${context.file}:${identity.resourceKey}` },
    evidence: identity.identityBasis === 'compiler-binding-access-path' ? 'identifier' : 'expression',
  };
}

/** Resolve a handler expression only through its exact compiler reference or local declaration. */
export function runtimeCallableDefinition(context: BoundaryFileContext, node: SyntaxNode): IndexedDefinition | null {
  const bindings = sourceBindingResolver(context.file, context.root);
  if (callableValueWasWritten(context, node)) return null;
  const range = {
    startLine: node.startPosition.row,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row,
    endColumn: node.endPosition.column,
  };
  const references =
    scipOccurrenceTargetsForFile(context.db, context.file)?.targets.filter(
      (target) => sameOccurrenceRange(target.sourceRange, range) && target.definition.isFunctionLike,
    ) ?? [];
  const definitions = new Map(references.map((target) => [target.definition.symbol, target.definition]));
  if (definitions.size === 1) return [...definitions.values()][0]!;
  const identity = runtimeBindingIdentity(context, node);
  if (identity.evidence === 'expression' || identity.term?.kind !== 'symbol') return null;
  const symbol = identity.term.symbol;
  const local = getDefinitionsForFile(context.db, context.file).filter(
    (definition) => definition.symbol === symbol && definition.isFunctionLike,
  );
  if (local.length === 1) return local[0]!;
  return runtimeCallableFromSource(context, node, bindings);
}

function runtimeCallableFromSource(
  context: BoundaryFileContext,
  node: SyntaxNode,
  bindings: ReturnType<typeof sourceBindingResolver>,
): IndexedDefinition | null {
  const callable = bindings.callableValue(node);
  const name = bindings.valueDeclaration(node)?.name ?? callable?.childForFieldName('name')?.text;
  if (!callable || !name) return null;
  const source = sourceCallableBindings(context.db, context.file, name).filter(
    (definition) =>
      definition.startLine <= callable.startPosition.row &&
      definition.endLine === callable.endPosition.row &&
      (definition.startLine !== callable.startPosition.row ||
        (definition.startChar ?? 0) <= callable.startPosition.column) &&
      definition.endChar === callable.endPosition.column,
  );
  return source.length === 1 ? source[0]! : null;
}
