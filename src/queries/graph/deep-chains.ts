import type { ScipDatabase } from '../../storage/db.js';
import { buildFileDepGraph, type FileDependencyEdgeBasis } from '../../symbols/graph/file-dep-graph.js';
import { stronglyConnectedComponents } from '../../analysis/strongly-connected-components.js';

export interface DeepChainResult {
  /** Canonical representative file for each condensed dependency component. */
  chain: string[];
  /** Full component membership; arrays with multiple files are dependency cycles. */
  components: string[][];
  /** Number of condensed dependency components, not the number of files inside cycles. */
  depth: number;
  /** Total files represented by the condensed component path. */
  fileCount: number;
  /** The file relation whose condensed depth was measured. */
  edgeBasis?: FileDependencyEdgeBasis;
  actionTier: 'signal';
  chainKind: 'transitive-dependency-depth';
  evidenceReasons: string[];
  recommendation: string;
}

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
export function dependencyDepth(
  db: ScipDatabase,
  opts: { limit?: number; scope?: string; minDepth?: number; edgeBasis?: FileDependencyEdgeBasis } = {},
): DeepChainResult[] {
  const { limit = 10, scope, minDepth = 3, edgeBasis = 'symbol-references' } = opts;
  const graph = buildFileDepGraph(
    db,
    scope,
    edgeBasis === 'imports' ? { scipEdges: 'imports-only', sourceEdges: 'imports-and-reexports' } : undefined,
  );

  // 1. Condense mutually reachable files into dependency components.
  type SccId = number;
  const { components: sccs, componentOf: sccOf } = stronglyConnectedComponents(graph);

  // 2. Build condensed DAG over SCCs.
  // sccs are emitted in reverse topological order by Tarjan.
  const dag = new Map<SccId, Set<SccId>>();
  for (let i = 0; i < sccs.length; i++) {
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
  // pathLength[s] = number of condensed dependency components. A cycle is
  // one component, so adding its member count would falsely inflate depth.
  const longestSccPath = new Array<SccId[]>(sccs.length);
  const pathLength = new Array<number>(sccs.length);
  for (let s = 0; s < sccs.length; s++) {
    let bestTail: SccId[] = [];
    let bestTailLength = 0;
    for (const next of [...dag.get(s)!].sort((left, right) => left - right)) {
      const tailLength = pathLength[next]!;
      if (
        tailLength > bestTailLength ||
        (tailLength === bestTailLength && compareComponentPaths(longestSccPath[next]!, bestTail, sccs) < 0)
      ) {
        bestTailLength = tailLength;
        bestTail = longestSccPath[next]!;
      }
    }
    longestSccPath[s] = [s, ...bestTail];
    pathLength[s] = 1 + bestTailLength;
  }
  function lp(s: SccId): SccId[] {
    return longestSccPath[s]!;
  }

  // 4. Materialize one representative file path per SCC while retaining full
  // component membership. Multi-file cycles are one dependency component;
  // listing their members as sequential chain steps would invent edges.
  const sortedScc = sccs.map((members) => [...members].sort());

  const seen = new Set<string>();
  const results: DeepChainResult[] = [];
  for (let s = 0; s < sccs.length; s++) {
    const sccPath = lp(s);
    const components = sccPath.map((id) => sortedScc[id]!);
    const chain = components.map((component) => component[0]!);
    if (components.length < minDepth) continue;
    const key = chain.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(deepChainResult(chain, components, edgeBasis));
  }

  results.sort((a, b) => b.depth - a.depth || a.chain.join('\0').localeCompare(b.chain.join('\0')));
  return dedupeSuffixChains(results).slice(0, limit);
}

function compareComponentPaths(
  left: readonly number[],
  right: readonly number[],
  components: readonly string[][],
): number {
  if (right.length === 0) return -1;
  const leftKey = left.map((id) => [...components[id]!].sort()[0] ?? '').join('\0');
  const rightKey = right.map((id) => [...components[id]!].sort()[0] ?? '').join('\0');
  return leftKey.localeCompare(rightKey);
}

function deepChainResult(chain: string[], components: string[][], edgeBasis: FileDependencyEdgeBasis): DeepChainResult {
  const fileCount = components.reduce((sum, component) => sum + component.length, 0);
  const cycleCount = components.filter((component) => component.length > 1).length;
  return {
    chain,
    components,
    depth: components.length,
    fileCount,
    edgeBasis,
    actionTier: 'signal',
    chainKind: 'transitive-dependency-depth',
    evidenceReasons: [
      `${components.length} condensed dependency component(s) form the representative transitive path`,
      `${fileCount} file(s) are represented; ${cycleCount} component(s) contain a dependency cycle`,
      `edge basis: ${edgeBasis === 'imports' ? 'resolved file imports' : 'cross-file symbol references plus resolved source imports'}`,
      'cycles count once toward depth and retain their full membership separately',
    ],
    recommendation:
      'Review whether the chain crosses ownership or layer boundaries; shorten it only when the dependency direction is accidental.',
  };
}

function dedupeSuffixChains(results: DeepChainResult[]): DeepChainResult[] {
  const retained: DeepChainResult[] = [];
  for (const result of results) {
    if (retained.some((existing) => isStrictSuffixChain(result.chain, existing.chain))) continue;
    retained.push(result);
  }
  return retained;
}

function isStrictSuffixChain(candidate: readonly string[], existing: readonly string[]): boolean {
  if (candidate.length >= existing.length) return false;
  const offset = existing.length - candidate.length;
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] !== existing[offset + i]) return false;
  }
  return true;
}
