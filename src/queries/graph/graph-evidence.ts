import { createHash } from 'node:crypto';
import type { ScipDatabase } from '../../storage/db.js';
import { graphRelationProviderFor, graphRelationUnavailableBlindSpots } from '../../domain/graph-relation-providers.js';
import {
  GRAPH_EVIDENCE_FAMILIES,
  type GraphEvidenceFamily,
  type GraphProjectionDirection,
} from '../../domain/graph-exploration-contract.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import type {
  ExplorationEvidenceStrength,
  ExplorationSourceLocation,
  ExplorationTopologyEdge,
  ExplorationTopologyNode,
  ProgramEdgeSemantic,
} from '../internal/exploration-topology.js';
import { systemMapTopology } from './system-map.js';

export { GRAPH_EVIDENCE_FAMILIES } from '../../domain/graph-exploration-contract.js';
export type { GraphEvidenceFamily, GraphProjectionDirection } from '../../domain/graph-exploration-contract.js';

export const GRAPH_EVIDENCE_VIEWS = ['causal', 'structure', 'complete'] as const;

export type GraphEvidenceView = (typeof GRAPH_EVIDENCE_VIEWS)[number];

export interface GraphEvidenceSelectors {
  symbols?: readonly string[];
  locations?: readonly string[];
  searches?: readonly string[];
}

export interface GraphEvidenceOptions {
  view?: GraphEvidenceView;
  families?: readonly GraphEvidenceFamily[];
  direction?: GraphProjectionDirection;
  subtypes?: readonly string[];
  connecting?: boolean;
  inventoryOnly?: boolean;
  /** Materialize the exact membership of recoverable folds from the same projection. */
  foldIds?: readonly string[];
  maxDepth?: number;
  maxEdges?: number;
}

export interface GraphEvidenceSelection {
  direction: GraphProjectionDirection;
  subtypes: string[];
  connecting: boolean;
  inventoryOnly: boolean;
  foldIds: string[];
}

export interface GraphEvidenceInventoryRow {
  family: GraphEvidenceFamily;
  subtype: string;
  incoming: number;
  outgoing: number;
  both: number;
}

export interface GraphEvidenceFold {
  id: string;
  mode: 'linear' | 'scc' | 'topology';
  family: GraphEvidenceFamily;
  /** One subtype name, or `mixed` when this structural fold contains several. */
  subtype: string;
  /** Complete subtype inventory for the folded relationships. */
  subtypes?: string[];
  /** Query-neutral structural region shared by the folded relationships. */
  region?: string;
  edgeCount: number;
  edgeIds: string[];
  nodeIds: string[];
  minimumMaxEdges: number;
}

export interface GraphEvidenceTarget {
  kind: string;
  query: string;
  status: 'matched' | 'ambiguous' | 'missing';
  nodeIds: string[];
  omittedCandidates: number;
}

export interface GraphEvidenceNode {
  id: string;
  kind: string;
  label: string;
  symbol: string | null;
  location: ExplorationSourceLocation | null;
}

export interface GraphEvidenceEdge {
  id: string;
  family: GraphEvidenceFamily;
  /** Original typed-program semantic family before presentation grouping. */
  semanticFamily: ProgramEdgeSemantic['family'];
  subtype: string;
  from: GraphEvidenceNode;
  to: GraphEvidenceNode;
  sourceKind: string;
  providerId: string;
  supportCeiling: 'exact' | 'partial' | 'candidate';
  establishes: string;
  nonClaims: readonly string[];
  recoverWith: readonly string[];
  evidenceStrength: ExplorationEvidenceStrength;
  evidenceMethods: string[];
  evidenceConstituents?: Array<{ method: string; strength: ExplorationEvidenceStrength }>;
  context: ProgramEdgeSemantic['context'] | null;
  attributes: ProgramEdgeSemantic['attributes'] | null;
}

