import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type * as TypeScript from 'typescript';
import { loadTsMorph } from './ts-morph-runtime.js';

type TypeScriptModule = typeof TypeScript;
type AnalyzableCallable = TypeScript.FunctionLikeDeclaration & { body: TypeScript.ConciseBody };

export type TypeScriptLocalFlowPointKind = 'parameter-definition' | 'definition' | 'use' | 'predicate' | 'statement';
export type TypeScriptLocalFlowEdgeKind =
  | 'reaching-definition'
  | 'value-source'
  | 'closure-capture'
  | 'field-definition-to-use'
  | 'control-dependence';

export interface TypeScriptLocalFlowPoint {
  id: string;
  kind: TypeScriptLocalFlowPointKind;
  name: string;
  symbolKey: string | null;
  callableId: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface TypeScriptLocalFlowEdge {
  id: string;
  kind: TypeScriptLocalFlowEdgeKind;
  fromPointId: string;
  toPointId: string;
  strength: 'exact' | 'candidate';
  reason: string;
}

export interface TypeScriptLocalFlowCoverage {
  status: 'complete' | 'partial' | 'unsupported';
  basis: 'typescript-compiler-cfg-reaching-definitions';
  unsupported: string[];
}

export interface TypeScriptLocalFlowResult {
  points: TypeScriptLocalFlowPoint[];
  edges: TypeScriptLocalFlowEdge[];
  coverage: TypeScriptLocalFlowCoverage;
}

export interface TypeScriptLocalFlowRange {
  startLine: number;
  endLine: number;
}

interface MutableFlowPoint extends TypeScriptLocalFlowPoint {
  node: TypeScript.Node;
}

interface FlowDefinition {
  point: MutableFlowPoint;
  rhsUseIds: string[];
}

interface FlowUse {
  point: MutableFlowPoint;
  property: boolean;
}

interface CfgNode {
  id: string;
  kind: 'entry' | 'exit' | 'statement' | 'predicate';
  ast: TypeScript.Node | null;
  successors: Set<string>;
  predecessors: Set<string>;
  definitions: FlowDefinition[];
  uses: FlowUse[];
  displayPoint: MutableFlowPoint | null;
  invalidatesAllDefinitions: boolean;
}

interface CallableAnalysis {
  id: string;
  node: AnalyzableCallable;
  parentId: string | null;
  cfg: Map<string, CfgNode>;
  entryId: string;
  exitId: string;
}

interface BuildContext {
  breakTarget: string | null;
  continueTarget: string | null;
}

interface AnalysisState {
  ts: TypeScriptModule;
  sourceFile: TypeScript.SourceFile;
  checker: TypeScript.TypeChecker;
  points: Map<string, MutableFlowPoint>;
  edges: Map<string, TypeScriptLocalFlowEdge>;
  unsupported: Set<string>;
  nextCfgId: number;
}

const require = createRequire(import.meta.url);
let typescriptModule: TypeScriptModule | null | undefined;

/**
 * Compute structured intraprocedural reaching definitions and postdominator-
 * based control dependence over TypeScript compiler nodes. Heap aliases,
 * exceptional control flow, and closure invocation order stay explicit gaps.
 */
export function analyzeTypeScriptLocalFlow(
  sourceText: string,
  fileName: string,
  range?: TypeScriptLocalFlowRange,
): TypeScriptLocalFlowResult {
  const ts = loadTypeScript();
  if (!ts) return unsupportedResult('The TypeScript compiler runtime is unavailable.');
  const program = inMemoryProgram(ts, sourceText, fileName);
  const sourceFile = program.getSourceFile(resolve(fileName)) ?? program.getSourceFile(fileName);
  if (!sourceFile) return unsupportedResult(`The TypeScript compiler did not materialize ${fileName}.`);
  const state: AnalysisState = {
    ts,
    sourceFile,
    checker: program.getTypeChecker(),
    points: new Map(),
    edges: new Map(),
    unsupported: new Set(),
    nextCfgId: 0,
  };
  const callables = callableDeclarations(ts, sourceFile, range);
  if (callables.length === 0)
    return unsupportedResult('No function-like construct intersects the selected source range.');
  const callableIds = new Map(callables.map((node) => [node, callableId(sourceFile, node)]));
  const analyses = callables.map((node) =>
    buildCallableAnalysis(state, node, parentCallableId(ts, node, callableIds), callableIds.get(node)!),
  );
  for (const analysis of analyses) {
    extractAccesses(state, analysis);
    addReachingDefinitionEdges(state, analysis);
    addControlDependenceEdges(state, analysis);
  }
  addCrossCallableCandidates(state, analyses);
  const unsupported = [...state.unsupported].sort();
  return {
    points: [...state.points.values()].map(({ node: _node, ...point }) => point).sort(comparePoints),
    edges: [...state.edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    coverage: {
      status: unsupported.length === 0 ? 'complete' : 'partial',
      basis: 'typescript-compiler-cfg-reaching-definitions',
      unsupported,
    },
  };
}

function loadTypeScript(): TypeScriptModule | null {
  if (typescriptModule !== undefined) return typescriptModule;
  try {
    typescriptModule = require('typescript') as TypeScriptModule;
  } catch {
    typescriptModule = (loadTsMorph()?.ts as TypeScriptModule | undefined) ?? null;
  }
  return typescriptModule;
}

function inMemoryProgram(ts: TypeScriptModule, sourceText: string, fileName: string): TypeScript.Program {
  const absolute = resolve(fileName);
  const options: TypeScript.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noResolve: true,
  };
  const sourceFile = ts.createSourceFile(absolute, sourceText, options.target!, true, scriptKind(ts, absolute));
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(candidate) === absolute
      ? sourceFile
      : originalGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);
  host.readFile = (candidate) => (resolve(candidate) === absolute ? sourceText : originalReadFile(candidate));
  host.fileExists = (candidate) => resolve(candidate) === absolute || originalFileExists(candidate);
  return ts.createProgram([absolute], options, host);
}

