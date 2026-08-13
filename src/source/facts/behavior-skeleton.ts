import type { ScipDatabase } from '../../storage/db.js';
import type { ParserControlRelationSubtype } from '../../domain/graph-relation-providers.js';
import { getAst } from '../ast/ast-core.js';
import { smallestNodeCoveringLines } from '../ast/ast-callables.js';
import type { SyntaxNode } from '../ast/ast-types.js';
import { classifyFile } from '../primitives/file-kind.js';
import { getSourceLines } from '../primitives/source-text.js';
import { getSourceFacts } from './source-facts.js';

const MAX_TEST_CASES = 12;
const MIN_RECEIPT_BODY_LINES = 20;
const MAX_RECEIPT_LINE_CHARACTERS = 200;
const MAX_OUTLINE_LINE_CHARACTERS = 800;
const OUTLINE_SAVINGS_RATIO = 0.9;

export type BehaviorSignal =
  | 'anchor'
  | 'signature'
  | 'binding'
  | 'branch'
  | 'loop'
  | 'call'
  | 'await'
  | 'return'
  | 'throw'
  | 'mutation'
  | 'shape'
  | 'spread'
  | 'catch'
  | 'finally';

export interface BehaviorSkeletonLine {
  line: number;
  endLine: number;
  depth: number;
  signals: BehaviorSignal[];
  text: string;
  copied: boolean;
}

export interface BehaviorSkeleton {
  callable?: {
    name: string;
    startLine: number;
    endLine: number;
  };
  representation: 'outline';
  constructKind: string;
  signature: string;
  lines: BehaviorSkeletonLine[];
  signals: BehaviorSignal[];
  testCases: string[];
  coverage: {
    sourceStatements: number;
    representedStatements: number;
    copiedStatements: number;
    omittedStatements: 0;
  };
  rawCharacters: number;
  outlineCharacters: number;
  /** @deprecated Prefer coverage.sourceStatements. */
  candidateLines: number;
  /** @deprecated Behavioral outlines never silently omit statements. */
  omittedLines: number;
}

export interface BehaviorConstructRange {
  startLine: number;
  endLine: number;
}

export type BehaviorControlSubtype = ParserControlRelationSubtype;

export interface BehaviorControlConstruct {
  kind: 'predicate' | 'scope' | 'outcome' | 'terminal' | 'handler';
  label: string;
  startLine: number;
  endLine: number;
  implicit: boolean;
}

export interface BehaviorControlFact {
  controller: BehaviorControlConstruct;
  outcome: BehaviorControlConstruct;
  subtype: BehaviorControlSubtype;
  attributes: Record<string, string | boolean>;
}

export interface BehaviorControlAnalysis {
  facts: BehaviorControlFact[];
  terminals: BehaviorControlConstruct[];
  unsupported: Array<{ startLine: number; endLine: number; reason: string }>;
}

export interface BehaviorReceiptLine {
  line: number;
  signals: Array<BehaviorSignal | 'lifecycle'>;
  text: string;
}

export interface BehaviorReceiptShapeField {
  name: string;
  line: number;
}

export interface BehaviorReceiptShape {
  startLine: number;
  endLine: number;
  fields: BehaviorReceiptShapeField[];
}

/**
 * A bounded second encoding of the least-redundant behavior lines in an exact
 * source range. Counts cover every detected candidate even when its text is
 * omitted from the receipt.
 */
export interface BehaviorReceipt {
  owner: string | null;
  startLine: number;
  endLine: number;
  lines: BehaviorReceiptLine[];
  shapes: BehaviorReceiptShape[];
  signalCounts: Partial<Record<BehaviorSignal | 'lifecycle', number>>;
  candidateLines: number;
  omittedLines: number;
}

const NODE_SIGNALS: Readonly<Record<string, BehaviorSignal>> = {
  if_statement: 'branch',
  conditional_expression: 'branch',
  ternary_expression: 'branch',
  switch_statement: 'branch',
  switch_expression: 'branch',
  switch_case: 'branch',
  case_statement: 'branch',
  match_statement: 'branch',
  match_expression: 'branch',
  match_arm: 'branch',
  for_statement: 'loop',
  for_in_statement: 'loop',
  for_of_statement: 'loop',
  while_statement: 'loop',
  do_statement: 'loop',
  await_expression: 'await',
  return_statement: 'return',
  throw_statement: 'throw',
  raise_statement: 'throw',
  assignment_expression: 'mutation',
  augmented_assignment_expression: 'mutation',
  assignment: 'mutation',
  pair: 'shape',
  field_initializer: 'shape',
  spread_element: 'spread',
  dictionary_splat: 'spread',
  catch_clause: 'catch',
  except_clause: 'catch',
  finally_clause: 'finally',
};

const SIGNAL_ORDER: readonly BehaviorSignal[] = [
  'anchor',
  'signature',
  'binding',
  'branch',
  'loop',
  'call',
  'await',
  'return',
  'throw',
  'mutation',
  'shape',
  'spread',
  'catch',
  'finally',
];

const RECEIPT_SIGNAL_ORDER: ReadonlyArray<BehaviorSignal | 'lifecycle'> = [...SIGNAL_ORDER, 'lifecycle'];

const RECEIPT_EFFECT_SIGNALS: ReadonlyArray<BehaviorSignal | 'lifecycle'> = [
  'loop',
  'await',
  'throw',
  'mutation',
  'spread',
  'catch',
  'finally',
  'lifecycle',
];

const LIFECYCLE_CALLS = new Set([
  'onBeforeMount',
  'onBeforeUnmount',
  'onMounted',
  'onUnmounted',
  'useEffect',
  'useInsertionEffect',
  'useLayoutEffect',
]);

interface BehaviorCandidateSet {
  callable?: NonNullable<ReturnType<typeof getSourceFacts>>['callables'][number];
  rangeStart: number;
  rangeEnd: number;
  sourceLines: readonly string[];
  candidates: BehaviorReceiptLine[];
  shapes: BehaviorReceiptShape[];
}

interface BehaviorOutline {
  constructKind: string;
  signature: string;
  lines: BehaviorSkeletonLine[];
  sourceStatements: number;
  copiedStatements: number;
}

const BEHAVIOR_CONTAINER_NODE_TYPES = new Set([
  'class_declaration',
  'class_body',
  'class_definition',
  'decorated_definition',
  'export_declaration',
  'export_statement',
  'impl_item',
  'module',
  'program',
  'source_file',
]);

const SHAPE_CONTAINER_NODE_TYPES = new Set([
  'object',
  'object_pattern',
  'dictionary',
  'field_declaration_list',
  'struct_expression',
  'struct_pattern',
]);