export interface GraphEvidenceCoverage {
  status: 'accounted' | 'bounded' | 'incomplete';
  topologyStatus: 'accounted' | 'incomplete';
  scope: string;
  maxDepth: number;
  maxEdges: number;
  /** Present for projection-aware callers; omitted by results produced before projection metadata existed. */
  matchedEdges?: number;
  eligibleEdges: number;
  returnedEdges: number;
  omittedEdges: number;
  frontierGroups: number;
  unsupportedFrontiers: number;
  blindSpots: string[];
  explanation: string;
}

export interface GraphEvidenceResult {
  kind: 'graph';
  view: GraphEvidenceView | 'custom';
  families: GraphEvidenceFamily[];
  /** Explicit projection applied by the current implementation. */
  selection?: GraphEvidenceSelection;
  targets: GraphEvidenceTarget[];
  /** Complete relationship counts before materialization budgeting. */
  inventory?: GraphEvidenceInventoryRow[];
  edges: GraphEvidenceEdge[];
  /** Recoverable membership for relationships withheld by the materialization budget. */
  folds?: GraphEvidenceFold[];
  coverage: GraphEvidenceCoverage;
}

const VIEW_FAMILIES: Record<GraphEvidenceView, readonly GraphEvidenceFamily[]> = {
  causal: ['execution', 'runtime', 'dataflow', 'state', 'temporal'],
  structure: ['contract', 'identity', 'ownership', 'dependencies'],
  complete: GRAPH_EVIDENCE_FAMILIES,
};

const DEFAULT_DEPTH = 2;
const DEFAULT_MAX_EDGES = 48;
const MAX_EDGES_PER_RECOVERABLE_FOLD = 64;
// The internal topology is deliberately wider than the rendered packet. The
// renderer applies its own edge budget after coverage-diverse selection; using
// a small system-map presentation budget here would silently starve later edge
// families before they reach that selector.
const TOPOLOGY_CHARACTER_BUDGET = 50_000;

/**
 * Compose the existing system-map topology into one small, agent-selected
 * relationship packet. This function performs no task-relevance inference.
 */
