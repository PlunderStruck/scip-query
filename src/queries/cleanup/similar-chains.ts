import type { ScipDatabase } from '../../storage/db.js';
import { buildFileDepGraph } from '../../symbols/file-dep-graph.js';

export interface SimilarChainResult {
  chainA: string[];
  chainB: string[];
  /** Fraction of nodes shared (0-1) */
  similarity: number;
  /** Edit distance between the two chains */
  editDistance: number;
  /** Indices where the chains diverge — the consolidation targets */
  divergencePoints: Array<{
    index: number;
    nodeA: string;
    nodeB: string;
  }>;
  /** Shared prefix */
  commonPrefix: string[];
  /** Shared suffix */
  commonSuffix: string[];
}

/**
 * Find end-to-end dependency flows that are structurally similar
 * but diverge at a few points — indicating duplicated pipelines
 * that could be consolidated.
 *
 * Uses infrastructure-filtered chain comparison:
 *
 * 1. Build all dependency chains via DFS
 * 2. Compute node frequency across all chains
 * 3. Filter out infrastructure nodes (appearing in >50% of chains)
 * 4. Compare the filtered chains — what's left is the unique pipeline
 * 5. Edit distance on filtered chains finds real structural duplicates
 *
 * Two chains that both pass through db.ts → types.ts is meaningless.
 * Two chains that both pass through userValidation → userRepo → emailService
 * after filtering is a strong consolidation signal.
 */
// scip-query: ignore-extract — this is the command pipeline for chain
// similarity: generation, pair scoring, dedupe, infrastructure filtering, and
// ranking must stay visible as the public result contract.
export function similarChains(
  db: ScipDatabase,
  opts: {
    minSimilarity?: number;
    limit?: number;
    scope?: string;
    minChainLength?: number;
    maxChainLength?: number;
  } = {},
): SimilarChainResult[] {
  const {
    minSimilarity = 0.5,
    limit = 15,
    scope,
    minChainLength = 3,
    maxChainLength = 8,
  } = opts;

  const graph = buildFileDepGraph(db, scope);
  const rawChains = generateChains(graph, minChainLength, maxChainLength);

  if (rawChains.length === 0) return [];

  const filteredChains = filterInfrastructureChains(rawChains);

  if (filteredChains.length < 2) return [];

  return dedupeChainResults(
    findSimilarChainPairs(filteredChains, minSimilarity, limit),
    limit,
  );
}

interface FilteredChain {
  original: string[];
  filtered: string[];
}

function filterInfrastructureChains(rawChains: string[][]): FilteredChain[] {
  const infraNodes = infrastructureNodes(rawChains);
  const filteredChains: FilteredChain[] = [];
  for (const chain of rawChains) {
    const filtered = chain.filter((n) => !infraNodes.has(n));
    // Chains with 1-2 unique nodes are often just "query → infra", but the
    // historical threshold is two; keep it stable while making the phases
    // explicit.
    if (filtered.length >= 2) {
      filteredChains.push({ original: chain, filtered });
    }
  }
  return filteredChains;
}

function infrastructureNodes(rawChains: string[][]): Set<string> {
  const { nodeFreq, tailFreq } = chainFrequencyMaps(rawChains);
  const infraThreshold = rawChains.length * 0.9;
  const tailThreshold = rawChains.length * 0.8;
  const infraNodes = new Set<string>();

  for (const [node, freq] of nodeFreq) {
    if (freq > infraThreshold) infraNodes.add(node);
  }
  for (const [node, freq] of tailFreq) {
    if (freq > tailThreshold) infraNodes.add(node);
  }

  // Also treat structural role files as infrastructure — entry points,
  // barrels, and orchestrators are not meaningful pipeline nodes.
  const structuralNames = ['index.ts', 'index.js', 'cli.ts', 'main.ts', 'health.ts', 'health.js'];
  for (const node of nodeFreq.keys()) {
    const basename = node.split('/').pop() ?? '';
    if (structuralNames.includes(basename)) infraNodes.add(node);
  }

  return infraNodes;
}

function chainFrequencyMaps(rawChains: string[][]): {
  nodeFreq: Map<string, number>;
  tailFreq: Map<string, number>;
} {
  const nodeFreq = new Map<string, number>();
  const tailFreq = new Map<string, number>();

  for (const chain of rawChains) {
    const seen = new Set<string>();
    for (const node of chain) {
      if (!seen.has(node)) {
        nodeFreq.set(node, (nodeFreq.get(node) ?? 0) + 1);
        seen.add(node);
      }
    }
    for (let t = Math.max(0, chain.length - 2); t < chain.length; t++) {
      tailFreq.set(chain[t]!, (tailFreq.get(chain[t]!) ?? 0) + 1);
    }
  }

  return { nodeFreq, tailFreq };
}

function findSimilarChainPairs(
  filteredChains: FilteredChain[],
  minSimilarity: number,
  limit: number,
): SimilarChainResult[] {
  const results: SimilarChainResult[] = [];
  for (let i = 0; i < filteredChains.length; i++) {
    for (let j = i + 1; j < filteredChains.length; j++) {
      const result = compareFilteredChains(filteredChains[i]!, filteredChains[j]!, minSimilarity);
      if (result) results.push(result);
    }

    if (results.length > limit * 10) break;
  }

  results.sort((a, b) => {
    if (Math.abs(b.similarity - a.similarity) > 0.01) return b.similarity - a.similarity;
    return a.divergencePoints.length - b.divergencePoints.length;
  });
  return results;
}