/** Build a compact, source-faithful control/effect outline for one selected syntax unit. */
export function behaviorSkeleton(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
  focusLines: readonly number[] = [],
  options: { requireSavings?: boolean } = {},
): BehaviorSkeleton | null {
  const tree = getAst(db, relativePath);
  if (!tree) return null;
  const sourceLines = getSourceLines(db, relativePath);
  const constructRange = behaviorConstructRange(db, relativePath, startLine, endLine, focusLines);
  const callable = smallestCoveringCallable(db, relativePath, constructRange.startLine, constructRange.endLine);
  const rangeStart = callable?.startLine ?? startLine;
  const rangeEnd = callable?.endLine ?? endLine;
  const root =
    (callable ? findCallableNode(tree.rootNode, constructRange.startLine, constructRange.endLine) : null) ??
    smallestNodeCoveringLines(tree.rootNode, rangeStart, rangeEnd);
  if (!root) return null;
  const outline = buildBehaviorOutline(root, sourceLines, rangeStart, rangeEnd, focusLines);
  if (!outline || outline.lines.length === 0) return null;
  if (outline.lines.some((line) => line.text.length > MAX_OUTLINE_LINE_CHARACTERS)) return null;

  const rawCharacters = renderedRawCharacterEstimate(sourceLines, rangeStart, rangeEnd);
  const outlineCharacters = renderedOutlineCharacterEstimate(outline);
  if ((options.requireSavings ?? true) && outlineCharacters >= rawCharacters * OUTLINE_SAVINGS_RATIO) return null;

  const signals = SIGNAL_ORDER.filter((signal) => outline.lines.some((line) => line.signals.includes(signal)));

  return {
    ...(callable
      ? {
          callable: {
            name: callable.name,
            startLine: callable.startLine,
            endLine: callable.endLine,
          },
        }
      : {}),
    representation: 'outline',
    constructKind: outline.constructKind,
    signature: outline.signature,
    lines: outline.lines,
    signals,
    testCases: classifyFile(relativePath) === 'test' ? testCaseNames(sourceLines, rangeStart, rangeEnd) : [],
    coverage: {
      sourceStatements: outline.sourceStatements,
      representedStatements: outline.sourceStatements,
      copiedStatements: outline.copiedStatements,
      omittedStatements: 0,
    },
    rawCharacters,
    outlineCharacters,
    candidateLines: outline.sourceStatements,
    omittedLines: 0,
  };
}

/**
 * Return complete parser-derived control headers that govern selected source
 * lines, even when a full behavior outline would not save enough characters
 * to replace the raw construct. Connector slices use this smaller contract so
 * a multiline predicate cannot collapse to only its first physical line.
 */
export function governingBehaviorControlLines(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
  focusLines: readonly number[],
): BehaviorSkeletonLine[] {
  if (focusLines.length === 0) return [];
  const tree = getAst(db, relativePath);
  if (!tree) return [];
  const sourceLines = getSourceLines(db, relativePath);
  const constructRange = behaviorConstructRange(db, relativePath, startLine, endLine, focusLines);
  const callable = smallestCoveringCallable(db, relativePath, constructRange.startLine, constructRange.endLine);
  const rangeStart = callable?.startLine ?? startLine;
  const rangeEnd = callable?.endLine ?? endLine;
  const root =
    (callable ? findCallableNode(tree.rootNode, constructRange.startLine, constructRange.endLine) : null) ??
    smallestNodeCoveringLines(tree.rootNode, rangeStart, rangeEnd);
  if (!root) return [];
  const outline = buildBehaviorOutline(root, sourceLines, rangeStart, rangeEnd, focusLines);
  if (!outline) return [];
  return outline.lines.filter(
    (line) =>
      line.text.length <= MAX_OUTLINE_LINE_CHARACTERS &&
      line.signals.some((signal) => ['branch', 'loop', 'catch', 'finally'].includes(signal)) &&
      focusLines.some((focusLine) => focusLine >= line.line && focusLine <= line.endLine),
  );
}

/**
 * Recover exact control-dependence facts from the same parser evidence used by
 * behavior outlines. Branch outcomes are regions, so every statement inside a
 * branch remains covered without emitting one redundant edge per statement.
 */
export function behaviorControlAnalysis(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): BehaviorControlAnalysis | null {
  const tree = getAst(db, relativePath);
  if (!tree) return null;
  const root =
    findCallableNode(tree.rootNode, startLine, endLine) ?? smallestNodeCoveringLines(tree.rootNode, startLine, endLine);
  if (!root) return null;

  const facts: BehaviorControlFact[] = [];
  const terminals = terminalControlConstructs(root);
  const unsupported: BehaviorControlAnalysis['unsupported'] = [];

  walkControlNodes(root, root, (node) => {
    if (IF_NODE_TYPES.has(node.type) || CONDITIONAL_EXPRESSION_NODE_TYPES.has(node.type)) {
      addConditionalControlFacts(facts, unsupported, node);
      return;
    }
    if (LOOP_NODE_TYPES.has(node.type)) {
      addLoopControlFacts(facts, unsupported, node);
      return;
    }
    if (SWITCH_NODE_TYPES.has(node.type)) {
      addSwitchControlFacts(facts, unsupported, node);
      return;
    }
    if (TRY_NODE_TYPES.has(node.type)) addTryControlFacts(facts, node);
  });

  return {
    facts: uniqueControlFacts(facts),
    terminals: uniqueControlConstructs(terminals),
    unsupported,
  };
}

/**
 * Narrow an over-broad indexed unit to one callable only when every selected
 * focus line belongs to that same callable. Multiple sibling focuses retain
 * their shared parent so no requested construct disappears.
 */