export function graphEvidence(
  db: ScipDatabase,
  selectors: GraphEvidenceSelectors,
  options: GraphEvidenceOptions = {},
): GraphEvidenceResult {
  const symbols = uniqueNonEmpty([...(selectors.symbols ?? []), ...(selectors.locations ?? [])]);
  const searches = uniqueNonEmpty(selectors.searches ?? []);
  if (symbols.length === 0 && searches.length === 0) {
    throw new Error('evidence requires at least one positional symbol, --symbol, --at, or --search selector.');
  }

  const view = options.view ?? 'causal';
  const families = normalizeFamilies(options.families, view);
  const direction = options.direction ?? 'both';
  const subtypes = uniqueNonEmpty(options.subtypes ?? []);
  const connecting = options.connecting ?? false;
  const inventoryOnly = options.inventoryOnly ?? false;
  const foldIds = uniqueNonEmpty(options.foldIds ?? []);
  const maxDepth = options.maxDepth ?? DEFAULT_DEPTH;
  const maxEdges = options.maxEdges ?? DEFAULT_MAX_EDGES;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError(`Evidence depth must be a non-negative safe integer; received ${maxDepth}.`);
  }
  if (!Number.isSafeInteger(maxEdges) || maxEdges <= 0) {
    throw new RangeError(`Evidence max edges must be a positive safe integer; received ${maxEdges}.`);
  }
  if (!['incoming', 'outgoing', 'both'].includes(direction)) {
    throw new Error(`Unsupported graph evidence direction: ${direction}.`);
  }
  if (inventoryOnly && foldIds.length > 0) {
    throw new Error('Evidence fold materialization cannot be combined with --inventory-only.');
  }

  const topology = systemMapTopology(db, {
    symbols,
    searches,
    maxDepth,
    maxTopologyCharacters: TOPOLOGY_CHARACTER_BUDGET,
    relations: relationKindsFor(families),
  });
  const nodes = new Map(topology.nodes.map((node) => [node.id, node]));
  const allProjected = topology.edges
    .filter((edge) => edge.disposition === 'emitted' || edge.disposition === 'folded')
    .flatMap((edge) => graphEdgesFor(edge, nodes));
  const projected = allProjected
    .filter((edge) => families.includes(edge.family))
    .filter((edge) => subtypes.length === 0 || subtypes.includes(edge.subtype));
  const targetNodeIds = new Set(topology.anchors.flatMap((anchor) => anchor.nodeIds));
  if (connecting && targetNodeIds.size < 2) {
    throw new Error('Connecting evidence requires at least two resolved root nodes.');
  }
  const selectedIds = new Set(projected.map((edge) => edge.id));
  const incoming = reachableGraphEdges(allProjected, targetNodeIds, 'incoming').filter((edge) =>
    selectedIds.has(edge.id),
  );
  const outgoing = reachableGraphEdges(allProjected, targetNodeIds, 'outgoing').filter((edge) =>
    selectedIds.has(edge.id),
  );
  const both = reachableGraphEdges(allProjected, targetNodeIds, 'both').filter((edge) => selectedIds.has(edge.id));
  const inventory = graphEvidenceInventory(families, subtypes, incoming, outgoing, both);
  const directed = direction === 'incoming' ? incoming : direction === 'outgoing' ? outgoing : both;
  const connected = connecting ? connectingGraphEdges(directed, [...targetNodeIds], direction) : directed;
  const distances = graphDistances(connected, targetNodeIds, direction);
  const matched = [...connected].sort((left, right) => compareGraphEdges(left, right, distances));
  const recoverableFolds = graphEvidenceFolds(matched, maxEdges);
  const requestedFoldEdgeIds = selectedFoldEdgeIds(recoverableFolds, foldIds);
  const eligible = inventoryOnly
    ? []
    : foldIds.length > 0
      ? matched.filter((edge) => requestedFoldEdgeIds.has(edge.id))
      : matched;
  const edges = foldIds.length > 0 ? eligible : eligible.slice(0, maxEdges);
  const folds = foldIds.length > 0 || inventoryOnly ? [] : recoverableFolds;
  const omittedEdges = Math.max(0, eligible.length - edges.length);
  const unsupportedFrontiers = topology.frontiers.filter((frontier) => frontier.disposition === 'unsupported').length;
  const status = topology.coverage.status === 'incomplete' ? 'incomplete' : omittedEdges > 0 ? 'bounded' : 'accounted';

  return {
    kind: 'graph',
    view: options.families && options.families.length > 0 ? 'custom' : view,
    families,
    selection: { direction, subtypes, connecting, inventoryOnly, foldIds },
    targets: topology.anchors.map((anchor) => ({
      kind: anchor.kind,
      query: anchor.query,
      status: anchor.status,
      nodeIds: [...anchor.nodeIds],
      omittedCandidates: anchor.omittedCandidates,
    })),
    inventory,
    edges,
    folds,
    coverage: {
      status,
      topologyStatus: topology.coverage.status,
      scope: topology.coverage.scope,
      maxDepth,
      maxEdges,
      matchedEdges: matched.length,
      eligibleEdges: eligible.length,
      returnedEdges: edges.length,
      omittedEdges,
      frontierGroups: topology.frontiers.length,
      unsupportedFrontiers,
      blindSpots: uniqueNonEmpty([...topology.coverage.blindSpots, ...graphRelationUnavailableBlindSpots(families)]),
      explanation: inventoryOnly
        ? `${matched.length} relationship(s) match the explicit projection; only exact inventory counts were requested.`
        : foldIds.length > 0
          ? `Every relationship in ${foldIds.length} explicitly selected recoverable fold(s) was emitted.`
          : status === 'accounted'
            ? 'Every selected relationship in the bounded topology was emitted.'
            : status === 'bounded'
              ? `${omittedEdges} selected relationship(s) were withheld by the explicit edge budget.`
              : topology.coverage.explanation,
    },
  };
}

function normalizeFamilies(
  families: readonly GraphEvidenceFamily[] | undefined,
  view: GraphEvidenceView,
): GraphEvidenceFamily[] {
  const selected = families && families.length > 0 ? families : VIEW_FAMILIES[view];
  const invalid = selected.filter((family) => !GRAPH_EVIDENCE_FAMILIES.includes(family));
  if (invalid.length > 0) throw new Error(`Unsupported graph evidence family: ${invalid.join(', ')}.`);
  return uniqueNonEmpty(selected);
}

