import type { ScipDatabase } from '../../storage/db.js';
import { ProjectIndex } from '../internal/project-index.js';
import { ts } from '@ts-morph/common';
import { detectAstLanguage } from '../../source/ast.js';
import { analyzeSourceFunctions, type FunctionAnalysis } from '../../source/ast/function-metrics.js';
import { readProjectFileText } from '../../source/primitives/project-file-boundary.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { runCandidateAnalysis } from '../internal/candidate-scan.js';

export interface UnusedParamsFinding {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  paramCount: number;
  /** Trailing parameters never referenced in the body, in declaration order. */
  unusedTrailing: string[];
}

/** Trailing simple parameters with no same-binding read. Defaults, rest parameters,
 * parameter properties, dynamic eval/arguments, and rooted contracts are excluded.
 * Findings are review candidates: changing a signature can affect callers and arity.
 */
export function unusedParams(
  db: ScipDatabase,
  opts: { scope?: string; limit?: number; scanLimit?: number; files?: readonly string[] } = {},
): UnusedParamsFinding[] {
  const { scope, limit = 30, scanLimit } = opts;
  const index = new ProjectIndex(db);
  const analyses = new Map<string, FunctionAnalysis>();
  return runCandidateAnalysis({
    candidates: () =>
      index.productionCallableDefinitions({
        scope,
        files: opts.files,
        minLoc: 2,
        excludeRootedSymbols: true,
        requireFunctionLikeSymbol: true,
      }),
    filterCandidate: (definition) => isTypeScriptFamily(definition.relativePath),
    scanLimit,
    profile: { name: 'unused-params' },
    evaluate: (definition) => {
      let analysis = analyses.get(definition.relativePath);
      if (!analysis) {
        analysis = analyzeSourceFunctions(
          definition.relativePath,
          readProjectFileText(db.config.projectRoot, definition.relativePath),
        );
        analyses.set(definition.relativePath, analysis);
      }
      if (analysis.errors.length > 0) return null;
      const candidates: ts.FunctionLikeDeclaration[] = [];
      const collect = (node: ts.Node): void => {
        if (
          ts.isFunctionLike(node) &&
          'body' in node &&
          node.body &&
          analysis.sourceFile.getLineAndCharacterOfPosition(node.getStart(analysis.sourceFile)).line >=
            definition.startLine &&
          analysis.sourceFile.getLineAndCharacterOfPosition(node.end).line <= definition.endLine
        ) {
          candidates.push(node as ts.FunctionLikeDeclaration);
          return;
        }
        ts.forEachChild(node, collect);
      };
      collect(analysis.sourceFile);
      if (candidates.length !== 1) return null;
      const callable = candidates[0]!;
      const unusedTrailing = unusedTrailingBindings(callable, analysis.checker);
      if (unusedTrailing.length === 0) return null;

      return {
        symbol: definition.symbol,
        shortName: shortenSymbol(definition.symbol),
        file: definition.relativePath,
        startLine: definition.startLine,
        endLine: definition.endLine,
        paramCount: callable.parameters.length,
        unusedTrailing,
      };
    },
    orderResults: (left, right) =>
      right.unusedTrailing.length - left.unusedTrailing.length ||
      left.file.localeCompare(right.file) ||
      left.startLine - right.startLine,
    limit,
  });
}

function isTypeScriptFamily(relativePath: string): boolean {
  const language = detectAstLanguage(relativePath);
  return language === 'typescript' || language === 'tsx' || language === 'javascript';
}

/** Used = the identifier appears on a line strictly inside the body. */
function unusedTrailingBindings(callable: ts.FunctionLikeDeclaration, checker: ts.TypeChecker): string[] {
  if (
    !callable.body ||
    callable.parameters.some(
      (param) => !ts.isIdentifier(param.name) || param.initializer || param.dotDotDotToken || param.modifiers?.length,
    )
  )
    return [];
  const referenced = new Set<ts.Symbol>();
  let dynamic = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (node.text === 'arguments' || node.text === 'eval') dynamic = true;
      const binding = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (binding) referenced.add(binding);
    }
    ts.forEachChild(node, visit);
  };
  visit(callable.body);
  if (dynamic) return [];
  const unused: string[] = [];
  for (const param of [...callable.parameters].reverse()) {
    const name = (param.name as ts.Identifier).text;
    const binding = checker.getSymbolAtLocation(param.name);
    if (name.startsWith('_') || !binding || referenced.has(binding)) break;
    unused.unshift(name);
  }
  return unused;
}
