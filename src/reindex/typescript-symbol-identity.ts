import { createHash } from 'node:crypto';
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

type TS = typeof TypeScript;

interface BuilderSignatureRuntime {
  BuilderState?: {
    computeDtsSignature(
      program: TypeScript.Program,
      source: TypeScript.SourceFile,
      cancellationToken: undefined,
      host: { createHash: (text: string) => string },
      onSignature: (signature: string, sources?: readonly TypeScript.SourceFile[]) => void,
    ): void;
  };
}

/**
 * A supported module boundary combines the compiler's declaration signature
 * with the declaration targets reachable along each exported member path.
 * Equal declaration text alone loses origins of structurally equal values.
 * Unsupported evidence returns null and retains conservative re-emission.
 */
export function typeScriptExportBoundary(
  ts: TS,
  program: TypeScript.Program,
  source: TypeScript.SourceFile,
  indexer: TypeScriptSymbolIndexer,
): string | null {
  // The private builder operation is versioned with the compiler adapter.
  if (ts.version !== '5.9.3' || !eligibleModule(ts, program, source)) return null;
  const compute = (ts as TS & BuilderSignatureRuntime).BuilderState?.computeDtsSignature;
  if (!compute) return null;
  try {
    const signatures: string[] = [];
    compute(program, source, undefined, { createHash: hash }, (signature) => signatures.push(signature));
    if (signatures.length !== 1) return null;
    const origins = new ExportOrigins(ts, program.getTypeChecker(), indexer, source).capture();
    return hash(JSON.stringify([signatures[0], origins]));
  } catch {
    return null;
  }
}

function eligibleModule(ts: TS, program: TypeScript.Program, source: TypeScript.SourceFile): boolean {
  return (
    !source.isDeclarationFile &&
    /\.[cm]?tsx?$/.test(source.fileName) &&
    ts.isExternalModule(source) &&
    !program.getCompilerOptions().outFile &&
    program.getSyntacticDiagnostics(source).length === 0 &&
    !hasAmbientOrCommonJsExport(ts, source)
  );
}

function hasAmbientOrCommonJsExport(ts: TS, node: TypeScript.Node): boolean {
  if (ts.isModuleDeclaration(node) || (ts.isExportAssignment(node) && node.isExportEquals)) return true;
  return ts.forEachChild(node, (child) => hasAmbientOrCommonJsExport(ts, child) || undefined) === true;
}

class ExportOrigins {
  private readonly visited = new Map<TypeScript.Type, number>();
  private readonly nodes: Record<string, unknown>[] = [];

  constructor(
    private readonly ts: TS,
    private readonly checker: TypeScript.TypeChecker,
    private readonly indexer: TypeScriptSymbolIndexer,
    private readonly source: TypeScript.SourceFile,
  ) {}

  capture(): unknown {
    const module = this.checker.getSymbolAtLocation(this.source);
    if (!module) throw new Error('Module symbol unavailable');
    const roots = this.checker.getExportsOfModule(module).map((exported) => {
      const symbol = exported.flags & this.ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(exported) : exported;
      return [
        exported.name,
        this.origins(symbol),
        symbol.flags & this.ts.SymbolFlags.Value ? this.walk(this.checker.getTypeOfSymbol(symbol)) : null,
        symbol.flags & this.ts.SymbolFlags.Type ? this.walk(this.checker.getDeclaredTypeOfSymbol(symbol)) : null,
      ];
    });
    return { roots, types: this.nodes };
  }

  private origins(symbol: TypeScript.Symbol | undefined): unknown {
    if (!symbol) return null;
    const declarations = symbol.getDeclarations() ?? [];
    const identities = declarations.map((declaration) => {
      const identity = this.indexer.scipSymbol(declaration).value;
      if (identity && !identity.startsWith('local ')) return identity;
      // Compiler-only type owners (for example a mapped type in a library)
      // need not have a global SCIP name. Preserve their complete declaration
      // instead; do not equate document-local counters across compiler states.
      const source = declaration.getSourceFile();
      if (!source || declaration.pos < 0) throw new Error('Declaration identity unavailable');
      return [source.fileName, declaration.kind, declaration.getStart(source), declaration.getText(source)];
    });
    return [symbol.name, identities, symbol.getDocumentationComment(this.checker), symbol.getJsDocTags(this.checker)];
  }

