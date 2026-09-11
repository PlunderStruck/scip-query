import { sourceModuleReferences, type ModuleReference } from './module-references.js';
import { extname } from 'node:path';
import { ts } from '@ts-morph/common';
import { parseSourceBindings } from './function-metrics.js';
import type { SyntaxNode } from './ast-types.js';
import {
  accessBinding,
  constantValueExpression,
  aliasedDeclaration,
  enclosingCallable,
  memberLiteralKey,
  unwrapBindingExpression,
} from './source-binding-access.js';
import { sourceBindingEffects } from './source-binding-effects.js';

interface ResourceIdentity {
  resourceKey: string;
  identityBasis: 'compiler-binding-access-path' | 'source-access-occurrence';
}

export interface SourceBindingResolver {
  readonly available: boolean;
  moduleReferences(): ModuleReference[];
  resource(node: SyntaxNode): ResourceIdentity;
  isCaptured(node: SyntaxNode): boolean;
  directParameterPosition(node: SyntaxNode): number | null;
  tupleElements(node: SyntaxNode): SyntaxNode[] | null;
  callableParameters(node: SyntaxNode): Array<'direct' | 'rest' | 'default' | 'destructured'> | null;
  hasLocalBinding(node: SyntaxNode): boolean;
  isParameterBinding(node: SyntaxNode): boolean;
  constantInitializer(node: SyntaxNode): SyntaxNode | null;
  callableValue(node: SyntaxNode): SyntaxNode | null;
  hasObservedWrite(
    node: SyntaxNode,
    includeProperties?: boolean,
    memberPath?: readonly string[],
    includeContents?: boolean,
    observedAt?: SyntaxNode | null,
  ): boolean;
  hasObservedCallableWrite(node: SyntaxNode, memberPath?: readonly string[], observedAt?: SyntaxNode): boolean;
  hasEscapedValue(node: SyntaxNode, memberPath: readonly string[]): boolean;
  valueDeclaration(
    node: SyntaxNode,
  ): { name: string; startLine: number; startColumn: number; endLine: number; endColumn: number } | null;
  importedValue(node: SyntaxNode): { module: string; member: string | null } | null;
  constructedValue(node: SyntaxNode): { module: string; member: string | null } | null;
}

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const cache = new WeakMap<SyntaxNode, SourceBindingResolver>();

