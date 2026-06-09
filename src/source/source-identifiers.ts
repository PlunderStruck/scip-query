import type { AstLanguage } from './ast-language.js';
import type { SyntaxNode } from './ast-types.js';

const RUST_IDENTIFIER_TYPES = new Set(['identifier', 'type_identifier', 'field_identifier']);
const PYTHON_IDENTIFIER_TYPES = new Set(['identifier']);
// Shorthand object properties ({ messageId }) and destructuring patterns are
// variable references — omitting them made fully-forwarded parameters look
// unused (caught live by unused-params on a foreign repo).
const DEFAULT_IDENTIFIER_TYPES = new Set([
  'identifier',
  'property_identifier',
  'type_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
]);
const INTERPOLATION_LANGUAGES = new Set<AstLanguage>(['rust', 'python']);
const BRACE_BLOCK_RE = /\{([^{}]*)\}/g;
const IDENT_IN_BLOCK_RE = /\b([A-Za-z_][\w]*)\b/g;

// scip-query: ignore-wrapper — source-facts owns the single tree walk; this
// helper keeps per-language identifier node policy out of the orchestrator.
export function shouldRecordIdentifierNode(node: SyntaxNode, language: AstLanguage): boolean {
  return identifierTypesForLanguage(language).has(node.type);
}

// scip-query: ignore-wrapper — interpolation support is part of identifier
// collection policy, not a separate source-facts lifecycle.
export function shouldRecordInterpolatedIdentifiers(node: SyntaxNode, language: AstLanguage): boolean {
  return INTERPOLATION_LANGUAGES.has(language) && node.type === 'string_content';
}

// scip-query: ignore-wrapper — this materializes the line-indexed identifier
// view from the source-facts identifier map.
export function identifiersByLine(lineMap: ReadonlyMap<string, number[]>): Array<Set<string>> {
  let maxLine = 0;
  for (const lines of lineMap.values()) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last > maxLine) maxLine = last;
  }

  const out: Array<Set<string>> = new Array(maxLine + 1);
  for (let index = 0; index <= maxLine; index += 1) out[index] = new Set();
  for (const [name, lines] of lineMap) {
    for (const line of lines) out[line]!.add(name);
  }
  return out;
}

function identifierTypesForLanguage(language: AstLanguage): ReadonlySet<string> {
  if (language === 'rust') return RUST_IDENTIFIER_TYPES;
  if (language === 'python') return PYTHON_IDENTIFIER_TYPES;
  return DEFAULT_IDENTIFIER_TYPES;
}

// scip-query: ignore-wrapper — source-facts owns traversal; this helper owns
// the Rust/Python interpolation token policy.
export function recordInterpolatedIdentifiers(
  node: SyntaxNode,
  recordIdentifier: (name: string, line: number) => void,
): void {
  const baseLine = node.startPosition.row;
  for (const block of node.text.matchAll(BRACE_BLOCK_RE)) {
    const inner = block[1] ?? '';
    for (const ident of inner.matchAll(IDENT_IN_BLOCK_RE)) {
      if (ident[1]) recordIdentifier(ident[1], baseLine);
    }
  }
}
