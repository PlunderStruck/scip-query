import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../internal/project-index.js';
import { runCandidateAnalysis } from '../internal/candidate-scan.js';
import { definitionLoc } from '../query-utils.js';

export type ExtractCandidateKind = 'workflow-orchestration' | 'broad-helper-cluster' | 'cohesive-helper-cluster';
export type ExtractCandidateActionTier = 'signal';

export interface ExtractCandidate {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  loc: number;
  /** Total callees */
  totalCallees: number;
  /** Reviewer-facing shape of the extraction signal. */
  extractionKind: ExtractCandidateKind;
  /** Extraction candidates are contextual signals, not direct repair mandates. */
  actionTier: ExtractCandidateActionTier;
  evidenceReasons: string[];
  recommendation: string;
  /** Distinct clusters of callees (natural extraction seams) */
  clusters: Array<{
    callees: string[];
    /** How isolated this cluster is from the rest (0-1, higher = more extractable) */
    isolation: number;
  }>;
}

interface CalleeChunk {
  symbol: string;
  chunkId: number;
}

interface ScoredCluster {
  callees: string[];
  isolation: number;
}

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
// scip-query: ignore-extract — this is the public extraction-candidate
// detector pipeline: callable selection, callee-map loading, per-symbol
// scoring, and aggregate summary are one command contract.
export function extractCandidates(
  db: ScipDatabase,
  opts: {
    scope?: string;
    minLoc?: number;
    minCallees?: number;
    limit?: number;
    scanLimit?: number;
    semantic?: boolean;
  } = {},
): ExtractCandidate[] {
  const { scope, minLoc = 10, minCallees = 6, limit = 20, scanLimit } = opts;
  const index = new ProjectIndex(db);
  return runCandidateAnalysis({
    candidates: () =>
      index.productionCallableDefinitions({
        scope,
        minLoc,
        excludeTypesFiles: true,
        requireFunctionLikeSymbol: true,
        sortByLocDesc: true,
      }),
    scanLimit,
    profile: { name: 'extract-candidates' },
    prepare: (symbols) => index.calleeMap(symbols, { semantic: opts.semantic !== false }),
    evaluate: (sym, calleeMap) => extractionCandidateForSymbol(sym, calleeMap.get(sym.symbolId) ?? [], minCallees),
    orderResults: (a, b) => b.clusters.length - a.clusters.length || b.loc - a.loc,
    limit,
  });
}

// scip-query: ignore-extract — this is the detector's own per-symbol scoring
// unit; co-occurrence graph construction, connected clusters, and LOC scoring
// are the definition of an extraction candidate.
function extractionCandidateForSymbol(
  definition: IndexedDefinition,
  calleeChunks: readonly CalleeChunk[],
  minCallees: number,
): ExtractCandidate | null {
  const calleeSet = new Set(calleeChunks.map((callee) => callee.symbol));
  if (calleeSet.size < minCallees) return null;

  const cooccurrence = buildCooccurrenceGraph(calleeSet, calleeChunks);
  const clusters = connectedCalleeClusters(calleeSet, cooccurrence);

  // Only interesting if there are multiple clusters (= extraction seams exist).
  if (clusters.length < 2) return null;

  const scoredClusters = scoreExtractionClusters(clusters, cooccurrence);
  if (scoredClusters.length === 0) return null;

  const shortName = shortenSymbol(definition.symbol);
  const classification = classifyExtractionCandidate(shortName, calleeSet.size, clusters.length, scoredClusters);

  return {
    symbol: definition.symbol,
    shortName,
    relativePath: definition.relativePath,
    startLine: definition.startLine,
    endLine: definition.endLine,
    loc: definitionLoc(definition),
    totalCallees: calleeSet.size,
    extractionKind: classification.extractionKind,
    actionTier: 'signal',
    evidenceReasons: classification.evidenceReasons,
    recommendation: classification.recommendation,
    clusters: scoredClusters,
  };
}

