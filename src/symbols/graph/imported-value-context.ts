import { getAst } from '../../source/ast/ast-core.js';
import { unwrapExpression, walkNamedSyntax } from '../../source/ast/ast-callables.js';
import { sourceBindingResolver } from '../../source/ast/source-binding-identity.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import { resolveImportPath } from '../../source/primitives/import-path-resolver.js';
import type { ScipDatabase } from '../../storage/db.js';
import { resolveImportedDefinitions } from '../imported-definitions.js';
import { javaScriptStringValue } from './javascript-string-value.js';
import { chunkOccurrenceTargetsForFile, sameOccurrenceRange } from './scip-chunk-occurrences.js';
import { readRepositoryTextFile } from '../../source/primitives/repository-text.js';
import { getDefinitionsForFile } from '../definition-catalog.js';
import { recordSymbolReferenceAccess } from '../../domain/file-access-recorder.js';

export interface BoundaryValueContext {
  db: ScipDatabase;
  file: string;
  root: SyntaxNode;
}

export function importedTarget(context: BoundaryValueContext, node: SyntaxNode, namespaceMember?: string) {
  const imported = sourceBindingResolver(context.file, context.root).importedValue(node);
  const member = imported?.member ?? namespaceMember;
  if (!imported || !member) return null;
  const compilerTarget = imported.member !== null ? importedOccurrenceTarget(context, node) : null;
  if (compilerTarget) return compilerTarget;
  const file = resolveImportPath(context.db, context.file, imported.module);
  const targets = file ? resolveImportedDefinitions(context.db, file, member) : [];
  return targets.length === 1 ? targets[0]! : null;
}

/** The compiler reference already follows renamed and default re-exports to their defining file. */
function importedOccurrenceTarget(context: BoundaryValueContext, input: SyntaxNode) {
  const node = unwrapExpression(input);
  if (node.type !== 'identifier') return null;
  if (readRepositoryTextFile(context.db, context.file)?.freshness.semantic.state === 'stale') return null;
  const range = {
    startLine: node.startPosition.row,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row,
    endColumn: node.endPosition.column,
  };
  const occurrences = chunkOccurrenceTargetsForFile(context.db, context.file);
  if (!occurrences.available) return null;
  const matches = occurrences.targets.filter(
    (target) => target.definition.relativePath !== context.file && sameOccurrenceRange(target.sourceRange, range),
  );
  const unique = new Map(matches.map((target) => [target.definition.symbol, target.definition]));
  return unique.size === 1 ? [...unique.values()][0]! : null;
}

export function importedDefinitionContext(
  context: BoundaryValueContext,
  target: NonNullable<ReturnType<typeof importedTarget>>,
) {
  const root = getAst(context.db, target.relativePath)?.rootNode;
  const declaration = root && definitionBinding(root, target);
  return root && declaration ? { context: { ...context, file: target.relativePath, root }, declaration } : null;
}

/** Qualify shared object contents using compiler-linked uses in other indexed modules. */
export function sharedMemberWriteIsUnproved(
  context: BoundaryValueContext,
  node: SyntaxNode,
  properties: readonly string[],
): boolean {
  const bindings = sourceBindingResolver(context.file, context.root);
  if (bindings.hasEscapedValue(node, properties)) return true;
  const declaration = bindings.valueDeclaration(node);
  if (!declaration) return false;
  const definitions = getDefinitionsForFile(context.db, context.file).filter(
    (definition) =>
      definition.leaf === declaration.name &&
      definition.startLine === declaration.startLine &&
      (definition.startChar ?? 0) <= declaration.startColumn &&
      definition.endLine >= declaration.endLine,
  );
  if (definitions.length !== 1) return false;
  const symbol = definitions[0]!.symbol;
  const files = sharedSymbolReferencingFiles(context.db, symbol);
  recordSymbolReferenceAccess(symbol, files);
  return files.some((file) => file !== context.file && referringFileMayWrite(context, file, symbol, properties));
}

export function sharedSymbolReferencingFiles(db: ScipDatabase, symbol: string): string[] {
  return db
    .all<{ relative_path: string }>(
      `SELECT DISTINCT d.relative_path FROM global_symbols gs
     JOIN mentions m ON m.symbol_id = gs.id JOIN chunks c ON c.id = m.chunk_id
     JOIN documents d ON d.id = c.document_id WHERE gs.symbol = ?`,
      symbol,
    )
    .map((row) => row.relative_path)
    .sort();
}

function referringFileMayWrite(
  context: BoundaryValueContext,
  file: string,
  symbol: string,
  properties: readonly string[],
): boolean {
  const text = readRepositoryTextFile(context.db, file);
  const root = getAst(context.db, file)?.rootNode;
  const occurrences = chunkOccurrenceTargetsForFile(context.db, file);
  if (!root || !text || text.freshness.semantic.state === 'stale' || !occurrences.available) return true;
  const references = occurrences.targets.filter((target) => target.definition.symbol === symbol);
  const bindings = sourceBindingResolver(file, root);
  if (!bindings.available || references.length === 0) return true;
  const unmatched = new Set(references);
  let written = false;
  walkNamedSyntax(root, (node) => {
    if (
      written ||
      ![
        'identifier',
        'property_identifier',
        'shorthand_property_identifier',
        'string',
        'string_fragment',
        'number',
      ].includes(node.type)
    )
      return;
    const range = {
      startLine: node.startPosition.row,
      startColumn: node.startPosition.column,
      endLine: node.endPosition.row,
      endColumn: node.endPosition.column,
    };
    const matches = references.filter((target) => sameOccurrenceRange(target.sourceRange, range));
    if (matches.length === 0) return;
    for (const match of matches) unmatched.delete(match);
    const access = referenceValueAccess(node);
    // Replacing this slot changes a literal; passing its primitive value to an
    // unknown consumer cannot mutate the slot that supplied it.
    written = !access || bindings.hasObservedWrite(access, true, properties, false, null);
  });
  return written || unmatched.size > 0;
}

