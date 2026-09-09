import { sourceModuleReferences, type ModuleReference } from './module-references.js';
import { extname } from 'node:path';
import { ts } from '@ts-morph/common';
import { parseSourceBindings } from './function-metrics.js';
import type { SyntaxNode } from './ast-types.js';

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
  callableParameters(node: SyntaxNode): Array<'direct' | 'rest' | 'default' | 'destructured'> | null;
  hasLocalBinding(node: SyntaxNode): boolean;
  constantInitializer(node: SyntaxNode): SyntaxNode | null;
  callableValue(node: SyntaxNode): SyntaxNode | null;
  hasObservedWrite(node: SyntaxNode, includeProperties?: boolean): boolean;
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
  const identifiers = new Map<number, ts.Identifier>();
  const expressions = new Map<string, ts.Node>();
  const written = new Set<ts.Declaration>();
  const propertyWrites = new Set<ts.Declaration>();
  const syntax = new Map<string, SyntaxNode>();
  const collectSyntax = (node: SyntaxNode): void => {
    syntax.set(`${node.startIndex}:${node.endIndex}`, node);
    for (const child of node.namedChildren) collectSyntax(child);
  };
  collectSyntax(root);
  const parsed = SUPPORTED_EXTENSIONS.has(extname(file)) ? parseSourceBindings(file, root.text) : null;
  if (parsed && parsed.errors.length === 0) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) identifiers.set(node.getStart(parsed.sourceFile), node);
      expressions.set(`${node.getStart(parsed.sourceFile)}:${node.end}`, node);
      for (const target of assignedIdentifiers(node)) {
        const symbol = ts.isShorthandPropertyAssignment(target.parent)
          ? parsed.checker.getShorthandAssignmentValueSymbol(target.parent)
          : parsed.checker.getSymbolAtLocation(target);
        if (symbol?.valueDeclaration) written.add(symbol.valueDeclaration);
      }
      for (const target of assignedProperties(node)) {
        const binding = aliasedDeclaration(target, parsed.checker);
        if (binding) propertyWrites.add(binding);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed.sourceFile);
  }
  const declaration = (node: SyntaxNode): ts.Declaration | undefined => {
    const identifier = identifiers.get(node.startIndex);
    if (!identifier || !parsed) return undefined;
    const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
      ? parsed.checker.getShorthandAssignmentValueSymbol(identifier.parent)
      : parsed.checker.getSymbolAtLocation(identifier);
    return symbol?.valueDeclaration;
  };
  const resolver: SourceBindingResolver = {
    available: !!parsed && parsed.errors.length === 0,
    moduleReferences() {
      return parsed && parsed.errors.length === 0 ? sourceModuleReferences(parsed.sourceFile, parsed.checker) : [];
    },
    constantInitializer(node) {
      const binding = declaration(node);
      if (
        !binding ||
        !ts.isVariableDeclaration(binding) ||
        !binding.initializer ||
        !(binding.parent.flags & ts.NodeFlags.Const) ||
        written.has(binding)
      )
        return null;
      return syntax.get(`${binding.initializer.getStart()}:${binding.initializer.end}`) ?? null;
    },
    callableValue(node) {
      const expression = expressions.get(`${node.startIndex}:${node.endIndex}`);
      if (!expression || !parsed) return null;
      const binding = aliasedDeclaration(expression, parsed.checker, written);
      const value = binding && ts.isVariableDeclaration(binding) ? binding.initializer : binding;
      return value && (ts.isFunctionDeclaration(value) || ts.isFunctionExpression(value) || ts.isArrowFunction(value))
        ? (syntax.get(`${value.getStart()}:${value.end}`) ?? null)
        : null;
    },
    hasObservedWrite(node, includeProperties = false) {
      const expression = expressions.get(`${accessBase(node).startIndex}:${accessBase(node).endIndex}`);
      if (!expression || !parsed || !declaration(accessBase(node))) return false;
      const binding = aliasedDeclaration(expression, parsed.checker, written);
      return !binding || written.has(binding) || (includeProperties && propertyWrites.has(binding));
    },
    callableParameters(node) {
      const matches = [...expressions.values()].filter(
        (candidate) =>
          ts.isFunctionLike(candidate) && candidate.end === node.endIndex && candidate.getStart() <= node.startIndex,
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
      const identifier = identifiers.get(accessBase(node).startIndex);
      return !!identifier && !!parsed?.checker.getSymbolAtLocation(identifier)?.declarations?.length;
    },
    valueDeclaration(node) {
      if (!parsed) return null;
      const expression = expressions.get(`${node.startIndex}:${node.endIndex}`);
      const binding = expression && aliasedDeclaration(expression, parsed.checker, written);
      if (!binding || !ts.isVariableDeclaration(binding) || !ts.isIdentifier(binding.name)) return null;
      const start = parsed.sourceFile.getLineAndCharacterOfPosition(binding.getStart());
      const end = parsed.sourceFile.getLineAndCharacterOfPosition(binding.end);
      return {
        name: binding.name.text,
        startLine: start.line,
        startColumn: start.character,
        endLine: end.line,
        endColumn: end.character,
      };
    },
    importedValue(node) {
      const expression = expressions.get(`${node.startIndex}:${node.endIndex}`);
      return expression && parsed ? importedExpression(expression, parsed.checker, new Set()) : null;
    },
    constructedValue(node) {
      const expression = expressions.get(`${node.startIndex}:${node.endIndex}`);
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
      const identifier = identifiers.get(node.startIndex);
      const binding = declaration(node);
      const declaringCallable = binding && enclosingCallable(binding);
      const usingCallable = identifier && enclosingCallable(identifier);
      return !!declaringCallable && !!usingCallable && declaringCallable !== usingCallable;
    },
    directParameterPosition(node) {
      if (!['identifier', 'shorthand_property_identifier'].includes(node.type)) return null;
      const identifier = identifiers.get(node.startIndex);
      const binding = declaration(node);
      if (!identifier || !binding || !ts.isParameter(binding) || !ts.isIdentifier(binding.name)) return null;
      if (enclosingCallable(identifier) !== binding.parent || written.has(binding)) return null;
      const parameters = binding.parent.parameters.filter((parameter) => parameter.name.getText() !== 'this');
      const position = parameters.indexOf(binding);
      return position >= 0 ? position : null;
    },
  };
  cache.set(root, resolver);
  return resolver;
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
  if (ts.isPropertyAccessExpression(node)) {
    const base = importedExpression(node.expression, checker, seen);
    return base && (base.member === null || base.member === 'default')
      ? { module: base.module, member: node.name.text }
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

function enclosingCallable(node: ts.Node): ts.SignatureDeclaration | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return parent;
  }
  return null;
}

