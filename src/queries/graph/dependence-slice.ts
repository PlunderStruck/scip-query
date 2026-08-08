import type { ScipDatabase } from '../../storage/db.js';
import {
  graphEvidence,
  type GraphEvidenceCoverage,
  type GraphEvidenceEdge,
  type GraphEvidenceTarget,
} from './graph-evidence.js';

export type DependenceSliceDirection = 'backward' | 'forward';

export interface DependenceSliceEdge extends GraphEvidenceEdge {
  traversalDepth: number;
  supporting: boolean;
}

/** Coverage of the partial dependence graph used for this slice. */
export interface DependenceSliceCoverage {
  status: GraphEvidenceCoverage['status'];
  criterionKind: 'symbol-summary' | 'source-location-summary';
  basis: 'partial-system-dependence-graph';
  analysisBasis: 'typescript-cfg-reaching-definitions-plus-system-edges';
  providers: readonly ['typescript-local-dependence', 'bounded-static-value-flow'];
  graph: GraphEvidenceCoverage;
  unsupportedRelations: string[];
}

export interface DependenceSliceResult {
  kind: 'dependence-slice';
  direction: DependenceSliceDirection;
  criterion: string;
  targets: GraphEvidenceTarget[];
  nodeIds: string[];
  edges: DependenceSliceEdge[];
  coverage: DependenceSliceCoverage;
}

const LOCATION_SELECTOR = /:\d+(?:-\d+)?$/u;

/**
 * Compute a directional slice over the currently proved program-dependence
 * projection around one exact symbol or source location.
 *
 * The criterion is a summary root rather than the classic `(program point,
 * variable)` pair. Data-transfer and control-dependence edges carry the slice;
 * ownership, call, and exact runtime edges connect those dependencies across
 * callable boundaries and are marked as supporting edges in the result.
 */
export function dependenceSlice(
  db: ScipDatabase,
  criterion: string,
  options: { direction?: DependenceSliceDirection; maxDepth?: number; maxEdges?: number } = {},
): DependenceSliceResult {
  const direction = options.direction ?? 'backward';
  const maxDepth = options.maxDepth ?? 3;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError(`Dependence-slice depth must be a non-negative safe integer; received ${maxDepth}.`);
  }
  const locationCriterion = LOCATION_SELECTOR.test(criterion);
  const graph = graphEvidence(db, locationCriterion ? { locations: [criterion] } : { symbols: [criterion] }, {
    families: ['execution', 'runtime', 'dataflow', 'ownership'],
    maxDepth: maxDepth + 1,
    maxEdges: options.maxEdges ?? 200,
  });
  const rootIds = new Set(graph.targets.flatMap((target) => target.nodeIds));
  const visited = new Set(rootIds);
  const edgeDepth = new Map<string, number>();

  expandOwnedNodes(graph.edges, visited, edgeDepth, 0);
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const reached: string[] = [];
    for (const edge of graph.edges) {
      if (direction === 'backward' ? visited.has(edge.to.id) : visited.has(edge.from.id)) {
        const next = direction === 'backward' ? edge.from.id : edge.to.id;
        if (visited.has(next)) continue;
        reached.push(next);
        edgeDepth.set(edge.id, depth);
      }
    }
    if (reached.length === 0) break;
    for (const nodeId of reached) visited.add(nodeId);
    expandOwnedNodes(graph.edges, visited, edgeDepth, depth);
  }

  const edges = graph.edges
    .filter((edge) => visited.has(edge.from.id) && visited.has(edge.to.id))
    .filter((edge) => edgeDepth.has(edge.id) || edge.family === 'ownership')
    .map((edge) => ({
      ...edge,
      traversalDepth: edgeDepth.get(edge.id) ?? 0,
      supporting: edge.family !== 'dataflow' && !isControlDependence(edge),
    }))
    .sort(
      (left, right) =>
        left.traversalDepth - right.traversalDepth ||
        left.family.localeCompare(right.family) ||
        left.from.label.localeCompare(right.from.label) ||
        left.to.label.localeCompare(right.to.label),
    );

  return {
    kind: 'dependence-slice',
    direction,
    criterion,
    targets: graph.targets,
    nodeIds: [...visited].sort(),
    edges,
    coverage: {
      status: graph.coverage.status,
      criterionKind: locationCriterion ? 'source-location-summary' : 'symbol-summary',
      basis: 'partial-system-dependence-graph',
      analysisBasis: 'typescript-cfg-reaching-definitions-plus-system-edges',
      providers: ['typescript-local-dependence', 'bounded-static-value-flow'],
      graph: graph.coverage,
      unsupportedRelations: [
        'general heap alias and cross-instance field points-to flow',
        'exceptional control and value flow',
        'closure invocation order',
        'downstream local definition-use after a call result',
        'unresolved dynamic dispatch',
      ],
    },
  };
}

function expandOwnedNodes(
  edges: readonly GraphEvidenceEdge[],
  visited: Set<string>,
  edgeDepth: Map<string, number>,
  depth: number,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (edge.family !== 'ownership' || !visited.has(edge.from.id) || visited.has(edge.to.id)) continue;
      visited.add(edge.to.id);
      edgeDepth.set(edge.id, depth);
      changed = true;
    }
  }
}

function isControlDependence(edge: GraphEvidenceEdge): boolean {
  return edge.semanticFamily === 'control' && edge.sourceKind === 'control-dependence';
}