/** Identify a source access by its lexical declaration, never by an assumed heap object. */
export function sourceBindingResolver(file: string, root: SyntaxNode): SourceBindingResolver {
  const cached = cache.get(root);
  if (cached) return cached;
  const parsed = SUPPORTED_EXTENSIONS.has(extname(file)) ? parseSourceBindings(file, root.text) : null;
  const valid = parsed && parsed.errors.length === 0 ? parsed : null;
  // Module references and declaration identity do not need mutation analysis or
  // a reverse map of every parser node. Prepare each view only for its consumers.
  let indexedNodes: ReturnType<typeof indexBindingNodes> | undefined;
  const nodes = () => (indexedNodes ??= indexBindingNodes(root, valid));
  let indexedSyntax: Map<string, SyntaxNode> | undefined;
  const syntax = () => (indexedSyntax ??= indexSourceSyntax(root));
  let computedEffects: ReturnType<typeof sourceBindingEffects> | null | undefined;
  const effects = () =>
    computedEffects === undefined
      ? (computedEffects = valid ? sourceBindingEffects(valid.sourceFile, valid.checker) : null)
      : computedEffects;
  const noWrites = new Set<ts.Declaration>();
  const written = () => effects()?.written ?? noWrites;
  const expressionFor = (node: SyntaxNode) => nodes().expressions.get(`${node.startIndex}:${node.endIndex}`);
  const declaration = (node: SyntaxNode): ts.Declaration | undefined => {
    const identifier = nodes().identifiers.get(node.startIndex);
    if (!identifier || !parsed) return undefined;
    return accessBinding(identifier, parsed.checker);
  };
  const observedWrite = (
    node: SyntaxNode,
    includeProperties = false,
    memberPath: readonly string[] = [],
    contents = true,
    observedAt: SyntaxNode | null = node,
  ): boolean => {
    const expression = expressionFor(node);
    if (!expression || !parsed) return false;
    const observation = observedAt ? (expressionFor(observedAt) ?? expression) : null;
    return (
      effects()?.hasWrite(expression, includeProperties, memberPath, contents, observation) ??
      !!declaration(accessBase(node))
    );
  };
  const resolver: SourceBindingResolver = {
    available: !!parsed && parsed.errors.length === 0,
    moduleReferences() {
      return parsed && parsed.errors.length === 0
        ? sourceModuleReferences(parsed.sourceFile, () => parsed.checker).map((reference) => ({
            ...reference,
            line: reference.line + root.startPosition.row,
          }))
        : [];
    },
    constantInitializer(node) {
      const binding = declaration(node);
      if (
        !binding ||
        !ts.isVariableDeclaration(binding) ||
        !binding.initializer ||
        !(binding.parent.flags & ts.NodeFlags.Const) ||
        written().has(binding)
      )
        return null;
      return syntax().get(`${binding.initializer.getStart()}:${binding.initializer.end}`) ?? null;
    },
    callableValue(node) {
      const expression = expressionFor(node);
      if (!expression || !parsed) return null;
      const binding = aliasedDeclaration(expression, parsed.checker, written());
      const value = binding && ts.isVariableDeclaration(binding) ? binding.initializer : binding;
      return callableSourceNode(value, syntax());
    },
    hasObservedWrite: observedWrite,
    hasEscapedValue(node, memberPath) {
      const expression = expressionFor(node);
      return !!expression && !!effects()?.hasEscapedValue(expression, memberPath);
    },
    hasObservedCallableWrite(node, memberPath = [], observedAt = node) {
      return observedWrite(node, true, memberPath, false, observedAt);
    },
    callableParameters(node) {
      const matches = [...nodes().expressions.values()].filter(
        (candidate) =>
          ts.isFunctionLike(candidate) &&
          candidate.end + root.startIndex === node.endIndex &&
          candidate.getStart() + root.startIndex <= node.startIndex,
      );
      if (matches.length !== 1 || !ts.isFunctionLike(matches[0]!)) return null;
      return matches[0]!.parameters
        .filter((parameter) => parameter.name.getText() !== 'this')
        .map((parameter) =>
          parameter.dotDotDotToken
            ? 'rest'
            : parameter.initializer
              ? 'default'
              : ts.isIdentifier(parameter.name)
                ? 'direct'
                : 'destructured',
        );
    },
    hasLocalBinding(node) {
      const identifier = nodes().identifiers.get(accessBase(node).startIndex);
      return !!identifier && !!parsed?.checker.getSymbolAtLocation(identifier)?.declarations?.length;
    },
    isParameterBinding(node) {
      const expression = expressionFor(node);
      return !!expression && !!effects()?.usesParameter(expression);
    },
    valueDeclaration(node) {
      if (!parsed) return null;
      const expression = expressionFor(node);
      const binding = expression && aliasedDeclaration(expression, parsed.checker, written());
      if (!binding || !ts.isVariableDeclaration(binding) || !ts.isIdentifier(binding.name)) return null;
      const start = parsed.sourceFile.getLineAndCharacterOfPosition(binding.getStart());
      const end = parsed.sourceFile.getLineAndCharacterOfPosition(binding.end);
      return {
        name: binding.name.text,
        startLine: start.line + root.startPosition.row,
        startColumn: start.character + (start.line === 0 ? root.startPosition.column : 0),
        endLine: end.line + root.startPosition.row,
        endColumn: end.character + (end.line === 0 ? root.startPosition.column : 0),
      };
    },
    importedValue(node) {
      const expression = expressionFor(node);
      return expression && parsed ? importedExpression(expression, parsed.checker, new Set()) : null;
    },
    constructedValue(node) {
      const expression = expressionFor(node);
      return expression && parsed ? constructedExpression(expression, parsed.checker, new Set()) : null;
    },
    resource(node) {
      const base = accessBase(node);
      const binding = declaration(base);
      if (!binding)
        return { resourceKey: `access:${node.startIndex}:${node.endIndex}`, identityBasis: 'source-access-occurrence' };
      const path = node.text.slice(base.endIndex - node.startIndex).trim();
      return {
        resourceKey: `binding:${binding.getStart()}:${binding.end}:${path}`,
        identityBasis: 'compiler-binding-access-path',
      };
    },
    isCaptured(node) {
      const identifier = nodes().identifiers.get(node.startIndex);
      const binding = declaration(node);
      const declaringCallable = binding && enclosingCallable(binding);
      const usingCallable = identifier && enclosingCallable(identifier);
      return !!declaringCallable && !!usingCallable && declaringCallable !== usingCallable;
    },
    directParameterPosition(node) {
      const expression = expressionFor(node);
      const identifier = expression && unwrapBindingExpression(expression);
      if (!identifier || !ts.isIdentifier(identifier) || !parsed) return null;
      const binding = aliasedDeclaration(identifier, parsed.checker, written());
      if (!binding || !ts.isParameter(binding) || !ts.isIdentifier(binding.name)) return null;
      if (enclosingCallable(identifier) !== binding.parent || written().has(binding)) return null;
      const parameters = binding.parent.parameters.filter((parameter) => parameter.name.getText() !== 'this');
      const position = parameters.indexOf(binding);
      return position >= 0 ? position : null;
    },
    tupleElements(node) {
      const original = expressionFor(node);
      if (!original || !parsed || observedWrite(node, true)) return null;
      const value = constantValueExpression(original, parsed.checker, written());
      if (
        !value ||
        !ts.isArrayLiteralExpression(value) ||
        value.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element))
      )
        return null;
      const elements = value.elements.map((element) => syntax().get(`${element.getStart()}:${element.end}`));
      return elements.every((element): element is SyntaxNode => !!element) ? elements : null;
    },
  };
  cache.set(root, resolver);
  return resolver;
}