  private walk(type: TypeScript.Type): number {
    const previous = this.visited.get(type);
    if (previous !== undefined) return previous;
    if (this.nodes.length >= 2_000) throw new Error('Exported type traversal exceeds its budget');
    const id = this.nodes.length;
    this.visited.set(type, id);
    const node: Record<string, unknown> = { flags: type.flags };
    this.nodes.push(node);
    node.symbol = this.origins(type.symbol);
    node.alias = this.origins(type.aliasSymbol);
    node.aliasArguments = type.aliasTypeArguments?.map((argument) => this.walk(argument));
    if (supportedPrimitive(this.ts, type)) return id;
    if (type.isUnionOrIntersection()) {
      node.parts = type.types.map((part) => this.walk(part));
      return id;
    }
    if (!(type.flags & this.ts.TypeFlags.Object)) throw new Error('Unsupported exported type');
    this.object(type as TypeScript.ObjectType, node);
    return id;
  }

  private object(type: TypeScript.ObjectType, node: Record<string, unknown>): void {
    if (type.objectFlags & this.ts.ObjectFlags.Reference) {
      const reference = type as TypeScript.TypeReference;
      node.arguments = this.checker.getTypeArguments(reference).map((argument) => this.walk(argument));
      if (externalDeclarations(reference.target.symbol)) {
        node.externalTarget = this.origins(reference.target.symbol);
        return;
      }
      if (this.checker.isTupleType(type)) {
        node.tuple = true;
        return;
      }
    }
    if (type.objectFlags & this.ts.ObjectFlags.ClassOrInterface) {
      if (externalDeclarations(type.symbol)) {
        node.externalTarget = this.origins(type.symbol);
        return;
      }
      throw new Error('Unsupported exported class or interface');
    }
    // Resolve concrete mapped objects through the same compiler property and
    // index queries as consumers. Unresolved parameters/conditionals encountered
    // along those paths are unsupported, never treated as empty type evidence.
    node.properties = this.checker
      .getPropertiesOfType(type)
      .map((property) => [property.name, this.origins(property), this.walk(this.checker.getTypeOfSymbol(property))]);
    node.calls = this.checker
      .getSignaturesOfType(type, this.ts.SignatureKind.Call)
      .map((signature) => this.signature(signature));
    node.constructors = this.checker
      .getSignaturesOfType(type, this.ts.SignatureKind.Construct)
      .map((signature) => this.signature(signature));
    node.indexes = this.checker
      .getIndexInfosOfType(type)
      .map((info) => [this.walk(info.keyType), this.walk(info.type)]);
  }

  private signature(signature: TypeScript.Signature): unknown {
    if (signature.typeParameters?.length || this.checker.getTypePredicateOfSignature(signature)) {
      throw new Error('Unsupported generic or predicate signature');
    }
    return {
      parameters: signature.parameters.map((parameter) => [
        parameter.name,
        this.origins(parameter),
        this.walk(this.checker.getTypeOfSymbol(parameter)),
      ]),
      thisParameter: signature.thisParameter ? this.walk(this.checker.getTypeOfSymbol(signature.thisParameter)) : null,
      returns: this.walk(this.checker.getReturnTypeOfSignature(signature)),
    };
  }
}

function externalDeclarations(symbol: TypeScript.Symbol | undefined): boolean {
  const declarations = symbol?.getDeclarations();
  return !!declarations?.length && declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

function supportedPrimitive(ts: TS, type: TypeScript.Type): boolean {
  const supported =
    ts.TypeFlags.Unknown |
    ts.TypeFlags.String |
    ts.TypeFlags.Number |
    ts.TypeFlags.Boolean |
    ts.TypeFlags.BooleanLiteral |
    ts.TypeFlags.StringLiteral |
    ts.TypeFlags.NumberLiteral |
    ts.TypeFlags.BigInt |
    ts.TypeFlags.BigIntLiteral |
    ts.TypeFlags.ESSymbol |
    ts.TypeFlags.Void |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Null |
    ts.TypeFlags.Never;
  return (type.flags & ~supported) === 0;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
