import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch, getCalleeRowsForSymbol } from '../query-support.js';
import type { ComplexityResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Per-symbol complexity analysis combining source-level branch counting
 * with index-level metrics (fan-in, fan-out, callee count).
 *
 * Branch counting uses language-aware regex. The language is read from
 * the SCIP documents table, so it works for any indexed language.
 */
export function complexity(
  db: ScipDatabase,
  symbolPattern: string,
): ComplexityResult | null {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return null;

  // Get language
  const doc = db.get<{ language: string | null }>(
    `SELECT language FROM documents WHERE relative_path = ?`,
    match.relativePath,
  );
  const language = doc?.language ?? 'unknown';

  // Read source for branch counting
  const filePath = join(db.config.projectRoot, match.relativePath);
  let source = '';
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n');
    source = lines.slice(match.startLine, match.endLine + 1).join('\n');
  } catch {
    // If we can't read the file, just skip branch counting
  }

  const branches = countBranches(source, language);
  const loc = match.endLine - match.startLine + 1;

  // Callee count
  const callees = getCalleeRowsForSymbol(db, match);
  const uniqueCallees = new Set(callees.map((c) => c.symbol));

  // Fan-in
  const fanInRow = db.get<{ c: number }>(
    `SELECT COUNT(DISTINCT c.document_id) AS c
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    WHERE m.symbol_id = ? AND m.role != 1`,
    match.symbolId,
  );

  // Fan-out (callees in other files)
  const fanOut = new Set(
    callees.filter((c) => c.file !== match.relativePath).map((c) => c.symbol),
  ).size;

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
    fanIn: fanInRow?.c ?? 0,
    fanOut,
  };
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
