import type { ScipDatabase } from '../db.js';
import { buildFileDepGraph } from '../query-support.js';
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
  const graph = buildFileDepGraph(db, scope);

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