function scriptKind(ts: TypeScriptModule, fileName: string): TypeScript.ScriptKind {
  if (/\.tsx$/iu.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/iu.test(fileName)) return ts.ScriptKind.JS;
  if (/\.jsx$/iu.test(fileName)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

function callableDeclarations(
  ts: TypeScriptModule,
  sourceFile: TypeScript.SourceFile,
  range: TypeScriptLocalFlowRange | undefined,
): AnalyzableCallable[] {
  const result: AnalyzableCallable[] = [];
  const visit = (node: TypeScript.Node): void => {
    if (isAnalyzableCallable(ts, node)) {
      const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
      if (!range || (startLine <= range.endLine && endLine >= range.startLine)) result.push(node);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return result.sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile));
}

function isAnalyzableCallable(ts: TypeScriptModule, node: TypeScript.Node): node is AnalyzableCallable {
  return ts.isFunctionLike(node) && 'body' in node && node.body !== undefined;
}

function callableId(sourceFile: TypeScript.SourceFile, node: AnalyzableCallable): string {
  return `callable:${encodeURIComponent(sourceFile.fileName)}:${node.getStart(sourceFile)}:${node.getEnd()}`;
}

function parentCallableId(
  ts: TypeScriptModule,
  node: AnalyzableCallable,
  ids: ReadonlyMap<AnalyzableCallable, string>,
): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (isAnalyzableCallable(ts, current) && ids.has(current)) return ids.get(current)!;
  }
  return null;
}

function buildCallableAnalysis(
  state: AnalysisState,
  callable: AnalyzableCallable,
  parentId: string | null,
  id: string,
): CallableAnalysis {
  const cfg = new Map<string, CfgNode>();
  const exit = cfgNode(state, cfg, 'exit', null);
  const body = callable.body;
  let first = exit.id;
  if (body && state.ts.isBlock(body)) {
    first = buildStatements(state, cfg, [...body.statements], exit.id, { breakTarget: null, continueTarget: null });
  } else if (body) {
    const expression = cfgNode(state, cfg, 'statement', body);
    connect(cfg, expression.id, exit.id);
    first = expression.id;
  }
  const entry = cfgNode(state, cfg, 'entry', callable);
  connect(cfg, entry.id, first);
  return { id, node: callable, parentId, cfg, entryId: entry.id, exitId: exit.id };
}