export function behaviorConstructRange(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
  focusLines: readonly number[] = [],
): BehaviorConstructRange {
  const selectedFocusLines = focusLines.filter((line) => line >= startLine && line <= endLine);
  const tree = getAst(db, relativePath);
  if (selectedFocusLines.length > 0 && tree) {
    const focusedNodes: SyntaxNode[] = [];
    walk(tree.rootNode, (node) => {
      if (
        isBehaviorFocusNode(node) &&
        node.startPosition.row >= startLine &&
        node.endPosition.row <= endLine &&
        selectedFocusLines.every((line) => node.startPosition.row <= line && node.endPosition.row >= line)
      ) {
        focusedNodes.push(node);
      }
    });
    const focusedNode = focusedNodes.sort(
      (left, right) =>
        left.endPosition.row - left.startPosition.row - (right.endPosition.row - right.startPosition.row) ||
        left.startPosition.row - right.startPosition.row,
    )[0];
    if (focusedNode) {
      return { startLine: focusedNode.startPosition.row, endLine: focusedNode.endPosition.row };
    }
  }
  const covering = smallestCoveringCallable(db, relativePath, startLine, endLine);
  if (covering) return { startLine: covering.startLine, endLine: covering.endLine };
  if (selectedFocusLines.length === 0) return { startLine, endLine };
  const focused = (getSourceFacts(db, relativePath)?.callables ?? [])
    .filter(
      (callable) =>
        callable.startLine >= startLine &&
        callable.endLine <= endLine &&
        selectedFocusLines.every((line) => callable.startLine <= line && callable.endLine >= line),
    )
    .sort(
      (left, right) =>
        left.endLine - left.startLine - (right.endLine - right.startLine) || left.startLine - right.startLine,
    )[0];
  if (!tree) {
    return focused ? { startLine: focused.startLine, endLine: focused.endLine } : { startLine, endLine };
  }
  const astCallables: SyntaxNode[] = [];
  walk(tree.rootNode, (node) => {
    if (
      CALLABLE_NODE_TYPES.has(node.type) &&
      node.startPosition.row >= startLine &&
      node.endPosition.row <= endLine &&
      selectedFocusLines.every((line) => node.startPosition.row <= line && node.endPosition.row >= line)
    ) {
      astCallables.push(node);
    }
  });
  const astFocused = astCallables.sort(
    (left, right) =>
      left.endPosition.row - left.startPosition.row - (right.endPosition.row - right.startPosition.row) ||
      left.startPosition.row - right.startPosition.row,
  )[0];
  if (astFocused) {
    return { startLine: astFocused.startPosition.row, endLine: astFocused.endPosition.row };
  }
  return focused ? { startLine: focused.startLine, endLine: focused.endLine } : { startLine, endLine };
}

/**
 * Select the behavior lines least like their siblings while preserving complete
 * per-signal counts. The range never expands beyond source already delivered.
 */
export function behaviorReceipt(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
  opts: { maxLines?: number; minimumBodyLines?: number } = {},
): BehaviorReceipt | null {
  const bodyLines = endLine - startLine + 1;
  if (bodyLines < (opts.minimumBodyLines ?? MIN_RECEIPT_BODY_LINES)) return null;

  const collected = collectBehaviorCandidates(db, relativePath, startLine, endLine, [], false);
  if (!collected) return null;
  const candidates: BehaviorReceiptLine[] = collected.candidates
    .map((candidate) => ({
      ...candidate,
      signals: candidate.signals.filter((signal) => signal !== 'anchor' && signal !== 'signature'),
    }))
    .filter((candidate) => candidate.signals.length > 0);
  if (candidates.length === 0) return null;

  const signalCounts = behaviorSignalCounts(candidates);
  const printable = candidates.filter((candidate) => candidate.text.length <= MAX_RECEIPT_LINE_CHARACTERS);
  if (printable.length === 0) return null;
  const effectSignals = RECEIPT_EFFECT_SIGNALS.filter((signal) => (signalCounts[signal] ?? 0) > 0);
  const nonAwaitEffects = effectSignals.filter((signal) => signal !== 'await');
  const shapeFields = collected.shapes.reduce((total, shape) => total + shape.fields.length, 0);
  if (nonAwaitEffects.length === 0 && !((signalCounts.await ?? 0) > 0 && shapeFields > 0) && shapeFields < 3) {
    return null;
  }
  const ranked = rankReceiptLines(printable, signalCounts);
  const representatives = new Map<number, BehaviorReceiptLine>();
  for (const signal of effectSignals) {
    const representative = ranked.find((candidate) => candidate.signals.includes(signal));
    if (representative) representatives.set(representative.line, representative);
  }
  if (representatives.size === 0) {
    const branch = ranked.find((candidate) => candidate.signals.includes('branch'));
    if (branch) representatives.set(branch.line, branch);
  }
  const maxLines = Math.min(10, Math.max(1, opts.maxLines ?? representatives.size));
  const selected = new Map<number, BehaviorReceiptLine>();

  for (const candidate of representatives.values()) {
    if (selected.size >= maxLines) break;
    selected.set(candidate.line, candidate);
  }
  if (selected.size >= candidates.length && collected.shapes.length === 0) return null;

  return {
    owner: collected.callable?.name ?? null,
    startLine,
    endLine,
    lines: [...selected.values()].sort((left, right) => left.line - right.line),
    shapes: collected.shapes,
    signalCounts,
    candidateLines: candidates.length,
    omittedLines: candidates.length - selected.size,
  };
}

/**
 * Preserve the parser-derived behavior attached to exact source lines. This
 * is the lossless companion to a compact outline: callers that intentionally
 * render raw source can still rank calls and effects without reinterpreting
 * the text or pretending that the raw representation is semantically empty.
 */
export function behaviorSignalsByLine(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): Map<number, BehaviorSignal[]> {
  const collected = collectBehaviorCandidates(db, relativePath, startLine, endLine, [], false);
  if (!collected) return new Map();
  return new Map(
    collected.candidates.map((candidate) => [
      candidate.line,
      candidate.signals.filter((signal): signal is BehaviorSignal => signal !== 'lifecycle'),
    ]),
  );
}

/**
 * Produce one receipt for a normal callable, or one per direct callable inside
 * a large class/module surface so unrelated methods cannot dilute one another.
 */
export function behaviorReceipts(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): BehaviorReceipt[] {
  const tree = getAst(db, relativePath);
  if (!tree) return [];
  const root = smallestNodeCoveringLines(tree.rootNode, startLine, endLine);
  if (!root) return [];

  if (BEHAVIOR_CONTAINER_NODE_TYPES.has(root.type)) {
    const nested = directContainedCallables(db, relativePath, startLine, endLine);
    const receipts = nested.flatMap((callable) => {
      const receipt = behaviorReceipt(db, relativePath, callable.startLine, callable.endLine, {
        minimumBodyLines: 0,
      });
      return receipt ? [receipt] : [];
    });
    if (receipts.length > 0) return receipts;
  }

  const receipt = behaviorReceipt(db, relativePath, startLine, endLine, { minimumBodyLines: 0 });
  return receipt ? [receipt] : [];
}

const CALLABLE_NODE_TYPES = new Set([
  'arrow_function',
  'constructor_declaration',
  'function_declaration',
  'function_definition',
  'function_expression',
  'generator_function',
  'generator_function_declaration',
  'function_item',
  'lambda',
  'lambda_expression',
  'method',
  'method_declaration',
  'method_definition',
]);

const BLOCK_NODE_TYPES = new Set(['block', 'body', 'compound_statement', 'declaration_list', 'statement_block']);