function relationKindsFor(families: readonly GraphEvidenceFamily[]) {
  void families;
  // State, temporal, and ownership projections can be attached to source or
  // runtime observations reached through a different structural relation. Keep
  // topology construction complete, then filter only the rendered semantics.
  return ['call', 'contract-symbol', 'import', 'reference', 'runtime-boundary'] as const;
}

function graphEdgesFor(
  edge: ExplorationTopologyEdge,
  nodes: ReadonlyMap<string, ExplorationTopologyNode>,
): GraphEvidenceEdge[] {
  const from = nodes.get(edge.fromNodeId);
  const to = nodes.get(edge.toNodeId);
  if (!from || !to) return [];
  return (edge.semantics ?? []).flatMap((semantic, index) => {
    const family = graphFamilyFor(semantic);
    if (!family) return [];
    const providerContract = graphRelationProviderFor(family, semantic.subtype);
    if (!providerContract) {
      throw new Error(`No graph relation provider contract is registered for ${family}/${semantic.subtype}.`);
    }
    const evidenceStrength = combinedEvidenceStrength(edge);
    if (!providerContract.relation.evidenceStrengths.includes(evidenceStrength)) {
      // Topology construction can attach a lead the selected provider does not
      // claim. Omit it from the projection instead of aborting the command.
      return [];
    }
    return [
      {
        id: `${edge.id}:${index}:${family}`,
        family,
        semanticFamily: semantic.family,
        subtype: semantic.subtype,
        from: graphNode(from),
        to: graphNode(to),
        sourceKind: edge.kind,
        providerId: providerContract.provider.id,
        supportCeiling: providerContract.relation.supportCeiling,
        establishes: providerContract.relation.establishes,
        nonClaims: [...providerContract.relation.nonClaims],
        recoverWith: [...providerContract.relation.recoverWith],
        evidenceStrength,
        evidenceMethods: uniqueNonEmpty(edge.evidence.map((source) => source.method)),
        evidenceConstituents: uniqueEvidenceConstituents(edge.evidence),
        context: semantic.context ? { ...semantic.context } : null,
        attributes: semantic.attributes ? { ...semantic.attributes } : null,
      },
    ];
  });
}

function uniqueEvidenceConstituents(
  evidence: Readonly<ExplorationTopologyEdge['evidence']>,
): Array<{ method: string; strength: ExplorationEvidenceStrength }> {
  const rows = new Map<string, { method: string; strength: ExplorationEvidenceStrength }>();
  for (const source of evidence) rows.set(`${source.method}\0${source.strength}`, source);
  return [...rows.values()].map(({ method, strength }) => ({ method, strength }));
}

function graphFamilyFor(semantic: ProgramEdgeSemantic): GraphEvidenceFamily | null {
  switch (semantic.family) {
    case 'control':
      return semantic.context?.crossesRuntimeBoundary === true || semantic.subtype === 'runtime-handoff'
        ? 'runtime'
        : 'execution';
    case 'data':
      return 'dataflow';
    case 'state':
      return 'state';
    case 'temporal':
      return 'temporal';
    case 'contract':
      return 'contract';
    case 'identity':
      if (semantic.subtype.startsWith('contains') || semantic.subtype.startsWith('owns-')) return 'ownership';
      if (semantic.subtype.startsWith('import')) return 'dependencies';
      return 'identity';
  }
}

function graphNode(node: ExplorationTopologyNode): GraphEvidenceNode {
  const symbol = symbolFromNodeId(node);
  return {
    id: node.id,
    kind: node.kind,
    label: symbol ? shortenSymbol(symbol) : node.label,
    symbol,
    location: node.location ? { ...node.location } : null,
  };
}

function symbolFromNodeId(node: ExplorationTopologyNode): string | null {
  if (node.kind !== 'symbol' || !node.id.startsWith('symbol:')) return null;
  return decodeURIComponent(node.id.slice('symbol:'.length));
}