function buildStatements(
  state: AnalysisState,
  cfg: Map<string, CfgNode>,
  statements: readonly TypeScript.Statement[],
  next: string,
  context: BuildContext,
): string {
  let current = next;
  for (let index = statements.length - 1; index >= 0; index -= 1) {
    current = buildStatement(state, cfg, statements[index]!, current, context);
  }
  return current;
}

function buildStatement(
  state: AnalysisState,
  cfg: Map<string, CfgNode>,
  statement: TypeScript.Statement,
  next: string,
  context: BuildContext,
): string {
  const ts = state.ts;
  if (ts.isBlock(statement)) return buildStatements(state, cfg, [...statement.statements], next, context);
  if (ts.isIfStatement(statement)) {
    const predicate = cfgNode(state, cfg, 'predicate', statement.expression);
    const whenTrue = buildStatement(state, cfg, statement.thenStatement, next, context);
    const whenFalse = statement.elseStatement
      ? buildStatement(state, cfg, statement.elseStatement, next, context)
      : next;
    connect(cfg, predicate.id, whenTrue);
    connect(cfg, predicate.id, whenFalse);
    return predicate.id;
  }
  if (ts.isWhileStatement(statement)) {
    const predicate = cfgNode(state, cfg, 'predicate', statement.expression);
    const body = buildStatement(state, cfg, statement.statement, predicate.id, {
      breakTarget: next,
      continueTarget: predicate.id,
    });
    connect(cfg, predicate.id, body);
    connect(cfg, predicate.id, next);
    return predicate.id;
  }
  if (ts.isDoStatement(statement)) {
    const predicate = cfgNode(state, cfg, 'predicate', statement.expression);
    const body = buildStatement(state, cfg, statement.statement, predicate.id, {
      breakTarget: next,
      continueTarget: predicate.id,
    });
    connect(cfg, predicate.id, body);
    connect(cfg, predicate.id, next);
    return body;
  }
  if (ts.isForStatement(statement)) {
    const predicate = cfgNode(state, cfg, 'predicate', statement.condition ?? statement);
    const increment = statement.incrementor ? cfgNode(state, cfg, 'statement', statement.incrementor) : null;
    if (increment) connect(cfg, increment.id, predicate.id);
    const continueTarget = increment?.id ?? predicate.id;
    const body = buildStatement(state, cfg, statement.statement, continueTarget, {
      breakTarget: next,
      continueTarget,
    });
    connect(cfg, predicate.id, body);
    if (statement.condition) connect(cfg, predicate.id, next);
    if (!statement.initializer) return predicate.id;
    const initializer = cfgNode(state, cfg, 'statement', statement.initializer);
    connect(cfg, initializer.id, predicate.id);
    return initializer.id;
  }
  if (ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
    state.unsupported.add(
      'for-in/for-of iterator assignment is conservatively represented without iterable element flow.',
    );
    const predicate = cfgNode(state, cfg, 'predicate', statement.expression);
    const initializer = cfgNode(state, cfg, 'statement', statement.initializer);
    const body = buildStatement(state, cfg, statement.statement, predicate.id, {
      breakTarget: next,
      continueTarget: predicate.id,
    });
    connect(cfg, predicate.id, initializer.id);
    connect(cfg, predicate.id, next);
    connect(cfg, initializer.id, body);
    return predicate.id;
  }
  if (ts.isSwitchStatement(statement)) {
    state.unsupported.add(
      'switch fallthrough is represented conservatively; discriminant-to-case value refinement is unsupported.',
    );
    const predicate = cfgNode(state, cfg, 'predicate', statement.expression);
    let fallthrough = next;
    const entries: string[] = [];
    for (let index = statement.caseBlock.clauses.length - 1; index >= 0; index -= 1) {
      const clause = statement.caseBlock.clauses[index]!;
      fallthrough = buildStatements(state, cfg, [...clause.statements], fallthrough, {
        ...context,
        breakTarget: next,
      });
      entries.push(fallthrough);
    }
    for (const entry of entries) connect(cfg, predicate.id, entry);
    connect(cfg, predicate.id, next);
    return predicate.id;
  }
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    const terminal = cfgNode(state, cfg, 'statement', statement);
    const exit = [...cfg.values()].find((node) => node.kind === 'exit')!;
    connect(cfg, terminal.id, exit.id);
    return terminal.id;
  }
  if (ts.isBreakStatement(statement)) {
    const node = cfgNode(state, cfg, 'statement', statement);
    if (!context.breakTarget) state.unsupported.add('A break statement could not be attached to a structured target.');
    connect(cfg, node.id, context.breakTarget ?? next);
    return node.id;
  }
  if (ts.isContinueStatement(statement)) {
    const node = cfgNode(state, cfg, 'statement', statement);
    if (!context.continueTarget)
      state.unsupported.add('A continue statement could not be attached to a structured target.');
    connect(cfg, node.id, context.continueTarget ?? next);
    return node.id;
  }
  if (ts.isTryStatement(statement)) {
    state.unsupported.add(
      'Exceptional control-flow and finally completion are not included in the local compiler CFG.',
    );
    const node = cfgNode(state, cfg, 'statement', statement);
    node.invalidatesAllDefinitions = true;
    connect(cfg, node.id, next);
    return node.id;
  }
  const node = cfgNode(state, cfg, 'statement', statement);
  connect(cfg, node.id, next);
  return node.id;
}