const IF_NODE_TYPES = new Set(['if_expression', 'if_statement', 'unless', 'unless_statement']);
const CONDITIONAL_EXPRESSION_NODE_TYPES = new Set(['conditional_expression', 'ternary_expression']);
const LOOP_NODE_TYPES = new Set([
  'do_statement',
  'enhanced_for_statement',
  'for_expression',
  'for_in_statement',
  'for_of_statement',
  'for_statement',
  'loop_expression',
  'while_statement',
]);
const SWITCH_NODE_TYPES = new Set(['match_expression', 'match_statement', 'switch_expression', 'switch_statement']);
const CASE_NODE_TYPES = new Set(['case_statement', 'match_arm', 'switch_case', 'switch_default']);
const TRY_NODE_TYPES = new Set(['try_expression', 'try_statement']);
const CATCH_NODE_TYPES = new Set(['catch_clause', 'except_clause', 'rescue']);
const FINALLY_NODE_TYPES = new Set(['ensure', 'finally_clause']);
const ELSE_NODE_TYPES = new Set(['else', 'else_clause']);
const TERMINAL_NODE_TYPES = new Set(['raise_statement', 'return_statement', 'throw_statement']);
const COMMENT_NODE_TYPES = new Set(['block_comment', 'comment', 'line_comment']);

function addConditionalControlFacts(
  facts: BehaviorControlFact[],
  unsupported: BehaviorControlAnalysis['unsupported'],
  node: SyntaxNode,
): void {
  const condition = node.childForFieldName('condition') ?? firstNonBodyChild(node);
  const consequence =
    node.childForFieldName('consequence') ??
    node.childForFieldName('body') ??
    node.namedChildren.find((child) => BLOCK_NODE_TYPES.has(child.type));
  const alternative =
    node.childForFieldName('alternative') ?? node.namedChildren.find((child) => ELSE_NODE_TYPES.has(child.type));
  if (!condition || !consequence) {
    unsupported.push(controlUnsupported(node, 'conditional-fields-unresolved'));
    return;
  }
  const controller = controlConstruct(condition, 'predicate', condition.text);
  const consequenceOutcome = controlConstruct(consequence, outcomeKind(consequence), 'consequence');
  addControlFact(facts, controller, consequenceOutcome, 'predicate-consequence', { branchRole: 'consequence' });
  addTerminalControlFacts(facts, controller, consequence, 'consequence');

  if (alternative) {
    const alternativeOutcome = controlConstruct(alternative, outcomeKind(alternative), 'alternative');
    addControlFact(facts, controller, alternativeOutcome, 'predicate-alternative', { branchRole: 'alternative' });
    addTerminalControlFacts(facts, controller, alternative, 'alternative');
    return;
  }
  addControlFact(
    facts,
    controller,
    implicitControlConstruct(controller, 'otherwise continue'),
    'predicate-fallthrough',
    { branchRole: 'fallthrough' },
  );
}

function addLoopControlFacts(
  facts: BehaviorControlFact[],
  unsupported: BehaviorControlAnalysis['unsupported'],
  node: SyntaxNode,
): void {
  const body = node.childForFieldName('body') ?? node.namedChildren.find((child) => BLOCK_NODE_TYPES.has(child.type));
  if (!body) {
    unsupported.push(controlUnsupported(node, 'loop-body-unresolved'));
    return;
  }
  const condition = node.childForFieldName('condition');
  const controller = controlConstruct(condition ?? node, 'predicate', condition?.text ?? headerBeforeChild(node, body));
  addControlFact(facts, controller, controlConstruct(body, 'outcome', 'iteration'), 'loop-iteration', {
    branchRole: 'iteration',
  });
  addTerminalControlFacts(facts, controller, body, 'iteration');
  addControlFact(facts, controller, implicitControlConstruct(controller, 'loop exits'), 'loop-exit', {
    branchRole: 'exit',
  });
}

function addSwitchControlFacts(
  facts: BehaviorControlFact[],
  unsupported: BehaviorControlAnalysis['unsupported'],
  node: SyntaxNode,
): void {
  const body = node.childForFieldName('body') ?? node.namedChildren.find((child) => BLOCK_NODE_TYPES.has(child.type));
  const subject =
    node.childForFieldName('value') ??
    node.childForFieldName('condition') ??
    node.childForFieldName('subject') ??
    firstNonBodyChild(node);
  const cases = switchCases(body ?? node);
  if (!subject || cases.length === 0) {
    unsupported.push(controlUnsupported(node, 'switch-cases-unresolved'));
    return;
  }
  const controller = controlConstruct(subject, 'predicate', subject.text);
  let hasDefault = false;
  for (const candidate of cases) {
    const defaultCase = isDefaultCase(candidate);
    hasDefault ||= defaultCase;
    const label = headerBeforeChild(
      candidate,
      candidate.namedChildren.find((child) => isStatementNode(child)),
    );
    addControlFact(
      facts,
      controller,
      controlConstruct(candidate, 'outcome', label || (defaultCase ? 'default' : 'case')),
      defaultCase ? 'predicate-default' : 'predicate-case',
      { branchRole: defaultCase ? 'default' : 'case' },
    );
    addTerminalControlFacts(facts, controller, candidate, defaultCase ? 'default' : 'case');
  }
  if (!hasDefault) {
    addControlFact(
      facts,
      controller,
      implicitControlConstruct(controller, 'no case matched'),
      'predicate-fallthrough',
      { branchRole: 'fallthrough' },
    );
  }
}

function addTryControlFacts(facts: BehaviorControlFact[], node: SyntaxNode): void {
  const controller = controlConstruct(node, 'scope', 'try');
  for (const handler of tryHandlers(node)) {
    const isFinally = FINALLY_NODE_TYPES.has(handler.type);
    const handlerConstruct = controlConstruct(
      handler,
      'handler',
      isFinally ? 'finally' : headerBeforeChild(handler, callableBody(handler)),
    );
    addControlFact(facts, controller, handlerConstruct, isFinally ? 'finally-cleanup' : 'exception-handler', {
      branchRole: isFinally ? 'finally' : 'catch',
    });
    addHandlerTerminalFacts(facts, handlerConstruct, handler, isFinally ? 'finally' : 'catch');
  }
}

function addHandlerTerminalFacts(
  facts: BehaviorControlFact[],
  controller: BehaviorControlConstruct,
  handler: SyntaxNode,
  branchRole: string,
): void {
  for (const terminal of terminalControlConstructs(handler)) {
    const terminalKind = terminal.label.startsWith('throw') || terminal.label.startsWith('raise') ? 'throw' : 'return';
    addControlFact(facts, controller, terminal, terminalKind === 'throw' ? 'handler-throw' : 'handler-return', {
      branchRole,
      terminalKind,
    });
  }
}

function addTerminalControlFacts(
  facts: BehaviorControlFact[],
  controller: BehaviorControlConstruct,
  outcome: SyntaxNode,
  branchRole: string,
): void {
  for (const terminal of terminalControlConstructs(outcome)) {
    const terminalKind = terminal.label.startsWith('throw') || terminal.label.startsWith('raise') ? 'throw' : 'return';
    addControlFact(facts, controller, terminal, terminalKind === 'throw' ? 'predicate-throw' : 'predicate-return', {
      branchRole,
      terminalKind,
    });
  }
}