function combinedEvidenceStrength(edge: ExplorationTopologyEdge): ExplorationEvidenceStrength {
  const strengths = uniqueNonEmpty(edge.evidence.map((source) => source.strength));
  if (strengths.length === 1) return strengths[0]!;
  if (strengths.includes('exact') && strengths.every((strength) => strength === 'exact' || strength === 'derived')) {
    return 'mixed';
  }
  if (strengths.includes('candidate')) return 'candidate';
  if (strengths.includes('unknown') || strengths.length === 0) return 'unknown';
  return 'mixed';
}

function reachableGraphEdges(
  edges: readonly GraphEvidenceEdge[],
  roots: ReadonlySet<string>,
  direction: GraphProjectionDirection,
): GraphEvidenceEdge[] {
  const adjacent = graphAdjacency(edges, direction);
  const selected = new Map<string, GraphEvidenceEdge>();
  const distances = new Map<string, number>();
  const queue = [...roots].sort();
  for (const root of queue) distances.set(root, 0);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const distance = distances.get(current)!;
    for (const step of adjacent.get(current) ?? []) {
      selected.set(step.edge.id, step.edge);
      if (distances.has(step.next)) continue;
      distances.set(step.next, distance + 1);
      queue.push(step.next);
    }
  }
  return [...selected.values()];
}

interface GraphAdjacencyStep {
  edge: GraphEvidenceEdge;
  next: string;
}

function graphAdjacency(
  edges: readonly GraphEvidenceEdge[],
  direction: GraphProjectionDirection,
): ReadonlyMap<string, readonly GraphAdjacencyStep[]> {
  const adjacent = new Map<string, GraphAdjacencyStep[]>();
  const add = (from: string, next: string, edge: GraphEvidenceEdge) => {
    const rows = adjacent.get(from) ?? [];
    rows.push({ edge, next });
    adjacent.set(from, rows);
  };
  for (const edge of edges) {
    if (direction !== 'incoming') add(edge.from.id, edge.to.id, edge);
    if (direction !== 'outgoing') add(edge.to.id, edge.from.id, edge);
  }
  for (const rows of adjacent.values()) {
    rows.sort((left, right) => left.edge.id.localeCompare(right.edge.id) || left.next.localeCompare(right.next));
  }
  return adjacent;
}

function graphEvidenceInventory(
  families: readonly GraphEvidenceFamily[],
  subtypes: readonly string[],
  incoming: readonly GraphEvidenceEdge[],
  outgoing: readonly GraphEvidenceEdge[],
  both: readonly GraphEvidenceEdge[],
): GraphEvidenceInventoryRow[] {
  const keys = new Set<string>();
  for (const edge of [...incoming, ...outgoing, ...both]) keys.add(`${edge.family}\u0000${edge.subtype}`);
  if (subtypes.length > 0) {
    for (const family of families) {
      for (const subtype of subtypes) keys.add(`${family}\u0000${subtype}`);
    }
  }
  const counts = (edges: readonly GraphEvidenceEdge[]) => {
    const result = new Map<string, number>();
    for (const edge of edges) {
      const key = `${edge.family}\u0000${edge.subtype}`;
      result.set(key, (result.get(key) ?? 0) + 1);
    }
    return result;
  };
  const incomingCounts = counts(incoming);
  const outgoingCounts = counts(outgoing);
  const bothCounts = counts(both);
  return [...keys]
    .map((key) => {
      const [family, subtype] = key.split('\u0000') as [GraphEvidenceFamily, string];
      return {
        family,
        subtype,
        incoming: incomingCounts.get(key) ?? 0,
        outgoing: outgoingCounts.get(key) ?? 0,
        both: bothCounts.get(key) ?? 0,
      };
    })
    .sort(
      (left, right) =>
        GRAPH_EVIDENCE_FAMILIES.indexOf(left.family) - GRAPH_EVIDENCE_FAMILIES.indexOf(right.family) ||
        left.subtype.localeCompare(right.subtype),
    );
}

