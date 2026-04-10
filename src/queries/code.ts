import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch } from '../query-support.js';
import type { CodeResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Read the source code for a symbol, bounded to its definition range.
 * Language-agnostic: just reads the file and extracts the relevant lines.
 */
export function code(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { context?: number } = {},
): CodeResult | null {
  const { context = 0 } = opts;

  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return null;

  // Get the language from the documents table
  const doc = db.get<{ language: string | null }>(
    `SELECT language FROM documents WHERE relative_path = ?`,
    match.relativePath,
  );

  // Read the file
  const filePath = join(db.config.projectRoot, match.relativePath);
  let fileContent: string;
  try {
    fileContent = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = fileContent.split('\n');
  const startLine = Math.max(0, match.startLine - context);
  const endLine = Math.min(lines.length - 1, match.endLine + context);
  const source = lines.slice(startLine, endLine + 1).join('\n');

  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    relativePath: match.relativePath,
    startLine: startLine + 1, // 1-indexed for display
    endLine: endLine + 1,
    language: doc?.language ?? null,
    source,
  };
}
