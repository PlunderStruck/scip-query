import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch, resolveIndexedFile } from '../query-support.js';
import type { CodeResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Read the source code for a symbol, bounded to its definition range.
 * Language-agnostic: just reads the file and extracts the relevant lines.
 *
 * Accepts:
 *   - Symbol name pattern: "processVegaMention"
 *   - Full short name: "src:modules:chat:processVegaMention"
 *   - File:line-line syntax: "src/chat/service.ts:100-200"
 */
export function code(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { context?: number } = {},
): CodeResult | null {
  const { context = 0 } = opts;

  // Handle direct file:line-line syntax (bypass symbol lookup)
  const fileLineMatch = symbolPattern.match(/^(.+\.\w+):(\d+)-(\d+)$/);
  if (fileLineMatch) {
    return readFileRange(db, fileLineMatch[1]!, parseInt(fileLineMatch[2]!, 10), parseInt(fileLineMatch[3]!, 10), context);
  }

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

/** Read source by file path and line range directly (no symbol lookup) */
function readFileRange(
  db: ScipDatabase,
  filePath: string,
  startLine: number,
  endLine: number,
  context: number,
): CodeResult | null {
  // Find the file in the index
  const resolvedPath = resolveIndexedFile(db, filePath);
  if (!resolvedPath) return null;

  const doc = db.get<{ relative_path: string; language: string | null }>(
    `SELECT relative_path, language FROM documents WHERE relative_path = ?`,
    resolvedPath,
  );
  if (!doc) return null;

  const fullPath = join(db.config.projectRoot, doc.relative_path);
  let fileContent: string;
  try {
    fileContent = readFileSync(fullPath, 'utf-8');
  } catch {
    return null;
  }

  const lines = fileContent.split('\n');
  const start = Math.max(0, startLine - 1 - context); // convert to 0-indexed
  const end = Math.min(lines.length - 1, endLine - 1 + context);
  const source = lines.slice(start, end + 1).join('\n');

  return {
    symbol: `${doc.relative_path}:${startLine}-${endLine}`,
    shortName: `${doc.relative_path}:${startLine}-${endLine}`,
    relativePath: doc.relative_path,
    startLine: start + 1,
    endLine: end + 1,
    language: doc.language,
    source,
  };
}
