import type { ScipDatabase } from '../../storage/db.js';
import { isMissingProjectFileError, readProjectFileText } from '../../source/primitives/project-file-boundary.js';
import { resolveSymbol } from '../../symbols/symbol-lookup.js';
import { indexedReferenceFileCount } from '../internal/indexed-reference-count.js';
import { leafName, shortenSymbol } from '../../symbols/symbol-parser.js';
import {
  analyzeSourceFunctions,
  FUNCTION_METRIC_RULES,
  type SourceFunction,
} from '../../source/ast/function-metrics.js';
import { ProjectIndex } from '../internal/project-index.js';
import { stripCommentsAndStrings } from '../../source/primitives/source-stripper.js';
import {
  getAst,
  getSourceFacts,
  smallestNodeCoveringLines,
  type SyntaxNode,
  walkNamedSyntax,
} from '../../source/ast.js';
import { branchContribution } from '../../source/ast/branch-nodes.js';
import type { SymbolMatch } from '../../domain/symbol-types.js';

export interface ComplexityResult {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  loc: number;
  /** Branch count from AST when available, otherwise source-level regex fallback. */
  branches: number;
  estimateBasis: BranchEstimateBasis;
  metricRules?: string;
  /** Cyclomatic complexity estimate: branches + 1 */
  cyclomaticEstimate: number;
  /** Distinct compiler-resolved callees; candidate targets are reported separately. */
  calleeCount: number;
  candidateCalleeCount: number;
  fanIn: number;
  fanOut: number;
}

export type BranchEstimateBasis = 'ast' | 'regex-fallback';

export interface BranchEstimate {
  branches: number;
  estimateBasis: BranchEstimateBasis;
  metricRules?: string;
}

/**
 * Per-symbol complexity analysis combining source-level branch counting
 * with index-level metrics (fan-in, fan-out, callee count).
 *
 * TS/JS uses function-local compiler syntax metrics. Other languages use
 * a labeled AST or regex estimate; source must be available.
 */
// scip-query: ignore-extract — this is the per-symbol complexity scoring pass:
// branches, fan-out, fan-in, LOC, language, and preview source are the public
// report contract.
export function complexity(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { semantic?: boolean } = {},
): ComplexityResult | null {
  const resolution = resolveSymbol(db, symbolPattern);
  if (resolution.candidates.length > 0) {
    throw new Error(`Ambiguous symbol: ${symbolPattern}. Use an exact SCIP symbol or file:line.`);
  }
  const match = resolution.match;
  if (!match) return null;
  const index = new ProjectIndex(db);

  const branchEstimate = branchEstimateForDefinition(db, match);
  const loc = match.endLine - match.startLine + 1;

  const calleeMap = index.calleeMap([match], { additive: true, semantic: opts.semantic });
  const allCallees = calleeMap.get(match.symbolId) ?? [];
  const callees = allCallees.filter(
    (callee) => callee.source === 'scip-occurrence' || callee.source === 'semantic-callee',
  );
  const uniqueCallees = new Set(callees.map((c) => c.symbol));
  const candidateCallees = new Set(
    allCallees.filter((callee) => !uniqueCallees.has(callee.symbol)).map((callee) => callee.symbol),
  );

  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    relativePath: match.relativePath,
    startLine: match.startLine,
    endLine: match.endLine,
    loc,
    branches: branchEstimate.branches,
    estimateBasis: branchEstimate.estimateBasis,
    metricRules: branchEstimate.metricRules ?? `${branchEstimate.estimateBasis}-estimate-v1`,
    cyclomaticEstimate: branchEstimate.branches + 1,
    calleeCount: uniqueCallees.size,
    candidateCalleeCount: candidateCallees.size,
    fanIn: indexedReferenceFileCount(db, match.symbolId),
    fanOut: fanOutForCallees(callees, match.relativePath),
  };
}

// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
export function branchEstimateForDefinition(db: ScipDatabase, definition: SymbolMatch): BranchEstimate {
  readSymbolSource(db, definition.relativePath, definition.startLine, definition.endLine);
  const sourceMetric = functionBranchEstimate(definition, currentFunctionMetrics(db, definition.relativePath));
  if (sourceMetric) return sourceMetric;
  const ast = getAst(db, definition.relativePath);
  if (ast) {
    const node = smallestNodeCoveringLines(ast.rootNode, definition.startLine, definition.endLine);
    if (node) {
      return {
        branches: countBranchesFromAst(node),
        estimateBasis: 'ast',
      };
    }
  }

  return {
    branches: countBranchesFromRegex(
      readSymbolSource(db, definition.relativePath, definition.startLine, definition.endLine),
      languageForFile(db, definition.relativePath),
    ),
    estimateBasis: 'regex-fallback',
  };
}