function graphEvidenceFolds(edges: readonly GraphEvidenceEdge[], maxEdges: number): GraphEvidenceFold[] {
  const omitted = edges.slice(maxEdges);
  const byRegion = new Map<string, GraphEvidenceEdge[]>();
  for (const edge of omitted) {
    const region = graphFoldRegion(edge);
    const key = `${edge.family}\u0000${region}`;
    const rows = byRegion.get(key) ?? [];
    rows.push(edge);
    byRegion.set(key, rows);
  }
  const positionById = new Map(edges.map((edge, index) => [edge.id, index + 1]));
  const folds: GraphEvidenceFold[] = [];
  for (const [key, rows] of [...byRegion].sort(([left], [right]) => left.localeCompare(right))) {
    const [family, region] = key.split('\u0000') as [GraphEvidenceFamily, string];
    const ordered = [...rows].sort((left, right) => left.id.localeCompare(right.id));
    for (let offset = 0; offset < ordered.length; offset += MAX_EDGES_PER_RECOVERABLE_FOLD) {
      const chunk = ordered.slice(offset, offset + MAX_EDGES_PER_RECOVERABLE_FOLD);
      const edgeIds = chunk.map((edge) => edge.id);
      const subtypes = uniqueNonEmpty(chunk.map((edge) => edge.subtype)).sort();
      const subtype = subtypes.length === 1 ? subtypes[0]! : 'mixed';
      const sortedNodeIds = [...new Set(chunk.flatMap((edge) => [edge.from.id, edge.to.id]))].sort();
      folds.push({
        id: stableGraphFoldId(family, subtypes.join('\u0000'), edgeIds),
        mode: graphFoldMode(chunk),
        family,
        subtype,
        subtypes,
        region,
        edgeCount: edgeIds.length,
        edgeIds,
        nodeIds: sortedNodeIds,
        minimumMaxEdges: Math.max(...edgeIds.map((id) => positionById.get(id) ?? edges.length)),
      });
    }
  }
  return folds.sort(
    (left, right) =>
      GRAPH_EVIDENCE_FAMILIES.indexOf(left.family) - GRAPH_EVIDENCE_FAMILIES.indexOf(right.family) ||
      (left.region ?? '').localeCompare(right.region ?? '') ||
      left.id.localeCompare(right.id),
  );
}

function graphFoldRegion(edge: GraphEvidenceEdge): string {
  const from = edge.from.location?.file ?? `kind:${edge.from.kind}`;
  const to = edge.to.location?.file ?? `kind:${edge.to.kind}`;
  return from === to ? from : `${from} -> ${to}`;
}

function selectedFoldEdgeIds(
  folds: readonly GraphEvidenceFold[],
  requestedIds: readonly string[],
): ReadonlySet<string> {
  if (requestedIds.length === 0) return new Set();
  const byId = new Map(folds.map((fold) => [fold.id, fold]));
  const unknown = requestedIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    const available = folds.map((fold) => fold.id).sort();
    throw new Error(
      `Unknown evidence fold ${unknown.join(', ')} for this projection. Available folds: ${available.join(', ') || '(none)'}.`,
    );
  }
  return new Set(requestedIds.flatMap((id) => byId.get(id)!.edgeIds));
}

function graphFoldMode(edges: readonly GraphEvidenceEdge[]): GraphEvidenceFold['mode'] {
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.from.id);
    nodes.add(edge.to.id);
    const targets = outgoing.get(edge.from.id) ?? new Set<string>();
    targets.add(edge.to.id);
    outgoing.set(edge.from.id, targets);
    const sources = incoming.get(edge.to.id) ?? new Set<string>();
    sources.add(edge.from.id);
    incoming.set(edge.to.id, sources);
  }
  if (hasDirectedCycle(nodes, outgoing)) return 'scc';
  const isLinear = [...nodes].every(
    (node) => (incoming.get(node)?.size ?? 0) <= 1 && (outgoing.get(node)?.size ?? 0) <= 1,
  );
  return isLinear ? 'linear' : 'topology';
}

function hasDirectedCycle(nodes: ReadonlySet<string>, outgoing: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of outgoing.get(node) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...nodes].some(visit);
}

function stableGraphFoldId(family: GraphEvidenceFamily, subtype: string, edgeIds: readonly string[]): string {
  return `fold:${createHash('sha256')
    .update([family, subtype, ...edgeIds].join('\u0000'))
    .digest('hex')
    .slice(0, 16)}`;
}