function cfgNode(
  state: AnalysisState,
  cfg: Map<string, CfgNode>,
  kind: CfgNode['kind'],
  ast: TypeScript.Node | null,
): CfgNode {
  const node: CfgNode = {
    id: `cfg:${state.nextCfgId++}`,
    kind,
    ast,
    successors: new Set(),
    predecessors: new Set(),
    definitions: [],
    uses: [],
    displayPoint: null,
    invalidatesAllDefinitions: false,
  };
  cfg.set(node.id, node);
  return node;
}

function connect(cfg: Map<string, CfgNode>, from: string, to: string): void {
  cfg.get(from)!.successors.add(to);
  cfg.get(to)!.predecessors.add(from);
}

function extractAccesses(state: AnalysisState, analysis: CallableAnalysis): void {
  const entry = analysis.cfg.get(analysis.entryId)!;
  for (const parameter of analysis.node.parameters) {
    const target = accessTarget(state, parameter.name);
    if (!target) {
      state.unsupported.add('Destructured parameter definition-use is not implemented.');
      continue;
    }
    entry.definitions.push({
      point: point(state, target.node, 'parameter-definition', target.symbolKey, target.name, analysis.id),
      rhsUseIds: [],
    });
  }
  for (const cfgNodeValue of analysis.cfg.values()) {
    if (!cfgNodeValue.ast || cfgNodeValue.kind === 'entry' || cfgNodeValue.kind === 'exit') continue;
    if (cfgNodeValue.kind === 'predicate') {
      cfgNodeValue.displayPoint = point(state, cfgNodeValue.ast, 'predicate', null, 'predicate', analysis.id);
    }
    collectNodeAccesses(state, analysis, cfgNodeValue, cfgNodeValue.ast);
    if (!cfgNodeValue.displayPoint && cfgNodeValue.definitions.length === 0 && cfgNodeValue.uses.length === 0) {
      cfgNodeValue.displayPoint = point(
        state,
        cfgNodeValue.ast,
        'statement',
        null,
        statementLabel(state, cfgNodeValue.ast),
        analysis.id,
      );
    }
  }
}