export function branchEstimatesForDefinitions(
  db: ScipDatabase,
  definitions: ReadonlyArray<SymbolMatch>,
): Map<number, BranchEstimate> {
  const result = new Map<number, BranchEstimate>();
  const definitionsByFile = new Map<string, SymbolMatch[]>();

  for (const definition of definitions) {
    readSymbolSource(db, definition.relativePath, definition.startLine, definition.endLine);
    const bucket = definitionsByFile.get(definition.relativePath) ?? [];
    bucket.push(definition);
    definitionsByFile.set(definition.relativePath, bucket);
  }

  for (const [relativePath, definitionsInFile] of definitionsByFile) {
    addFileBranchEstimates(db, relativePath, definitionsInFile, result);
  }

  return result;
}

/** Prefer current function metrics, then persisted exact ranges, then AST/regex fallbacks. */
function addFileBranchEstimates(
  db: ScipDatabase,
  relativePath: string,
  definitionsInFile: readonly SymbolMatch[],
  result: Map<number, BranchEstimate>,
): void {
  const functions = currentFunctionMetrics(db, relativePath);
  // The persisted source facts already carry a branch count per callable;
  // a definition whose range matches one exactly needs no parse.
  const factBranches = new Map<string, number>();
  for (const callable of getSourceFacts(db, relativePath)?.callables ?? []) {
    if (callable.branches !== undefined)
      factBranches.set(`${callable.startLine}:${callable.endLine}`, callable.branches);
  }
  const fileDefinitions: SymbolMatch[] = [];
  for (const definition of definitionsInFile) {
    const sourceMetric = functionBranchEstimate(definition, functions);
    if (sourceMetric) {
      result.set(definition.symbolId, sourceMetric);
      continue;
    }
    const branches = factBranches.get(`${definition.startLine}:${definition.endLine}`);
    if (branches === undefined) fileDefinitions.push(definition);
    else result.set(definition.symbolId, { branches, estimateBasis: 'ast' });
  }
  if (fileDefinitions.length > 0) addFallbackBranchEstimates(db, relativePath, fileDefinitions, result);
}

function addFallbackBranchEstimates(
  db: ScipDatabase,
  relativePath: string,
  fileDefinitions: readonly SymbolMatch[],
  result: Map<number, BranchEstimate>,
): void {
  const ast = getAst(db, relativePath);
  const astDefinitions =
    ast === null
      ? []
      : fileDefinitions.filter(
          (definition) =>
            ast.rootNode.startPosition.row <= definition.startLine &&
            ast.rootNode.endPosition.row >= definition.endLine,
        );
  const astDefinitionIds = new Set(astDefinitions.map((definition) => definition.symbolId));

  if (ast && astDefinitions.length > 0) {
    for (const definition of astDefinitions) {
      result.set(definition.symbolId, { branches: 0, estimateBasis: 'ast' });
    }
    addAstBranchEstimates(ast.rootNode, astDefinitions, result);
  }

  for (const definition of fileDefinitions) {
    if (astDefinitionIds.has(definition.symbolId)) continue;
    result.set(definition.symbolId, regexBranchEstimate(db, definition));
  }
}

function currentFunctionMetrics(db: ScipDatabase, file: string): SourceFunction[] {
  if (!/\.[cm]?[jt]sx?$/i.test(file)) return [];
  try {
    return analyzeSourceFunctions(file, readProjectFileText(db.config.projectRoot, file)).functions;
  } catch (error) {
    if (!isMissingProjectFileError(error)) throw error;
    return [];
  }
}

function functionBranchEstimate(
  definition: SymbolMatch,
  functions: readonly SourceFunction[],
): BranchEstimate | undefined {
  const name = leafName(definition.symbol);
  const matches = functions.filter(
    (fn) =>
      fn.startLine - 1 >= definition.startLine &&
      fn.endLine - 1 <= definition.endLine &&
      fn.name
        .split('.')
        .at(-1)
        ?.replace(/^(get|set) /, '') === name,
  );
  if (matches.length !== 1) return undefined;
  return { branches: matches[0]!.cyclomatic - 1, estimateBasis: 'ast', metricRules: FUNCTION_METRIC_RULES };
}

