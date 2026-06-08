import { callableBodyNodeTypesForLanguage, detectAstLanguage, getAst } from './ast.js';
import type { AstLanguage, SyntaxNode, Tree } from './ast.js';
import type { ScipDatabase } from '../storage/db.js';

export interface CallableSignature {
  paramCount: number;
}

const SIGNATURE_CACHE = new WeakMap<Tree, Map<string, CallableSignature>>();

/**
 * Pull a function's parameter count from the AST. Used by similar-pair
 * filtering to avoid declaring a 1-arg helper similar to a 7-arg orchestrator
 * just because they happen to share infrastructure callees.
 *
 * On first call per file, walks the entire AST once and indexes every
 * callable's signature by (startLine, endLine). Subsequent calls are O(1)
 * Map lookups — critical when called for thousands of candidates.
 *
 * scip-query: ignore-wrapper — public AST-signature primitive used through
 * ProjectIndex; callers should not know the per-tree signature cache shape.
 */
export function getCallableSignature(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): CallableSignature | null {
  const lang = detectAstLanguage(relativePath);
  if (!lang) return null;
  const tree = getAst(db, relativePath);
  if (!tree) return null;

  let cache = SIGNATURE_CACHE.get(tree);
  if (!cache) {
    cache = buildSignatureIndex(tree, lang);
    SIGNATURE_CACHE.set(tree, cache);
  }
  return cache.get(`${startLine}:${endLine}`) ?? null;
}

function buildSignatureIndex(tree: Tree, lang: AstLanguage): Map<string, CallableSignature> {
  const callableNodeTypes = callableBodyNodeTypesForLanguage(lang);
  const index = new Map<string, CallableSignature>();
  const walk = (node: SyntaxNode): void => {
    if (callableNodeTypes.has(node.type)) {
      const paramsNode = node.namedChildren.find((c) =>
        c.type === 'parameters' || c.type === 'formal_parameters',
      );
      let paramCount = 0;
      if (paramsNode) {
        for (const p of paramsNode.namedChildren) {
          if (p.type === 'comment' || p.type === 'line_comment' || p.type === 'block_comment') continue;
          paramCount += 1;
        }
      }
      index.set(`${node.startPosition.row}:${node.endPosition.row}`, { paramCount });
    }
    for (const child of node.children) walk(child);
  };
  walk(tree.rootNode);
  return index;
}