function collectNodeAccesses(
  state: AnalysisState,
  analysis: CallableAnalysis,
  cfg: CfgNode,
  root: TypeScript.Node,
): void {
  const ts = state.ts;
  if (ts.isTryStatement(root)) return;
  const visit = (node: TypeScript.Node): void => {
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node)) {
      const uses = node.initializer ? collectUses(state, analysis.id, node.initializer, cfg) : [];
      cfg.uses.push(...uses);
      const target = accessTarget(state, node.name);
      if (target) {
        cfg.definitions.push({
          point: point(state, target.node, 'definition', target.symbolKey, target.name, analysis.id),
          rhsUseIds: uses.map((use) => use.point.id),
        });
      } else {
        cfg.invalidatesAllDefinitions = true;
        state.unsupported.add('Destructured variable reaching definitions are not implemented.');
      }
      return;
    }
    if (ts.isBinaryExpression(node) && assignmentOperator(ts, node.operatorToken.kind)) {
      const rhsUses = collectUses(state, analysis.id, node.right, cfg);
      if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        rhsUses.push(...collectUses(state, analysis.id, node.left, cfg));
      cfg.uses.push(...rhsUses);
      const target = accessTarget(state, node.left);
      if (target) {
        cfg.definitions.push({
          point: point(state, target.node, 'definition', target.symbolKey, target.name, analysis.id),
          rhsUseIds: rhsUses.map((use) => use.point.id),
        });
      } else {
        cfg.invalidatesAllDefinitions = true;
        state.unsupported.add('Dynamic or destructured assignment targets are not included in reaching definitions.');
      }
      return;
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
        const uses = collectUses(state, analysis.id, node.operand, cfg);
        cfg.uses.push(...uses);
        const target = accessTarget(state, node.operand);
        if (target) {
          cfg.definitions.push({
            point: point(state, target.node, 'definition', target.symbolKey, target.name, analysis.id),
            rhsUseIds: uses.map((use) => use.point.id),
          });
        }
        return;
      }
    }
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
    if (isUseNode(state, node)) {
      const use = useForNode(state, analysis.id, node);
      if (use) cfg.uses.push(use);
      if (ts.isPropertyAccessExpression(node)) visit(node.expression);
      return;
    }
    node.forEachChild(visit);
  };
  visit(root);
  cfg.uses = uniqueUses(cfg.uses);
}

function collectUses(state: AnalysisState, callableIdValue: string, root: TypeScript.Node, cfg: CfgNode): FlowUse[] {
  const uses: FlowUse[] = [];
  const visit = (node: TypeScript.Node): void => {
    if (state.ts.isFunctionLike(node)) return;
    if (state.ts.isBinaryExpression(node) && assignmentOperator(state.ts, node.operatorToken.kind)) {
      cfg.invalidatesAllDefinitions = true;
      state.unsupported.add('Nested assignment expressions are not included in ordered local definition-use flow.');
      if (node.operatorToken.kind !== state.ts.SyntaxKind.EqualsToken) visit(node.left);
      visit(node.right);
      return;
    }
    if (isUseNode(state, node)) {
      const use = useForNode(state, callableIdValue, node);
      if (use) uses.push(use);
      if (state.ts.isPropertyAccessExpression(node)) visit(node.expression);
      return;
    }
    node.forEachChild(visit);
  };
  visit(root);
  return uniqueUses(uses);
}

