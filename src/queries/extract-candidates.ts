import type { ScipDatabase } from '../db.js';
import { getCalleeRowsForSymbol } from '../query-support.js';
import type { ExtractCandidate } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find functions with natural extraction seams.
 *
 * A large function that references two distinct groups of symbols —
 * where group A's symbols are never co-referenced with group B's —
 * has a natural extraction boundary. The isolated cluster can likely
 * be pulled into its own function.
 *
 * We detect this by:
 * 1. Finding all callees of a function
 * 2. Building a co-occurrence graph (which callees appear in the same chunk)
 * 3. Finding connected components — disconnected components = extraction seams
 * 4. Scoring each cluster by how isolated it is from the rest
 */
export function extractCandidates(
  db: ScipDatabase,
  opts: { scope?: string; minLoc?: number; minCallees?: number; limit?: number } = {},
): ExtractCandidate[] {
  const { scope, minLoc = 10, minCallees = 6, limit = 20 } = opts;
  const scopeFilter = scope ? `AND d.relative_path LIKE '%${scope}%'` : '';

  // Find functions large enough to consider
  const symbols = db.all<{
    id: number;
    symbol: string;
    document_id: number;
    start_line: number;
    end_line: number;
    relative_path: string;
  }>(
    `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.end_line, d.relative_path
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE 1 = 1
      ${db.pathExclusionsFor('d')}
      ${db.symbolNoiseFor('gs')}
      AND (der.end_line - der.start_line + 1) >= ?
      ${scopeFilter}
    ORDER BY (der.end_line - der.start_line + 1) DESC`,
    minLoc,
  );

  const results: ExtractCandidate[] = [];

  for (const sym of symbols) {
    if (db.isIgnored(sym.relative_path)) continue;

    // Skip pure type files — "callees" in a type file are just type references,
    // not function calls. Splitting type files is a cosmetic choice, not an
    // extraction opportunity.
    const basename = sym.relative_path.split('/').pop() ?? '';
    if (basename.includes('types')) continue;

    // Get callees with their chunk locations (to build co-occurrence)
    const calleeChunks = getCalleeRowsForSymbol(db, {
      documentId: sym.document_id,
      startLine: sym.start_line,
      endLine: sym.end_line,
      symbolId: sym.id,
    });

    // Collect unique callees
    const calleeSet = new Set(calleeChunks.map((c) => c.symbol));
    if (calleeSet.size < minCallees) continue;

    // Build co-occurrence graph: two callees are connected if they
    // appear in the same chunk (meaning they're used in proximity)
    const cooccurrence = new Map<string, Set<string>>();
    for (const callee of calleeSet) {
      cooccurrence.set(callee, new Set());
    }

    // Group by chunk
    const chunkToCallees = new Map<number, Set<string>>();
    for (const cc of calleeChunks) {
      if (!chunkToCallees.has(cc.chunkId)) chunkToCallees.set(cc.chunkId, new Set());
      chunkToCallees.get(cc.chunkId)!.add(cc.symbol);
    }

    // Callees in the same chunk are co-occurring
    for (const callees of chunkToCallees.values()) {
      const arr = [...callees];
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          cooccurrence.get(arr[i]!)!.add(arr[j]!);
          cooccurrence.get(arr[j]!)!.add(arr[i]!);
        }
      }
    }

    // Find connected components via BFS
    const visited = new Set<string>();
    const clusters: Set<string>[] = [];

    for (const callee of calleeSet) {
      if (visited.has(callee)) continue;
      const cluster = new Set<string>();
      const queue = [callee];
      while (queue.length > 0) {
        const current = queue.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        cluster.add(current);
        for (const neighbor of cooccurrence.get(current) ?? []) {
          if (!visited.has(neighbor)) queue.push(neighbor);
        }
      }
      clusters.push(cluster);
    }

    // Only interesting if there are multiple clusters (= extraction seams exist)
    if (clusters.length < 2) continue;

    // Score each cluster by isolation:
    // isolation = 1 - (edges to other clusters / total possible edges to other clusters)
    const scoredClusters = clusters
      .filter((c) => c.size >= 2) // single-callee clusters aren't interesting
      .map((cluster) => {
        const otherCallees = new Set<string>();
        for (const c of clusters) {
          if (c !== cluster) {
            for (const s of c) otherCallees.add(s);
          }
        }

        // Count cross-cluster edges
        let crossEdges = 0;
        for (const callee of cluster) {
          for (const neighbor of cooccurrence.get(callee) ?? []) {
            if (otherCallees.has(neighbor)) crossEdges++;
          }
        }

        const maxCrossEdges = cluster.size * otherCallees.size;
        const isolation = maxCrossEdges > 0 ? 1 - crossEdges / maxCrossEdges : 1;

        return {
          callees: [...cluster].map(shortenSymbol),
          isolation,
        };
      })
      .filter((c) => c.isolation > 0.5) // Only report well-isolated clusters
      .sort((a, b) => b.isolation - a.isolation);

    if (scoredClusters.length > 0) {
      results.push({
        symbol: sym.symbol,
        shortName: shortenSymbol(sym.symbol),
        relativePath: sym.relative_path,
        startLine: sym.start_line,
        endLine: sym.end_line,
        loc: sym.end_line - sym.start_line + 1,
        totalCallees: calleeSet.size,
        clusters: scoredClusters,
      });
    }
  }

  results.sort((a, b) => b.clusters.length - a.clusters.length || b.loc - a.loc);
  return results.slice(0, limit);
}
