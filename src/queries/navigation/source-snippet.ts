import type { ScipDatabase } from '../../storage/db.js';
import { getAst, type SyntaxNode } from '../../source/ast.js';
import { getSourceLines } from '../../source/primitives/source-text.js';

export interface SourceSnippet {
  relativePath: string;
  startLine: number;
  endLine: number;
  focusLine: number;
  source: string;
}

export interface SourceUnitSnippet extends SourceSnippet {
  unitType: string | null;
  unitStartLine: number;
  unitEndLine: number;
  omittedLines: number;
}

const READABLE_SOURCE_UNIT_TYPES = new Set([
  'arrow_function',
  'class_declaration',
  'constructor_declaration',
  'field_definition',
  'function_declaration',
  'function_definition',
  'function_expression',
  'function_item',
  'generator_function_declaration',
  'generator_function',
  'lexical_declaration',
  'method',
  'method_declaration',
  'method_definition',
  'object_method',
  'variable_declaration',
]);

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

/**
 * Return the smallest readable syntax unit containing a source line.
 *
 * Compiler indexes sometimes give an object literal or field initializer a
 * one-line declaration range even though the behavior lives in nested source.
 * The syntax tree recovers that source unit without widening to the full file.
 */
export function enclosingSourceUnitSnippet(
  db: ScipDatabase,
  relativePath: string,
  focusLine: number,
  maxLines: number,
  fallbackContext = 6,
): SourceUnitSnippet | null {
  if (!Number.isSafeInteger(maxLines) || maxLines <= 0) {
    throw new RangeError(`maxLines must be a positive safe integer; received ${maxLines}`);
  }
  const lines = getSourceLines(db, relativePath);
  if (lines.length === 0 || focusLine < 0 || focusLine >= lines.length) return null;
  const unit = smallestReadableUnit(getAst(db, relativePath)?.rootNode ?? null, focusLine);
  if (!unit) {
    const fallback = sourceSnippet(db, relativePath, focusLine, fallbackContext);
    return fallback
      ? {
          ...fallback,
          unitType: null,
          unitStartLine: fallback.startLine,
          unitEndLine: fallback.endLine,
          omittedLines: 0,
        }
      : null;
  }

  const unitStartLine = Math.max(0, unit.startPosition.row);
  const rawEndLine = unit.endPosition.column === 0 ? unit.endPosition.row - 1 : unit.endPosition.row;
  const unitEndLine = Math.min(lines.length - 1, Math.max(unitStartLine, rawEndLine));
  const unitLineCount = unitEndLine - unitStartLine + 1;
  const kept = Math.min(unitLineCount, maxLines);
  const desiredOffset = focusLine - unitStartLine - Math.floor(kept / 2);
  const offset = Math.max(0, Math.min(unitLineCount - kept, desiredOffset));
  const startLine = unitStartLine + offset;
  const endLine = startLine + kept - 1;
  return {
    relativePath,
    startLine,
    endLine,
    focusLine,
    source: lines.slice(startLine, endLine + 1).join('\n'),
    unitType: unit.type,
    unitStartLine,
    unitEndLine,
    omittedLines: unitLineCount - kept,
  };
}

function smallestReadableUnit(root: SyntaxNode | null, line: number): SyntaxNode | null {
  if (!root || !containsLine(root, line)) return null;
  let current: SyntaxNode | null = deepestNodeContainingLine(root, line);
  while (current) {
    if (READABLE_SOURCE_UNIT_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function deepestNodeContainingLine(node: SyntaxNode, line: number): SyntaxNode {
  const children = node.namedChildren
    .filter((child) => containsLine(child, line))
    .sort((left, right) => nodeSpan(left) - nodeSpan(right));
  return children.length > 0 ? deepestNodeContainingLine(children[0]!, line) : node;
}

function containsLine(node: SyntaxNode, line: number): boolean {
  return node.startPosition.row <= line && node.endPosition.row >= line;
}

function nodeSpan(node: SyntaxNode): number {
  return node.endIndex - node.startIndex;
}
