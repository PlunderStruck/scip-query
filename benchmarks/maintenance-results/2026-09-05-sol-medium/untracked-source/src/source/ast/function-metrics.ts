import { createHash } from 'node:crypto';
import { ts } from '@ts-morph/common';

export interface ComplexityContribution {
  line: number;
  column: number;
  kind: string;
  cyclomatic: number;
  cognitive: number;
}

export interface SourceFunction {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  sourceHash: string;
  bodyHash: string;
  renamedBodyHash: string;
  tokenCount: number;
  cyclomatic: number;
  cognitive: number;
  contributions: ComplexityContribution[];
  calls: string[];
}

export interface FunctionAnalysis {
  sourceFile: ts.SourceFile;
  functions: SourceFunction[];
  errors: string[];
}

export const FUNCTION_METRIC_RULES = 'typescript-function-local-v1';

export function sourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

/** Current bytes, independent of the age or availability of a compiler index. */
export function analyzeSourceFunctions(file: string, source: string): FunctionAnalysis {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const diagnostics =
    (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const errors = diagnostics.map((diagnostic) => {
    const line = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
    return `${file}:${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
  });
  const functions: SourceFunction[] = [];
  function visit(node: ts.Node, owners: readonly string[]): void {
    if (isImplementedFunction(node)) {
      const name = functionName(node, sourceFile);
      const identity = [...owners, name];
      functions.push(measureFunction(node, sourceFile, identity.join('.')));
      ts.forEachChild(node, (child) => visit(child, identity));
      return;
    }
    const owner =
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name
        ? node.name.text
        : ts.isVariableDeclaration(node) && node.initializer && !isImplementedFunction(node.initializer)
          ? node.name.getText(sourceFile)
          : ts.isModuleDeclaration(node)
            ? node.name.getText(sourceFile)
            : null;
    ts.forEachChild(node, (child) => visit(child, owner ? [...owners, owner] : owners));
  }
  if (errors.length === 0) visit(sourceFile, []);
  return { sourceFile, functions, errors };
}

type ImplementedFunction = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };

function isImplementedFunction(node: ts.Node): node is ImplementedFunction {
  return ts.isFunctionLike(node) && 'body' in node && Boolean(node.body);
}

function functionName(node: ImplementedFunction, file: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isGetAccessor(node)) return `get ${node.name.getText(file)}`;
  if (ts.isSetAccessor(node)) return `set ${node.name.getText(file)}`;
  if (node.name) return node.name.getText(file);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return parent.name.getText(file);
  }
  if (ts.isCallExpression(parent)) {
    return `<callback:${parent.expression.getText(file)}:${parent.arguments.indexOf(node as ts.Expression)}>`;
  }
  const position = file.getLineAndCharacterOfPosition(node.getStart(file));
  return `<anonymous@${position.line + 1}:${position.character + 1}>`;
}

function measureFunction(node: ImplementedFunction, file: ts.SourceFile, name: string): SourceFunction {
  const contributions: ComplexityContribution[] = [];
  const calls = new Set<string>();
  const add = (at: ts.Node, kind: string, cyclomatic: number, cognitive: number): void => {
    const position = file.getLineAndCharacterOfPosition(at.getStart(file));
    contributions.push({ line: position.line + 1, column: position.character + 1, kind, cyclomatic, cognitive });
  };
  function visit(current: ts.Node, nesting: number): void {
    if (current !== node && isImplementedFunction(current)) return;
    if (ts.isIfStatement(current)) {
      const elseIf = ts.isIfStatement(current.parent) && current.parent.elseStatement === current;
      add(current, elseIf ? 'else-if' : 'if', 1, elseIf ? 1 : nesting + 1);
      visit(current.expression, nesting);
      visit(current.thenStatement, nesting + 1);
      if (current.elseStatement) {
        if (!ts.isIfStatement(current.elseStatement)) add(current.elseStatement, 'else', 0, 1);
        visit(current.elseStatement, ts.isIfStatement(current.elseStatement) ? nesting : nesting + 1);
      }
      return;
    }
    if (isLoop(current) || ts.isCatchClause(current) || ts.isConditionalExpression(current)) {
      add(current, ts.SyntaxKind[current.kind], 1, nesting + 1);
      ts.forEachChild(current, (child) => visit(child, nesting + 1));
      return;
    }
    if (ts.isSwitchStatement(current)) {
      add(current, 'switch', 0, nesting + 1);
      visit(current.expression, nesting);
      visit(current.caseBlock, nesting + 1);
      return;
    }
    if (ts.isCaseClause(current)) add(current, 'case', 1, 0);
    if (ts.isBinaryExpression(current) && isShortCircuit(current.operatorToken.kind)) {
      const operator = current.operatorToken.kind;
      const parent = unwrapLogicalParent(current);
      const continuesSequence = ts.isBinaryExpression(parent) && parent.operatorToken.kind === operator;
      add(
        current.operatorToken,
        ts.tokenToString(operator) ?? 'logical',
        1,
        operator === ts.SyntaxKind.QuestionQuestionToken || continuesSequence ? 0 : 1,
      );
    }
    if ((ts.isBreakStatement(current) || ts.isContinueStatement(current)) && current.label) {
      add(current, 'labeled-jump', 0, 1);
    }
    if (ts.isCallExpression(current)) {
      const called = current.expression.getText(file);
      calls.add(called);
    }
    ts.forEachChild(current, (child) => visit(child, nesting));
  }
  visit(node.body, 0);
  const startOffset = node.getStart(file);
  const endOffset = node.getEnd();
  const tokens = implementationTokens(node, file);
  return {
    name,
    file: file.fileName,
    startLine: file.getLineAndCharacterOfPosition(startOffset).line + 1,
    endLine: file.getLineAndCharacterOfPosition(endOffset - 1).line + 1,
    startOffset,
    endOffset,
    sourceHash: sourceHash(file.text.slice(startOffset, endOffset)),
    bodyHash: sourceHash(tokens.exact.join('\n')),
    renamedBodyHash: sourceHash(tokens.renamed.join('\n')),
    tokenCount: tokens.exact.length,
    cyclomatic: 1 + contributions.reduce((sum, item) => sum + item.cyclomatic, 0),
    cognitive: contributions.reduce((sum, item) => sum + item.cognitive, 0),
    contributions,
    calls: [...calls].sort(),
  };
}

function isLoop(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function isShortCircuit(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

function unwrapLogicalParent(node: ts.Node): ts.Node {
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return parent;
}

/** Preserve literals and property names; renaming is candidate evidence, never behavioral equivalence. */
function implementationTokens(node: ImplementedFunction, file: ts.SourceFile): { exact: string[]; renamed: string[] } {
  const bindings = new Map<string, string>();
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      if (!bindings.has(name.text)) bindings.set(name.text, `local:${bindings.size}`);
    } else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
  };
  for (const parameter of node.parameters) bind(parameter.name);
  const collect = (current: ts.Node): void => {
    if (isImplementedFunction(current)) return;
    if (ts.isVariableDeclaration(current)) bind(current.name);
    ts.forEachChild(current, collect);
  };
  collect(node.body);
  const exact: string[] = [];
  const renamed: string[] = [];
  const visit = (current: ts.Node): void => {
    const children = current.getChildren(file);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    const text = current.getText(file);
    if (!text) return;
    exact.push(`${current.kind}:${text}`);
    const parent = current.parent;
    const propertyName =
      ts.isShorthandPropertyAssignment(parent) ||
      (ts.isBindingElement(parent) && parent.propertyName === current) ||
      (ts.isPropertyAccessExpression(parent) && parent.name === current) ||
      ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === current);
    const value = ts.isIdentifier(current) && !propertyName ? (bindings.get(text) ?? text) : text;
    renamed.push(`${current.kind}:${value}`);
  };
  visit(node.body);
  return { exact, renamed };
}
