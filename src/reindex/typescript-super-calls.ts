import type * as TypeScript from 'typescript';
import type { TypeScriptSymbolIndexer } from './typescript-symbol-identity.js';

export interface TypeScriptCallIndexer extends TypeScriptSymbolIndexer {
  checker: TypeScript.TypeChecker;
  visit(node: TypeScript.Node): void;
  pushOccurrence(occurrence: unknown): void;
}

export interface TypeScriptCallOccurrenceConstructor {
  new (value: { range: number[]; symbol: string; symbol_roles: number }): unknown;
}

const installed = new WeakSet<object>();

/** The pinned visitor skips the super keyword; emit its compiler-resolved invocation reference. */
export function installTypeScriptSuperCalls(
  prototype: TypeScriptCallIndexer,
  ts: typeof TypeScript,
  Occurrence: TypeScriptCallOccurrenceConstructor,
): void {
  if (installed.has(prototype)) return;
  const visit = prototype.visit;
  if (typeof visit !== 'function' || typeof prototype.pushOccurrence !== 'function') {
    throw new Error('scip-typescript call visitor has an unsupported module shape');
  }
  prototype.visit = function (node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
      const target = superCallDeclaration(this.checker, node, ts);
      const symbol = target ? this.scipSymbol(target).value : '';
      if (symbol) {
        const source = node.getSourceFile();
        const start = source.getLineAndCharacterOfPosition(node.expression.getStart(source));
        const end = source.getLineAndCharacterOfPosition(node.expression.getEnd());
        this.pushOccurrence(
          new Occurrence({
            range: [start.line, start.character, end.character],
            symbol,
            symbol_roles: 0,
          }),
        );
      }
    }
    visit.call(this, node);
  };
  installed.add(prototype);
}

function superCallDeclaration(checker: TypeScript.TypeChecker, call: TypeScript.CallExpression, ts: typeof TypeScript) {
  let owner: TypeScript.Node | undefined = call.parent;
  while (owner && !ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) owner = owner.parent;
  if (!owner) return null;
  const base = staticBaseClass(checker, owner as TypeScript.ClassLikeDeclaration, ts);
  if (!base) return null;
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration && ts.isConstructorDeclaration(declaration)) {
    return isStaticAncestor(checker, base, declaration.parent, ts) ? declaration : null;
  }
  return base.members.some((member) => ts.isConstructorDeclaration(member)) ? null : base;
}

function isStaticAncestor(
  checker: TypeScript.TypeChecker,
  base: TypeScript.ClassLikeDeclaration,
  target: TypeScript.Node,
  ts: typeof TypeScript,
): boolean {
  let ancestor: TypeScript.ClassLikeDeclaration | null = base;
  const visited = new Set<TypeScript.Node>();
  while (ancestor && !visited.has(ancestor)) {
    if (ancestor === target) return true;
    visited.add(ancestor);
    ancestor = staticBaseClass(checker, ancestor, ts);
  }
  return false;
}

function staticBaseClass(
  checker: TypeScript.TypeChecker,
  owner: TypeScript.ClassLikeDeclaration,
  ts: typeof TypeScript,
): TypeScript.ClassLikeDeclaration | null {
  const heritage = owner.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  const expression = heritage?.types[0]?.expression;
  return expression ? classForExpression(checker, expression, ts, new Set()) : null;
}

function classForExpression(
  checker: TypeScript.TypeChecker,
  expression: TypeScript.Expression,
  ts: typeof TypeScript,
  seen: Set<TypeScript.Node>,
): TypeScript.ClassLikeDeclaration | null {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (seen.has(expression)) return null;
  seen.add(expression);
  if (ts.isClassExpression(expression)) return expression;
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return null;
  const declaration = uniqueExpressionDeclaration(checker, expression, ts);
  if (!declaration) return null;
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) return declaration;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer && declaration.parent.flags & ts.NodeFlags.Const)
    return classForExpression(checker, declaration.initializer, ts, seen);
  return null;
}

function uniqueExpressionDeclaration(
  checker: TypeScript.TypeChecker,
  expression: TypeScript.Expression,
  ts: typeof TypeScript,
): TypeScript.Declaration | null {
  let symbol = checker.getSymbolAtLocation(expression);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  const declarations = symbol?.declarations ?? [];
  return declarations.length === 1 ? declarations[0]! : null;
}