function classifyExtractionCandidate(
  shortName: string,
  totalCallees: number,
  detectedClusterCount: number,
  scoredClusters: readonly ScoredCluster[],
): {
  extractionKind: ExtractCandidateKind;
  evidenceReasons: string[];
  recommendation: string;
} {
  const largestClusterSize = Math.max(...scoredClusters.map((cluster) => cluster.callees.length));
  const bestIsolation = Math.max(...scoredClusters.map((cluster) => cluster.isolation));
  const reasons = [
    `${totalCallees} distinct callees across ${detectedClusterCount} co-occurrence cluster(s)`,
    `${scoredClusters.length} extractable cluster(s) passed size and isolation thresholds`,
    `largest extractable cluster has ${largestClusterSize} callees at ${Math.round(bestIsolation * 100)}% isolation`,
  ];

  const orchestrationReason = workflowOrchestrationReason(shortName, totalCallees, detectedClusterCount);
  if (orchestrationReason !== null) {
    return {
      extractionKind: 'workflow-orchestration',
      evidenceReasons: [...reasons, orchestrationReason],
      recommendation:
        'Review the isolated helper group as a possible private or feature-local helper, but keep the orchestration sequence together when it preserves the workflow.',
    };
  }

  if (largestClusterSize >= 6) {
    return {
      extractionKind: 'broad-helper-cluster',
      evidenceReasons: [...reasons, 'one isolated helper group is broad enough to deserve a named review'],
      recommendation:
        'Review whether the broad helper cluster has a stable concept name before extracting it; avoid creating a bag-of-helpers abstraction.',
    };
  }

  return {
    extractionKind: 'cohesive-helper-cluster',
    evidenceReasons: reasons,
    recommendation:
      'Review the isolated callee group as a possible same-file or feature-local helper; extract only if the new name preserves the current behavior.',
  };
}

function workflowOrchestrationReason(
  shortName: string,
  totalCallees: number,
  detectedClusterCount: number,
): string | null {
  if (totalCallees >= 10) return `callee breadth suggests orchestration: ${totalCallees} callees`;
  if (detectedClusterCount >= 4) {
    return `multiple disconnected callee groups suggest orchestration: ${detectedClusterCount} groups`;
  }
  const leaf = callableLeaf(shortName);
  if (ORCHESTRATION_VERBS.has(leaf)) return `caller verb suggests orchestration: ${leaf}`;
  return null;
}

function callableLeaf(shortName: string): string {
  return (
    shortName
      .split(':')
      .pop()
      ?.replace(/\(\)$/, '')
      .replace(/[^A-Za-z0-9_]/g, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[_\s-]+/)
      .filter(Boolean)[0]
      ?.toLowerCase() ?? ''
  );
}

const ORCHESTRATION_VERBS = new Set([
  'apply',
  'build',
  'check',
  'collect',
  'create',
  'diff',
  'execute',
  'find',
  'handle',
  'load',
  'prepare',
  'process',
  'render',
  'resolve',
  'run',
  'select',
  'sync',
  'update',
  'validate',
  'verify',
  'write',
]);

function buildCooccurrenceGraph(
  calleeSet: ReadonlySet<string>,
  calleeChunks: readonly CalleeChunk[],
): Map<string, Set<string>> {
  // Two callees are connected if they appear in the same chunk, meaning they
  // are used in proximity.
  const cooccurrence = new Map<string, Set<string>>();
  for (const callee of calleeSet) {
    cooccurrence.set(callee, new Set());
  }

  const chunkToCallees = new Map<number, Set<string>>();
  for (const callee of calleeChunks) {
    let bucket = chunkToCallees.get(callee.chunkId);
    if (!bucket) {
      bucket = new Set();
      chunkToCallees.set(callee.chunkId, bucket);
    }
    bucket.add(callee.symbol);
  }

  for (const callees of chunkToCallees.values()) {
    const arr = [...callees];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        cooccurrence.get(arr[i]!)!.add(arr[j]!);
        cooccurrence.get(arr[j]!)!.add(arr[i]!);
      }
    }
  }
  return cooccurrence;
}

function connectedCalleeClusters(
  calleeSet: ReadonlySet<string>,
  cooccurrence: Map<string, Set<string>>,
): Set<string>[] {
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
  return clusters;
}

function scoreExtractionClusters(
  clusters: readonly Set<string>[],
  cooccurrence: Map<string, Set<string>>,
): ScoredCluster[] {
  // isolation = 1 - (edges to other clusters / total possible edges to other clusters)
  return clusters
    .filter((cluster) => cluster.size >= 3)
    .map((cluster) => scoreExtractionCluster(cluster, clusters, cooccurrence))
    .filter((cluster) => cluster.isolation > 0.5)
    .sort((a, b) => b.isolation - a.isolation);
}

function scoreExtractionCluster(
  cluster: Set<string>,
  clusters: readonly Set<string>[],
  cooccurrence: Map<string, Set<string>>,
): ScoredCluster {
  const otherCallees = new Set<string>();
  for (const otherCluster of clusters) {
    if (otherCluster === cluster) continue;
    for (const symbol of otherCluster) otherCallees.add(symbol);
  }

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
}