function isUseNode(
  state: AnalysisState,
  node: TypeScript.Node,
): node is TypeScript.Identifier | TypeScript.PropertyAccessExpression {
  if (state.ts.isPropertyAccessExpression(node)) return true;
  if (!state.ts.isIdentifier(node)) return false;
  const parent = node.parent;
  if (state.ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ('name' in parent && parent.name === node && isDeclarationNameOwner(state.ts, parent)) return false;
  if (state.ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (state.ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (state.ts.isLabeledStatement(parent) || state.ts.isBreakOrContinueStatement(parent)) return false;
  if (insideTypeNode(state.ts, node)) return false;
  return true;
}

function isDeclarationNameOwner(ts: TypeScriptModule, node: TypeScript.Node): boolean {
  return (
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isImportSpecifier(node) ||
    ts.isImportClause(node) ||
    ts.isNamespaceImport(node)
  );
}

function insideTypeNode(ts: TypeScriptModule, node: TypeScript.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isExpression(current) || ts.isStatement(current) || ts.isSourceFile(current)) return false;
    if (ts.isTypeNode(current)) return true;
  }
  return false;
}

function useForNode(state: AnalysisState, callableIdValue: string, node: TypeScript.Node): FlowUse | null {
  const target = accessTarget(state, node);
  if (!target) return null;
  return {
    point: point(state, target.node, 'use', target.symbolKey, target.name, callableIdValue),
    property: state.ts.isPropertyAccessExpression(node),
  };
}

function accessTarget(
  state: AnalysisState,
  node: TypeScript.Node,
): { node: TypeScript.Node; symbolKey: string; name: string } | null {
  const ts = state.ts;
  if (ts.isIdentifier(node)) {
    const key = compilerSymbolKey(state, node);
    return key ? { node, symbolKey: key, name: node.text } : null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const key = compilerSymbolKey(state, node.name);
    return key ? { node, symbolKey: key, name: node.getText(state.sourceFile) } : null;
  }
  if (ts.isParenthesizedExpression(node)) return accessTarget(state, node.expression);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return accessTarget(state, node.expression);
  }
  if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
    state.unsupported.add(
      'Heap aggregate identity and destructured assignment are not included in local points-to flow.',
    );
  }
  return null;
}

function compilerSymbolKey(state: AnalysisState, node: TypeScript.Node): string | null {
  let symbol = state.checker.getSymbolAtLocation(node);
  if (!symbol) return null;
  if ((symbol.flags & state.ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = state.checker.getAliasedSymbol(symbol);
    } catch {
      // Retain the local alias symbol when its target is unavailable.
    }
  }
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return `symbol:${symbol.getName()}`;
  return `symbol:${encodeURIComponent(declaration.getSourceFile().fileName)}:${declaration.getStart()}:${symbol.getName()}`;
}

function point(
  state: AnalysisState,
  node: TypeScript.Node,
  kind: TypeScriptLocalFlowPointKind,
  symbolKey: string | null,
  name: string,
  callableIdValue: string,
): MutableFlowPoint {
  const start = node.getStart(state.sourceFile);
  const end = node.getEnd();
  const location = state.sourceFile.getLineAndCharacterOfPosition(start);
  const id = `flow-point:${encodeURIComponent(state.sourceFile.fileName)}:${start}:${end}:${kind}:${encodeURIComponent(symbolKey ?? name)}`;
  const existing = state.points.get(id);
  if (existing) return existing;
  const created: MutableFlowPoint = {
    id,
    kind,
    name,
    symbolKey,
    callableId: callableIdValue,
    start,
    end,
    line: location.line,
    column: location.character,
    node,
  };
  state.points.set(id, created);
  return created;
}

function addReachingDefinitionEdges(state: AnalysisState, analysis: CallableAnalysis): void {
  const definitions = [...analysis.cfg.values()].flatMap((node) => node.definitions);
  const definitionById = new Map(definitions.map((definition) => [definition.point.id, definition]));
  const definitionsBySymbol = groupDefinitionsBySymbol(definitions);
  const input = new Map<string, Set<string>>();
  const output = new Map<string, Set<string>>();
  for (const node of analysis.cfg.values()) {
    input.set(node.id, new Set());
    output.set(node.id, new Set());
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of analysis.cfg.values()) {
      const nextInput = union([...node.predecessors].map((id) => output.get(id)!));
      const nextOutput = new Set(nextInput);
      if (node.invalidatesAllDefinitions) nextOutput.clear();
      const generated = lastDefinitionPerSymbol(node.definitions);
      for (const definition of generated) {
        for (const killed of definitionsBySymbol.get(definition.point.symbolKey!) ?? [])
          nextOutput.delete(killed.point.id);
        nextOutput.add(definition.point.id);
      }
      if (!sameSet(input.get(node.id)!, nextInput)) {
        input.set(node.id, nextInput);
        changed = true;
      }
      if (!sameSet(output.get(node.id)!, nextOutput)) {
        output.set(node.id, nextOutput);
        changed = true;
      }
    }
  }
  for (const node of analysis.cfg.values()) {
    const reaching = input.get(node.id)!;
    for (const use of node.uses) {
      const preceding = node.definitions
        .filter(
          (definition) =>
            definition.point.symbolKey === use.point.symbolKey &&
            definition.point.start < use.point.start &&
            !definition.rhsUseIds.includes(use.point.id),
        )
        .sort((left, right) => right.point.start - left.point.start)[0];
      const candidateDefinitionIds = preceding ? [preceding.point.id] : reaching;
      for (const definitionId of candidateDefinitionIds) {
        const definition = definitionById.get(definitionId)!;
        if (definition.point.symbolKey !== use.point.symbolKey) continue;
        addEdge(
          state,
          'reaching-definition',
          definition.point.id,
          use.point.id,
          'exact',
          'A CFG path reaches this use without an intervening definition.',
        );
      }
    }
    for (const definition of node.definitions) {
      for (const useId of definition.rhsUseIds) {
        addEdge(
          state,
          'value-source',
          useId,
          definition.point.id,
          'exact',
          'This right-hand-side use supplies the new definition.',
        );
      }
    }
  }
}