function indexBindingNodes(root: SyntaxNode, parsed: ReturnType<typeof parseSourceBindings> | null) {
  const identifiers = new Map<number, ts.Identifier>();
  const expressions = new Map<string, ts.Node>();
  if (parsed) {
    const visit = (node: ts.Node): void => {
      const start = node.getStart(parsed.sourceFile) + root.startIndex;
      if (ts.isIdentifier(node)) identifiers.set(start, node);
      expressions.set(`${start}:${node.end + root.startIndex}`, node);
      ts.forEachChild(node, visit);
    };
    visit(parsed.sourceFile);
  }
  return { identifiers, expressions };
}

function indexSourceSyntax(root: SyntaxNode): Map<string, SyntaxNode> {
  const syntax = new Map<string, SyntaxNode>();
  const visit = (node: SyntaxNode): void => {
    syntax.set(`${node.startIndex - root.startIndex}:${node.endIndex - root.startIndex}`, node);
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return syntax;
}

type ImportedValue = ReturnType<SourceBindingResolver['importedValue']>;

function constructedExpression(node: ts.Node, checker: ts.TypeChecker, seen: Set<ts.Node>): ImportedValue {
  if (seen.has(node)) return null;
  seen.add(node);
  if (ts.isCallExpression(node) || ts.isNewExpression(node))
    return importedExpression(node.expression, checker, new Set());
  if (!ts.isIdentifier(node)) return null;
  const binding = checker.getSymbolAtLocation(node)?.valueDeclaration;
  return binding &&
    ts.isVariableDeclaration(binding) &&
    binding.initializer &&
    binding.parent.flags & ts.NodeFlags.Const
    ? constructedExpression(binding.initializer, checker, seen)
    : null;
}

function importedExpression(node: ts.Node, checker: ts.TypeChecker, seen: Set<ts.Node>): ImportedValue {
  if (seen.has(node)) return null;
  seen.add(node);
  node = unwrapBindingExpression(node);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const base = importedExpression(node.expression, checker, seen);
    const member = ts.isPropertyAccessExpression(node) ? node.name.text : memberLiteralKey(node.argumentExpression);
    return base && member !== null && (base.member === null || base.member === 'default')
      ? { module: base.module, member }
      : null;
  }
  if (ts.isCallExpression(node)) return requiredModule(node, checker);
  return importedIdentifier(node, checker, seen);
}