function compareFilteredChains(
  a: FilteredChain,
  b: FilteredChain,
  minSimilarity: number,
): SimilarChainResult | null {
  if (!sharesNode(a.filtered, b.filtered)) return null;

  const { distance, ops } = editDistance(a.filtered, b.filtered);
  const maxLen = Math.max(a.filtered.length, b.filtered.length);
  if (maxLen === 0) return null;

  const similarity = 1 - distance / maxLen;
  if (similarity < minSimilarity) return null;
  if (distance === 0) return null;

  const divergencePoints = ops
    .filter((op) => op.type === 'substitute')
    .map((op) => ({
      index: op.indexA,
      nodeA: a.filtered[op.indexA]!,
      nodeB: b.filtered[op.indexB]!,
    }));
  if (divergencePoints.length === 0) return null;

  const matchCount = ops.filter((op) => op.type === 'match').length;
  if (matchCount < 2) return null;

  return {
    chainA: a.original,
    chainB: b.original,
    similarity,
    editDistance: distance,
    divergencePoints,
    commonPrefix: getCommonPrefix(a.original, b.original),
    commonSuffix: getCommonSuffix(a.original, b.original),
  };
}

function sharesNode(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  return b.some((node) => setA.has(node));
}

function dedupeChainResults(results: SimilarChainResult[], limit: number): SimilarChainResult[] {
  const deduped: SimilarChainResult[] = [];
  for (const r of results) {
    const isDuplicate = deduped.some(
      (existing) =>
        isSubChain(r.chainA, existing.chainA) && isSubChain(r.chainB, existing.chainB),
    );
    if (!isDuplicate) deduped.push(r);
    if (deduped.length >= limit) break;
  }

  return deduped;
}

// ── Chain generation ───────────────────────────────────────

function generateChains(
  graph: Map<string, Set<string>>,
  minLen: number,
  maxLen: number,
): string[][] {
  const chains: string[][] = [];
  const maxChains = 500;

  for (const startNode of graph.keys()) {
    if (chains.length >= maxChains) break;
    dfsChains(graph, startNode, [startNode], new Set([startNode]), minLen, maxLen, chains, maxChains);
  }

  return chains;
}

function dfsChains(
  graph: Map<string, Set<string>>,
  node: string,
  path: string[],
  visited: Set<string>,
  minLen: number,
  maxLen: number,
  results: string[][],
  maxResults: number,
): void {
  if (results.length >= maxResults) return;
  if (path.length >= maxLen) {
    if (path.length >= minLen) results.push([...path]);
    return;
  }

  const neighbors = graph.get(node);
  if (!neighbors || neighbors.size === 0) {
    if (path.length >= minLen) results.push([...path]);
    return;
  }

  let extended = false;
  for (const next of neighbors) {
    if (visited.has(next)) continue;
    visited.add(next);
    path.push(next);
    dfsChains(graph, next, path, visited, minLen, maxLen, results, maxResults);
    path.pop();
    visited.delete(next);
    extended = true;
    if (results.length >= maxResults) return;
  }

  if (!extended && path.length >= minLen) {
    results.push([...path]);
  }
}

// ── Edit distance ──────────────────────────────────────────

interface EditOp {
  type: 'match' | 'substitute' | 'insert' | 'delete';
  indexA: number;
  indexB: number;
}

function editDistance(a: string[], b: string[]): { distance: number; ops: EditOp[] } {
  const m = a.length;
  const n = b.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      } else {
        dp[i]![j] = 1 + Math.min(
          dp[i - 1]![j]!,
          dp[i]![j - 1]!,
          dp[i - 1]![j - 1]!,
        );
      }
    }
  }

  const ops: EditOp[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ type: 'match', indexA: i - 1, indexB: j - 1 });
      i--; j--;
    } else if (i > 0 && j > 0 && dp[i]![j] === dp[i - 1]![j - 1]! + 1) {
      ops.unshift({ type: 'substitute', indexA: i - 1, indexB: j - 1 });
      i--; j--;
    } else if (j > 0 && dp[i]![j] === dp[i]![j - 1]! + 1) {
      ops.unshift({ type: 'insert', indexA: i, indexB: j - 1 });
      j--;
    } else {
      ops.unshift({ type: 'delete', indexA: i - 1, indexB: j });
      i--;
    }
  }

  return { distance: dp[m]![n]!, ops };
}

// ── Utility ────────────────────────────────────────────────

function getCommonPrefix(a: string[], b: string[]): string[] {
  const prefix: string[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) prefix.push(a[i]!);
    else break;
  }
  return prefix;
}

function getCommonSuffix(a: string[], b: string[]): string[] {
  const suffix: string[] = [];
  let ai = a.length - 1;
  let bi = b.length - 1;
  while (ai >= 0 && bi >= 0 && a[ai] === b[bi]) {
    suffix.unshift(a[ai]!);
    ai--; bi--;
  }
  return suffix;
}

function isSubChain(sub: string[], full: string[]): boolean {
  if (sub.length > full.length) return false;
  const fullStr = full.join('→');
  const subStr = sub.join('→');
  return fullStr.includes(subStr);
}
