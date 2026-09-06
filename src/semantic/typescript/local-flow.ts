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
  /** A partial write (element access) adds a definition without killing earlier ones. */
  partial: boolean;
}

interface AccessTargetInfo {
  node: TypeScript.Node;
  symbolKey: string;
  name: string;
}

interface AssignmentTargetInfo extends AccessTargetInfo {
  partial: boolean;
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
  /** Where a thrown or implicitly raised exception lands: the nearest enclosing catch or finally entry. */
  throwTarget: string | null;
  /** The callable's single exit node. */
  exitId: string;
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
 * Default library declaration files parsed once per process. Every in-memory
 * program shares them, as the language service shares files through its
 * document registry: the binder skips a file whose locals already exist, and
 * the checker clones a symbol before merging a second declaration into it.
 */
const libSourceFiles = new Map<string, TypeScript.SourceFile>();

/**
 * Compute structured intraprocedural reaching definitions and postdominator-
 * based control dependence over TypeScript compiler nodes. Try, catch, and
 * finally regions are modeled with a conservative raise edge from every
 * try-block node. Heap aliases, closure invocation order, and a finally
 * block after an abrupt completion stay explicit gaps.
 */
export function analyzeTypeScriptLocalFlow(
  sourceText: string,
  fileName: string,
  range?: TypeScriptLocalFlowRange,
): TypeScriptLocalFlowResult {
  const ts = loadTypeScript();
  if (!ts) return unsupportedResult('The TypeScript compiler runtime is unavailable.');
  const program = inMemoryProgram(ts, parseTypeScriptSourceFile(ts, sourceText, fileName));
  const sourceFile = program.getSourceFile(resolve(fileName)) ?? program.getSourceFile(fileName);
  if (!sourceFile) return unsupportedResult(`The TypeScript compiler did not materialize ${fileName}.`);
  const diagnostics = program.getSyntacticDiagnostics(sourceFile);
  if (diagnostics.length) {
    return unsupportedResult(
      diagnostics
        .map((diagnostic) => {
          const location = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
          return `TypeScript syntax error at ${fileName}:${location.line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
        })
        .join('; '),
    );
  }
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

/** The TypeScript compiler module shared by compiler-backed analyses, or null when it is unavailable. */
export function loadTypeScriptModule(): TypeScriptModule | null {
  return loadTypeScript();
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

/**
 * Compiler options shared by every in-memory program. One object identity
 * keeps the type-reference resolution cache valid across programs.
 */
let sharedCompilerOptions: TypeScript.CompilerOptions | null = null;
let moduleResolutionCache: TypeScript.ModuleResolutionCache | null = null;
let typeReferenceResolutionCache: TypeScript.TypeReferenceDirectiveResolutionCache | null = null;

function compilerOptionsFor(ts: TypeScriptModule): TypeScript.CompilerOptions {
  if (!sharedCompilerOptions) {
    sharedCompilerOptions = {
      target: ts.ScriptTarget.ESNext,
      // Bundler resolution never consults package scopes for the module
      // format of the analyzed file; NodeNext would read package.json files
      // up the tree for every program.
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      noResolve: true,
      // Without this, every program looks for `@typescript/lib-*`
      // replacement packages in node_modules before using the bundled libs.
      libReplacement: false,
    };
  }
  return sharedCompilerOptions;
}

/** Parsed source files most recently analyzed, so a consumer that models the same file does not parse it again. */
const PARSED_SOURCE_FILES = new Map<string, { text: string; sourceFile: TypeScript.SourceFile }>();
const PARSED_SOURCE_FILE_LIMIT = 8;

/**
 * Parse a file the way the local-flow program will see it: an absolute
 * file name, parent pointers set, and the script kind from the extension.
 * The last few parses are retained so that the analyzer and a consumer
 * modelling the same file share one tree.
 */
export function parseTypeScriptSourceFile(
  ts: TypeScriptModule,
  sourceText: string,
  fileName: string,
): TypeScript.SourceFile {
  const absolute = resolve(fileName);
  const cached = PARSED_SOURCE_FILES.get(absolute);
  if (cached && cached.text === sourceText) {
    PARSED_SOURCE_FILES.delete(absolute);
    PARSED_SOURCE_FILES.set(absolute, cached);
    return cached.sourceFile;
  }
  const sourceFile = ts.createSourceFile(
    absolute,
    sourceText,
    compilerOptionsFor(ts).target!,
    true,
    scriptKind(ts, absolute),
  );
  PARSED_SOURCE_FILES.set(absolute, { text: sourceText, sourceFile });
  while (PARSED_SOURCE_FILES.size > PARSED_SOURCE_FILE_LIMIT) {
    const oldest = PARSED_SOURCE_FILES.keys().next().value;
    if (oldest === undefined) break;
    PARSED_SOURCE_FILES.delete(oldest);
  }
  return sourceFile;
}

function inMemoryProgram(ts: TypeScriptModule, sourceFile: TypeScript.SourceFile): TypeScript.Program {
  const absolute = sourceFile.fileName;
  const sourceText = sourceFile.text;
  const options = compilerOptionsFor(ts);
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  // Automatic `@types` packages give imports such as `react` a declaration
  // file inside the program, which is what lets a property write on a typed
  // value (`ref.current = x`) keep a compiler symbol. `noResolve` keeps every
  // other import out of the program but still resolves it through
  // node_modules, so both resolvers share process-wide caches: each package
  // is located once, and package manifests are parsed once.
  if (!moduleResolutionCache || !typeReferenceResolutionCache) {
    const currentDirectory = host.getCurrentDirectory();
    const getCanonicalFileName = host.getCanonicalFileName.bind(host);
    moduleResolutionCache = ts.createModuleResolutionCache(currentDirectory, getCanonicalFileName, options);
    typeReferenceResolutionCache = ts.createTypeReferenceDirectiveResolutionCache(
      currentDirectory,
      getCanonicalFileName,
      options,
      moduleResolutionCache.getPackageJsonInfoCache(),
    );
  }
  const moduleCache = moduleResolutionCache;
  const typeCache = typeReferenceResolutionCache;
  // Enumerating the automatic type directives reads every `@types` package
  // manifest; pin the list on the shared options after the first program.
  if (options.types === undefined) options.types = ts.getAutomaticTypeDirectiveNames(options, host);
  host.getModuleResolutionCache = () => moduleCache;
  // Only a package whose declarations arrived through `@types` can resolve
  // to a file that is in the program; every other import stays unresolved
  // without walking node_modules for it.
  const typedPackages = new Set(options.types ?? []);
  host.resolveModuleNameLiterals = (
    literals,
    containingFile,
    redirectedReference,
    resolveOptions,
    containingSourceFile,
  ) =>
    literals.map((literal) =>
      typedPackages.has(typesPackageName(literal.text))
        ? ts.resolveModuleName(
            literal.text,
            containingFile,
            resolveOptions,
            host,
            moduleCache,
            redirectedReference,
            ts.getModeForUsageLocation(containingSourceFile, literal, resolveOptions),
          )
        : { resolvedModule: undefined },
    );
  host.resolveTypeReferenceDirectiveReferences = (references, containingFile, redirectedReference, resolveOptions) =>
    references.map((reference) =>
      ts.resolveTypeReferenceDirective(
        typeof reference === 'string' ? reference : reference.fileName,
        containingFile,
        resolveOptions,
        host,
        redirectedReference,
        typeCache,
      ),
    );
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (resolve(candidate) === absolute) return sourceFile;
    const cached = libSourceFiles.get(candidate);
    if (cached) return cached;
    const created = originalGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);
    if (created) libSourceFiles.set(candidate, created);
    return created;
  };
  host.readFile = (candidate) => (resolve(candidate) === absolute ? sourceText : originalReadFile(candidate));
  host.fileExists = (candidate) => resolve(candidate) === absolute || originalFileExists(candidate);
  return ts.createProgram([absolute], options, host);
}

/** The `@types` directive name a module specifier would be declared under: `@babel/core/x` is `babel__core`. */
function typesPackageName(specifier: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return '';
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) return segments.length >= 2 ? `${segments[0]!.slice(1)}__${segments[1]!}` : '';
  return segments[0] ?? '';
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
    first = buildStatements(state, cfg, [...body.statements], exit.id, {
      breakTarget: null,
      continueTarget: null,
      throwTarget: null,
      exitId: exit.id,
    });
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
  if (ts.isIfStatement(statement)) return buildIfStatement(state, cfg, statement, next, context);
  if (ts.isWhileStatement(statement) || ts.isDoStatement(statement))
    return buildPredicateLoop(state, cfg, statement, next, context);
  if (ts.isForStatement(statement)) return buildForStatement(state, cfg, statement, next, context);
  if (ts.isForInStatement(statement) || ts.isForOfStatement(statement))
    return buildIterationStatement(state, cfg, statement, next, context);
  if (ts.isSwitchStatement(statement)) return buildSwitchStatement(state, cfg, statement, next, context);
  if (ts.isTryStatement(statement)) return buildTryStatement(state, cfg, statement, next, context);
  if (ts.isExpressionStatement(statement)) return buildExpressionFlow(state, cfg, statement.expression, next);
  return (
    buildJumpStatement(state, cfg, statement, next, context) ?? buildSequentialStatement(state, cfg, statement, next)
  );
}

function buildIfStatement(
  state: AnalysisState,
  cfg: Map<string, CfgNode>,
  statement: TypeScript.IfStatement,
  next: string,
  context: BuildContext,
): string {
  const predicate = cfgNode(state, cfg, 'predicate', statement.expression);
  const whenTrue = buildStatement(state, cfg, statement.thenStatement, next, context);
  const whenFalse = statement.elseStatement ? buildStatement(state, cfg, statement.elseStatement, next, context) : next;
  connect(cfg, predicate.id, whenTrue);
  connect(cfg, predicate.id, whenFalse);
  return predicate.id;
}

function buildPredicateLoop(
  state: AnalysisState,
  cfg: Map<string, CfgNode>,
  statement: TypeScript.WhileStatement | TypeScript.DoStatement,
  next: string,
  context: BuildContext,
): string {
  const predicate = cfgNode(state, cfg, 'predicate', statement.expression);
  const body = buildStatement(state, cfg, statement.statement, predicate.id, {
    ...context,
    breakTarget: next,
    continueTarget: predicate.id,
  });
  connect(cfg, predicate.id, body);
  connect(cfg, predicate.id, next);
  return state.ts.isDoStatement(statement) ? body : predicate.id;
}

function buildForStatement(
  state: AnalysisState,
  cfg: Map<string, CfgNode>,
  statement: TypeScript.ForStatement,
  next: string,
  context: BuildContext,
): string {
  const predicate = cfgNode(state, cfg, 'predicate', statement.condition ?? statement);
  const increment = statement.incrementor ? cfgNode(state, cfg, 'statement', statement.incrementor) : null;
  if (increment) connect(cfg, increment.id, predicate.id);
  const continueTarget = increment?.id ?? predicate.id;
  const body = buildStatement(state, cfg, statement.statement, continueTarget, {
    ...context,
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

function buildIterationStatement(
  state: AnalysisState,
  cfg: Map<string, CfgNode>,
  statement: TypeScript.ForInStatement | TypeScript.ForOfStatement,
  next: string,
  context: BuildContext,
): string {
  state.unsupported.add(
    'for-in/for-of loop variables are drawn from the iterable as a whole; per-element flow is not modeled.',
  );
  const predicate = cfgNode(state, cfg, 'predicate', statement.expression);
  const initializer = cfgNode(state, cfg, 'statement', statement.initializer);
  const body = buildStatement(state, cfg, statement.statement, predicate.id, {
    ...context,
    breakTarget: next,
    continueTarget: predicate.id,
  });
  connect(cfg, predicate.id, initializer.id);
  connect(cfg, predicate.id, next);
  connect(cfg, initializer.id, body);
  return predicate.id;
}

function buildSwitchStatement(
  state: AnalysisState,
  cfg: Map<string, CfgNode>,
  statement: TypeScript.SwitchStatement,
  next: string,
  context: BuildContext,
): string {
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

function buildJumpStatement(
  state: AnalysisState,
  cfg: Map<string, CfgNode>,
  statement: TypeScript.Statement,
  next: string,
  context: BuildContext,
): string | null {
  const ts = state.ts;
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    const terminal = cfgNode(state, cfg, 'statement', statement);
    const target = ts.isThrowStatement(statement) ? (context.throwTarget ?? context.exitId) : context.exitId;
    connect(cfg, terminal.id, target);
    return terminal.id;
  }
  if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) {
    const kind = ts.isBreakStatement(statement) ? 'break' : 'continue';
    const target = context[`${kind}Target`];
    const node = cfgNode(state, cfg, 'statement', statement);
    if (!target) state.unsupported.add(`A ${kind} statement could not be attached to a structured target.`);
    connect(cfg, node.id, target ?? next);
    return node.id;
  }
  return null;
}

function buildSequentialStatement(
  state: AnalysisState,
  cfg: Map<string, CfgNode>,
  statement: TypeScript.Statement,
  next: string,
): string {
  const node = cfgNode(state, cfg, 'statement', statement);
  connect(cfg, node.id, next);
  return node.id;
}

/** Branching expression statements need distinct CFG paths so a conditional write cannot kill its fallback. */
function buildExpressionFlow(
  state: AnalysisState,
  cfg: Map<string, CfgNode>,
  expression: TypeScript.Expression,
  next: string,
): string {
  const ts = state.ts;
  if (ts.isParenthesizedExpression(expression)) return buildExpressionFlow(state, cfg, expression.expression, next);
  if (ts.isConditionalExpression(expression)) {
    const predicate = cfgNode(state, cfg, 'predicate', expression.condition);
    connect(cfg, predicate.id, buildExpressionFlow(state, cfg, expression.whenTrue, next));
    connect(cfg, predicate.id, buildExpressionFlow(state, cfg, expression.whenFalse, next));
    return predicate.id;
  }
  if (ts.isBinaryExpression(expression) && shortCircuitOperator(ts, expression.operatorToken.kind)) {
    const predicate = cfgNode(state, cfg, 'predicate', expression.left);
    connect(cfg, predicate.id, next);
    connect(cfg, predicate.id, buildExpressionFlow(state, cfg, expression.right, next));
    return predicate.id;
  }
  const node = cfgNode(state, cfg, 'statement', expression);
  connect(cfg, node.id, next);
  return node.id;
}

function shortCircuitOperator(ts: TypeScriptModule, kind: TypeScript.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

/**
 * A try statement is built as three regions. Any node inside the try block
 * may raise, so the state before each of them (the try entry and every
 * try-block node) flows to the catch entry, and a `throw` inside the block
 * lands there instead of at the exit. The catch block may raise into the
 * finally block the same way. Normal completion of either block continues
 * through the finally block, when present, to the next statement. A return,
 * break, or continue inside the try or catch skips the finally block in
 * this graph; that gap is disclosed.
 */
function buildTryStatement(
  state: AnalysisState,
  cfg: Map<string, CfgNode>,
  statement: TypeScript.TryStatement,
  next: string,
  context: BuildContext,
): string {
  const ts = state.ts;
  const finallyEntry = statement.finallyBlock
    ? buildStatements(state, cfg, [...statement.finallyBlock.statements], next, context)
    : null;
  const after = finallyEntry ?? next;
  let catchEntry: string | null = null;
  let catchNodes: string[] = [];
  if (statement.catchClause) {
    const before = new Set(cfg.keys());
    const catchContext: BuildContext = { ...context, throwTarget: finallyEntry ?? context.throwTarget };
    const catchBody = buildStatements(state, cfg, [...statement.catchClause.block.statements], after, catchContext);
    catchEntry = catchBody;
    if (statement.catchClause.variableDeclaration) {
      const binding = cfgNode(state, cfg, 'statement', statement.catchClause.variableDeclaration);
      connect(cfg, binding.id, catchBody);
      catchEntry = binding.id;
    }
    catchNodes = [...cfg.keys()].filter((id) => !before.has(id));
  }
  const raiseTarget = catchEntry ?? finallyEntry ?? context.throwTarget;
  const before = new Set(cfg.keys());
  const tryEntry = buildStatements(state, cfg, [...statement.tryBlock.statements], after, {
    ...context,
    throwTarget: raiseTarget,
  });
  const tryNodes = [...cfg.keys()].filter((id) => !before.has(id));
  const entry = cfgNode(state, cfg, 'statement', null);
  connect(cfg, entry.id, tryEntry);
  if (raiseTarget) {
    connect(cfg, entry.id, raiseTarget);
    for (const id of tryNodes) if (mayRaiseInto(state, cfg.get(id)!)) connect(cfg, id, raiseTarget);
  }
  if (finallyEntry && catchEntry) {
    for (const id of catchNodes) if (mayRaiseInto(state, cfg.get(id)!)) connect(cfg, id, finallyEntry);
  }
  if (statement.finallyBlock && hasAbruptCompletion(ts, statement.tryBlock, statement.catchClause?.block)) {
    state.unsupported.add(
      'A finally block after return, break, or continue inside its try or catch is not sequenced in the local compiler CFG.',
    );
  }
  return entry.id;
}

/** Nodes whose completion could still be followed by a raise before the handler; terminal jumps have already left. */
function mayRaiseInto(state: AnalysisState, node: CfgNode): boolean {
  const ast = node.ast;
  if (!ast || node.kind === 'exit' || node.kind === 'entry') return false;
  const ts = state.ts;
  return !(ts.isReturnStatement(ast) || ts.isThrowStatement(ast) || ts.isBreakOrContinueStatement(ast));
}

function hasAbruptCompletion(ts: TypeScriptModule, ...blocks: (TypeScript.Block | undefined)[]): boolean {
  let found = false;
  const visit = (node: TypeScript.Node): void => {
    if (found || ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) || ts.isBreakOrContinueStatement(node)) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  for (const block of blocks) if (block) visit(block);
  return found;
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
    const targets = bindingTargets(state, parameter.name);
    if (targets.length === 0 && state.ts.isIdentifier(parameter.name)) {
      state.unsupported.add('A parameter binding could not be resolved to a compiler symbol.');
      continue;
    }
    for (const target of targets) {
      entry.definitions.push({
        point: point(state, target.node, 'parameter-definition', target.symbolKey, target.name, analysis.id),
        rhsUseIds: [],
        partial: false,
      });
    }
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
  const visit = (node: TypeScript.Node): void => {
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node)) return collectDeclarationAccesses(state, analysis, cfg, node);
    if (
      ts.isConditionalExpression(node) ||
      (ts.isBinaryExpression(node) && shortCircuitOperator(ts, node.operatorToken.kind))
    ) {
      // Expressions not split into CFG nodes (e.g. within a predicate or initializer)
      // must not model their conditional assignments as unconditional definitions.
      cfg.uses.push(...collectUses(state, analysis.id, node, cfg));
      return;
    }
    if (ts.isBinaryExpression(node) && assignmentOperator(ts, node.operatorToken.kind))
      return collectAssignmentAccesses(state, analysis, cfg, node);
    if (isUpdateExpression(ts, node)) return collectUpdateAccesses(state, analysis, cfg, node);
    if (ts.isDeleteExpression(node)) {
      reportDelete(state, cfg);
      return;
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

function collectDeclarationAccesses(
  state: AnalysisState,
  analysis: CallableAnalysis,
  cfg: CfgNode,
  node: TypeScript.VariableDeclaration,
): void {
  const ts = state.ts;
  const source = node.initializer ?? iterationSource(ts, node);
  reportPossibleAlias(state, node.initializer);
  const uses = source ? collectUses(state, analysis.id, source, cfg) : [];
  const targets = bindingTargets(state, node.name, (fallback) =>
    uses.push(...collectUses(state, analysis.id, fallback, cfg)),
  );
  cfg.uses.push(...uses);
  if (targets.length === 0 && ts.isIdentifier(node.name)) {
    cfg.invalidatesAllDefinitions = true;
    state.unsupported.add('A variable declaration could not be resolved to a compiler symbol.');
    return;
  }
  recordFlowDefinitions(state, analysis.id, cfg, targets, uses);
}

function collectAssignmentAccesses(
  state: AnalysisState,
  analysis: CallableAnalysis,
  cfg: CfgNode,
  node: TypeScript.BinaryExpression,
): void {
  const ts = state.ts;
  if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) reportPossibleAlias(state, node.right);
  const rhsUses = collectUses(state, analysis.id, node.right, cfg);
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
    rhsUses.push(...collectUses(state, analysis.id, node.left, cfg));
  const targets = assignmentTargets(state, analysis.id, node.left, cfg, rhsUses);
  cfg.uses.push(...rhsUses);
  if (!targets) {
    cfg.invalidatesAllDefinitions = true;
    state.unsupported.add('Dynamic assignment targets are not included in reaching definitions.');
    return;
  }
  recordFlowDefinitions(state, analysis.id, cfg, targets, rhsUses);
}

function collectUpdateAccesses(
  state: AnalysisState,
  analysis: CallableAnalysis,
  cfg: CfgNode,
  node: TypeScript.PrefixUnaryExpression | TypeScript.PostfixUnaryExpression,
): void {
  const uses = collectUses(state, analysis.id, node.operand, cfg);
  const targets = assignmentTargets(state, analysis.id, node.operand, cfg, uses) ?? [];
  cfg.uses.push(...uses);
  recordFlowDefinitions(state, analysis.id, cfg, targets, uses);
}

function recordFlowDefinitions(
  state: AnalysisState,
  callableIdValue: string,
  cfg: CfgNode,
  targets: readonly (AccessTargetInfo & { partial?: boolean })[],
  uses: readonly FlowUse[],
): void {
  const rhsUseIds = uses.map((use) => use.point.id);
  for (const target of targets) {
    cfg.definitions.push({
      point: point(state, target.node, 'definition', target.symbolKey, target.name, callableIdValue),
      rhsUseIds,
      partial: target.partial ?? false,
    });
  }
}

function collectUses(state: AnalysisState, callableIdValue: string, root: TypeScript.Node, cfg: CfgNode): FlowUse[] {
  const uses: FlowUse[] = [];
  const visit = (node: TypeScript.Node): void => {
    if (state.ts.isFunctionLike(node)) return;
    if (state.ts.isDeleteExpression(node)) {
      reportDelete(state, cfg);
      return;
    }
    if (isUpdateExpression(state.ts, node)) {
      cfg.invalidatesAllDefinitions = true;
      const location = state.sourceFile.getLineAndCharacterOfPosition(node.getStart(state.sourceFile));
      state.unsupported.add(
        `Nested increment/decrement at ${state.sourceFile.fileName}:${location.line + 1} is not included in ordered local definition-use flow.`,
      );
      visit(node.operand);
      return;
    }
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

function isUpdateExpression(
  ts: TypeScriptModule,
  node: TypeScript.Node,
): node is TypeScript.PrefixUnaryExpression | TypeScript.PostfixUnaryExpression {
  return (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

function reportPossibleAlias(state: AnalysisState, node: TypeScript.Expression | undefined): void {
  if (!node) return;
  const values = aliasValues(state.ts, node);
  if (values) {
    for (const value of values) reportPossibleAlias(state, value);
    return;
  }
  if (!receiverTarget(state, node) || !mayCarryObject(state, node)) return;
  const location = state.sourceFile.getLineAndCharacterOfPosition(node.getStart(state.sourceFile));
  state.unsupported.add(
    `Object alias at ${state.sourceFile.fileName}:${location.line + 1} is not included in local points-to flow.`,
  );
}

/** Values retained by aggregate construction or forwarded by an expression wrapper. */
function aliasValues(
  ts: TypeScriptModule,
  node: TypeScript.Expression,
): readonly (TypeScript.Expression | undefined)[] | undefined {
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.map((property) => aliasPropertyValue(ts, property));
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => (ts.isSpreadElement(element) ? element.expression : element));
  }
  if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse];
  const wrapped = aliasWrappedValue(ts, node);
  return wrapped ? [wrapped] : undefined;
}

function aliasPropertyValue(
  ts: TypeScriptModule,
  property: TypeScript.ObjectLiteralElementLike,
): TypeScript.Expression | undefined {
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  if (ts.isSpreadAssignment(property)) return property.expression;
  return undefined;
}

function aliasWrappedValue(ts: TypeScriptModule, node: TypeScript.Expression): TypeScript.Expression | undefined {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return node.expression;
  }
  return undefined;
}

function reportDelete(state: AnalysisState, cfg: CfgNode): void {
  cfg.invalidatesAllDefinitions = true;
  state.unsupported.add(
    'Property deletion is not included in local mutation flow; prior reaching definitions are invalidated.',
  );
}

function mayCarryObject(state: AnalysisState, node: TypeScript.Node): boolean {
  const ts = state.ts;
  const type = state.checker.getTypeAtLocation(node);
  const types = type.isUnionOrIntersection() ? type.types : [type];
  return types.some(
    (part) =>
      (part.flags &
        (ts.TypeFlags.Object |
          ts.TypeFlags.Any |
          ts.TypeFlags.Unknown |
          ts.TypeFlags.TypeParameter |
          ts.TypeFlags.NonPrimitive)) !==
      0,
  );
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

/**
 * Every identifier a binding name introduces: one for a plain identifier, one
 * per leaf of an object or array pattern. Default-value expressions inside
 * the pattern are reported through `onDefault` so their reads join the
 * definition's right-hand side.
 */
function bindingTargets(
  state: AnalysisState,
  name: TypeScript.BindingName,
  onDefault?: (initializer: TypeScript.Expression) => void,
): AccessTargetInfo[] {
  const ts = state.ts;
  if (ts.isIdentifier(name)) {
    const target = accessTarget(state, name);
    return target ? [target] : [];
  }
  const targets: AccessTargetInfo[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (element.initializer && onDefault) onDefault(element.initializer);
    targets.push(...bindingTargets(state, element.name, onDefault));
  }
  return targets;
}

/**
 * Every storage location an assignment expression writes. An element write
 * (`items[index] = value`) is a partial definition of its container; object
 * and array destructuring assignments write each nested target. Null means
 * the target cannot be named, so reaching definitions are invalidated.
 */
function assignmentTargets(
  state: AnalysisState,
  callableIdValue: string,
  expression: TypeScript.Expression,
  cfg: CfgNode,
  rhsUses: FlowUse[],
): AssignmentTargetInfo[] | null {
  const ts = state.ts;
  if (ts.isParenthesizedExpression(expression)) {
    return assignmentTargets(state, callableIdValue, expression.expression, cfg, rhsUses);
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) {
    return assignmentTargets(state, callableIdValue, expression.expression, cfg, rhsUses);
  }
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    const target = accessTarget(state, expression);
    return target ? [{ ...target, partial: false }] : null;
  }
  if (ts.isElementAccessExpression(expression)) {
    const base = accessTarget(state, expression.expression);
    if (!base) return null;
    rhsUses.push(...collectUses(state, callableIdValue, expression.expression, cfg));
    rhsUses.push(...collectUses(state, callableIdValue, expression.argumentExpression, cfg));
    return [{ node: expression, symbolKey: base.symbolKey, name: `${base.name}[…]`, partial: true }];
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const targets: AssignmentTargetInfo[] = [];
    for (const property of expression.properties) {
      let nested: AssignmentTargetInfo[] | null = null;
      if (ts.isShorthandPropertyAssignment(property)) {
        const symbol = state.checker.getShorthandAssignmentValueSymbol(property);
        const key = symbol ? symbolKeyFor(state, symbol) : null;
        nested = key ? [{ node: property.name, symbolKey: key, name: property.name.text, partial: false }] : null;
        if (property.objectAssignmentInitializer)
          rhsUses.push(...collectUses(state, callableIdValue, property.objectAssignmentInitializer, cfg));
      } else if (ts.isPropertyAssignment(property)) {
        nested = assignmentTargets(state, callableIdValue, property.initializer, cfg, rhsUses);
      } else if (ts.isSpreadAssignment(property)) {
        nested = assignmentTargets(state, callableIdValue, property.expression, cfg, rhsUses);
      }
      if (!nested) return null;
      targets.push(...nested);
    }
    return targets;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const targets: AssignmentTargetInfo[] = [];
    for (const element of expression.elements) {
      if (ts.isOmittedExpression(element)) continue;
      let nested: AssignmentTargetInfo[] | null;
      if (ts.isSpreadElement(element)) {
        nested = assignmentTargets(state, callableIdValue, element.expression, cfg, rhsUses);
      } else if (ts.isBinaryExpression(element) && element.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        rhsUses.push(...collectUses(state, callableIdValue, element.right, cfg));
        nested = assignmentTargets(state, callableIdValue, element.left, cfg, rhsUses);
      } else {
        nested = assignmentTargets(state, callableIdValue, element, cfg, rhsUses);
      }
      if (!nested) return null;
      targets.push(...nested);
    }
    return targets;
  }
  return null;
}

/** The iterable a `for...of` or `for...in` loop variable is drawn from, when this declaration is that variable. */
function iterationSource(ts: TypeScriptModule, node: TypeScript.VariableDeclaration): TypeScript.Expression | null {
  const list = node.parent;
  if (!list || !ts.isVariableDeclarationList(list)) return null;
  const loop = list.parent;
  if (loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) && loop.initializer === list) {
    return loop.expression;
  }
  return null;
}

/**
 * The storage location an access names. An identifier is keyed by its
 * compiler symbol. A property access is keyed by its receiver's location
 * plus the member name, so `ref.current` on two different refs are two
 * locations and no receiver type has to be inferred; a receiver that is
 * not itself a location (a call result) makes the access unnamed. `this`
 * is one location per class or object literal, or per free function.
 */
function accessTarget(state: AnalysisState, node: TypeScript.Node): AccessTargetInfo | null {
  const ts = state.ts;
  if (ts.isIdentifier(node)) {
    const key = compilerSymbolKey(state, node);
    return key ? { node, symbolKey: key, name: node.text } : null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const receiver = receiverTarget(state, node.expression);
    return receiver
      ? { node, symbolKey: `${receiver.symbolKey}.${node.name.text}`, name: node.getText(state.sourceFile) }
      : null;
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) return { node, symbolKey: thisSymbolKey(state, node), name: 'this' };
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

/**
 * The location a property access reads through, when its receiver is one:
 * a binding, `this`, or another named location. A call result or a literal
 * receiver is a value, not a location, and is not a gap in the model.
 */
function receiverTarget(state: AnalysisState, node: TypeScript.Node): AccessTargetInfo | null {
  const ts = state.ts;
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || node.kind === ts.SyntaxKind.ThisKeyword) {
    return accessTarget(state, node);
  }
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return receiverTarget(state, node.expression);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
    return receiverTarget(state, node.expression);
  }
  return null;
}

/** `this` names the instance of the nearest class or object literal, or the receiver of the nearest free function. */
function thisSymbolKey(state: AnalysisState, node: TypeScript.Node): string {
  const ts = state.ts;
  const file = encodeURIComponent(state.sourceFile.fileName);
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isArrowFunction(current)) continue;
    if (ts.isClassLike(current)) return `symbol:${file}:${current.getStart(state.sourceFile)}:this`;
    if (ts.isFunctionLike(current)) {
      const owner = current.parent;
      if (owner && (ts.isClassLike(owner) || ts.isObjectLiteralExpression(owner))) {
        return `symbol:${file}:${owner.getStart(state.sourceFile)}:this`;
      }
      return `symbol:${file}:${current.getStart(state.sourceFile)}:this`;
    }
  }
  return `symbol:${file}:0:this`;
}

function compilerSymbolKey(state: AnalysisState, node: TypeScript.Node): string | null {
  const parent = node.parent;
  // `{ value }` in an object literal names the local binding, not the property it creates.
  const symbol =
    parent && state.ts.isShorthandPropertyAssignment(parent) && parent.name === node
      ? (state.checker.getShorthandAssignmentValueSymbol(parent) ?? state.checker.getSymbolAtLocation(node))
      : state.checker.getSymbolAtLocation(node);
  return symbol ? symbolKeyFor(state, symbol) : null;
}

function symbolKeyFor(state: AnalysisState, resolved: TypeScript.Symbol): string {
  let symbol = resolved;
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

/** Dense bit set over definition or node indices. */
type BitSet = Uint32Array;

function bitSet(bits: number): BitSet {
  return new Uint32Array((bits + 31) >>> 5);
}

function bitSetHas(set: BitSet, index: number): boolean {
  return (set[index >>> 5]! & (1 << (index & 31))) !== 0;
}

function bitSetAdd(set: BitSet, index: number): void {
  set[index >>> 5]! |= 1 << (index & 31);
}

function bitSetForEach(set: BitSet, visit: (index: number) => void): void {
  for (let word = 0; word < set.length; word += 1) {
    let bits = set[word]!;
    while (bits !== 0) {
      const lowest = bits & -bits;
      visit((word << 5) + (31 - Math.clz32(lowest)));
      bits ^= lowest;
    }
  }
}

/** Node ids in reverse postorder from `root` over `next`; unreachable nodes follow in insertion order. */
function reversePostorder(
  cfg: ReadonlyMap<string, CfgNode>,
  root: string,
  next: (node: CfgNode) => ReadonlySet<string>,
): string[] {
  const visited = new Set<string>();
  const postorder: string[] = [];
  const stack: { id: string; successors: string[]; cursor: number }[] = [];
  const push = (id: string): void => {
    visited.add(id);
    stack.push({ id, successors: [...next(cfg.get(id)!)], cursor: 0 });
  };
  push(root);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.cursor < frame.successors.length) {
      const successor = frame.successors[frame.cursor]!;
      frame.cursor += 1;
      if (!visited.has(successor)) push(successor);
    } else {
      postorder.push(frame.id);
      stack.pop();
    }
  }
  const order = postorder.reverse();
  for (const id of cfg.keys()) if (!visited.has(id)) order.push(id);
  return order;
}

/**
 * Iterative reaching definitions over dense bit sets. Nodes are visited in
 * reverse postorder from the entry with a worklist, so straight-line code
 * converges in one pass and loops in a few, regardless of the order in
 * which the CFG builder created the nodes.
 */
function addReachingDefinitionEdges(state: AnalysisState, analysis: CallableAnalysis): void {
  const definitions = [...analysis.cfg.values()].flatMap((node) => node.definitions);
  const definitionIndex = new Map<string, number>();
  definitions.forEach((definition, index) => definitionIndex.set(definition.point.id, index));
  const definitionsBySymbol = groupDefinitionsBySymbol(definitions);
  const bySymbolIndices = new Map<string, number[]>();
  for (const [symbolKey, rows] of definitionsBySymbol) {
    bySymbolIndices.set(
      symbolKey,
      rows.map((definition) => definitionIndex.get(definition.point.id)!),
    );
  }
  const order = reversePostorder(analysis.cfg, analysis.entryId, (node) => node.successors);
  const nodeIndex = new Map<string, number>();
  order.forEach((id, index) => nodeIndex.set(id, index));
  const nodes = order.map((id) => analysis.cfg.get(id)!);
  const width = definitions.length;
  const gen = nodes.map(() => bitSet(width));
  const kill = nodes.map(() => bitSet(width));
  nodes.forEach((node, index) => {
    for (const definition of lastDefinitionPerSymbol(node.definitions)) {
      if (!definition.partial) {
        for (const killed of bySymbolIndices.get(definition.point.symbolKey!) ?? []) bitSetAdd(kill[index]!, killed);
      }
      bitSetAdd(gen[index]!, definitionIndex.get(definition.point.id)!);
    }
  });
  const input = nodes.map(() => bitSet(width));
  const output = nodes.map(() => bitSet(width));
  const queued = new Uint8Array(nodes.length).fill(1);
  const worklist: number[] = nodes.map((_node, index) => index);
  let head = 0;
  while (head < worklist.length) {
    const index = worklist[head]!;
    head += 1;
    queued[index] = 0;
    const node = nodes[index]!;
    const nextInput = input[index]!;
    nextInput.fill(0);
    for (const predecessor of node.predecessors) {
      const from = output[nodeIndex.get(predecessor)!]!;
      for (let word = 0; word < from.length; word += 1) nextInput[word]! |= from[word]!;
    }
    const nextOutput = output[index]!;
    const genSet = gen[index]!;
    const killSet = kill[index]!;
    let changed = false;
    for (let word = 0; word < nextOutput.length; word += 1) {
      // Bitwise operators yield signed 32-bit values; normalize before comparing with the stored unsigned word.
      const value =
        (node.invalidatesAllDefinitions ? genSet[word]! : (nextInput[word]! & ~killSet[word]!) | genSet[word]!) >>> 0;
      if (value !== nextOutput[word]) {
        nextOutput[word] = value;
        changed = true;
      }
    }
    if (!changed) continue;
    for (const successor of node.successors) {
      const successorIndex = nodeIndex.get(successor)!;
      if (queued[successorIndex] === 0) {
        queued[successorIndex] = 1;
        worklist.push(successorIndex);
      }
    }
  }
  nodes.forEach((node, index) => {
    const reaching = input[index]!;
    for (const use of node.uses) {
      const preceding = node.definitions
        .filter(
          (definition) =>
            definition.point.symbolKey === use.point.symbolKey &&
            definition.point.start < use.point.start &&
            !definition.rhsUseIds.includes(use.point.id),
        )
        .sort((left, right) => right.point.start - left.point.start)[0];
      const candidateDefinitions = preceding
        ? [preceding]
        : (bySymbolIndices.get(use.point.symbolKey ?? '') ?? [])
            .filter((definitionIndexValue) => bitSetHas(reaching, definitionIndexValue))
            .map((definitionIndexValue) => definitions[definitionIndexValue]!);
      for (const definition of candidateDefinitions) {
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
  });
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
  const { order, sets } = computePostdominators(analysis);
  const nodeIndex = new Map<string, number>();
  order.forEach((id, index) => nodeIndex.set(id, index));
  const exitIndex = nodeIndex.get(analysis.exitId)!;
  for (const branch of analysis.cfg.values()) {
    if (branch.kind !== 'predicate' || !branch.displayPoint) continue;
    for (const use of branch.uses) {
      addEdge(
        state,
        'value-source',
        use.point.id,
        branch.displayPoint.id,
        'exact',
        'The predicate evaluates this variable occurrence to choose its control-flow successor.',
      );
    }
    if (branch.successors.size < 2) continue;
    const branchPostdominators = sets[nodeIndex.get(branch.id)!]!;
    for (const successor of branch.successors) {
      bitSetForEach(sets[nodeIndex.get(successor)!]!, (dependentIndex) => {
        if (dependentIndex === exitIndex || bitSetHas(branchPostdominators, dependentIndex)) return;
        const dependent = analysis.cfg.get(order[dependentIndex]!)!;
        const targets = [
          ...dependent.definitions.map((definition) => definition.point),
          ...dependent.uses.map((use) => use.point),
          ...(dependent.displayPoint ? [dependent.displayPoint] : []),
        ];
        for (const target of uniquePoints(targets)) {
          addEdge(
            state,
            'control-dependence',
            branch.displayPoint!.id,
            target.id,
            'exact',
            'The target postdominates a branch successor but does not postdominate the predicate.',
          );
        }
      });
    }
  }
}

/**
 * Postdominator sets as bit sets indexed by the returned node order, which
 * is reverse postorder over predecessors from the exit so that information
 * flows from the exit outward in as few passes as possible.
 */
function computePostdominators(analysis: CallableAnalysis): { order: string[]; sets: BitSet[] } {
  const order = reversePostorder(analysis.cfg, analysis.exitId, (node) => node.predecessors);
  const nodeIndex = new Map<string, number>();
  order.forEach((id, index) => nodeIndex.set(id, index));
  const count = order.length;
  const exitIndex = nodeIndex.get(analysis.exitId)!;
  const sets = order.map((_id, index) => {
    const set = bitSet(count);
    if (index === exitIndex) {
      bitSetAdd(set, index);
    } else {
      set.fill(0xffffffff);
      const spare = set.length * 32 - count;
      if (spare > 0) set[set.length - 1] = 0xffffffff >>> spare;
    }
    return set;
  });
  const nodes = order.map((id) => analysis.cfg.get(id)!);
  const queued = new Uint8Array(count).fill(1);
  const worklist: number[] = nodes.map((_node, index) => index);
  let head = 0;
  const scratch = bitSet(count);
  while (head < worklist.length) {
    const index = worklist[head]!;
    head += 1;
    queued[index] = 0;
    if (index === exitIndex) continue;
    const node = nodes[index]!;
    if (node.successors.size === 0) continue;
    scratch.fill(0xffffffff);
    for (const successor of node.successors) {
      const from = sets[nodeIndex.get(successor)!]!;
      for (let word = 0; word < scratch.length; word += 1) scratch[word]! &= from[word]!;
    }
    bitSetAdd(scratch, index);
    const current = sets[index]!;
    let changed = false;
    for (let word = 0; word < current.length; word += 1) {
      if (scratch[word] !== current[word]) {
        current[word] = scratch[word]!;
        changed = true;
      }
    }
    if (!changed) continue;
    for (const predecessor of node.predecessors) {
      const predecessorIndex = nodeIndex.get(predecessor)!;
      if (queued[predecessorIndex] === 0) {
        queued[predecessorIndex] = 1;
        worklist.push(predecessorIndex);
      }
    }
  }
  return { order, sets };
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
        } else if (use.property && definition.callableId !== use.point.callableId) {
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
