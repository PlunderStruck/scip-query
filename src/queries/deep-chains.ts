import type { ScipDatabase } from '../db.js';
import { buildFileDepGraph } from '../reference-graph.js';
import type { DeepChainResult } from '../types.js';

/**
 * Find the longest transitive dependency chains between files.
 * A chain A → B → C → D means A depends on B, B on C, C on D.
 *
 * Long chains = high coupling depth = changes at the end ripple through many layers.
 *
 * Implementation: condense the graph into strongly-connected components
 * (each cycle becomes one super-node), then run a single-pass longest-path
 * DP over the resulting DAG via topological order. Linear in nodes+edges.
 * For each starting node we record one representative longest chain;
 * within a cycle we pick a canonical representative file. This avoids the
 * exponential blow-up of enumerating every simple path (which OOMs on
 * dense graphs with cycles, like cross-crate Rust workspaces).
 */
export function deepChains(
  db: ScipDatabase,
  opts: { limit?: number; scope?: string; minDepth?: number } = {},
): DeepChainResult[] {
  const { limit = 10, scope, minDepth = 3 } = opts;
  const graph = buildFileDepGraph(db, scope);

  // 1. Tarjan's SCC.
  type SccId = number;
  const sccOf = new Map<string, SccId>();
  const sccs: string[][] = [];

  // Iterative Tarjan to avoid stack overflow on big graphs.
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let nextIndex = 0;

  type Frame = { node: string; iter: Iterator<string>; pendingChild: string | null };
  for (const start of graph.keys()) {
    if (indices.has(start)) continue;
    const callStack: Frame[] = [];
    const startIter = (graph.get(start) ?? new Set<string>()).values();
    indices.set(start, nextIndex);
    lowlink.set(start, nextIndex);
    nextIndex += 1;
    stack.push(start);
    onStack.add(start);
    callStack.push({ node: start, iter: startIter, pendingChild: null });

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      if (frame.pendingChild !== null) {
        // We just returned from recursing into pendingChild.
        const child = frame.pendingChild;
        frame.pendingChild = null;
        lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, lowlink.get(child)!));
      }

      const next = frame.iter.next();
      if (next.done) {
        // Pop SCC if root.
        if (lowlink.get(frame.node) === indices.get(frame.node)) {
          const component: string[] = [];
          while (true) {
            const w = stack.pop()!;
            onStack.delete(w);
            component.push(w);
            sccOf.set(w, sccs.length);
            if (w === frame.node) break;
          }
          sccs.push(component);
        }
        callStack.pop();
        continue;
      }

      const child = next.value;
      if (!indices.has(child)) {
        indices.set(child, nextIndex);
        lowlink.set(child, nextIndex);
        nextIndex += 1;
        stack.push(child);
        onStack.add(child);
        const childIter = (graph.get(child) ?? new Set<string>()).values();
        frame.pendingChild = child;
        callStack.push({ node: child, iter: childIter, pendingChild: null });
      } else if (onStack.has(child)) {
        lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, indices.get(child)!));
      }
    }
  }

  // 2. Build condensed DAG over SCCs.
  // sccs are emitted in reverse topological order by Tarjan.
  const dag = new Map<SccId, Set<SccId>>();
  // Member count per SCC drives chain length: a 5-file cycle counts as 5.
  const sccSize = new Array<number>(sccs.length);
  for (let i = 0; i < sccs.length; i++) {
    sccSize[i] = sccs[i]!.length;
    dag.set(i, new Set<SccId>());
  }
  for (const [from, neighbors] of graph) {
    const fromScc = sccOf.get(from)!;
    for (const to of neighbors) {
      const toScc = sccOf.get(to)!;
      if (toScc !== fromScc) dag.get(fromScc)!.add(toScc);
    }
  }

  // 3. Longest path in DAG. Tarjan emits SCCs in REVERSE topological order
  // (sinks first, sources last), so a forward iteration of `sccs` gives us
  // a valid bottom-up DP order.
  // longestSccPath[s] = list of SCC IDs forming the longest chain starting at s.
  // pathLength[s] = sum of sccSize[id] over that path.
  const longestSccPath = new Array<SccId[]>(sccs.length);
  const pathLength = new Array<number>(sccs.length);
  for (let s = 0; s < sccs.length; s++) {
    let bestTail: SccId[] = [];
    let bestTailLength = 0;
    for (const next of dag.get(s)!) {
      const tailLength = pathLength[next]!;
      if (tailLength > bestTailLength) {
        bestTailLength = tailLength;
        bestTail = longestSccPath[next]!;
      }
    }
    longestSccPath[s] = [s, ...bestTail];
    pathLength[s] = sccSize[s]! + bestTailLength;
  }
  function lp(s: SccId): SccId[] {
    return longestSccPath[s]!;
  }

  // 4. Materialize one representative file path per SCC.
  // For DAG output we pick the alphabetically-first file in each SCC as
  // the representative. Multi-file cycles inflate the chain length by
  // listing every member of the SCC in alphabetical order before moving on.
  const sortedScc = sccs.map((members) => [...members].sort());

  const seen = new Set<string>();
  const results: DeepChainResult[] = [];
  for (let s = 0; s < sccs.length; s++) {
    const sccPath = lp(s);
    const chain: string[] = [];
    for (const id of sccPath) chain.push(...sortedScc[id]!);
    if (chain.length < minDepth) continue;
    const key = chain.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ chain, depth: chain.length });
  }

  results.sort((a, b) => b.depth - a.depth);
  return results.slice(0, limit);
}