function addControlFact(
  facts: BehaviorControlFact[],
  controller: BehaviorControlConstruct,
  outcome: BehaviorControlConstruct,
  subtype: BehaviorControlSubtype,
  attributes: Record<string, string | boolean>,
): void {
  facts.push({ controller, outcome, subtype, attributes });
}

function controlConstruct(
  node: SyntaxNode,
  kind: BehaviorControlConstruct['kind'],
  label: string,
): BehaviorControlConstruct {
  return {
    kind,
    label: normalizeClauseText(label).slice(0, MAX_OUTLINE_LINE_CHARACTERS),
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    implicit: false,
  };
}

function implicitControlConstruct(controller: BehaviorControlConstruct, label: string): BehaviorControlConstruct {
  return { ...controller, kind: 'outcome', label, implicit: true };
}

function outcomeKind(node: SyntaxNode): BehaviorControlConstruct['kind'] {
  return TERMINAL_NODE_TYPES.has(node.type) ? 'terminal' : 'outcome';
}

function terminalControlConstructs(root: SyntaxNode): BehaviorControlConstruct[] {
  const terminals: BehaviorControlConstruct[] = [];
  walkControlNodes(root, root, (node) => {
    if (TERMINAL_NODE_TYPES.has(node.type)) terminals.push(controlConstruct(node, 'terminal', node.text));
  });
  return uniqueControlConstructs(terminals);
}

function walkControlNodes(root: SyntaxNode, node: SyntaxNode, visit: (candidate: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    if (child !== root && CALLABLE_NODE_TYPES.has(child.type)) continue;
    walkControlNodes(root, child, visit);
  }
}

function switchCases(root: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const visit = (node: SyntaxNode): void => {
    for (const child of node.namedChildren) {
      if (SWITCH_NODE_TYPES.has(child.type)) continue;
      if (CASE_NODE_TYPES.has(child.type)) result.push(child);
      else visit(child);
    }
  };
  visit(root);
  return result;
}

function tryHandlers(root: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const visit = (node: SyntaxNode): void => {
    for (const child of node.namedChildren) {
      if (TRY_NODE_TYPES.has(child.type)) continue;
      if (CATCH_NODE_TYPES.has(child.type) || FINALLY_NODE_TYPES.has(child.type)) result.push(child);
      else if (!CALLABLE_NODE_TYPES.has(child.type)) visit(child);
    }
  };
  visit(root);
  return result;
}

function isDefaultCase(node: SyntaxNode): boolean {
  const header = headerBeforeChild(
    node,
    node.namedChildren.find((child) => isStatementNode(child)),
  ).trim();
  return node.type === 'switch_default' || /^(?:default\b|_\s*=>)/u.test(header);
}

function controlUnsupported(node: SyntaxNode, reason: string): BehaviorControlAnalysis['unsupported'][number] {
  return { startLine: node.startPosition.row, endLine: node.endPosition.row, reason };
}

function uniqueControlFacts(facts: readonly BehaviorControlFact[]): BehaviorControlFact[] {
  const keyed = new Map<string, BehaviorControlFact>();
  for (const fact of facts) {
    keyed.set(
      `${fact.controller.startLine}\u0000${fact.controller.endLine}\u0000${fact.outcome.startLine}\u0000${fact.outcome.endLine}\u0000${fact.subtype}\u0000${fact.outcome.label}`,
      fact,
    );
  }
  return [...keyed.values()];
}

function uniqueControlConstructs(constructs: readonly BehaviorControlConstruct[]): BehaviorControlConstruct[] {
  const keyed = new Map<string, BehaviorControlConstruct>();
  for (const construct of constructs) {
    keyed.set(
      `${construct.startLine}\u0000${construct.endLine}\u0000${construct.kind}\u0000${construct.label}`,
      construct,
    );
  }
  return [...keyed.values()];
}

function isBehaviorFocusNode(node: SyntaxNode): boolean {
  return (
    CALLABLE_NODE_TYPES.has(node.type) ||
    LOOP_NODE_TYPES.has(node.type) ||
    SWITCH_NODE_TYPES.has(node.type) ||
    TRY_NODE_TYPES.has(node.type) ||
    CATCH_NODE_TYPES.has(node.type) ||
    FINALLY_NODE_TYPES.has(node.type)
  );
}

