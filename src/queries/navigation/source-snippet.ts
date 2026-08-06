import type { ScipDatabase } from '../../storage/db.js';
import { getAst, type SyntaxNode } from '../../source/ast.js';
import { readableSourceUnitRange } from '../../source/facts/source-construct.js';
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

export type ReferenceSourceKind = 'complete-call-expression' | 'non-call-reference' | 'bounded-context';

export interface ReferenceSourceSnippet extends SourceSnippet {
  kind: ReferenceSourceKind;
}

const CALL_EXPRESSION_TYPES = new Set([
  'call',
  'call_expression',
  'command',
  'command_call',
  'function_call_expression',
  'invocation_expression',
  'macro_invocation',
  'method_call',
  'method_invocation',
  'new_expression',
  'object_creation_expression',
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

/**
 * Read source for a resolved reference without clipping a call's arguments.
 *
 * A complete call expression supports predicates about the invocation itself.
 * When the parser cannot identify one unambiguous call to the referenced leaf,
 * the result stays explicitly bounded so consumers cannot mistake context for
 * proof about every argument.
 */
export function referenceSourceSnippet(
  db: ScipDatabase,
  relativePath: string,
  focusLine: number,
  contextLines: number,
  referencedLeaf: string,
): ReferenceSourceSnippet | null {
  const fallback = sourceSnippet(db, relativePath, focusLine, contextLines);
  if (!fallback) return null;
  const root = getAst(db, relativePath)?.rootNode ?? null;
  if (!root) return { ...fallback, kind: 'bounded-context' };

  const calls = minimalMatchingCalls(root, focusLine, referencedLeaf);
  if (calls.length !== 1) {
    return { ...fallback, kind: calls.length === 0 ? 'non-call-reference' : 'bounded-context' };
  }

  const call = calls[0]!;
  const lines = getSourceLines(db, relativePath);
  const startLine = Math.max(0, call.startPosition.row);
  const rawEndLine = call.endPosition.column === 0 ? call.endPosition.row - 1 : call.endPosition.row;
  const endLine = Math.min(lines.length - 1, Math.max(startLine, rawEndLine));
  return {
    relativePath,
    startLine,
    endLine,
    focusLine,
    source: lines.slice(startLine, endLine + 1).join('\n'),
    kind: 'complete-call-expression',
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
  const unit = readableSourceUnitRange(db, relativePath, focusLine);
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

  const unitStartLine = unit.startLine;
  const unitEndLine = unit.endLine;
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

function minimalMatchingCalls(root: SyntaxNode, line: number, referencedLeaf: string): SyntaxNode[] {
  const candidates: SyntaxNode[] = [];
  collectMatchingCalls(root, line, referencedLeaf, candidates);
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other !== candidate && other.startIndex >= candidate.startIndex && other.endIndex <= candidate.endIndex,
      ),
  );
}

function collectMatchingCalls(node: SyntaxNode, line: number, referencedLeaf: string, matches: SyntaxNode[]): void {
  if (!containsLine(node, line)) return;
  if (CALL_EXPRESSION_TYPES.has(node.type) && callTargetLeaf(node) === referencedLeaf) matches.push(node);
  for (const child of node.namedChildren) collectMatchingCalls(child, line, referencedLeaf, matches);
}

function callTargetLeaf(node: SyntaxNode): string | null {
  const target =
    node.childForFieldName('function') ??
    node.childForFieldName('constructor') ??
    node.childForFieldName('method') ??
    node.childForFieldName('name') ??
    node.namedChild(0);
  if (!target) return null;
  const identifiers = target.text.match(/[\p{L}_$][\p{L}\p{N}_$!?-]*/gu);
  return identifiers?.at(-1) ?? null;
}

function containsLine(node: SyntaxNode, line: number): boolean {
  return node.startPosition.row <= line && node.endPosition.row >= line;
}
