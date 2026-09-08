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
}

const installed = new WeakSet<object>();

/**
 * The pinned FileIndexer gives anonymous declarations counter-based global
 * names. Their counters belong to the visiting file, so a reference can name a
 * different symbol than its definition when emitted in another compiler shard.
 * Source positions belong to the declaration and agree in every visitor.
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
    if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) {
      return originalSymbol.call(this, node);
    }
    const cached = this.globalSymbolTable.get(node);
    if (cached) return cached;
    const owner = this.scipSymbol(node.getSourceFile());
    const descriptor = symbols.metaDescriptor(`${node.name.getText()}$${node.getStart()}`);
    return this.cached(node, symbols.global(owner, descriptor));
  };
  prototype.descriptor = function (node) {
    return ts.isTypeLiteralNode(node)
      ? symbols.metaDescriptor(`typeLiteral$${node.getStart()}`)
      : originalDescriptor.call(this, node);
  };
  installed.add(prototype);
}