function buildBehaviorOutline(
  root: SyntaxNode,
  sourceLines: readonly string[],
  rangeStart: number,
  rangeEnd: number,
  focusLines: readonly number[],
): BehaviorOutline | null {
  const callableNode = findCallableNode(root, rangeStart, rangeEnd);
  const outlineRoot = callableNode ?? root;
  const body = callableBody(outlineRoot);
  const lines: BehaviorSkeletonLine[] = [];
  let sourceStatements = 0;
  let copiedStatements = 0;

  const addClause = (
    node: SyntaxNode,
    depth: number,
    text: string,
    signals: readonly BehaviorSignal[],
    copied = false,
    countsAsStatement = true,
  ): void => {
    const normalized = copied ? text.trim() : normalizeClauseText(text);
    if (!normalized) return;
    const nodeStart = Math.max(rangeStart, node.startPosition.row);
    const nodeEnd = Math.min(rangeEnd, node.endPosition.row);
    lines.push({
      line: nodeStart,
      endLine: Math.max(nodeStart, nodeEnd),
      depth,
      signals: SIGNAL_ORDER.filter(
        (signal) =>
          signals.includes(signal) ||
          (signal === 'anchor' && focusLines.some((line) => line >= nodeStart && line <= nodeEnd)),
      ),
      text: normalized,
      copied,
    });
    if (countsAsStatement) {
      sourceStatements += 1;
      if (copied) copiedStatements += 1;
    }
  };

  const emitBlock = (node: SyntaxNode, depth: number): void => {
    for (const child of node.namedChildren) emitNode(child, depth);
  };

  const emitAlternative = (node: SyntaxNode, depth: number): void => {
    if (IF_NODE_TYPES.has(node.type)) {
      emitIf(node, depth, 'else if');
      return;
    }
    if (ELSE_NODE_TYPES.has(node.type)) {
      const nested = node.namedChildren.find((child) => IF_NODE_TYPES.has(child.type));
      if (nested) {
        emitIf(nested, depth, 'else if');
        return;
      }
      addClause(node, depth, 'else', ['branch'], false, false);
      const branchBody = callableBody(node) ?? node.namedChildren.find((child) => BLOCK_NODE_TYPES.has(child.type));
      if (branchBody) emitNode(branchBody, depth + 1);
      else for (const child of node.namedChildren) emitNode(child, depth + 1);
      return;
    }
    addClause(node, depth, 'else', ['branch'], false, false);
    emitNode(node, depth + 1);
  };

  const emitIf = (
    node: SyntaxNode,
    depth: number,
    keyword = node.type.startsWith('unless') ? 'unless' : 'if',
  ): void => {
    const condition = node.childForFieldName('condition') ?? firstNonBodyChild(node);
    const consequence =
      node.childForFieldName('consequence') ??
      node.childForFieldName('body') ??
      node.namedChildren.find((child) => BLOCK_NODE_TYPES.has(child.type));
    const alternative =
      node.childForFieldName('alternative') ?? node.namedChildren.find((child) => ELSE_NODE_TYPES.has(child.type));
    const conditionText = condition ? condition.text : headerBeforeChild(node, consequence);
    addClause(node, depth, `${keyword} ${stripOuterParens(conditionText)}`, signalsForNode(condition, ['branch']));
    if (consequence) emitNode(consequence, depth + 1);
    if (alternative) emitAlternative(alternative, depth);
  };

  const emitLoop = (node: SyntaxNode, depth: number): void => {
    const loopBody =
      node.childForFieldName('body') ?? node.namedChildren.find((child) => BLOCK_NODE_TYPES.has(child.type));
    addClause(node, depth, headerBeforeChild(node, loopBody), signalsForNode(node, ['loop']));
    if (loopBody) emitNode(loopBody, depth + 1);
  };

  const emitSwitch = (node: SyntaxNode, depth: number): void => {
    const switchBody =
      node.childForFieldName('body') ?? node.namedChildren.find((child) => BLOCK_NODE_TYPES.has(child.type));
    addClause(node, depth, headerBeforeChild(node, switchBody), signalsForNode(node, ['branch']));
    if (switchBody) emitNode(switchBody, depth + 1);
  };

  const emitCase = (node: SyntaxNode, depth: number): void => {
    const firstStatement = node.namedChildren.find((child) => isStatementNode(child));
    addClause(node, depth, headerBeforeChild(node, firstStatement), ['branch'], false, false);
    for (const child of node.namedChildren) {
      if (child === firstStatement || isStatementNode(child)) emitNode(child, depth + 1);
    }
  };

  const emitTry = (node: SyntaxNode, depth: number): void => {
    addClause(node, depth, 'try', [], false);
    for (const child of node.namedChildren) {
      if (BLOCK_NODE_TYPES.has(child.type)) emitNode(child, depth + 1);
      else if (CATCH_NODE_TYPES.has(child.type) || FINALLY_NODE_TYPES.has(child.type)) emitNode(child, depth);
    }
  };

  const emitHandler = (node: SyntaxNode, depth: number, kind: 'catch' | 'finally'): void => {
    const handlerBody =
      node.childForFieldName('body') ?? node.namedChildren.find((child) => BLOCK_NODE_TYPES.has(child.type));
    const header = kind === 'finally' ? 'finally' : headerBeforeChild(node, handlerBody);
    addClause(node, depth, header, [kind], false, false);
    if (handlerBody) emitNode(handlerBody, depth + 1);
  };

  const emitCallable = (node: SyntaxNode, depth: number): void => {
    const nestedBody = callableBody(node);
    addClause(node, depth, headerBeforeChild(node, nestedBody), signalsForNode(node, ['binding']));
    if (nestedBody) emitNode(nestedBody, depth + 1);
  };

  const emitNode = (node: SyntaxNode, depth: number): void => {
    if (node.startPosition.row > rangeEnd || node.endPosition.row < rangeStart) return;
    if (COMMENT_NODE_TYPES.has(node.type) || node.type === 'empty_statement') return;
    if (BLOCK_NODE_TYPES.has(node.type)) {
      emitBlock(node, depth);
      return;
    }
    if (IF_NODE_TYPES.has(node.type)) {
      emitIf(node, depth);
      return;
    }
    if (LOOP_NODE_TYPES.has(node.type)) {
      emitLoop(node, depth);
      return;
    }
    if (SWITCH_NODE_TYPES.has(node.type)) {
      emitSwitch(node, depth);
      return;
    }
    if (CASE_NODE_TYPES.has(node.type)) {
      emitCase(node, depth);
      return;
    }
    if (TRY_NODE_TYPES.has(node.type)) {
      emitTry(node, depth);
      return;
    }
    if (CATCH_NODE_TYPES.has(node.type)) {
      emitHandler(node, depth, 'catch');
      return;
    }
    if (FINALLY_NODE_TYPES.has(node.type)) {
      emitHandler(node, depth, 'finally');
      return;
    }
    if (ELSE_NODE_TYPES.has(node.type)) {
      emitAlternative(node, depth);
      return;
    }
    if (CALLABLE_NODE_TYPES.has(node.type)) {
      emitCallable(node, depth);
      return;
    }

    const recognized = isRecognizedStatementNode(node);
    const copied = !recognized || containsMultilineLiteral(node);
    addClause(node, depth, node.text, signalsForNode(node), copied);
  };

  if (body && body !== outlineRoot) emitNode(body, 0);
  else emitNode(outlineRoot, 0);
  if (sourceStatements === 0) return null;

  return {
    constructKind: behaviorConstructKind(outlineRoot),
    signature: callableSignature(outlineRoot, body, sourceLines, rangeStart),
    lines,
    sourceStatements,
    copiedStatements,
  };
}

function findCallableNode(node: SyntaxNode, startLine: number, endLine: number): SyntaxNode | null {
  const matching = node.namedChildren.filter(
    (child) => child.startPosition.row <= startLine && child.endPosition.row >= endLine,
  );
  for (const child of matching.sort(compareNodeSpan)) {
    const callable = findCallableNode(child, startLine, endLine);
    if (callable) return callable;
  }
  return CALLABLE_NODE_TYPES.has(node.type) && node.startPosition.row <= startLine && node.endPosition.row >= endLine
    ? node
    : null;
}

function compareNodeSpan(left: SyntaxNode, right: SyntaxNode): number {
  return (
    left.endPosition.row - left.startPosition.row - (right.endPosition.row - right.startPosition.row) ||
    left.startPosition.row - right.startPosition.row
  );
}

function callableBody(node: SyntaxNode): SyntaxNode | null {
  return (
    node.childForFieldName('body') ??
    node.childForFieldName('consequence') ??
    node.namedChildren.find((child) => BLOCK_NODE_TYPES.has(child.type)) ??
    null
  );
}

function callableSignature(
  node: SyntaxNode,
  body: SyntaxNode | null,
  sourceLines: readonly string[],
  rangeStart: number,
): string {
  const header = headerBeforeChild(node, body);
  if (header) return header;
  return (sourceLines[rangeStart] ?? node.text).trim();
}

