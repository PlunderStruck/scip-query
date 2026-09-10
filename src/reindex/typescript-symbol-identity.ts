import type * as TypeScript from 'typescript';

interface SymbolValue {
  value: string;
}

export interface TypeScriptSymbolIndexer {
  globalSymbolTable: Map<TypeScript.Node, SymbolValue>;
  scipSymbol(node: TypeScript.Node): SymbolValue;
  descriptor(node: TypeScript.Node): unknown;
  cached(node: TypeScript.Node, symbol: SymbolValue): SymbolValue;
}

export interface TypeScriptSymbolConstructors {
  global(owner: SymbolValue, descriptor: unknown): SymbolValue;
  metaDescriptor(name: string): unknown;
  methodDescriptor(name: string): unknown;
}

const installed = new WeakSet<object>();

/**
 * The pinned FileIndexer gives anonymous declarations counter-based global
 * names. Their counters belong to the visiting file, so a reference can name a
 * different symbol than its definition when emitted in another compiler shard.
 * Source positions belong to the declaration and agree in every visitor.
 * Object literals also need stable owners: the upstream document-local owner
 * otherwise prevents their methods from entering the repository symbol graph.
 * Install once on the same runtime used by full and incremental producers.
 */
export function installTypeScriptSymbolIdentity(
  prototype: TypeScriptSymbolIndexer,
  ts: typeof TypeScript,
  symbols: TypeScriptSymbolConstructors,
): void {
  if (installed.has(prototype)) return;
  const originalSymbol = prototype.scipSymbol;
  const originalDescriptor = prototype.descriptor;
  if (
    typeof originalSymbol !== 'function' ||
    typeof originalDescriptor !== 'function' ||
    typeof prototype.cached !== 'function'
  ) {
    throw new Error('scip-typescript symbol runtime has an unsupported module shape');
  }
  prototype.scipSymbol = function (node) {
    if (anonymousDefaultCallable(node, ts)) {
      const cached = this.globalSymbolTable.get(node);
      return (
        cached ??
        this.cached(node, symbols.global(this.scipSymbol(node.getSourceFile()), symbols.methodDescriptor('default')))
      );
    }
    if (
      !ts.isPropertyAssignment(node) &&
      !ts.isShorthandPropertyAssignment(node) &&
      !ts.isObjectLiteralExpression(node)
    ) {
      return originalSymbol.call(this, node);
    }
    const cached = this.globalSymbolTable.get(node);
    if (cached) return cached;
    const owner = this.scipSymbol(node.getSourceFile());
    const name = ts.isObjectLiteralExpression(node) ? 'objectLiteral' : node.name.getText();
    const descriptor = symbols.metaDescriptor(`${name}$${node.getStart()}`);
    return this.cached(node, symbols.global(owner, descriptor));
  };
  prototype.descriptor = function (node) {
    return ts.isTypeLiteralNode(node)
      ? symbols.metaDescriptor(`typeLiteral$${node.getStart()}`)
      : originalDescriptor.call(this, node);
  };
  installed.add(prototype);
}

/** One module default export has one compiler declaration identity across visitors. */
export function anonymousDefaultCallable(
  node: TypeScript.Node,
  ts: typeof TypeScript,
): TypeScript.FunctionDeclaration | TypeScript.FunctionExpression | TypeScript.ArrowFunction | null {
  if (ts.isFunctionDeclaration(node)) return anonymousDefaultFunction(node, ts) ? node : null;
  if (ts.isExportAssignment(node)) {
    if (node.isExportEquals || !ts.isSourceFile(node.parent)) return null;
    const value = unwrapTypeScriptExpression(node.expression, ts);
    return ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? value : null;
  }
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return null;
  let current: TypeScript.Node = node;
  while (current.parent && unwrapTypeScriptExpression(current.parent, ts) === node) current = current.parent;
  return current.parent && ts.isExportAssignment(current.parent) ? anonymousDefaultCallable(current.parent, ts) : null;
}

function anonymousDefaultFunction(node: TypeScript.FunctionDeclaration, ts: typeof TypeScript): boolean {
  return (
    !node.name &&
    ts.isSourceFile(node.parent) &&
    !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  );
}

/** Erased TypeScript wrappers and parentheses preserve the underlying expression's identity. */
export function unwrapTypeScriptExpression(node: TypeScript.Node, ts: typeof TypeScript): TypeScript.Node {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    node = node.expression;
  return node;
}
