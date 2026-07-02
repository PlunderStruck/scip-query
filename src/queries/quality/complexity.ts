import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../../core/project-index.js';
import { stripCommentsAndStrings } from '../../source/source-stripper.js';
import { getAst, type SyntaxNode } from '../../source/ast.js';
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
  /** Cyclomatic complexity estimate: branches + 1 */
  cyclomaticEstimate: number;
  /** Number of distinct callees within the definition */
  calleeCount: number;
  fanIn: number;
  fanOut: number;
}

export type BranchEstimateBasis = 'ast' | 'regex-fallback';

interface BranchEstimate {
  branches: number;
  estimateBasis: BranchEstimateBasis;
}

/**
 * Per-symbol complexity analysis combining source-level branch counting
 * with index-level metrics (fan-in, fan-out, callee count).
 *
 * Branch counting uses language-aware regex. The language is read from
 * the SCIP documents table, so it works for any indexed language.
 */
// scip-query: ignore-extract — this is the per-symbol complexity scoring pass:
// branches, fan-out, fan-in, LOC, language, and preview source are the public
// report contract.
export function complexity(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { semantic?: boolean } = {},
): ComplexityResult | null {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return null;
  const index = new ProjectIndex(db);

  const branchEstimate = branchEstimateForDefinition(db, match);
  const loc = match.endLine - match.startLine + 1;

  const calleeMap = index.calleeMap([match], { additive: true, semantic: opts.semantic });
  const callees = calleeMap.get(match.symbolId) ?? [];
  const uniqueCallees = new Set(callees.map((c) => c.symbol));

  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    relativePath: match.relativePath,
    startLine: match.startLine,
    endLine: match.endLine,
    loc,
    branches: branchEstimate.branches,
    estimateBasis: branchEstimate.estimateBasis,
    cyclomaticEstimate: branchEstimate.branches + 1,
    calleeCount: uniqueCallees.size,
    fanIn: fanInForSymbol(db, match.symbolId),
    fanOut: fanOutForCallees(callees, match.relativePath),
  };
}

export function branchEstimateForDefinition(db: ScipDatabase, definition: SymbolMatch): BranchEstimate {
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

function languageForFile(db: ScipDatabase, relativePath: string): string {
  const doc = db.get<{ language: string | null }>(
    `SELECT language FROM documents WHERE relative_path = ?`,
    relativePath,
  );
  return doc?.language ?? 'unknown';
}

function readSymbolSource(db: ScipDatabase, relativePath: string, startLine: number, endLine: number): string {
  try {
    const lines = readFileSync(join(db.config.projectRoot, relativePath), 'utf-8').split('\n');
    return lines.slice(startLine, endLine + 1).join('\n');
  } catch {
    return '';
  }
}

function fanInForSymbol(db: ScipDatabase, symbolId: number): number {
  return (
    db.get<{ c: number }>(
      `SELECT COUNT(DISTINCT c.document_id) AS c
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN (
      SELECT m2.symbol_id, c2.document_id
      FROM mentions m2
      JOIN chunks c2 ON m2.chunk_id = c2.id
      WHERE m2.role = 1
      GROUP BY m2.symbol_id
    ) sym_def ON sym_def.symbol_id = m.symbol_id
    WHERE m.symbol_id = ?
      AND m.role != 1
      AND sym_def.document_id != c.document_id`,
      symbolId,
    )?.c ?? 0
  );
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
  walkAst(node, (current) => {
    if (AST_BRANCH_NODE_TYPES.has(current.type)) {
      count += 1;
      return;
    }

    if (
      current.type === 'binary_expression' &&
      current.parent?.type !== 'binary_expression' &&
      (current.text.includes('&&') || current.text.includes('||'))
    ) {
      count += countBooleanOperators(current.text);
    }
  });
  return count;
}

function walkAst(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walkAst(child, visit);
}

function smallestNodeCoveringLines(node: SyntaxNode, startLine: number, endLine: number): SyntaxNode | null {
  if (node.startPosition.row > startLine || node.endPosition.row < endLine) return null;
  for (const child of node.namedChildren) {
    const match = smallestNodeCoveringLines(child, startLine, endLine);
    if (match) return match;
  }
  return node;
}

const AST_BRANCH_NODE_TYPES = new Set([
  'if_statement',
  'conditional_expression',
  'ternary_expression',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'while_statement',
  'do_statement',
  'switch_case',
  'case_statement',
  'catch_clause',
  'except_clause',
  'elif_clause',
  'match_arm',
]);

function countBooleanOperators(text: string): number {
  return (text.match(/&&|\|\|/g) ?? []).length;
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
