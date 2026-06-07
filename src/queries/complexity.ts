import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import { findFirstSymbolMatch } from '../symbols/symbol-lookup.js';
import { shortenSymbol } from '../symbols/symbol-parser.js';
import { ProjectIndex } from '../core/project-index.js';

export interface ComplexityResult {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  loc: number;
  /** Branch count from source-level regex (if, else, for, while, switch, catch, ternary, &&, ||) */
  branches: number;
  /** Cyclomatic complexity estimate: branches + 1 */
  cyclomaticEstimate: number;
  /** Number of distinct callees within the definition */
  calleeCount: number;
  fanIn: number;
  fanOut: number;
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

  const branches = countBranches(
    readSymbolSource(db, match.relativePath, match.startLine, match.endLine),
    languageForFile(db, match.relativePath),
  );
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
    branches,
    cyclomaticEstimate: branches + 1,
    calleeCount: uniqueCallees.size,
    fanIn: fanInForSymbol(db, match.symbolId),
    fanOut: fanOutForCallees(callees, match.relativePath),
  };
}

function languageForFile(db: ScipDatabase, relativePath: string): string {
  const doc = db.get<{ language: string | null }>(
    `SELECT language FROM documents WHERE relative_path = ?`,
    relativePath,
  );
  return doc?.language ?? 'unknown';
}

function readSymbolSource(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): string {
  try {
    const lines = readFileSync(join(db.config.projectRoot, relativePath), 'utf-8').split('\n');
    return lines.slice(startLine, endLine + 1).join('\n');
  } catch {
    return '';
  }
}

function fanInForSymbol(db: ScipDatabase, symbolId: number): number {
  return db.get<{ c: number }>(
    `SELECT COUNT(DISTINCT c.document_id) AS c
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    WHERE m.symbol_id = ? AND m.role != 1`,
    symbolId,
  )?.c ?? 0;
}

function fanOutForCallees(
  callees: ReadonlyArray<{ symbol: string; file: string }>,
  relativePath: string,
): number {
  return new Set(
    callees.filter((callee) => callee.file !== relativePath).map((callee) => callee.symbol),
  ).size;
}

/**
 * Count branch points in source code using language-aware regex.
 * Works across all SCIP-supported languages.
 */
function countBranches(source: string, language: string): number {
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
    /\?\s*[^?]/g,    // ternary (but not ??)
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

/**
 * Rough strip of comments and string literals to reduce false positives
 * in branch counting. Not perfect but good enough for estimation.
 */
function stripCommentsAndStrings(source: string): string {
  return source
    // Block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Line comments
    .replace(/\/\/.*/g, '')
    // Python/Ruby line comments
    .replace(/#.*/g, '')
    // Double-quoted strings
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // Single-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    // Template literals
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}