function assignmentTarget(node: ts.Node): ts.Node | undefined {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return node.left;
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return node.operand;
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) return node.initializer;
  return undefined;
}

function assignedIdentifiers(node: ts.Node): ts.Identifier[] {
  const target = assignmentTarget(node);
  return target ? assignmentPatternIdentifiers(target) : [];
}

/** Assignment patterns share their traversal; variable writes and member writes retain distinct leaves. */
function assignmentPatternChildren(node: ts.Node): readonly ts.Node[] {
  if (ts.isParenthesizedExpression(node) || ts.isSpreadElement(node) || ts.isSpreadAssignment(node))
    return [node.expression];
  if (ts.isArrayLiteralExpression(node)) return node.elements;
  if (ts.isObjectLiteralExpression(node)) return node.properties;
  if (ts.isPropertyAssignment(node)) return [node.initializer];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return [node.left];
  return [];
}

function assignmentPatternIdentifiers(node: ts.Node): ts.Identifier[] {
  if (ts.isIdentifier(node)) return [node];
  if (ts.isShorthandPropertyAssignment(node)) return [node.name];
  return assignmentPatternChildren(node).flatMap(assignmentPatternIdentifiers);
}

/** Follow only stable lexical aliases; a write invalidates the whole chain. */
function aliasedDeclaration(
  node: ts.Node,
  checker: ts.TypeChecker,
  written = new Set<ts.Declaration>(),
): ts.Declaration | undefined {
  const seen = new Set<ts.Node>();
  while (ts.isIdentifier(node) && !seen.has(node)) {
    seen.add(node);
    const binding = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (!binding || written.has(binding)) return undefined;
    if (
      !ts.isVariableDeclaration(binding) ||
      !binding.initializer ||
      !(binding.parent.flags & ts.NodeFlags.Const) ||
      !ts.isIdentifier(binding.initializer)
    )
      return binding;
    node = binding.initializer;
  }
  return undefined;
}

function assignedProperties(node: ts.Node): ts.Node[] {
  const target = ts.isDeleteExpression(node) ? node.expression : assignmentTarget(node);
  return target ? propertyAssignmentBases(target) : [];
}

function propertyAssignmentBases(node: ts.Node): ts.Node[] {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    let base = node.expression;
    while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) base = base.expression;
    return [base];
  }
  return assignmentPatternChildren(node).flatMap(propertyAssignmentBases);
}
