import { createHash } from 'node:crypto';
import { ts } from '@ts-morph/common';
import { bindingNames } from './maintenance-bindings.js';

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
}

export interface FunctionAnalysis {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  functions: SourceFunction[];
  exports: SourceExportDeclaration[];
  errors: string[];
}

/** Source-level export statements, not resolved public API or observed invocation coverage. */
export interface SourceExportDeclaration {
  file: string;
  startLine: number;
  endLine: number;
  names: string[];
  syntax: string;
  from?: string;
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
  const checker = sourceBindingChecker(sourceFile);
  function visit(node: ts.Node, owners: readonly string[]): void {
    if (isImplementedFunction(node)) {
      const name = functionName(node, sourceFile);
      const identity = [...owners, name];
      functions.push(measureFunction(node, sourceFile, identity.join('.'), checker));
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
  return { sourceFile, checker, functions, exports: errors.length ? [] : sourceExports(sourceFile), errors };
}

function sourceExports(source: ts.SourceFile): SourceExportDeclaration[] {
  const exports: SourceExportDeclaration[] = [];
  for (const statement of source.statements) {
    const names = exportedNames(statement, source);
    if (!names) continue;
    exports.push({
      file: source.fileName,
      startLine: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
      endLine: source.getLineAndCharacterOfPosition(statement.getEnd() - 1).line + 1,
      names,
      syntax: ts.isVariableStatement(statement) ? 'VariableStatement' : ts.SyntaxKind[statement.kind],
      ...(ts.isExportDeclaration(statement) && statement.moduleSpecifier
        ? {
            from: ts.isStringLiteralLike(statement.moduleSpecifier)
              ? statement.moduleSpecifier.text
              : statement.moduleSpecifier.getText(source),
          }
        : {}),
    });
  }
  return exports;
}

function exportedNames(statement: ts.Statement, source: ts.SourceFile): string[] | undefined {
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    if (!clause) return ['*'];
    return ts.isNamedExports(clause) ? clause.elements.map((item) => item.name.text) : [clause.name.text];
  }
  if (ts.isExportAssignment(statement)) return [statement.isExportEquals ? 'export=' : 'default'];
  return declarationExportNames(statement, source);
}

function declarationExportNames(statement: ts.Statement, source: ts.SourceFile): string[] | undefined {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return undefined;
  if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return ['default'];
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name));
  return 'name' in statement && statement.name ? [(statement.name as ts.Node).getText(source)] : [];
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

function measureFunction(
  node: ImplementedFunction,
  file: ts.SourceFile,
  name: string,
  checker: ts.TypeChecker,
): SourceFunction {
  const traversal = new FunctionComplexity(file);
  traversal.visit(node.body, 0);
  const contributions = traversal.contributions;
  const startOffset = node.getStart(file);
  const endOffset = node.getEnd();
  const tokens = implementationTokens(node, file, checker);
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
  };
}

/** One traversal owns one function's ordered contributions; nested functions are separate analyses. */
class FunctionComplexity {
  readonly contributions: ComplexityContribution[] = [];

  constructor(private readonly file: ts.SourceFile) {}

  visit(node: ts.Node, nesting: number): void {
    if (isImplementedFunction(node)) return;
    if (ts.isIfStatement(node)) {
      this.visitIf(node, nesting);
      return;
    }
    if (isLoop(node) || ts.isCatchClause(node) || ts.isConditionalExpression(node)) {
      this.add(node, ts.SyntaxKind[node.kind], 1, nesting + 1);
      ts.forEachChild(node, (child) => this.visit(child, nesting + 1));
      return;
    }
    if (ts.isSwitchStatement(node)) {
      this.add(node, 'switch', 0, nesting + 1);
      this.visit(node.expression, nesting);
      this.visit(node.caseBlock, nesting + 1);
      return;
    }
    if (ts.isCaseClause(node)) this.add(node, 'case', 1, 0);
    this.recordLogicalOperator(node);
    this.recordLabeledJump(node);
    ts.forEachChild(node, (child) => this.visit(child, nesting));
  }

  private visitIf(node: ts.IfStatement, nesting: number): void {
    const elseIf = ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
    this.add(node, elseIf ? 'else-if' : 'if', 1, elseIf ? 1 : nesting + 1);
    this.visit(node.expression, nesting);
    this.visit(node.thenStatement, nesting + 1);
    if (node.elseStatement) {
      if (!ts.isIfStatement(node.elseStatement)) this.add(node.elseStatement, 'else', 0, 1);
      this.visit(node.elseStatement, ts.isIfStatement(node.elseStatement) ? nesting : nesting + 1);
    }
  }

  private recordLogicalOperator(node: ts.Node): void {
    if (!ts.isBinaryExpression(node) || !isShortCircuit(node.operatorToken.kind)) return;
    const operator = node.operatorToken.kind;
    const parent = unwrapLogicalParent(node);
    const continuesSequence = ts.isBinaryExpression(parent) && parent.operatorToken.kind === operator;
    this.add(
      node.operatorToken,
      ts.tokenToString(operator) ?? 'logical',
      1,
      operator === ts.SyntaxKind.QuestionQuestionToken || continuesSequence ? 0 : 1,
    );
  }

  private recordLabeledJump(node: ts.Node): void {
    if ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) && node.label) {
      this.add(node, 'labeled-jump', 0, 1);
    }
  }

  private add(node: ts.Node, kind: string, cyclomatic: number, cognitive: number): void {
    const position = this.file.getLineAndCharacterOfPosition(node.getStart(this.file));
    this.contributions.push({ line: position.line + 1, column: position.character + 1, kind, cyclomatic, cognitive });
  }
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
function implementationTokens(
  node: ImplementedFunction,
  file: ts.SourceFile,
  checker: ts.TypeChecker,
): { exact: string[]; renamed: string[] } {
  const bindings = new Map<ts.Symbol, string>();
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol && !bindings.has(symbol)) bindings.set(symbol, `local:${bindings.size}`);
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
    const symbol =
      ts.isIdentifier(current) && !isPropertyNameToken(current) ? checker.getSymbolAtLocation(current) : undefined;
    const value = symbol ? (bindings.get(symbol) ?? text) : text;
    renamed.push(`${current.kind}:${value}`);
  };
  visit(node.body);
  return { exact, renamed };
}

/** Keep observable property keys distinct from local bindings that may be renamed. */
function isPropertyNameToken(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (ts.isBindingElement(parent)) return isBindingPropertyName(node, parent);
  if (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) {
    return parent.name === node;
  }
  return false;
}

function isBindingPropertyName(node: ts.Node, binding: ts.BindingElement): boolean {
  if (binding.propertyName) return binding.propertyName === node;
  return binding.name === node && !binding.dotDotDotToken && ts.isObjectBindingPattern(binding.parent);
}

/** Bind only this source file. No libraries, imports, filesystem, or type-correctness assumptions. */
function sourceBindingChecker(file: ts.SourceFile): ts.TypeChecker {
  const owns = (name: string): boolean => name === file.fileName || name === '/' + file.fileName;
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (owns(name) ? file : undefined),
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: owns,
    readFile: (name) => (owns(name) ? file.text : undefined),
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (name) => name,
    getNewLine: () => '\n',
  };
  return ts
    .createProgram(
      [file.fileName],
      { noLib: true, noResolve: true, allowJs: true, target: ts.ScriptTarget.Latest },
      host,
    )
    .getTypeChecker();
}
