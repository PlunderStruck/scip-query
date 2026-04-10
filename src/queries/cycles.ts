import type { ScipDatabase } from '../db.js';
import type { CycleResult } from '../types.js';

/**
 * Detect circular dependency chains between files.
 * A cycle exists when file A depends on B, B depends on C, and C depends on A.
 *
 * Uses the same dependency edges as the `deps` command (symbol definitions
 * referenced across files), then runs DFS cycle detection.
 */
export function cycles(
  db: ScipDatabase,
  opts: { scope?: string; maxDepth?: number } = {},
): CycleResult[] {
  const { scope, maxDepth = 10 } = opts;
  const scopeFilter = scope ? `AND d1.relative_path LIKE '%${scope}%'` : '';

  // Build the file dependency graph
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

  // Build adjacency list
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (db.isIgnored(edge.from_file) || db.isIgnored(edge.to_file)) continue;
    if (!graph.has(edge.from_file)) graph.set(edge.from_file, new Set());
    graph.get(edge.from_file)!.add(edge.to_file);
  }

  // DFS cycle detection
  const allCycles: CycleResult[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string, depth: number): void {
    if (depth > maxDepth) return;
    if (inStack.has(node)) {
      // Found a cycle — extract it from the stack
      const cycleStart = stack.indexOf(node);
      if (cycleStart !== -1) {
        const cyclePath = stack.slice(cycleStart).concat(node);
        // Normalize: start from the lexicographically smallest file
        const minIdx = cyclePath.indexOf(
          cyclePath.reduce((a, b) => (a < b ? a : b)),
        );
        const normalized = [
          ...cyclePath.slice(minIdx, -1),
          ...cyclePath.slice(0, minIdx),
          cyclePath[minIdx]!,
        ];
        // Deduplicate
        const key = normalized.join(' -> ');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          allCycles.push({ path: normalized });
        }
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    stack.push(node);

    const neighbors = graph.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        dfs(neighbor, depth + 1);
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  const seenCycles = new Set<string>();
  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node, 0);
    }
  }

  // Sort by cycle length (shorter cycles are more actionable)
  allCycles.sort((a, b) => a.path.length - b.path.length);

  return allCycles;
}