function regexBranchEstimate(db: ScipDatabase, definition: SymbolMatch): BranchEstimate {
  return {
    branches: countBranchesFromRegex(
      readSymbolSource(db, definition.relativePath, definition.startLine, definition.endLine),
      languageForFile(db, definition.relativePath),
    ),
    estimateBasis: 'regex-fallback',
  };
}

function languageForFile(db: ScipDatabase, relativePath: string): string {
  const doc = db.get<{ language: string | null }>(
    `SELECT language FROM documents WHERE relative_path = ?`,
    relativePath,
  );
  return doc?.language ?? 'unknown';
}

function readSymbolSource(db: ScipDatabase, relativePath: string, startLine: number, endLine: number): string {
  const lines = readProjectFileText(db.config.projectRoot, relativePath, {
    inputKind: 'indexed source file',
  }).split('\n');
  const source = lines.slice(startLine, endLine + 1).join('\n');
  if (startLine < 0 || endLine < startLine || endLine >= lines.length || !source.trim()) {
    throw new Error(
      `Current source does not cover the indexed definition in ${relativePath}. Reindex before measuring complexity.`,
    );
  }
  return source;
}

function fanOutForCallees(callees: ReadonlyArray<{ symbol: string; file: string }>, relativePath: string): number {
  return new Set(callees.filter((callee) => callee.file !== relativePath).map((callee) => callee.symbol)).size;
}

/**
 * Count branch points in a parsed AST. The count follows the same practical
 * McCabe approximation as the command output: decision nodes plus boolean
 * decision operators.
 */
export function countBranchesFromAst(node: SyntaxNode): number {
  let count = 0;
  walkNamedSyntax(node, (current) => {
    count += branchContribution(current);
  });
  return count;
}

function addAstBranchEstimates(
  root: SyntaxNode,
  definitions: ReadonlyArray<SymbolMatch>,
  result: Map<number, BranchEstimate>,
): void {
  const sorted = [...definitions].sort(
    (left, right) => left.startLine - right.startLine || right.endLine - left.endLine,
  );
  walkNamedSyntax(root, (current) => {
    const contribution = branchContribution(current);
    if (contribution === 0) return;

    const startLine = current.startPosition.row;
    const endLine = current.endPosition.row;
    for (const definition of sorted) {
      if (definition.startLine > startLine) break;
      if (definition.endLine < endLine) continue;
      const estimate = result.get(definition.symbolId);
      if (estimate) estimate.branches += contribution;
    }
  });
}

/**
 * Count branch points in source code using language-aware regex.
 * Works across all SCIP-supported languages when AST parsing is unavailable.
 */
function countBranchesFromRegex(source: string, language: string): number {
  // Strip comments and strings to avoid false positives
  const stripped = stripCommentsAndStrings(source);
  let count = 0;

  // Universal branch keywords (work across most C-family languages)
  const universalPatterns = [
    /\bif\b/g,
    /\belse\s+if\b/g,
    /\belse\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bswitch\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /\?\s*[^?]/g, // ternary (but not ??)
    /&&/g,
    /\|\|/g,
  ];

  for (const pattern of universalPatterns) {
    const matches = stripped.match(pattern);
    if (matches) count += matches.length;
  }

  // Language-specific patterns
  if (language === 'python') {
    const pyPatterns = [/\belif\b/g, /\bexcept\b/g, /\bfinally\b/g];
    for (const p of pyPatterns) {
      const m = stripped.match(p);
      if (m) count += m.length;
    }
  } else if (language === 'rust') {
    const rustPatterns = [/\bmatch\b/g, /=>/g, /\bloop\b/g];
    for (const p of rustPatterns) {
      const m = stripped.match(p);
      if (m) count += m.length;
    }
  } else if (language === 'ruby') {
    const rubyPatterns = [/\belsif\b/g, /\bunless\b/g, /\brescue\b/g, /\bwhen\b/g];
    for (const p of rubyPatterns) {
      const m = stripped.match(p);
      if (m) count += m.length;
    }
  } else if (language === 'go') {
    const goPatterns = [/\bselect\b/g, /\bdefer\b/g];
    for (const p of goPatterns) {
      const m = stripped.match(p);
      if (m) count += m.length;
    }
  }

  return count;
}
