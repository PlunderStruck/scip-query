import type { SyntaxNode, TreeCursor } from './ast-types.js';

/**
 * Per-root index of the node types whole-file analyzers scan for.
 *
 * Runtime-boundary extraction ran up to eight full-tree `descendantsOfType`
 * scans per file (one per extractor per type group), and native cursor
 * traversal dominated whole-repository extraction time. One indexed pass per
 * root answers every later scan from memory; node objects are materialized
 * only for indexed types, so the pass also creates less native cache memory
 * than the scans it replaces.
 */
const NODE_TYPE_INDEX = new WeakMap<SyntaxNode, ReadonlyMap<string, readonly SyntaxNode[]>>();

const INDEXED_NODE_TYPES: ReadonlySet<string> = new Set([
  'call_expression',
  'call',
  'decorator',
  'pair',
  'string',
  'string_literal',
  'template_string',
  'variable_declarator',
]);

/**
 * Document-order nodes of the requested types under (and including) `root`.
 * Types outside the indexed set fall back to a direct scan, so callers keep
 * `descendantsOfType` semantics regardless of what they ask for.
 */
export function nodesOfTypes(root: SyntaxNode, type: string | string[]): readonly SyntaxNode[] {
  const requested = Array.isArray(type) ? type : [type];
  if (!requested.every((name) => INDEXED_NODE_TYPES.has(name))) {
    return root.descendantsOfType(type);
  }
  const index = indexedNodesByType(root);
  if (requested.length === 1) return index.get(requested[0]!) ?? [];
  const combined = requested.flatMap((name) => index.get(name) ?? []);
  return combined.sort((left, right) => left.startIndex - right.startIndex);
}

/**
 * Depth-guarded pre-order cursor visit of `root` and every descendant
 * (anonymous nodes included). `root` may be any node: the depth counter is
 * what confines the scan to the subtree, because a cursor will walk past a
 * subtree root through gotoParent/gotoNextSibling.
 */
export function forEachTreeCursorNode(root: SyntaxNode, visit: (cursor: TreeCursor) => void): void {
  const cursor = root.walk();
  let depth = 0;
  let done = false;
  while (!done) {
    visit(cursor);
    if (cursor.gotoFirstChild()) {
      depth += 1;
      continue;
    }
    for (;;) {
      if (depth === 0) {
        done = true;
        break;
      }
      if (cursor.gotoNextSibling()) break;
      cursor.gotoParent();
      depth -= 1;
    }
  }
}

function indexedNodesByType(root: SyntaxNode): ReadonlyMap<string, readonly SyntaxNode[]> {
  const cached = NODE_TYPE_INDEX.get(root);
  if (cached) return cached;
  const index = new Map<string, SyntaxNode[]>();
  forEachTreeCursorNode(root, (cursor) => {
    const nodeType = cursor.nodeType;
    if (!INDEXED_NODE_TYPES.has(nodeType)) return;
    const bucket = index.get(nodeType);
    if (bucket) bucket.push(cursor.currentNode);
    else index.set(nodeType, [cursor.currentNode]);
  });
  NODE_TYPE_INDEX.set(root, index);
  return index;
}
