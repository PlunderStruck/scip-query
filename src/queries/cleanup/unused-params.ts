import type { ScipDatabase } from '../../storage/db.js';
import { ProjectIndex } from '../../core/project-index.js';
import { detectAstLanguage, getSourceFacts } from '../../source/ast.js';
import { getIdentifierLineMap } from '../../symbols/identifier-index.js';
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

/**
 * Speculative generality: trailing parameters nobody uses — a signature AI
 * move (options and hooks added "for later" that never came).
 *
 * Deliberately conservative, TS/JS only:
 * - TRAILING runs only — removing a trailing parameter is type-safe under
 *   TypeScript's function variance; removing a mid-list one breaks the
 *   positional contract. (Rust is excluded: call sites break, and rustc
 *   already warns there.)
 * - `_`-prefixed names are declared-intentional and skipped.
 * - Functions with pattern/rest parameters are skipped entirely.
 * - One-line bodies are skipped (line-granular usage can't tell a use from
 *   the declaration itself).
 * - Externally-live (package surface / entryRoots) symbols are skipped —
 *   their signatures are API.
 */
export function unusedParams(
  db: ScipDatabase,
  opts: { scope?: string; limit?: number; scanLimit?: number; files?: readonly string[] } = {},
): UnusedParamsFinding[] {
  const { scope, limit = 30, scanLimit } = opts;
  const index = new ProjectIndex(db);
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
      const callable = getSourceFacts(db, definition.relativePath)?.callables.find(
        (candidate) => candidate.startLine === definition.startLine && candidate.endLine === definition.endLine,
      );
      if (!callable || callable.params.length === 0) return null;
      if (callable.params.some((param) => !param.simple)) return null;
      if (callable.paramsEndLine >= callable.endLine) return null; // one-liner

      const lineMap = getIdentifierLineMap(db, definition.relativePath);
      const unusedTrailing: string[] = [];
      for (let i = callable.params.length - 1; i >= 0; i--) {
        const param = callable.params[i]!;
        if (param.name === '' || param.name.startsWith('_')) break;
        if (isUsedInBody(lineMap.get(param.name), callable.paramsEndLine, callable.endLine)) break;
        unusedTrailing.unshift(param.name);
      }
      if (unusedTrailing.length === 0) return null;

      return {
        symbol: definition.symbol,
        shortName: shortenSymbol(definition.symbol),
        file: definition.relativePath,
        startLine: definition.startLine,
        endLine: definition.endLine,
        paramCount: callable.paramCount,
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
function isUsedInBody(lines: readonly number[] | undefined, paramsEndLine: number, endLine: number): boolean {
  if (!lines) return false;
  return lines.some((line) => line > paramsEndLine && line <= endLine);
}
