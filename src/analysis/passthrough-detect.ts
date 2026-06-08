/**
 * Passthrough-body detection — used by the `passthrough-candidates` query.
 *
 * Pulled out of ast.ts because it's a single-query consumer with body-shape
 * pattern matching that's distinct from the AST runtime everyone shares.
 */
import type { ScipDatabase } from '../storage/db.js';
import { type AstLanguage, callableBodyNodeTypesForLanguage, detectAstLanguage, getAst, type SyntaxNode, type Tree } from '../source/ast.js';

/**
 * True when a function's body is a *direct* forward to one other call —
 * `return inner(a, b)` (or void `inner(a, b)`) where the call's args are
 * exactly the function's parameters in order. Passthrough-candidates uses
 * this to filter out type guards, defaulted wrappers, and partial
 * applications that happen to call exactly one function.
 *
 * Returns false when the body has any extra logic — additional statements,
 * literal args, computed args, default-value substitution, control flow.
 *
 * Per-file cache (we re-use the AST parse).
 */
export function isLiteralPassthrough(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): boolean {
  const lang = detectAstLanguage(relativePath);
  if (!lang) return true; // No AST — fall back to LOC heuristic (current behavior).
  const tree = getAst(db, relativePath);
  if (!tree) return true;

  let cache = PASSTHROUGH_CACHE.get(tree);
  if (!cache) {
    cache = buildPassthroughIndex(tree, lang);
    PASSTHROUGH_CACHE.set(tree, cache);
  }
  const result = cache.get(`${startLine}:${endLine}`);
  return result ?? true;
}

const PASSTHROUGH_CACHE = new WeakMap<Tree, Map<string, boolean>>();

function buildPassthroughIndex(tree: Tree, lang: AstLanguage): Map<string, boolean> {
  const callableNodeTypes = callableBodyNodeTypesForLanguage(lang);
  const index = new Map<string, boolean>();
  const walk = (node: SyntaxNode): void => {
    if (callableNodeTypes.has(node.type)) {
      index.set(`${node.startPosition.row}:${node.endPosition.row}`, isPassthroughBody(node, lang));
    }
    for (const child of node.children) walk(child);
  };
  walk(tree.rootNode);
  return index;
}

function isPassthroughBody(fnNode: SyntaxNode, lang: AstLanguage): boolean {
  // Find the body block.
  const body = fnNode.namedChildren.find((c) =>
    c.type === 'block' || c.type === 'statement_block',
  );
  if (!body) return false;

  // Body must contain exactly one statement (or for Rust an expression).
  const statements = body.namedChildren.filter((c) =>
    c.type !== 'comment' && c.type !== 'line_comment' && c.type !== 'block_comment',
  );
  if (statements.length !== 1) return false;
  const only = statements[0]!;

  // Unwrap return statements / expression statements to find the call.
  let callNode: SyntaxNode | null = null;
  if (only.type === 'return_statement') {
    callNode = only.namedChild(0) ?? null;
  } else if (only.type === 'expression_statement') {
    callNode = only.namedChild(0) ?? null;
  } else if (lang === 'rust' && (only.type === 'call_expression' || only.type === 'macro_invocation')) {
    // Rust expression-as-block tail
    callNode = only;
  }
  if (!callNode) return false;
  const callType = lang === 'python' ? 'call' : 'call_expression';
  if (callNode.type !== callType) return false;

  // Get the call's arguments and the function's parameters.
  const argsNode = callNode.namedChildren.find((c) =>
    c.type === 'arguments' || c.type === 'argument_list',
  );
  if (!argsNode) return false;
  const callArgs = argsNode.namedChildren.filter((c) => c.type !== 'comment');

  const paramsNode = fnNode.namedChildren.find((c) =>
    c.type === 'parameters' || c.type === 'formal_parameters',
  );
  if (!paramsNode) return false;
  const paramNames: string[] = [];
  for (const p of paramsNode.namedChildren) {
    // TS: required_parameter > identifier
    // Rust: parameter > identifier (also self_parameter for methods)
    // Python: identifier directly, or default_parameter > identifier
    if (p.type === 'identifier') paramNames.push(p.text);
    else {
      const id = p.namedChildren.find((c) => c.type === 'identifier');
      if (id) paramNames.push(id.text);
    }
  }

  // Args must equal params in order, by name.
  if (callArgs.length !== paramNames.length) return false;
  for (let i = 0; i < paramNames.length; i += 1) {
    const arg = callArgs[i]!;
    if (arg.type !== 'identifier') return false;
    if (arg.text !== paramNames[i]) return false;
  }
  return true;
}