function behaviorConstructKind(node: SyntaxNode): string {
  if (node.type.includes('constructor')) return 'constructor';
  if (node.type.includes('method') || node.type === 'method') {
    return hasAncestorType(node, new Set(['class_body', 'class_declaration', 'class_definition']))
      ? 'class method'
      : 'object method';
  }
  if (node.type === 'arrow_function' || node.type === 'function_expression' || node.type === 'lambda') {
    return hasAncestorType(node, new Set(['object', 'pair'])) ? 'object member' : 'function value';
  }
  if (node.type.includes('function')) {
    return hasAncestorType(node, CALLABLE_NODE_TYPES) ? 'nested function' : 'module function';
  }
  return 'source construct';
}

function hasAncestorType(node: SyntaxNode, types: ReadonlySet<string>): boolean {
  let current = node.parent;
  while (current) {
    if (types.has(current.type)) return true;
    current = current.parent;
  }
  return false;
}

function firstNonBodyChild(node: SyntaxNode): SyntaxNode | null {
  return (
    node.namedChildren.find((child) => !BLOCK_NODE_TYPES.has(child.type) && !ELSE_NODE_TYPES.has(child.type)) ?? null
  );
}

function headerBeforeChild(node: SyntaxNode, child: SyntaxNode | null | undefined): string {
  if (!child) return normalizeClauseText(node.text);
  const relativeEnd = Math.max(0, child.startIndex - node.startIndex);
  return normalizeClauseText(node.text.slice(0, relativeEnd))
    .replace(/[:{]\s*$/u, '')
    .trim();
}

function stripOuterParens(text: string): string {
  const normalized = normalizeClauseText(text);
  return normalized.startsWith('(') && normalized.endsWith(')') ? normalized.slice(1, -1).trim() : normalized;
}

function normalizeClauseText(text: string): string {
  return text.trim().replace(/\r?\n[\t ]*/gu, ' ');
}

function signalsForNode(
  node: SyntaxNode | null | undefined,
  initial: readonly BehaviorSignal[] = [],
): BehaviorSignal[] {
  const signals = new Set<BehaviorSignal>(initial);
  if (node) {
    walk(node, (candidate) => {
      const signal = NODE_SIGNALS[candidate.type];
      if (signal) signals.add(signal);
      if (candidate.type === 'call_expression') {
        signals.add('call');
        if (hasStructuredCallPayload(candidate)) signals.add('shape');
      }
      if (BINDING_NODE_TYPES.has(candidate.type)) signals.add('binding');
    });
  }
  return SIGNAL_ORDER.filter((signal) => signals.has(signal));
}

function containsMultilineLiteral(node: SyntaxNode): boolean {
  let found = false;
  walk(node, (candidate) => {
    if (found || !candidate.text.includes('\n')) return;
    if (/(?:string|template|heredoc|raw_string)/u.test(candidate.type)) found = true;
  });
  return found;
}

function isStatementNode(node: SyntaxNode): boolean {
  return (
    BLOCK_NODE_TYPES.has(node.type) ||
    IF_NODE_TYPES.has(node.type) ||
    LOOP_NODE_TYPES.has(node.type) ||
    SWITCH_NODE_TYPES.has(node.type) ||
    TRY_NODE_TYPES.has(node.type) ||
    CALLABLE_NODE_TYPES.has(node.type) ||
    isRecognizedStatementNode(node)
  );
}

function isRecognizedStatementNode(node: SyntaxNode): boolean {
  return (
    /(?:statement|declaration|expression|assignment|return|throw|raise|break|continue|yield|with_item)$/u.test(
      node.type,
    ) || BINDING_NODE_TYPES.has(node.type)
  );
}

function renderedRawCharacterEstimate(sourceLines: readonly string[], startLine: number, endLine: number): number {
  let characters = 0;
  for (let line = startLine; line <= endLine; line += 1) characters += (sourceLines[line]?.length ?? 0) + 10;
  return characters;
}

function renderedOutlineCharacterEstimate(outline: BehaviorOutline): number {
  return (
    outline.constructKind.length +
    outline.signature.length +
    80 +
    outline.lines.reduce((total, line) => total + line.text.length + line.depth * 2 + 10, 0)
  );
}

function collectBehaviorCandidates(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
  focusLines: readonly number[],
  expandToCallable: boolean,
): BehaviorCandidateSet | null {
  const tree = getAst(db, relativePath);
  if (!tree) return null;

  const sourceLines = getSourceLines(db, relativePath);
  const callable = smallestCoveringCallable(db, relativePath, startLine, endLine);
  const rangeStart = expandToCallable ? (callable?.startLine ?? startLine) : startLine;
  const rangeEnd = expandToCallable ? (callable?.endLine ?? endLine) : endLine;
  const exactCallableRoot =
    callable?.startLine === rangeStart && callable.endLine === rangeEnd
      ? findCallableNode(tree.rootNode, rangeStart, rangeEnd)
      : null;
  const root = exactCallableRoot ?? smallestNodeCoveringLines(tree.rootNode, rangeStart, rangeEnd);
  if (!root) return null;

  const signalsByLine = new Map<number, Set<BehaviorSignal | 'lifecycle'>>();
  const shapesByContainer = new Map<string, BehaviorReceiptShape>();
  const textOverrides = new Map<number, string>();
  const record = (line: number, signal: BehaviorSignal | 'lifecycle'): void => {
    if (line < rangeStart || line > rangeEnd) return;
    const signals = signalsByLine.get(line) ?? new Set<BehaviorSignal | 'lifecycle'>();
    signals.add(signal);
    signalsByLine.set(line, signals);
  };

  if (callable) record(callable.startLine, 'signature');
  for (const focusLine of focusLines) record(focusLine, 'anchor');
  walk(root, (node) => {
    const signal = NODE_SIGNALS[node.type];
    if (signal) record(node.startPosition.row, signal);
    if (signal === 'shape') recordShape(shapesByContainer, node, root, rangeStart, rangeEnd);
    if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function') ?? node.namedChild(0);
      const leaf = callee?.text.split('.').at(-1);
      if (hasStructuredCallPayload(node)) {
        record(node.startPosition.row, 'shape');
        const completeCall = normalizeSourceLine(node.text);
        if (completeCall.length <= MAX_RECEIPT_LINE_CHARACTERS) {
          textOverrides.set(node.startPosition.row, completeCall);
        }
      }
      if (leaf && LIFECYCLE_CALLS.has(leaf)) {
        record(node.startPosition.row, 'lifecycle');
        const completeCall = normalizeSourceLine(node.text);
        if (completeCall.length <= MAX_RECEIPT_LINE_CHARACTERS) {
          textOverrides.set(node.startPosition.row, completeCall);
        }
      }
    }
    if (BINDING_NODE_TYPES.has(node.type)) record(node.startPosition.row, 'binding');
  });

  const facts = getSourceFacts(db, relativePath);
  for (const callSite of facts?.callSites ?? []) {
    if (callSite.line < rangeStart || callSite.line > rangeEnd) continue;
    record(callSite.line, 'call');
    if (callSite.calleeLeaf === 'catch') record(callSite.line, 'catch');
  }

  const candidates = [...signalsByLine.entries()]
    .sort(([left], [right]) => left - right)
    .map(([line, signals]) => ({
      line,
      signals: RECEIPT_SIGNAL_ORDER.filter((signal) => signals.has(signal)),
      text: textOverrides.get(line) ?? normalizeSourceLine(sourceLines[line] ?? ''),
    }))
    .filter((line) => line.text.length > 0 || line.signals.includes('anchor'));
  return {
    ...(callable ? { callable } : {}),
    rangeStart,
    rangeEnd,
    sourceLines,
    candidates,
    shapes: [...shapesByContainer.values()].sort((left, right) => left.startLine - right.startLine),
  };
}