function groupDefinitionsBySymbol(definitions: readonly FlowDefinition[]): Map<string, FlowDefinition[]> {
  const result = new Map<string, FlowDefinition[]>();
  for (const definition of definitions) {
    if (!definition.point.symbolKey) continue;
    const rows = result.get(definition.point.symbolKey) ?? [];
    rows.push(definition);
    result.set(definition.point.symbolKey, rows);
  }
  return result;
}

function lastDefinitionPerSymbol(definitions: readonly FlowDefinition[]): FlowDefinition[] {
  const bySymbol = new Map<string, FlowDefinition>();
  for (const definition of definitions) {
    if (definition.point.symbolKey) bySymbol.set(definition.point.symbolKey, definition);
  }
  return [...bySymbol.values()];
}

function addControlDependenceEdges(state: AnalysisState, analysis: CallableAnalysis): void {
  const postdominators = computePostdominators(analysis);
  for (const branch of analysis.cfg.values()) {
    if (branch.successors.size < 2 || !branch.displayPoint) continue;
    const branchPostdominators = postdominators.get(branch.id)!;
    for (const successor of branch.successors) {
      for (const dependentId of postdominators.get(successor) ?? []) {
        if (branchPostdominators.has(dependentId) || dependentId === analysis.exitId) continue;
        const dependent = analysis.cfg.get(dependentId)!;
        const targets = [
          ...dependent.definitions.map((definition) => definition.point),
          ...dependent.uses.map((use) => use.point),
          ...(dependent.displayPoint ? [dependent.displayPoint] : []),
        ];
        for (const target of uniquePoints(targets)) {
          addEdge(
            state,
            'control-dependence',
            branch.displayPoint.id,
            target.id,
            'exact',
            'The target postdominates a branch successor but does not postdominate the predicate.',
          );
        }
      }
    }
  }
}

function computePostdominators(analysis: CallableAnalysis): Map<string, Set<string>> {
  const ids = [...analysis.cfg.keys()];
  const all = new Set(ids);
  const result = new Map<string, Set<string>>();
  for (const id of ids) result.set(id, id === analysis.exitId ? new Set([id]) : new Set(all));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of analysis.cfg.values()) {
      if (node.id === analysis.exitId) continue;
      const successorSets = [...node.successors].map((id) => result.get(id)!);
      const next = new Set([node.id, ...intersection(successorSets)]);
      if (!sameSet(result.get(node.id)!, next)) {
        result.set(node.id, next);
        changed = true;
      }
    }
  }
  return result;
}

