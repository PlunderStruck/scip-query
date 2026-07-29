import { extname } from 'node:path';
import { isMissingProjectFileError, readProjectFileText } from '../../source/primitives/project-file-boundary.js';
import type { ScipDatabase } from '../../storage/db.js';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { resolveIndexedFile } from '../internal/file-resolution.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';

export interface CodeResult {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  language: string | null;
  source: string;
}

/**
 * Read the source code for a symbol, bounded to its definition range.
 * Language-agnostic: just reads the file and extracts the relevant lines.
 *
 * Accepts:
 *   - Symbol name pattern: "processVegaMention"
 *   - Full short name: "src:modules:chat:processVegaMention"
 *   - File:line-line syntax: "src/chat/service.ts:100-200"
 */
export function code(db: ScipDatabase, symbolPattern: string, opts: { context?: number } = {}): CodeResult | null {
  const { context = 0 } = opts;

  // Handle direct file:line-line syntax (bypass symbol lookup)
  const directRange = parseFileLineRange(symbolPattern);
  if (directRange) return readFileRange(db, directRange.filePath, directRange.startLine, directRange.endLine, context);

  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return null;
  return readSymbolRange(db, match, context);
}

function parseFileLineRange(symbolPattern: string): {
  filePath: string;
  startLine: number;
  endLine: number;
} | null {
  const fileLineMatch = symbolPattern.match(/^(.+\.\w+):(\d+)-(\d+)$/);
  if (!fileLineMatch) return null;
  const startLine = Number(fileLineMatch[2]);
  const endLine = Number(fileLineMatch[3]);
  if (!Number.isSafeInteger(startLine) || startLine < 1) {
    throw new RangeError(`Source range start line must be a positive integer, got "${fileLineMatch[2]}".`);
  }
  if (!Number.isSafeInteger(endLine) || endLine < startLine) {
    throw new RangeError(
      `Source range end line must be an integer at or after ${startLine}, got "${fileLineMatch[3]}".`,
    );
  }
  return {
    filePath: fileLineMatch[1]!,
    startLine,
    endLine,
  };
}

function readSymbolRange(
  db: ScipDatabase,
  match: NonNullable<ReturnType<typeof findFirstSymbolMatch>>,
  context: number,
): CodeResult | null {
  // Get the language from the documents table
  const doc = db.get<{ language: string | null }>(
    `SELECT language FROM documents WHERE relative_path = ?`,
    match.relativePath,
  );

  // Read the file
  let fileContent: string;
  try {
    fileContent = readProjectFileText(db.config.projectRoot, match.relativePath, {
      inputKind: 'indexed source file',
    });
  } catch (error) {
    if (!isMissingProjectFileError(error)) throw error;
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
    // 0-indexed, like every other query result. The CLI's displayLine()
    // converts once at render time. Returning 1-indexed here caused a
    // double-conversion in the CLI and printed labels off by +1.
    startLine,
    endLine,
    language: doc?.language ?? supportedLanguageFromPath(match.relativePath),
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

  let fileContent: string;
  try {
    fileContent = readProjectFileText(db.config.projectRoot, doc.relative_path, {
      inputKind: 'indexed source file',
    });
  } catch (error) {
    if (!isMissingProjectFileError(error)) throw error;
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
    startLine: start,
    endLine: end,
    language: doc.language ?? supportedLanguageFromPath(doc.relative_path),
    source,
  };
}

// Maps a file extension to the project's canonical SupportedLanguage name
// (used for display/reporting). Distinct from reindex/augment.ts's
// auxiliaryDocumentLanguageTag (a best-effort tag for otherwise-unindexed
// files, not a canonical language) and augment-vue-runtime.ts's
// volarLanguageIdForPath (LSP languageId vocabulary for a TS language
// service, e.g. 'typescriptreact') -- three different jobs that happened
// to share a name.
function supportedLanguageFromPath(relativePath: string): string | null {
  switch (extname(relativePath).toLowerCase()) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
    case '.pyi':
      return 'python';
    case '.rs':
      return 'rust';
    case '.go':
      return 'go';
    case '.java':
      return 'java';
    case '.kt':
    case '.kts':
      return 'kotlin';
    case '.scala':
      return 'scala';
    case '.rb':
      return 'ruby';
    case '.php':
      return 'php';
    case '.cs':
      return 'csharp';
    case '.vb':
      return 'vb';
    case '.dart':
      return 'dart';
    case '.c':
    case '.h':
      return 'c';
    case '.cc':
    case '.cpp':
    case '.cxx':
    case '.hpp':
    case '.hh':
    case '.hxx':
      return 'cpp';
    case '.vue':
      return 'vue';
    default:
      return null;
  }
}