function directContainedCallables(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): NonNullable<ReturnType<typeof getSourceFacts>>['callables'] {
  const contained = (getSourceFacts(db, relativePath)?.callables ?? [])
    .filter(
      (callable) =>
        callable.startLine >= startLine &&
        callable.endLine <= endLine &&
        (callable.startLine !== startLine || callable.endLine !== endLine),
    )
    .sort(
      (left, right) =>
        left.startLine - right.startLine || right.endLine - right.startLine - (left.endLine - left.startLine),
    );
  return contained.filter(
    (candidate) =>
      !contained.some(
        (possibleParent) =>
          possibleParent !== candidate &&
          possibleParent.startLine <= candidate.startLine &&
          possibleParent.endLine >= candidate.endLine &&
          (possibleParent.startLine !== candidate.startLine || possibleParent.endLine !== candidate.endLine),
      ),
  );
}

function recordShape(
  shapes: Map<string, BehaviorReceiptShape>,
  node: SyntaxNode,
  root: SyntaxNode,
  rangeStart: number,
  rangeEnd: number,
): void {
  if (node.startPosition.row < rangeStart || node.endPosition.row > rangeEnd) return;
  const nameNode = node.childForFieldName('key') ?? node.childForFieldName('name') ?? node.namedChild(0);
  const name = normalizeSourceLine(nameNode?.text ?? '');
  if (!name || name.includes('\n') || name.length > 60) return;
  const container = nearestShapeContainer(node, root);
  if (container.startPosition.row < rangeStart || container.endPosition.row > rangeEnd) return;
  const key = `${container.startPosition.row}:${container.endPosition.row}`;
  const shape = shapes.get(key) ?? {
    startLine: container.startPosition.row,
    endLine: container.endPosition.row,
    fields: [],
  };
  if (!shape.fields.some((field) => field.name === name && field.line === node.startPosition.row)) {
    shape.fields.push({ name, line: node.startPosition.row });
  }
  shapes.set(key, shape);
}

function nearestShapeContainer(node: SyntaxNode, root: SyntaxNode): SyntaxNode {
  let current = node.parent;
  while (current && current !== root.parent) {
    if (SHAPE_CONTAINER_NODE_TYPES.has(current.type)) return current;
    if (current === root) break;
    current = current.parent;
  }
  return node.parent ?? node;
}

function smallestCoveringCallable(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): NonNullable<ReturnType<typeof getSourceFacts>>['callables'][number] | undefined {
  return getSourceFacts(db, relativePath)
    ?.callables.filter((callable) => callable.startLine <= startLine && callable.endLine >= endLine)
    .sort(
      (left, right) =>
        left.endLine - left.startLine - (right.endLine - right.startLine) || left.startLine - right.startLine,
    )[0];
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

function normalizeSourceLine(sourceLine: string): string {
  return sourceLine.trim().replace(/\s+/gu, ' ');
}

function hasStructuredCallPayload(node: SyntaxNode): boolean {
  if (node.type !== 'call_expression') return false;
  const argumentsNode =
    node.childForFieldName('arguments') ??
    node.namedChildren.find((child) => child.type === 'arguments' || child.type === 'argument_list');
  if (!argumentsNode) return false;

  let hasStructuredPayload = false;
  walk(argumentsNode, (candidate) => {
    if (SHAPE_CONTAINER_NODE_TYPES.has(candidate.type)) hasStructuredPayload = true;
  });
  return hasStructuredPayload;
}

function behaviorSignalCounts(
  candidates: readonly BehaviorReceiptLine[],
): Partial<Record<BehaviorSignal | 'lifecycle', number>> {
  const counts: Partial<Record<BehaviorSignal | 'lifecycle', number>> = {};
  for (const signal of RECEIPT_SIGNAL_ORDER) {
    const count = candidates.filter((candidate) => candidate.signals.includes(signal)).length;
    if (count > 0) counts[signal] = count;
  }
  return counts;
}

function rankReceiptLines(
  candidates: readonly BehaviorReceiptLine[],
  signalCounts: Readonly<Partial<Record<BehaviorSignal | 'lifecycle', number>>>,
): BehaviorReceiptLine[] {
  const combinationCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = candidate.signals.join(',');
    combinationCounts.set(key, (combinationCounts.get(key) ?? 0) + 1);
  }
  const effectSignals = new Set(RECEIPT_EFFECT_SIGNALS);
  const score = (candidate: BehaviorReceiptLine): number => {
    const combinationCount = combinationCounts.get(candidate.signals.join(',')) ?? 1;
    const rarestSignalCount = Math.min(...candidate.signals.map((signal) => signalCounts[signal] ?? 1));
    const weight = candidate.signals.some((signal) => effectSignals.has(signal)) ? 3 : 1;
    const semanticDensity = Math.max(0, candidate.signals.length - 1) * 1_000;
    return weight * (1_000 / combinationCount + 1_000 / rarestSignalCount) + semanticDensity;
  };
  return [...candidates].sort((left, right) => score(right) - score(left) || right.line - left.line);
}

const BINDING_NODE_TYPES = new Set([
  'lexical_declaration',
  'variable_declarator',
  'const_item',
  'static_item',
  'let_declaration',
  'assignment',
]);

function testCaseNames(sourceLines: readonly string[], startLine: number, endLine: number): string[] {
  const names: string[] = [];
  const pattern = /\b(?:describe|it|test)(?:\.(?:only|skip|todo))?\s*\(\s*(['"`])([^'"`]+)\1/u;
  for (let line = startLine; line <= endLine; line += 1) {
    const name = pattern.exec(sourceLines[line] ?? '')?.[2];
    if (!name || names.includes(name)) continue;
    names.push(name);
    if (names.length >= MAX_TEST_CASES) break;
  }
  return names;
}
