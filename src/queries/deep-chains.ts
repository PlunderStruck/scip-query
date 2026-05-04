import type { ScipDatabase } from '../db.js';
import { buildFileDepGraph } from '../reference-graph.js';
import type { DeepChainResult } from '../types.js';

/**
 * Find the longest transitive dependency chains between files.
 * A chain A → B → C → D means A depends on B, B on C, C on D.
 *
 * Long chains = high coupling depth = changes at the end ripple through many layers.
 */
export function deepChains(
  db: ScipDatabase,
  opts: { limit?: number; scope?: string; minDepth?: number } = {},
): DeepChainResult[] {
  const { limit = 10, scope, minDepth = 3 } = opts;
  const graph = buildFileDepGraph(db, scope);

  // DFS to find longest paths (with cycle detection)
  const results: DeepChainResult[] = [];

  function dfs(node: string, path: string[], visited: Set<string>): void {
    const neighbors = graph.get(node);
    if (!neighbors || neighbors.size === 0) {
      if (path.length >= minDepth) {
        results.push({ chain: [...path], depth: path.length });
      }
      return;
    }

    let extended = false;
    for (const next of neighbors) {
      if (visited.has(next)) continue; // skip cycles
      visited.add(next);
      path.push(next);
      dfs(next, path, visited);
      path.pop();
      visited.delete(next);
      extended = true;
    }

    // If no unvisited neighbors, this is a leaf in this path
    if (!extended && path.length >= minDepth) {
      results.push({ chain: [...path], depth: path.length });
    }
  }

  // Start DFS from each node
  for (const startNode of graph.keys()) {
    const visited = new Set<string>([startNode]);
    dfs(startNode, [startNode], visited);

    // Early termination if we have enough results
    if (results.length > limit * 10) break;
  }

  // Sort by depth descending, take top N
  results.sort((a, b) => b.depth - a.depth);
  return results.slice(0, limit);
}
