import type { ScipDatabase } from '../db.js';
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
  const scopeFilter = scope ? `AND d1.relative_path LIKE '%${scope}%'` : '';

  // Build file dependency graph
  const edges = db.all<{ from_file: string; to_file: string }>(
    `SELECT DISTINCT
      d1.relative_path AS from_file,
      d2.relative_path AS to_file
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents d1 ON c.document_id = d1.id
    JOIN global_symbols gs ON m.symbol_id = gs.id
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d2 ON der.document_id = d2.id
    WHERE d1.id != d2.id
      AND m.role = 0
      AND d1.relative_path NOT LIKE 'node_modules/%'
      AND d2.relative_path NOT LIKE 'node_modules/%'
      ${scopeFilter}`,
  );

  const graph = new Map<string, Set<string>>();
  for (const e of edges) {
    if (db.isIgnored(e.from_file) || db.isIgnored(e.to_file)) continue;
    if (!graph.has(e.from_file)) graph.set(e.from_file, new Set());
    graph.get(e.from_file)!.add(e.to_file);
  }

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