function connectingGraphEdges(
  edges: readonly GraphEvidenceEdge[],
  roots: readonly string[],
  direction: GraphProjectionDirection,
): GraphEvidenceEdge[] {
  const selected = new Map<string, GraphEvidenceEdge>();
  const orderedRoots = [...new Set(roots)].sort();
  for (let left = 0; left < orderedRoots.length; left += 1) {
    for (let right = left + 1; right < orderedRoots.length; right += 1) {
      for (const edge of shortestGraphPath(edges, orderedRoots[left]!, orderedRoots[right]!, direction)) {
        selected.set(edge.id, edge);
      }
    }
  }
  return [...selected.values()];
}

function shortestGraphPath(
  edges: readonly GraphEvidenceEdge[],
  from: string,
  to: string,
  direction: GraphProjectionDirection,
): GraphEvidenceEdge[] {
  const adjacent = graphAdjacency(edges, direction);
  const distances = new Map([[from, 0]]);
  const previous = new Map<string, { node: string; edge: GraphEvidenceEdge }>();
  const queue = [from];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const distance = distances.get(current)!;
    if (current === to) continue;
    for (const step of adjacent.get(current) ?? []) {
      if (distances.has(step.next)) continue;
      distances.set(step.next, distance + 1);
      previous.set(step.next, { node: current, edge: step.edge });
      queue.push(step.next);
    }
  }
  if (!distances.has(to)) return [];
  const path: GraphEvidenceEdge[] = [];
  for (let current = to; current !== from; ) {
    const step = previous.get(current);
    if (!step) return [];
    path.push(step.edge);
    current = step.node;
  }
  return path.reverse();
}

function graphDistances(
  edges: readonly GraphEvidenceEdge[],
  roots: ReadonlySet<string>,
  direction: GraphProjectionDirection,
): ReadonlyMap<string, number> {
  const adjacent = graphAdjacency(edges, direction);
  const distances = new Map<string, number>();
  const queue = [...roots];
  for (const root of roots) distances.set(root, 0);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const distance = distances.get(current)!;
    for (const { next } of adjacent.get(current) ?? []) {
      if (distances.has(next)) continue;
      distances.set(next, distance + 1);
      queue.push(next);
    }
  }
  return distances;
}

function compareGraphEdges(
  left: GraphEvidenceEdge,
  right: GraphEvidenceEdge,
  distances: ReadonlyMap<string, number>,
): number {
  return (
    edgeDistance(left, distances) - edgeDistance(right, distances) ||
    structuralPenalty(left) - structuralPenalty(right) ||
    evidenceStrengthRank(left.evidenceStrength) - evidenceStrengthRank(right.evidenceStrength) ||
    GRAPH_EVIDENCE_FAMILIES.indexOf(left.family) - GRAPH_EVIDENCE_FAMILIES.indexOf(right.family) ||
    left.from.label.localeCompare(right.from.label) ||
    left.to.label.localeCompare(right.to.label) ||
    left.subtype.localeCompare(right.subtype) ||
    left.id.localeCompare(right.id)
  );
}

function edgeDistance(edge: GraphEvidenceEdge, distances: ReadonlyMap<string, number>): number {
  return Math.min(
    distances.get(edge.from.id) ?? Number.MAX_SAFE_INTEGER,
    distances.get(edge.to.id) ?? Number.MAX_SAFE_INTEGER,
  );
}

function structuralPenalty(edge: GraphEvidenceEdge): number {
  const structuralEndpoints = [edge.from, edge.to].filter((node) => node.kind === 'structural-region').length;
  return structuralEndpoints === 2 ? 2 : structuralEndpoints;
}

function evidenceStrengthRank(strength: ExplorationEvidenceStrength): number {
  switch (strength) {
    case 'exact':
      return 0;
    case 'mixed':
      return 1;
    case 'derived':
      return 2;
    case 'candidate':
      return 3;
    case 'unknown':
      return 4;
  }
}

function uniqueNonEmpty<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean) as T[])];
}
