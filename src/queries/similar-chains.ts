import type { ScipDatabase } from '../db.js';
import { buildFileDepGraph } from '../query-support.js';
import type { SimilarChainResult } from '../types.js';

/**
 * Find end-to-end dependency chains that are structurally similar
 * but diverge at a few points.
 *
 * Two chains like:
 *   A → B → C → D → E
 *   A → B → X → D → E
 *
 * Have high structural similarity (80%) with one divergence point (C vs X).
 * That divergence point is exactly where you'd extract a common abstraction.
 *
 * Uses edit distance (Levenshtein on file-node sequences) to find
 * chains that are "almost the same" — the substitution points are
 * the consolidation targets.
 */
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

  // Build file dependency graph
  const graph = buildFileDepGraph(db, scope);

  // Generate chains via DFS (bounded length)
  const chains = generateChains(graph, minChainLength, maxChainLength);

  // Pairwise chain comparison using edit distance
  const results: SimilarChainResult[] = [];

  for (let i = 0; i < chains.length; i++) {
    for (let j = i + 1; j < chains.length; j++) {
      const a = chains[i]!;
      const b = chains[j]!;

      // Quick reject: if chains share no nodes, skip
      const nodeSetA = new Set(a);
      let sharedCount = 0;
      for (const node of b) {
        if (nodeSetA.has(node)) sharedCount++;
      }
      if (sharedCount === 0) continue;

      // Compute edit distance and similarity
      const { distance, ops } = editDistance(a, b);
      const maxLen = Math.max(a.length, b.length);
      const similarity = 1 - distance / maxLen;

      if (similarity < minSimilarity) continue;
      // Skip if identical
      if (distance === 0) continue;

      // Extract divergence points (substitution operations)
      const divergencePoints = ops
        .filter((op) => op.type === 'substitute')
        .map((op) => ({
          index: op.indexA,
          nodeA: a[op.indexA]!,
          nodeB: b[op.indexB]!,
        }));

      // If no divergence points (only inserts/deletes), less interesting
      if (divergencePoints.length === 0) continue;

      // Find common prefix and suffix
      const commonPrefix = getCommonPrefix(a, b);
      const commonSuffix = getCommonSuffix(a, b);

      results.push({
        chainA: a,
        chainB: b,
        similarity,
        editDistance: distance,
        divergencePoints,
        commonPrefix,
        commonSuffix,
      });
    }

    // Early termination
    if (results.length > limit * 10) break;
  }

  // Sort by: highest similarity first, then fewest divergence points
  results.sort((a, b) => {
    if (Math.abs(b.similarity - a.similarity) > 0.01) return b.similarity - a.similarity;
    return a.divergencePoints.length - b.divergencePoints.length;
  });

  // Deduplicate: skip chains that are sub-chains of already-reported ones
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
  const maxChains = 500; // cap to avoid combinatorial explosion

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

  // DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      } else {
        dp[i]![j] = 1 + Math.min(
          dp[i - 1]![j]!,     // delete
          dp[i]![j - 1]!,     // insert
          dp[i - 1]![j - 1]!, // substitute
        );
      }
    }
  }

  // Backtrace to get operations
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
