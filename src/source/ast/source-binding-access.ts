import { ts } from '@ts-morph/common';

export function enclosingCallable(node: ts.Node): ts.SignatureDeclaration | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return parent;
  }
  return null;
}

/** Follow only stable lexical aliases; a write invalidates the whole chain. */
export function aliasedDeclaration(
  node: ts.Node,
  checker: ts.TypeChecker,
  written = new Set<ts.Declaration>(),
): ts.Declaration | undefined {
  const seen = new Set<ts.Node>();
  node = unwrapBindingExpression(node);
  while (ts.isIdentifier(node) && !seen.has(node)) {
    seen.add(node);
    const binding = accessBinding(node, checker);
    if (!binding || written.has(binding)) return undefined;
    if (
      !ts.isVariableDeclaration(binding) ||
      !binding.initializer ||
      !(binding.parent.flags & ts.NodeFlags.Const) ||
      !ts.isIdentifier(unwrapBindingExpression(binding.initializer))
    )
      return binding;
    node = unwrapBindingExpression(binding.initializer);
  }
  return undefined;
}

export type MemberPath = readonly (string | null)[];

export interface BindingAccess {
  binding: ts.Declaration;
  path: MemberPath;
  reassigned: boolean;
}

/** Arrows capture their enclosing receiver; an ordinary function introduces a separate receiver. */
export function accessBinding(node: ts.Node, checker: ts.TypeChecker): ts.Declaration | undefined {
  if (ts.isIdentifier(node)) {
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    // Import aliases have a local declaration but no valueDeclaration. Keep
    // that local identity so writes in the importer remain attached to it.
    return (
      symbol?.valueDeclaration ??
      symbol?.declarations?.find(
        (declaration) =>
          ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration),
      )
    );
  }
  if (node.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current)) return current;
  }
  return undefined;
}

export function isParameterDeclaration(binding: ts.Node): boolean {
  while (ts.isBindingElement(binding)) binding = binding.parent.parent;
  return ts.isParameter(binding);
}

/** TypeScript-only wrappers preserve the identity of the expression they contain. */
export function unwrapBindingExpression(node: ts.Node): ts.Node {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
    node = node.expression;
  return node;
}

/** Retain member paths through stable lexical aliases; a computed key is unknown, never a guessed name. */
export function bindingAccess(
  node: ts.Node,
  checker: ts.TypeChecker,
  written: ReadonlySet<ts.Declaration> = new Set(),
  seen: Set<ts.Declaration> = new Set(),
): BindingAccess | undefined {
  node = unwrapBindingExpression(node);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const base = bindingAccess(node.expression, checker, written, seen);
    if (!base) return undefined;
    const key = ts.isPropertyAccessExpression(node) ? node.name.text : memberLiteralKey(node.argumentExpression);
    return { ...base, path: [...base.path, key] };
  }
  const binding = accessBinding(node, checker);
  if (!binding || seen.has(binding)) return undefined;
  seen.add(binding);
  if (written.has(binding)) return { binding, path: [], reassigned: true };
  const alias = stableAliasExpression(binding);
  return alias ? bindingAccess(alias, checker, written, seen) : { binding, path: [], reassigned: false };
}

function stableAliasExpression(binding: ts.Declaration): ts.Node | undefined {
  if (!ts.isVariableDeclaration(binding) || !binding.initializer || !(binding.parent.flags & ts.NodeFlags.Const))
    return undefined;
  const value = unwrapBindingExpression(binding.initializer);
  return ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)
    ? value
    : undefined;
}

export function memberLiteralKey(node: ts.Node): string | null {
  node = unwrapBindingExpression(node);
  return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ? node.text : null;
}

export function memberPathsOverlap(left: MemberPath, right: MemberPath): boolean {
  return left
    .slice(0, Math.min(left.length, right.length))
    .every((key, index) => key === null || right[index] === null || key === right[index]);
}

/** Follow constant lexical initializers without choosing a value for any written binding. */
export function constantValueExpression(
  node: ts.Node,
  checker: ts.TypeChecker,
  written: ReadonlySet<ts.Declaration>,
): ts.Node | null {
  let value = unwrapBindingExpression(node);
  const seen = new Set<ts.Declaration>();
  while (ts.isIdentifier(value)) {
    const binding = accessBinding(value, checker);
    if (!binding || seen.has(binding)) return null;
    const initializer = stableVariableInitializer(binding, written);
    if (!initializer) return null;
    seen.add(binding);
    value = unwrapBindingExpression(initializer);
  }
  return value;
}

export function stableVariableInitializer(
  binding: ts.Declaration,
  written: ReadonlySet<ts.Declaration>,
): ts.Expression | undefined {
  return ts.isVariableDeclaration(binding) && binding.parent.flags & ts.NodeFlags.Const && !written.has(binding)
    ? binding.initializer
    : undefined;
}
