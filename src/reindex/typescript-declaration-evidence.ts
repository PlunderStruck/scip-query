import type * as TypeScript from 'typescript';
import {
  anonymousDefaultCallable,
  unwrapTypeScriptExpression,
  type TypeScriptSymbolIndexer,
} from './typescript-symbol-identity.js';

interface OccurrenceValue {
  range: number[];
  enclosing_range?: number[];
  symbol: string;
  symbol_roles: number;
}

export interface TypeScriptDeclarationIndexer extends TypeScriptSymbolIndexer {
  checker: TypeScript.TypeChecker;
  sourceFile: TypeScript.SourceFile;
  document: { occurrences: OccurrenceValue[]; symbols: Array<{ symbol: string }> };
  index(): void;
  getDeclarationsForPropertyAssignment(node: TypeScript.Node): readonly TypeScript.Declaration[] | undefined;
  pushOccurrence(value: unknown): void;
}

export interface TypeScriptEvidenceConstructors {
  Occurrence: new (value: OccurrenceValue) => OccurrenceValue;
  SymbolInformation: new (value: { symbol: string; documentation: string[] }) => { symbol: string };
}

const installed = new WeakSet<object>();

/** Complete compiler-owned declarations and references once, before either producer publishes them. */
export function installTypeScriptDeclarationEvidence(
  prototype: TypeScriptDeclarationIndexer,
  ts: typeof TypeScript,
  constructors: TypeScriptEvidenceConstructors,
): void {
  if (installed.has(prototype)) return;
  const contextualDeclarations = prototype.getDeclarationsForPropertyAssignment;
  if (typeof contextualDeclarations !== 'function') {
    throw new Error('scip-typescript contextual property runtime is unavailable');
  }
  prototype.getDeclarationsForPropertyAssignment = function (node) {
    // Inferred generic argument types can reuse structurally equal anonymous
    // object types from unrelated files. Their value declarations do not name
    // a property contract. Keep the new key's own definition in that case;
    // explicit interface/type-literal/class property declarations remain links.
    return contextualDeclarations
      .call(this, node)
      ?.filter((declaration) => declaration.parent?.kind !== ts.SyntaxKind.ObjectLiteralExpression);
  };
  const index = prototype.index;
  prototype.index = function () {
    index.call(this);
    // Honor upstream file-size exclusions; they emit no source-file occurrence.
    if (!this.document.occurrences.length) return;
    const definitions = new Map<string, OccurrenceValue[]>();
    for (const occurrence of this.document.occurrences) {
      if ((occurrence.symbol_roles & 1) === 0) continue;
      const group = definitions.get(occurrence.symbol) ?? [];
      group.push(occurrence);
      definitions.set(occurrence.symbol, group);
    }
    const visit = (node: TypeScript.Node): void => {
      completeMemberDefinitionRange(this, node, definitions, ts);
      const callable = anonymousDefaultCallable(node, ts);
      if (callable && (ts.isExportAssignment(node) || ts.isFunctionDeclaration(node)))
        emitAnonymousDefault(this, node, callable, constructors, ts);
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) emitWrappedMember(this, node, constructors, ts);
      ts.forEachChild(node, visit);
    };
    visit(this.sourceFile);
  };
  installed.add(prototype);
}

function emitAnonymousDefault(
  indexer: TypeScriptDeclarationIndexer,
  declaration: TypeScript.Node,
  callable: TypeScript.Node,
  constructors: TypeScriptEvidenceConstructors,
  ts: typeof TypeScript,
): void {
  const symbol = indexer.scipSymbol(declaration).value;
  if (
    !symbol ||
    indexer.document.occurrences.some(
      (occurrence) => occurrence.symbol === symbol && (occurrence.symbol_roles & 1) !== 0,
    )
  )
    return;
  const anchor =
    declaration.getChildren().find((child) => child.kind === ts.SyntaxKind.DefaultKeyword) ??
    callable.getFirstToken() ??
    callable;
  indexer.pushOccurrence(
    new constructors.Occurrence({
      symbol,
      symbol_roles: 1,
      range: rangeOf(anchor),
      enclosing_range: rangeOf(callable),
    }),
  );
  if (!indexer.document.symbols.some((entry) => entry.symbol === symbol))
    indexer.document.symbols.push(
      new constructors.SymbolInformation({ symbol, documentation: [`\`\`\`ts\n${callable.getText()}\n\`\`\``] }),
    );
}

function emitWrappedMember(
  indexer: TypeScriptDeclarationIndexer,
  call: TypeScript.CallExpression | TypeScript.NewExpression,
  constructors: TypeScriptEvidenceConstructors,
  ts: typeof TypeScript,
): void {
  const member = call.expression;
  if (!ts.isElementAccessExpression(member)) return;
  const key = unwrapTypeScriptExpression(member.argumentExpression, ts);
  if (key === member.argumentExpression || !(ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))) return;
  const property = indexer.checker.getTypeAtLocation(member.expression).getProperty(key.text);
  const declarations = property?.declarations ?? [];
  if (declarations.length !== 1) return;
  const symbol = indexer.scipSymbol(declarations[0]!).value;
  const range = rangeOf(key);
  if (
    symbol &&
    !indexer.document.occurrences.some(
      (occurrence) => occurrence.symbol === symbol && sameRange(occurrence.range, range),
    )
  )
    indexer.pushOccurrence(new constructors.Occurrence({ symbol, symbol_roles: 0, range }));
}

function rangeOf(node: TypeScript.Node): number[] {
  const source = node.getSourceFile();
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.end);
  return start.line === end.line
    ? [start.line, start.character, end.character]
    : [start.line, start.character, end.line, end.character];
}

function sameRange(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function completeMemberDefinitionRange(
  indexer: TypeScriptDeclarationIndexer,
  node: TypeScript.Node,
  definitions: ReadonlyMap<string, OccurrenceValue[]>,
  ts: typeof TypeScript,
): void {
  if (
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isPropertySignature(node)
  ) {
    const identity = indexer.scipSymbol(node).value;
    const nameRange = rangeOf(node.name);
    for (const occurrence of definitions.get(identity) ?? []) {
      if (!occurrence.enclosing_range?.length && sameRange(occurrence.range, nameRange))
        occurrence.enclosing_range = rangeOf(node);
    }
  }
}
