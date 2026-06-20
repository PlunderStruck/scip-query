import type { AstLanguage } from './ast-language.js';

const RUST_CALLABLE_NODE_TYPES = new Set(['function_item', 'function_signature_item']);
const PYTHON_CALLABLE_NODE_TYPES = new Set(['function_definition']);
const JAVASCRIPT_LIKE_CALLABLE_NODE_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
]);

/**
 * Callable body nodes for AST walks that index a function-like node by range.
 *
 * This intentionally excludes variable declarators and public fields: those
 * query-shaped definitions need name binding and stay in `ast-facts.ts`.
 */
export function callableBodyNodeTypesForLanguage(lang: AstLanguage): ReadonlySet<string> {
  switch (lang) {
    case 'rust':
      return RUST_CALLABLE_NODE_TYPES;
    case 'python':
      return PYTHON_CALLABLE_NODE_TYPES;
    default:
      return JAVASCRIPT_LIKE_CALLABLE_NODE_TYPES;
  }
}