function addCrossCallableCandidates(state: AnalysisState, analyses: readonly CallableAnalysis[]): void {
  const parentById = new Map(analyses.map((analysis) => [analysis.id, analysis.parentId]));
  const allDefinitions = analyses.flatMap((analysis) =>
    [...analysis.cfg.values()].flatMap((node) => node.definitions.map((definition) => definition.point)),
  );
  const definitionsBySymbol = new Map<string, MutableFlowPoint[]>();
  for (const definition of allDefinitions) {
    if (!definition.symbolKey) continue;
    const rows = definitionsBySymbol.get(definition.symbolKey) ?? [];
    rows.push(definition);
    definitionsBySymbol.set(definition.symbolKey, rows);
  }
  const reachedUses = new Set(
    [...state.edges.values()].filter((edge) => edge.kind === 'reaching-definition').map((edge) => edge.toPointId),
  );
  for (const analysis of analyses) {
    for (const use of [...analysis.cfg.values()].flatMap((node) => node.uses)) {
      if (!use.point.symbolKey || reachedUses.has(use.point.id)) continue;
      const candidates = definitionsBySymbol.get(use.point.symbolKey) ?? [];
      for (const definition of candidates) {
        if (isAncestorCallable(definition.callableId, use.point.callableId, parentById)) {
          addEdge(
            state,
            'closure-capture',
            definition.id,
            use.point.id,
            'candidate',
            'Compiler identity proves the captured binding, but invocation order can select among outer definitions.',
          );
        } else if (use.property) {
          addEdge(
            state,
            'field-definition-to-use',
            definition.id,
            use.point.id,
            'candidate',
            'Compiler identity matches the field; cross-callable receiver and execution order remain unresolved.',
          );
        }
      }
    }
  }
  if ([...state.edges.values()].some((edge) => edge.kind === 'closure-capture')) {
    state.unsupported.add(
      'Closure capture identity is known, but invocation order and intervening writes remain candidate flow.',
    );
  }
  if ([...state.edges.values()].some((edge) => edge.kind === 'field-definition-to-use')) {
    state.unsupported.add('Cross-callable field flow lacks receiver points-to and invocation-order analysis.');
  }
}

function isAncestorCallable(
  candidate: string,
  callable: string,
  parentById: ReadonlyMap<string, string | null>,
): boolean {
  for (let current = parentById.get(callable) ?? null; current; current = parentById.get(current) ?? null) {
    if (current === candidate) return true;
  }
  return false;
}

function addEdge(
  state: AnalysisState,
  kind: TypeScriptLocalFlowEdgeKind,
  fromPointId: string,
  toPointId: string,
  strength: TypeScriptLocalFlowEdge['strength'],
  reason: string,
): void {
  const id = `local-flow-edge:${kind}:${encodeURIComponent(fromPointId)}:${encodeURIComponent(toPointId)}`;
  state.edges.set(id, { id, kind, fromPointId, toPointId, strength, reason });
}

function assignmentOperator(ts: TypeScriptModule, kind: TypeScript.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function statementLabel(state: AnalysisState, node: TypeScript.Node): string {
  const text = node.getText(state.sourceFile).replace(/\s+/gu, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text || state.ts.SyntaxKind[node.kind] || 'statement';
}

function uniqueUses(uses: readonly FlowUse[]): FlowUse[] {
  return [...new Map(uses.map((use) => [use.point.id, use])).values()];
}

function uniquePoints(points: readonly MutableFlowPoint[]): MutableFlowPoint[] {
  return [...new Map(points.map((entry) => [entry.id, entry])).values()];
}

function union(sets: readonly ReadonlySet<string>[]): Set<string> {
  return new Set(sets.flatMap((set) => [...set]));
}

function intersection(sets: readonly ReadonlySet<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  return new Set([...sets[0]!].filter((value) => sets.slice(1).every((set) => set.has(value))));
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function comparePoints(left: TypeScriptLocalFlowPoint, right: TypeScriptLocalFlowPoint): number {
  return left.start - right.start || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

function unsupportedResult(reason: string): TypeScriptLocalFlowResult {
  return {
    points: [],
    edges: [],
    coverage: {
      status: 'unsupported',
      basis: 'typescript-compiler-cfg-reaching-definitions',
      unsupported: [reason],
    },
  };
}
