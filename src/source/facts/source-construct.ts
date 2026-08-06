import { getAst } from '../ast/ast-core.js';
import type { SyntaxNode } from '../ast/ast-types.js';
import { getSourceLines } from '../primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { behaviorConstructRange } from './behavior-skeleton.js';

export interface ReadableSourceUnitRange {
  type: string;
  startLine: number;
  endLine: number;
}

export interface FocusedSourceConstructRange {
  startLine: number;
  endLine: number;
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

/** Return the smallest parser-delimited callable or declaration containing one line. */
export function readableSourceUnitRange(
  db: ScipDatabase,
  relativePath: string,
  focusLine: number,
): ReadableSourceUnitRange | null {
  const root = getAst(db, relativePath)?.rootNode ?? null;
  const unit = smallestReadableUnit(root, focusLine);
  if (!unit) return null;
  const lines = getSourceLines(db, relativePath);
  if (lines.length === 0) return null;
  const startLine = Math.max(0, unit.startPosition.row);
  const rawEndLine = unit.endPosition.column === 0 ? unit.endPosition.row - 1 : unit.endPosition.row;
  return {
    type: unit.type,
    startLine,
    endLine: Math.min(lines.length - 1, Math.max(startLine, rawEndLine)),
  };
}

/**
 * Return the smallest source construct that can own one selected line.
 *
 * Anonymous callbacks and registry handlers are narrower than their containing
 * declaration; plain data entries fall back to the surrounding declaration.
 * The result never widens beyond the caller's known enclosing range.
 */
export function focusedSourceConstructRange(
  db: ScipDatabase,
  relativePath: string,
  focusLine: number,
  enclosingStartLine: number,
  enclosingEndLine: number,
): FocusedSourceConstructRange {
  const behaviorRange = behaviorConstructRange(db, relativePath, enclosingStartLine, enclosingEndLine, [focusLine]);
  const behaviorStartsAnIncompleteContinuation =
    behaviorRange.startLine === behaviorRange.endLine &&
    /(?:=>|\(|\{|\[|,)\s*$/u.test(getSourceLines(db, relativePath)[behaviorRange.startLine] ?? '');
  if (
    !behaviorStartsAnIncompleteContinuation &&
    (behaviorRange.startLine > enclosingStartLine || behaviorRange.endLine < enclosingEndLine)
  ) {
    return behaviorRange;
  }

  const unit = readableSourceUnitRange(db, relativePath, focusLine);
  if (behaviorStartsAnIncompleteContinuation && unit) {
    return { startLine: unit.startLine, endLine: unit.endLine };
  }
  if (unit && unit.startLine >= enclosingStartLine && unit.endLine <= enclosingEndLine) {
    return { startLine: unit.startLine, endLine: unit.endLine };
  }
  return { startLine: enclosingStartLine, endLine: enclosingEndLine };
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