function importedIdentifier(node: ts.Node, checker: ts.TypeChecker, seen: Set<ts.Node>): ImportedValue {
  if (!ts.isIdentifier(node)) return null;
  const binding = checker.getSymbolAtLocation(node)?.declarations?.[0];
  if (!binding) return null;
  if (ts.isVariableDeclaration(binding) && binding.initializer && binding.parent.flags & ts.NodeFlags.Const)
    return importedExpression(binding.initializer, checker, seen);
  if (ts.isBindingElement(binding)) return importedDestructuredBinding(binding, checker, seen);
  return importedDeclaration(binding);
}

function requiredModule(node: ts.CallExpression, checker: ts.TypeChecker): ImportedValue {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'require') return null;
  const argument = node.arguments[0];
  if (
    checker.getSymbolAtLocation(node.expression)?.valueDeclaration ||
    node.arguments.length !== 1 ||
    !argument ||
    !ts.isStringLiteralLike(argument)
  )
    return null;
  return { module: argument.text, member: null };
}

function importedMember(binding: ts.Declaration): { member: string | null } | null {
  if (ts.isImportSpecifier(binding) && !binding.isTypeOnly)
    return { member: (binding.propertyName ?? binding.name).text };
  if (ts.isNamespaceImport(binding)) return { member: null };
  if (ts.isImportClause(binding) && !binding.isTypeOnly) return { member: 'default' };
  return null;
}

function importedDeclaration(binding: ts.Declaration): ImportedValue {
  const imported = importedMember(binding);
  if (!imported) return null;
  const { member } = imported;
  for (let parent: ts.Node | undefined = binding.parent; parent; parent = parent.parent) {
    if (ts.isImportClause(parent) && parent.isTypeOnly) return null;
    if (ts.isImportDeclaration(parent))
      return ts.isStringLiteralLike(parent.moduleSpecifier) ? { module: parent.moduleSpecifier.text, member } : null;
  }
  return null;
}

function importedDestructuredBinding(
  binding: ts.BindingElement,
  checker: ts.TypeChecker,
  seen: Set<ts.Node>,
): ImportedValue {
  if (!ts.isObjectBindingPattern(binding.parent) || binding.dotDotDotToken || binding.initializer) return null;
  const variable = binding.parent.parent;
  if (!ts.isVariableDeclaration(variable) || !variable.initializer || !(variable.parent.flags & ts.NodeFlags.Const))
    return null;
  const base = importedExpression(variable.initializer, checker, seen);
  const property = binding.propertyName ?? binding.name;
  if (!base || base.member !== null) return null;
  const name = importedPropertyName(property);
  return name === null ? null : { module: base.module, member: name };
}

function importedPropertyName(node: ts.Node): string | null {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
}

function accessBase(node: SyntaxNode): SyntaxNode {
  const object = node.childForFieldName('object') ?? node.childForFieldName('array');
  return object ? accessBase(object) : node;
}

function callableSourceNode(value: ts.Node | undefined, syntax: ReadonlyMap<string, SyntaxNode>): SyntaxNode | null {
  if (!value || !(ts.isFunctionDeclaration(value) || ts.isFunctionExpression(value) || ts.isArrowFunction(value)))
    return null;
  const callable = syntax.get(`${value.getStart()}:${value.end}`);
  // TypeScript includes the export modifier in a declaration's range; the
  // source parser represents that modifier as a separate enclosing unit.
  return callable?.type === 'export_statement' ? callable.childForFieldName('declaration') : (callable ?? null);
}