function referenceValueAccess(node: SyntaxNode): SyntaxNode | null {
  const reference = node.type === 'string_fragment' ? (node.parent ?? node) : node;
  const access =
    reference.parent && (node.type === 'property_identifier' || reference.parent.type === 'subscript_expression')
      ? reference.parent
      : reference;
  return ['identifier', 'shorthand_property_identifier', 'member_expression', 'subscript_expression'].includes(
    access.type,
  )
    ? access
    : null;
}

/** One bounded owner for local and imported callable values, shared by calls and constants. */
export function resolveCallableValue(
  context: BoundaryValueContext,
  node: SyntaxNode,
): { context: BoundaryValueContext; callable: SyntaxNode } | null {
  const callable = sourceBindingResolver(context.file, context.root).callableValue(node);
  if (callable) return { context, callable };
  const target = importedTarget(context, node);
  const resolved = target && importedDefinitionContext(context, target);
  if (!resolved) return null;
  const value = resolved.declaration;
  const imported = [
    'function_declaration',
    'function_expression',
    'arrow_function',
    'generator_function_declaration',
  ].includes(value.type)
    ? value
    : sourceBindingResolver(resolved.context.file, resolved.context.root).callableValue(value);
  return imported ? { context: resolved.context, callable: imported } : null;
}

export function definitionBinding(
  root: SyntaxNode,
  target: ReturnType<typeof resolveImportedDefinitions>[number],
): SyntaxNode | null {
  const candidates: SyntaxNode[] = [];
  walkNamedSyntax(root, (node) => {
    if (
      ![
        'variable_declarator',
        'function_declaration',
        'generator_function_declaration',
        'function_expression',
        'arrow_function',
      ].includes(node.type)
    )
      return;
    const name = node.childForFieldName('name');
    const anonymousDefault = !name && target.symbol.endsWith('/default().') && isDefaultExportValue(node);
    if (
      (!anonymousDefault && name?.text !== target.leaf) ||
      node.startPosition.row !== target.startLine ||
      node.endPosition.row > target.endLine
    )
      return;
    if (node.startPosition.column < (target.startChar ?? 0)) return;
    if (node.endPosition.row === target.endLine && target.endChar && node.endPosition.column > target.endChar) return;
    candidates.push(anonymousDefault ? node : name!);
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

/** Check the observed value in its defining file as well as the invocation's file. */
export function callableValueWasWritten(
  context: BoundaryValueContext,
  input: SyntaxNode,
  path: readonly string[] = [],
  seen: ReadonlySet<string> = new Set(),
  observedAt = { file: context.file, node: input },
): boolean {
  const node = unwrapExpression(input);
  const key = `${context.file}:${node.startIndex}:${node.endIndex}:${JSON.stringify(path)}`;
  if (seen.has(key)) return false;
  const next = new Set(seen).add(key);
  const bindings = sourceBindingResolver(context.file, context.root);
  if (bindings.hasObservedCallableWrite(node, path, observedAt.file === context.file ? observedAt.node : undefined))
    return true;
  const member = memberParts(node);
  const base = member?.base ?? node;
  const properties = [...(member?.properties ?? []), ...path];
  const local = bindings.constantInitializer(base);
  if (local) return callableValueWasWritten(context, local, properties, next, observedAt);
  const imported = bindings.importedValue(base);
  if (!imported) return false;
  const target = importedTarget(context, base, properties[0]);
  const resolved = target && importedDefinitionContext(context, target);
  if (!resolved) return false;
  const remaining = imported.member === null ? properties.slice(1) : properties;
  return callableValueWasWritten(resolved.context, resolved.declaration, remaining, next, observedAt);
}

/** Retain literal member identity through wrappers; a computed name stays unresolved. */
export function memberParts(input: SyntaxNode): { base: SyntaxNode; properties: string[] } | null {
  const node = unwrapExpression(input);
  if (!['member_expression', 'subscript_expression'].includes(node.type)) return null;
  const object = node.childForFieldName('object');
  const property =
    node.type === 'member_expression' ? node.childForFieldName('property') : node.childForFieldName('index');
  const key = property ? literalMemberKey(property) : null;
  if (!object || key === null) return null;
  const parent = memberParts(object);
  return parent
    ? { base: parent.base, properties: [...parent.properties, key] }
    : { base: unwrapExpression(object), properties: [key] };
}

function literalMemberKey(node: SyntaxNode): string | null {
  if (node.type === 'property_identifier') return node.text;
  if (node.type === 'number') {
    const value = Number(node.text.replaceAll('_', ''));
    return Number.isFinite(value) ? String(value) : null;
  }
  const value = javaScriptStringValue(node);
  return value && !value.interpolated ? value.value : null;
}

function isDefaultExportValue(node: SyntaxNode): boolean {
  let current = node;
  while (current.parent) {
    const unwrapped = unwrapExpression(current.parent);
    if (unwrapped.startIndex !== node.startIndex || unwrapped.endIndex !== node.endIndex) break;
    current = current.parent;
  }
  return current.parent?.type === 'export_statement';
}
