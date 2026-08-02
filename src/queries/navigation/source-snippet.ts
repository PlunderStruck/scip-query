import type { ScipDatabase } from '../../storage/db.js';
import { getSourceLines } from '../../source/primitives/source-text.js';

export interface SourceSnippet {
  relativePath: string;
  startLine: number;
  endLine: number;
  focusLine: number;
  source: string;
}

/**
 * Read a small source window around one zero-based evidence line.
 * The line identities stay stable so callers can merge related windows.
 */
export function sourceSnippet(
  db: ScipDatabase,
  relativePath: string,
  focusLine: number,
  contextLines: number,
): SourceSnippet | null {
  if (!Number.isSafeInteger(focusLine) || focusLine < 0) return null;
  if (!Number.isSafeInteger(contextLines) || contextLines < 0) {
    throw new RangeError(`contextLines must be a non-negative safe integer; received ${contextLines}`);
  }
  const lines = getSourceLines(db, relativePath);
  if (lines.length === 0 || focusLine >= lines.length) return null;
  const startLine = Math.max(0, focusLine - contextLines);
  const endLine = Math.min(lines.length - 1, focusLine + contextLines);
  return {
    relativePath,
    startLine,
    endLine,
    focusLine,
    source: lines.slice(startLine, endLine + 1).join('\n'),
  };
}

export function boundedDefinitionSnippet(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
  maxLines: number,
): SourceSnippet | null {
  if (!Number.isSafeInteger(maxLines) || maxLines <= 0) {
    throw new RangeError(`maxLines must be a positive safe integer; received ${maxLines}`);
  }
  const lines = getSourceLines(db, relativePath);
  if (lines.length === 0 || startLine < 0 || startLine >= lines.length) return null;
  const boundedEnd = Math.min(lines.length - 1, endLine, startLine + maxLines - 1);
  return {
    relativePath,
    startLine,
    endLine: boundedEnd,
    focusLine: startLine,
    source: lines.slice(startLine, boundedEnd + 1).join('\n'),
  };
}
