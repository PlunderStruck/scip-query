import { createHash } from 'node:crypto';

/**
 * A repository location is a source-backed place that another query can
 * retrieve exactly. A null location means the evidence identifies a
 * repository relationship but the installed index does not retain one
 * authoritative source line for that relationship.
 */
export interface ExplorationSourceLocation {
  file: string;
  line: number;
  endLine?: number;
}

export type ExplorationEvidenceStrength = 'exact' | 'derived' | 'candidate' | 'mixed' | 'unknown';
export type ExplorationDisposition = 'emitted' | 'folded' | 'excluded' | 'unsupported';
export type ExplorationAnchorStatus = 'matched' | 'ambiguous' | 'missing';

/**
 * The closed semantic families used to explain program relationships without
 * baking language or framework vocabulary into the universal graph contract.
 */
export const PROGRAM_EDGE_FAMILIES = ['identity', 'contract', 'control', 'data', 'state', 'temporal'] as const;

export type ProgramEdgeFamily = (typeof PROGRAM_EDGE_FAMILIES)[number];

const PROGRAM_EDGE_FAMILY_SET: ReadonlySet<string> = new Set(PROGRAM_EDGE_FAMILIES);

/** Context that qualifies a semantic relationship without changing its family. */
export interface ProgramEdgeSemanticContext {
  crossesRuntimeBoundary?: true;
  protocol?: string;
  runtimeKey?: string;
  process?: string;
  transaction?: string;
  synchronizationScope?: string;
}

export type ProgramEdgeSemanticAttribute = string | number | boolean | null;

/** One primitive interpretation of an existing evidenced topology edge. */
export interface ProgramEdgeSemantic {
  family: ProgramEdgeFamily;
  subtype: string;
  context?: ProgramEdgeSemanticContext;
  /** Evidence-specific values that qualify this primitive relationship. */
  attributes?: Record<string, ProgramEdgeSemanticAttribute>;
}

/**
 * A projected program edge preserves the original topology evidence while
 * giving causal traversal a repository-independent family and subtype.
 */
export interface ProgramEdge extends ProgramEdgeSemantic {
  id: string;
  sourceEdgeId: string;
  sourceKind: string;
  fromNodeId: string;
  toNodeId: string;
  directed: true;
  disposition: ExplorationDisposition;
  evidence: ExplorationEvidenceSource[];
}

export interface ProgramEdgeFamilyInventory {
  sourceEdges: number;
  projectedEdges: number;
  subtypes: string[];
}

/** Diagnostic accounting for semantic coverage of one topology packet. */
export interface ProgramEdgeInventory {
  sourceEdges: number;
  mappedSourceEdges: number;
  projectedEdges: number;
  unmappedSourceEdges: number;
  unsupportedSourceEdges: number;
  unmappedKinds: string[];
  families: Record<ProgramEdgeFamily, ProgramEdgeFamilyInventory>;
}

/**
 * A completion status names what one repository query established, never
 * whether the agent has finished the user's task. Selection completion covers
 * requested units, connector completion covers proved paths between anchors,
 * frontier accounting covers reversible withheld directions, and incomplete
 * coverage means at least one required identity or direction remains unknown.
 */
export type ExplorationCompletionStatus =
  | 'selection-complete'
  | 'connector-complete'
  | 'frontier-accounted'
  | 'coverage-incomplete';

export interface ExplorationCompletion {
  status: ExplorationCompletionStatus;
  scope: string;
  explanation: string;
}

/** One independently inspectable basis for a graph relationship. */
export interface ExplorationEvidenceSource {
  method: string;
  strength: ExplorationEvidenceStrength;
  identity: string | null;
  location: ExplorationSourceLocation | null;
}

/**
 * An anchor records how an explicit query term was tied to repository units.
 * Candidate identities remain separate from matched identities so ambiguity
 * is never silently converted into a graph fact.
 */
export interface ExplorationTopologyAnchor {
  id: string;
  kind: string;
  query: string;
  status: ExplorationAnchorStatus;
  nodeIds: string[];
  candidateNodeIds: string[];
  omittedCandidates: number;
}

/** A node is one repository unit at the resolution chosen by the producer. */
export interface ExplorationTopologyNode {
  id: string;
  kind: string;
  label: string;
  disposition: ExplorationDisposition;
  location: ExplorationSourceLocation | null;
  anchorIds: string[];
  attributes: Record<string, string | number | boolean | null>;
}

/** An edge is one directed, evidenced relationship between two nodes. */
export interface ExplorationTopologyEdge {
  id: string;
  kind: string;
  fromNodeId: string;
  toNodeId: string;
  directed: true;
  disposition: ExplorationDisposition;
  evidence: ExplorationEvidenceSource[];
  /** Additive semantic projection; absent means this producer has not mapped the edge yet. */
  semantics?: ProgramEdgeSemantic[];
}

/** A path records a proved or still-partial connection between explicit anchors. */
export interface ExplorationTopologyPath {
  id: string;
  fromAnchorId: string;
  toAnchorId: string;
  status: 'connected' | 'partial' | 'candidate';
  nodeIds: string[];
  edgeIds: string[];
}

/**
 * A frontier group is an accounted direction that the current packet did not
 * materialize. Its exact members make folding reversible without pretending
 * that those members were inspected.
 */
export interface ExplorationFrontierGroup {
  id: string;
  kind: string;
  direction: 'incoming' | 'outgoing' | 'undirected' | 'unresolved';
  fromNodeIds: string[];
  edgeIds: string[];
  memberNodeIds: string[];
  memberCount: number;
  disposition: 'folded' | 'excluded' | 'unsupported';
  reason: string;
  expansion: string | null;
}

export interface ExplorationDispositionCounts {
  total: number;
  emitted: number;
  folded: number;
  excluded: number;
  unsupported: number;
}

/**
 * Coverage accounts for the declared query scope. It does not claim that the
 * producer understood the user's English goal or represented dynamic runtime
 * behavior that its installed analyzers cannot observe.
 */
export interface ExplorationTopologyCoverage {
  status: 'accounted' | 'incomplete';
  scope: string;
  nodes: ExplorationDispositionCounts;
  edges: ExplorationDispositionCounts;
  matchedAnchors: number;
  ambiguousAnchors: number;
  missingAnchors: number;
  omittedCandidates: number;
  frontierGroups: number;
  programEdges: ProgramEdgeInventory;
  blindSpots: string[];
  explanation: string;
}

export interface ExplorationTopology {
  schemaVersion: 1;
  anchors: ExplorationTopologyAnchor[];
  nodes: ExplorationTopologyNode[];
  edges: ExplorationTopologyEdge[];
  paths: ExplorationTopologyPath[];
  frontiers: ExplorationFrontierGroup[];
  coverage: ExplorationTopologyCoverage;
  completion?: ExplorationCompletion;
}

export interface ExplorationTopologyInput {
  anchors: readonly ExplorationTopologyAnchor[];
  nodes: readonly ExplorationTopologyNode[];
  edges: readonly ExplorationTopologyEdge[];
  paths?: readonly ExplorationTopologyPath[];
  frontiers?: readonly ExplorationFrontierGroup[];
  scope: string;
  blindSpots?: readonly string[];
  incompleteReasons?: readonly string[];
}

export interface ExplorationTopologySelectionOptions {
  /** Soft budget: anchors and their shortest connectors are never truncated. */
  maxSelectedNodes?: number;
  /** Maximum proved upstream paths selected in addition to the ordinary node budget. */
  maxUpstreamCausalPaths?: number;
  /** Maximum nodes added by upstream paths; a path is never selected partially. */
  maxUpstreamCausalNodes?: number;
  expandedFrontierIds?: readonly string[];
}

export type ExplorationUpstreamEndpointKind = 'public-entry' | 'runtime-boundary' | 'traversal-root';

/**
 * Validate and deterministically order a query topology. This is deliberately
 * independent of system-map: any query can emit the same graph contract.
 */
export function createExplorationTopology(input: ExplorationTopologyInput): ExplorationTopology {
  const anchors = sortedUniqueRecords(input.anchors, 'anchor');
  const nodes = sortedUniqueRecords(input.nodes, 'node');
  const edges = sortedUniqueRecords(input.edges, 'edge');
  const paths = sortedUniqueRecords(input.paths ?? [], 'path');
  const frontiers = sortedUniqueRecords(input.frontiers ?? [], 'frontier');
  const anchorIds = new Set(anchors.map((anchor) => anchor.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));

  for (const anchor of anchors) {
    assertReferencesExist(`anchor ${anchor.id}`, [...anchor.nodeIds, ...anchor.candidateNodeIds], nodeIds, 'node');
  }
  for (const node of nodes) assertReferencesExist(`node ${node.id}`, node.anchorIds, anchorIds, 'anchor');
  for (const edge of edges) {
    assertReferencesExist(`edge ${edge.id}`, [edge.fromNodeId, edge.toNodeId], nodeIds, 'node');
    if (edge.evidence.length === 0) throw new Error(`Exploration edge ${edge.id} has no evidence source.`);
    validateProgramEdgeSemantics(edge);
  }
  for (const path of paths) {
    assertReferencesExist(`path ${path.id}`, [path.fromAnchorId, path.toAnchorId], anchorIds, 'anchor');
    assertReferencesExist(`path ${path.id}`, path.nodeIds, nodeIds, 'node');
    assertReferencesExist(`path ${path.id}`, path.edgeIds, edgeIds, 'edge');
  }
  for (const frontier of frontiers) {
    assertReferencesExist(`frontier ${frontier.id}`, frontier.fromNodeIds, nodeIds, 'node');
    assertReferencesExist(`frontier ${frontier.id}`, frontier.edgeIds, edgeIds, 'edge');
    assertReferencesExist(`frontier ${frontier.id}`, frontier.memberNodeIds, nodeIds, 'node');
    if (frontier.memberCount !== frontier.memberNodeIds.length) {
      throw new Error(
        `Exploration frontier ${frontier.id} reports ${frontier.memberCount} member(s) but identifies ${frontier.memberNodeIds.length}.`,
      );
    }
  }

  const incompleteReasons = uniqueSorted(input.incompleteReasons ?? []);
  const status = incompleteReasons.length === 0 ? 'accounted' : 'incomplete';
  const omittedCandidates = anchors.reduce((total, anchor) => total + anchor.omittedCandidates, 0);
  return {
    schemaVersion: 1,
    anchors,
    nodes,
    edges,
    paths,
    frontiers,
    coverage: {
      status,
      scope: input.scope,
      nodes: dispositionCounts(nodes),
      edges: dispositionCounts(edges),
      matchedAnchors: anchors.filter((anchor) => anchor.status === 'matched').length,
      ambiguousAnchors: anchors.filter((anchor) => anchor.status === 'ambiguous').length,
      missingAnchors: anchors.filter((anchor) => anchor.status === 'missing').length,
      omittedCandidates,
      frontierGroups: frontiers.length,
      programEdges: programEdgeInventory(edges),
      blindSpots: uniqueSorted(input.blindSpots ?? []),
      explanation:
        status === 'accounted'
          ? 'Every node and edge discovered within the declared query scope is emitted, folded with recoverable identity, explicitly excluded, or reported unsupported.'
          : `The declared query scope is not fully accounted for: ${incompleteReasons.join('; ')}`,
    },
    completion: topologyCompletion(status, paths, input.scope),
  };
}

/** Flatten semantic annotations without weakening or duplicating their source evidence. */
export function projectProgramEdges(edges: readonly ExplorationTopologyEdge[]): ProgramEdge[] {
  return edges
    .flatMap((edge) =>
      sortedProgramEdgeSemantics(edge.semantics ?? []).map((semantic) => ({
        id: programEdgeId(edge.id, semantic),
        sourceEdgeId: edge.id,
        sourceKind: edge.kind,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        directed: true as const,
        disposition: edge.disposition,
        evidence: [...edge.evidence],
        family: semantic.family,
        subtype: semantic.subtype,
        ...(semantic.context ? { context: { ...semantic.context } } : {}),
        ...(semantic.attributes ? { attributes: { ...semantic.attributes } } : {}),
      })),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Summarize which semantic families a topology producer mapped and which it did not. */
export function programEdgeInventory(edges: readonly ExplorationTopologyEdge[]): ProgramEdgeInventory {
  const projected = projectProgramEdges(edges);
  const mappedSourceEdgeIds = new Set(projected.map((edge) => edge.sourceEdgeId));
  const sourceEdgeIdsByFamily = new Map<ProgramEdgeFamily, Set<string>>(
    PROGRAM_EDGE_FAMILIES.map((family) => [family, new Set<string>()]),
  );
  const subtypesByFamily = new Map<ProgramEdgeFamily, Set<string>>(
    PROGRAM_EDGE_FAMILIES.map((family) => [family, new Set<string>()]),
  );
  const projectedByFamily = new Map<ProgramEdgeFamily, number>(PROGRAM_EDGE_FAMILIES.map((family) => [family, 0]));

  for (const edge of projected) {
    sourceEdgeIdsByFamily.get(edge.family)!.add(edge.sourceEdgeId);
    subtypesByFamily.get(edge.family)!.add(edge.subtype);
    projectedByFamily.set(edge.family, projectedByFamily.get(edge.family)! + 1);
  }

  return {
    sourceEdges: edges.length,
    mappedSourceEdges: mappedSourceEdgeIds.size,
    projectedEdges: projected.length,
    unmappedSourceEdges: edges.length - mappedSourceEdgeIds.size,
    unsupportedSourceEdges: edges.filter((edge) => edge.disposition === 'unsupported').length,
    unmappedKinds: uniqueSorted(edges.filter((edge) => !mappedSourceEdgeIds.has(edge.id)).map((edge) => edge.kind)),
    families: {
      identity: familyInventory('identity', sourceEdgeIdsByFamily, projectedByFamily, subtypesByFamily),
      contract: familyInventory('contract', sourceEdgeIdsByFamily, projectedByFamily, subtypesByFamily),
      control: familyInventory('control', sourceEdgeIdsByFamily, projectedByFamily, subtypesByFamily),
      data: familyInventory('data', sourceEdgeIdsByFamily, projectedByFamily, subtypesByFamily),
      state: familyInventory('state', sourceEdgeIdsByFamily, projectedByFamily, subtypesByFamily),
      temporal: familyInventory('temporal', sourceEdgeIdsByFamily, projectedByFamily, subtypesByFamily),
    },
  };
}

function familyInventory(
  family: ProgramEdgeFamily,
  sourceEdgeIdsByFamily: ReadonlyMap<ProgramEdgeFamily, ReadonlySet<string>>,
  projectedByFamily: ReadonlyMap<ProgramEdgeFamily, number>,
  subtypesByFamily: ReadonlyMap<ProgramEdgeFamily, ReadonlySet<string>>,
): ProgramEdgeFamilyInventory {
  return {
    sourceEdges: sourceEdgeIdsByFamily.get(family)?.size ?? 0,
    projectedEdges: projectedByFamily.get(family) ?? 0,
    subtypes: [...(subtypesByFamily.get(family) ?? [])].sort(),
  };
}

function validateProgramEdgeSemantics(edge: ExplorationTopologyEdge): void {
  const seen = new Set<string>();
  for (const semantic of edge.semantics ?? []) {
    if (!PROGRAM_EDGE_FAMILY_SET.has(semantic.family)) {
      throw new Error(`Exploration edge ${edge.id} has unknown program edge family: ${semantic.family}.`);
    }
    if (semantic.subtype.trim().length === 0) {
      throw new Error(`Exploration edge ${edge.id} has an empty program edge subtype.`);
    }
    const key = programEdgeSemanticKey(semantic);
    if (seen.has(key)) throw new Error(`Exploration edge ${edge.id} repeats program edge semantic ${key}.`);
    seen.add(key);
  }
}

function sortedProgramEdgeSemantics(semantics: readonly ProgramEdgeSemantic[]): ProgramEdgeSemantic[] {
  return [...semantics].sort((left, right) =>
    programEdgeSemanticKey(left).localeCompare(programEdgeSemanticKey(right)),
  );
}

function programEdgeSemanticKey(semantic: ProgramEdgeSemantic): string {
  return `${semantic.family}:${semantic.subtype}`;
}

function programEdgeId(sourceEdgeId: string, semantic: ProgramEdgeSemantic): string {
  return `program:${encodeURIComponent(sourceEdgeId)}:${semantic.family}:${encodeURIComponent(semantic.subtype)}`;
}

function topologyCompletion(
  coverageStatus: ExplorationTopologyCoverage['status'],
  paths: readonly ExplorationTopologyPath[],
  scope: string,
): ExplorationCompletion {
  if (coverageStatus === 'incomplete' || paths.some((path) => path.status !== 'connected')) {
    return {
      status: 'coverage-incomplete',
      scope,
      explanation:
        'The declared graph query has an ambiguous, missing, candidate-only, or disconnected anchor relationship.',
    };
  }
  if (paths.length > 0) {
    return {
      status: 'connector-complete',
      scope,
      explanation: 'Every requested anchor pair has a selected path supported by proved repository relationships.',
    };
  }
  return {
    status: 'frontier-accounted',
    scope,
    explanation:
      'Every discovered direction in the declared graph query is emitted or represented by an exact frontier.',
  };
}

/**
 * Select the smallest graph that preserves explicit anchors and their proved
 * connections. Everything else is folded by connected component behind the
 * first edge leaving the selection, with exact node and edge membership.
 */
export function selectExplorationTopology(
  topology: ExplorationTopology,
  options: ExplorationTopologySelectionOptions = {},
): ExplorationTopology {
  const maxSelectedNodes = options.maxSelectedNodes ?? 24;
  if (!Number.isSafeInteger(maxSelectedNodes) || maxSelectedNodes <= 0) {
    throw new RangeError(`maxSelectedNodes must be a positive safe integer; received ${maxSelectedNodes}`);
  }
  const maxUpstreamCausalPaths = options.maxUpstreamCausalPaths ?? 4;
  const maxUpstreamCausalNodes = options.maxUpstreamCausalNodes ?? 16;
  for (const [name, value] of [
    ['maxUpstreamCausalPaths', maxUpstreamCausalPaths],
    ['maxUpstreamCausalNodes', maxUpstreamCausalNodes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer; received ${value}`);
    }
  }
  const selectedNodeIds = new Set(
    topology.anchors.flatMap((anchor) => [...anchor.nodeIds, ...anchor.candidateNodeIds]),
  );
  const paths: ExplorationTopologyPath[] = [];
  const connectedAnchors = topology.anchors.filter(
    (anchor) => anchor.status !== 'missing' && anchor.nodeIds.length + anchor.candidateNodeIds.length > 0,
  );

  for (let leftIndex = 0; leftIndex < connectedAnchors.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < connectedAnchors.length; rightIndex += 1) {
      const left = connectedAnchors[leftIndex]!;
      const right = connectedAnchors[rightIndex]!;
      const proved = shortestAnchorPath(topology, left, right, false);
      const candidate = proved ?? shortestAnchorPath(topology, left, right, true);
      const path = candidate;
      if (path) {
        path.nodeIds.forEach((id) => selectedNodeIds.add(id));
        paths.push({
          id: stableTopologyId('path', left.id, right.id),
          fromAnchorId: left.id,
          toAnchorId: right.id,
          status: !proved || left.status === 'ambiguous' || right.status === 'ambiguous' ? 'candidate' : 'connected',
          nodeIds: path.nodeIds,
          edgeIds: path.edgeIds,
        });
      } else {
        paths.push({
          id: stableTopologyId('path', left.id, right.id),
          fromAnchorId: left.id,
          toAnchorId: right.id,
          status: 'partial',
          nodeIds: [],
          edgeIds: [],
        });
      }
    }
  }

  for (const nodeId of queryAlignedCausalSpineNodeIds(
    topology,
    [...selectedNodeIds],
    Math.max(0, maxSelectedNodes - selectedNodeIds.size),
  )) {
    selectedNodeIds.add(nodeId);
  }

  const upstreamCausalPaths = selectUpstreamCausalPaths(
    topology,
    topology.anchors.filter((anchor) => anchor.status === 'matched').flatMap((anchor) => anchor.nodeIds),
    {
      maxPaths: maxUpstreamCausalPaths,
      maxAdditionalNodes: maxUpstreamCausalNodes,
    },
  );
  for (const path of upstreamCausalPaths) path.nodeIds.forEach((nodeId) => selectedNodeIds.add(nodeId));

  addAdjacentJunctionsToFixedPoint(topology, selectedNodeIds, maxSelectedNodes);
  const baselineFrontiers = foldedComponentFrontiers(topology, selectedNodeIds);
  const requestedFrontiers = new Set(options.expandedFrontierIds ?? []);
  const knownFrontierIds = new Set(baselineFrontiers.map((frontier) => frontier.id));
  const unknownFrontierIds = [...requestedFrontiers].filter((id) => !knownFrontierIds.has(id)).sort();
  if (unknownFrontierIds.length > 0) {
    throw new Error(`Unknown exploration frontier id(s): ${unknownFrontierIds.join(', ')}`);
  }
  for (const frontier of baselineFrontiers) {
    if (!requestedFrontiers.has(frontier.id)) continue;
    frontier.memberNodeIds.forEach((id) => selectedNodeIds.add(id));
  }
  addAdjacentJunctionsToFixedPoint(topology, selectedNodeIds, maxSelectedNodes);

  const upstreamEndpointByNodeId = new Map(
    upstreamCausalPaths.map((path) => [path.endpointNodeId, path.endpointKind] as const),
  );
  const upstreamPathNodeIds = new Set(upstreamCausalPaths.flatMap((path) => path.nodeIds));
  const upstreamDistanceByNodeId = new Map<string, number>();
  for (const path of upstreamCausalPaths) {
    for (let index = 0; index < path.nodeIds.length; index += 1) {
      const nodeId = path.nodeIds[index]!;
      const distance = index;
      upstreamDistanceByNodeId.set(nodeId, Math.max(upstreamDistanceByNodeId.get(nodeId) ?? 0, distance));
    }
  }
  const nodes = topology.nodes.map((node): ExplorationTopologyNode => {
    const endpointKind = upstreamEndpointByNodeId.get(node.id);
    const upstreamAttributes = upstreamPathNodeIds.has(node.id)
      ? {
          upstreamCausalPath: true,
          upstreamCausalDistance: upstreamDistanceByNodeId.get(node.id) ?? 0,
          ...(endpointKind ? { upstreamCausalEndpoint: endpointKind } : {}),
        }
      : {};
    return {
      ...node,
      attributes: { ...node.attributes, ...upstreamAttributes },
      disposition:
        node.disposition === 'excluded' || node.disposition === 'unsupported'
          ? node.disposition
          : selectedNodeIds.has(node.id)
            ? 'emitted'
            : 'folded',
    };
  });
  const selectedEdges = new Set([
    ...paths.flatMap((path) => path.edgeIds),
    ...upstreamCausalPaths.flatMap((path) => path.edgeIds),
  ]);
  const edges = topology.edges.map(
    (edge): ExplorationTopologyEdge => ({
      ...edge,
      disposition:
        edge.disposition === 'excluded' || edge.disposition === 'unsupported'
          ? edge.disposition
          : selectedEdges.has(edge.id) || (selectedNodeIds.has(edge.fromNodeId) && selectedNodeIds.has(edge.toNodeId))
            ? 'emitted'
            : 'folded',
    }),
  );
  const selectedTopology = createExplorationTopology({
    anchors: topology.anchors,
    nodes,
    edges,
    paths,
    frontiers: [
      ...topology.frontiers.filter((frontier) => frontier.disposition !== 'folded'),
      ...foldedComponentFrontiers({ ...topology, nodes, edges }, selectedNodeIds),
    ],
    scope: topology.coverage.scope,
    blindSpots: topology.coverage.blindSpots,
    incompleteReasons: topology.coverage.status === 'incomplete' ? [topology.coverage.explanation] : [],
  });

  // A verifier-friendly invariant: every folded edge belongs to one frontier.
  const accountedFoldedEdgeIds = new Set(selectedTopology.frontiers.flatMap((frontier) => frontier.edgeIds));
  const unaccounted = selectedTopology.edges
    .filter((edge) => edge.disposition === 'folded' && !accountedFoldedEdgeIds.has(edge.id))
    .map((edge) => edge.id);
  if (unaccounted.length > 0) {
    throw new Error(`Folded exploration edge(s) are not frontier-accounted: ${unaccounted.sort().join(', ')}`);
  }
  return selectedTopology;
}

interface TraversedPath {
  nodeIds: string[];
  edgeIds: string[];
}

interface UpstreamCausalPath extends TraversedPath {
  anchorNodeId: string;
  endpointNodeId: string;
  endpointKind: ExplorationUpstreamEndpointKind;
  endpointPriority: number;
}

const MAX_UPSTREAM_CAUSAL_DEPTH = 10;

/**
 * Select a few shortest proved caller paths into explicit anchors. A runtime
 * endpoint is either a source-backed symbol proved reachable from a package,
 * framework, language, or configured public surface, or the producer-side
 * node of the first runtime edge encountered while walking callers. A
 * traversal root is only the earliest source-backed node in this bounded
 * query graph; it is not claimed to be a public or process entry point. The
 * selection depends on edge direction and evidence strength, never repository
 * vocabulary or inferred task intent.
 */
function selectUpstreamCausalPaths(
  topology: ExplorationTopology,
  anchorNodeIds: readonly string[],
  options: { maxPaths: number; maxAdditionalNodes: number },
): UpstreamCausalPath[] {
  if (anchorNodeIds.length === 0 || options.maxPaths === 0 || options.maxAdditionalNodes === 0) return [];
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, ExplorationTopologyEdge[]>();
  for (const edge of topology.edges) {
    if (!isProvedCausalEdge(edge)) continue;
    const edges = incoming.get(edge.toNodeId) ?? [];
    edges.push(edge);
    incoming.set(edge.toNodeId, edges);
  }
  for (const edges of incoming.values()) {
    edges.sort(
      (left, right) =>
        Number(isRuntimeCausalEdge(right)) - Number(isRuntimeCausalEdge(left)) ||
        topologyEdgeEvidenceRank(right) - topologyEdgeEvidenceRank(left) ||
        left.fromNodeId.localeCompare(right.fromNodeId) ||
        left.id.localeCompare(right.id),
    );
  }

  const candidates: UpstreamCausalPath[] = [];
  for (const anchorNodeId of uniqueSorted(anchorNodeIds)) {
    const queue: TraversedPath[] = [{ nodeIds: [anchorNodeId], edgeIds: [] }];
    const visited = new Set([anchorNodeId]);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const path = queue[cursor]!;
      const currentNodeId = path.nodeIds[path.nodeIds.length - 1]!;
      if (
        path.edgeIds.length > 0 &&
        nodeById.get(currentNodeId)?.location &&
        nodeById.get(currentNodeId)?.attributes['publicEntry'] === true
      ) {
        const endpointPriority =
          typeof nodeById.get(currentNodeId)?.attributes['publicEntryPriority'] === 'number'
            ? Number(nodeById.get(currentNodeId)?.attributes['publicEntryPriority'])
            : 1;
        candidates.push({
          ...path,
          anchorNodeId,
          endpointNodeId: currentNodeId,
          endpointKind: 'public-entry',
          endpointPriority,
        });
        // A wildcard package surface proves reachability but may be only an
        // internal compatibility export. Continue through it so an exact
        // manifest, framework, or configured doorway can supersede it.
        if (endpointPriority >= 2) continue;
      }
      const currentIncoming = incoming.get(currentNodeId) ?? [];
      if (currentIncoming.length === 0 && path.edgeIds.length > 0 && nodeById.get(currentNodeId)?.location) {
        candidates.push({
          ...path,
          anchorNodeId,
          endpointNodeId: currentNodeId,
          endpointKind: 'traversal-root',
          endpointPriority: 0,
        });
        continue;
      }
      if (path.edgeIds.length >= MAX_UPSTREAM_CAUSAL_DEPTH) continue;
      for (const edge of currentIncoming) {
        if (visited.has(edge.fromNodeId)) continue;
        const nextPath = {
          nodeIds: [...path.nodeIds, edge.fromNodeId],
          edgeIds: [...path.edgeIds, edge.id],
        };
        if (isRuntimeCausalEdge(edge) && nodeById.get(edge.fromNodeId)?.location) {
          candidates.push({
            ...nextPath,
            anchorNodeId,
            endpointNodeId: edge.fromNodeId,
            endpointKind: 'runtime-boundary',
            endpointPriority: 2,
          });
          continue;
        }
        visited.add(edge.fromNodeId);
        queue.push(nextPath);
      }
    }
  }

  const orderedCandidates = candidates
    .sort(compareUpstreamCausalPaths)
    .filter(
      (candidate, index, all) => all.findIndex((other) => other.endpointNodeId === candidate.endpointNodeId) === index,
    );
  const prioritized: UpstreamCausalPath[] = [];
  const priorities = [...new Set(orderedCandidates.map((candidate) => candidate.endpointPriority))].sort(
    (left, right) => right - left,
  );
  for (const priority of priorities) {
    const tier = orderedCandidates.filter((candidate) => candidate.endpointPriority === priority);
    const diverse: UpstreamCausalPath[] = [];
    const representedAreas = new Set<string>();
    for (const candidate of tier) {
      const area = topologyRepositoryArea(nodeById.get(candidate.endpointNodeId)?.location?.file ?? '');
      if (representedAreas.has(area)) continue;
      representedAreas.add(area);
      diverse.push(candidate);
    }
    prioritized.push(...diverse, ...tier.filter((candidate) => !diverse.includes(candidate)));
  }
  const selected: UpstreamCausalPath[] = [];
  const selectedNodeIds = new Set(anchorNodeIds);
  let addedNodes = 0;
  for (const candidate of prioritized) {
    if (selected.length >= options.maxPaths) break;
    const additionalNodeIds = candidate.nodeIds.filter((nodeId) => !selectedNodeIds.has(nodeId));
    if (addedNodes + additionalNodeIds.length > options.maxAdditionalNodes) continue;
    selected.push(candidate);
    additionalNodeIds.forEach((nodeId) => selectedNodeIds.add(nodeId));
    addedNodes += additionalNodeIds.length;
  }
  return selected;
}

function compareUpstreamCausalPaths(left: UpstreamCausalPath, right: UpstreamCausalPath): number {
  return (
    right.endpointPriority - left.endpointPriority ||
    left.edgeIds.length - right.edgeIds.length ||
    left.endpointNodeId.localeCompare(right.endpointNodeId) ||
    left.anchorNodeId.localeCompare(right.anchorNodeId)
  );
}

function topologyRepositoryArea(file: string): string {
  return file.split('/').filter(Boolean).slice(0, 2).join('/') || '<unknown>';
}

function isProvedCausalEdge(edge: ExplorationTopologyEdge): boolean {
  return (
    edge.disposition !== 'excluded' &&
    edge.disposition !== 'unsupported' &&
    isCausalSpineEdge(edge) &&
    edge.evidence.some((source) => ['exact', 'derived', 'mixed'].includes(source.strength))
  );
}

/**
 * Follow the strongest directed causal path whose identifiers retain the
 * explicit query vocabulary. This is graph selection, not task-intent
 * inference: every unselected alternative remains frontier-accounted.
 */
export function queryAlignedCausalSpineNodeIds(
  topology: ExplorationTopology,
  anchorNodeIds: readonly string[],
  maxAdditionalNodes: number,
  options: { emittedOnly?: boolean } = {},
): string[] {
  if (anchorNodeIds.length === 0 || maxAdditionalNodes === 0) return [];
  const queryTerms = new Set(
    topology.anchors
      .filter((anchor) => anchor.status === 'matched')
      .flatMap((anchor) => topologyIdentifierTerms(anchor.query)),
  );
  if (queryTerms.size === 0) return [];
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, ExplorationTopologyEdge[]>();
  for (const edge of topology.edges) {
    if (
      (options.emittedOnly && edge.disposition !== 'emitted') ||
      edge.disposition === 'excluded' ||
      edge.disposition === 'unsupported' ||
      edge.kind === 'structural-membership' ||
      edge.kind.endsWith('frontier') ||
      !isCausalSpineEdge(edge)
    ) {
      continue;
    }
    const edges = outgoing.get(edge.fromNodeId) ?? [];
    edges.push(edge);
    outgoing.set(edge.fromNodeId, edges);
  }

  interface SpineCandidate {
    nodeIds: string[];
    score: number;
    crossesRuntimeBoundary: boolean;
  }
  const candidates: SpineCandidate[] = [];
  const maxEdges = Math.min(6, Math.max(2, maxAdditionalNodes + 1));
  const visit = (nodeId: string, nodeIds: string[], score: number, crossesRuntimeBoundary: boolean): void => {
    if (nodeIds.length > 1) candidates.push({ nodeIds, score, crossesRuntimeBoundary });
    if (nodeIds.length - 1 >= maxEdges) return;
    for (const edge of outgoing.get(nodeId) ?? []) {
      if (nodeIds.includes(edge.toNodeId)) continue;
      const target = nodeById.get(edge.toNodeId);
      if (!target) continue;
      const runtimeBoundary = isRuntimeCausalEdge(edge);
      const nextScore =
        score +
        (runtimeBoundary ? 100 : 8) +
        topologyIdentifierOverlap(target.label, queryTerms) * 24 +
        topologyEdgeEvidenceRank(edge);
      visit(edge.toNodeId, [...nodeIds, edge.toNodeId], nextScore, crossesRuntimeBoundary || runtimeBoundary);
    }
  };
  for (const anchorNodeId of anchorNodeIds) visit(anchorNodeId, [anchorNodeId], 0, false);

  const best = candidates.sort(
    (left, right) =>
      Number(right.crossesRuntimeBoundary) - Number(left.crossesRuntimeBoundary) ||
      right.score - left.score ||
      right.nodeIds.length - left.nodeIds.length ||
      left.nodeIds.join('\u0000').localeCompare(right.nodeIds.join('\u0000')),
  )[0];
  if (!best) return [];
  return best.nodeIds.filter((nodeId) => !anchorNodeIds.includes(nodeId)).slice(0, maxAdditionalNodes);
}

function isCausalSpineEdge(edge: ExplorationTopologyEdge): boolean {
  return (
    isRuntimeCausalEdge(edge) ||
    edge.kind === 'boundary-observation' ||
    edge.kind === 'call' ||
    edge.kind === 'compiler:call'
  );
}

function isRuntimeCausalEdge(edge: ExplorationTopologyEdge): boolean {
  return edge.kind === 'runtime-boundary' || edge.kind.startsWith('runtime:');
}

function topologyIdentifierTerms(value: string): string[] {
  return value
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1);
}

function topologyIdentifierOverlap(label: string, queryTerms: ReadonlySet<string>): number {
  return topologyIdentifierTerms(label).filter(
    (term, index, terms) => terms.indexOf(term) === index && queryTerms.has(term),
  ).length;
}

function topologyEdgeEvidenceRank(edge: ExplorationTopologyEdge): number {
  const ranks: Readonly<Record<ExplorationEvidenceStrength, number>> = {
    exact: 5,
    derived: 4,
    mixed: 3,
    candidate: 1,
    unknown: 0,
  };
  return Math.max(0, ...edge.evidence.map((evidence) => ranks[evidence.strength]));
}

function shortestAnchorPath(
  topology: ExplorationTopology,
  from: ExplorationTopologyAnchor,
  to: ExplorationTopologyAnchor,
  includeCandidateEvidence: boolean,
): TraversedPath | null {
  const starts = [...from.nodeIds, ...from.candidateNodeIds].sort();
  const targets = new Set([...to.nodeIds, ...to.candidateNodeIds]);
  if (starts.some((id) => targets.has(id))) {
    const shared = starts.find((id) => targets.has(id))!;
    return { nodeIds: [shared], edgeIds: [] };
  }
  const adjacency = new Map<string, Array<{ nodeId: string; edgeId: string }>>();
  for (const edge of topology.edges) {
    if (edge.disposition === 'excluded' || edge.disposition === 'unsupported') continue;
    if (edge.kind === 'structural-membership') continue;
    const candidateOnly = edge.evidence.every((source) => ['candidate', 'unknown'].includes(source.strength));
    if (candidateOnly && !includeCandidateEvidence) continue;
    pushAdjacency(adjacency, edge.fromNodeId, edge.toNodeId, edge.id);
    pushAdjacency(adjacency, edge.toNodeId, edge.fromNodeId, edge.id);
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.edgeId.localeCompare(right.edgeId));
  }
  const queue = starts.map((nodeId) => ({ nodeId, nodeIds: [nodeId], edgeIds: [] as string[] }));
  const visited = new Set(starts);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    for (const neighbor of adjacency.get(current.nodeId) ?? []) {
      if (visited.has(neighbor.nodeId)) continue;
      const next = {
        nodeId: neighbor.nodeId,
        nodeIds: [...current.nodeIds, neighbor.nodeId],
        edgeIds: [...current.edgeIds, neighbor.edgeId],
      };
      if (targets.has(neighbor.nodeId)) return next;
      visited.add(neighbor.nodeId);
      queue.push(next);
    }
  }
  return null;
}

function pushAdjacency(
  adjacency: Map<string, Array<{ nodeId: string; edgeId: string }>>,
  fromNodeId: string,
  toNodeId: string,
  edgeId: string,
): void {
  const neighbors = adjacency.get(fromNodeId) ?? [];
  neighbors.push({ nodeId: toNodeId, edgeId });
  adjacency.set(fromNodeId, neighbors);
}

function addAdjacentJunctions(
  topology: ExplorationTopology,
  selectedNodeIds: Set<string>,
  maxSelectedNodes: number,
): void {
  const degree = new Map<string, { incoming: number; outgoing: number }>();
  for (const edge of topology.edges) {
    const from = degree.get(edge.fromNodeId) ?? { incoming: 0, outgoing: 0 };
    const to = degree.get(edge.toNodeId) ?? { incoming: 0, outgoing: 0 };
    from.outgoing += 1;
    to.incoming += 1;
    degree.set(edge.fromNodeId, from);
    degree.set(edge.toNodeId, to);
  }
  const candidates = new Set<string>();
  for (const edge of topology.edges) {
    const fromSelected = selectedNodeIds.has(edge.fromNodeId);
    const toSelected = selectedNodeIds.has(edge.toNodeId);
    if (fromSelected === toSelected) continue;
    const candidateId = fromSelected ? edge.toNodeId : edge.fromNodeId;
    const node = topology.nodes.find((entry) => entry.id === candidateId);
    const nodeDegree = degree.get(candidateId) ?? { incoming: 0, outgoing: 0 };
    const boundaryJunction =
      /(?:runtime-boundary|external)/u.test(edge.kind) || Boolean(node && /(?:frontier|external)/u.test(node.kind));
    const branchOrMerge = nodeDegree.incoming > 1 || nodeDegree.outgoing > 1;
    if (boundaryJunction || branchOrMerge) candidates.add(candidateId);
  }
  for (const candidateId of [...candidates].sort()) {
    if (selectedNodeIds.size >= maxSelectedNodes) break;
    selectedNodeIds.add(candidateId);
  }
}

function addAdjacentJunctionsToFixedPoint(
  topology: ExplorationTopology,
  selectedNodeIds: Set<string>,
  maxSelectedNodes: number,
): void {
  let previousSize = -1;
  while (selectedNodeIds.size !== previousSize && selectedNodeIds.size < maxSelectedNodes) {
    previousSize = selectedNodeIds.size;
    addAdjacentJunctions(topology, selectedNodeIds, maxSelectedNodes);
  }
}

function foldedComponentFrontiers(
  topology: ExplorationTopology,
  selectedNodeIds: ReadonlySet<string>,
): ExplorationFrontierGroup[] {
  const foldedNodeIds = new Set(
    topology.nodes
      .filter(
        (node) =>
          !selectedNodeIds.has(node.id) && node.disposition !== 'excluded' && node.disposition !== 'unsupported',
      )
      .map((node) => node.id),
  );
  const adjacency = new Map<string, Set<string>>();
  for (const edge of topology.edges) {
    if (!foldedNodeIds.has(edge.fromNodeId) || !foldedNodeIds.has(edge.toNodeId)) continue;
    const from = adjacency.get(edge.fromNodeId) ?? new Set<string>();
    const to = adjacency.get(edge.toNodeId) ?? new Set<string>();
    from.add(edge.toNodeId);
    to.add(edge.fromNodeId);
    adjacency.set(edge.fromNodeId, from);
    adjacency.set(edge.toNodeId, to);
  }
  const components: string[][] = [];
  const visited = new Set<string>();
  for (const start of [...foldedNodeIds].sort()) {
    if (visited.has(start)) continue;
    const component: string[] = [];
    const queue = [start];
    visited.add(start);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const nodeId = queue[cursor]!;
      component.push(nodeId);
      for (const neighbor of [...(adjacency.get(nodeId) ?? [])].sort()) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    components.push(component.sort());
  }

  return components.map((memberNodeIds) => {
    const members = new Set(memberNodeIds);
    const componentEdges = topology.edges.filter((edge) => members.has(edge.fromNodeId) || members.has(edge.toNodeId));
    const crossingEdges = componentEdges.filter((edge) => members.has(edge.fromNodeId) !== members.has(edge.toNodeId));
    const fromNodeIds = uniqueSorted(
      crossingEdges.map((edge) => (members.has(edge.fromNodeId) ? edge.toNodeId : edge.fromNodeId)),
    );
    const directions = new Set(
      crossingEdges.map((edge) => (members.has(edge.toNodeId) ? 'outgoing' : 'incoming') as 'incoming' | 'outgoing'),
    );
    const edgeIds = uniqueSorted(componentEdges.map((edge) => edge.id));
    const kinds = uniqueSorted(crossingEdges.map((edge) => edge.kind));
    return {
      id: stableTopologyId('frontier', ...memberNodeIds, ...edgeIds),
      kind: kinds.join('+') || 'disconnected',
      direction: directions.size === 1 ? [...directions][0]! : 'undirected',
      fromNodeIds,
      edgeIds,
      memberNodeIds,
      memberCount: memberNodeIds.length,
      disposition: 'folded' as const,
      reason:
        crossingEdges.length > 0
          ? 'Connected evidence is folded beyond the first edge leaving the selected connector graph.'
          : 'Discovered evidence is disconnected from every selected anchor connector under the declared relation scope.',
      expansion: null,
    };
  });
}

function stableTopologyId(kind: string, ...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
  return `${kind}:${digest}`;
}

function sortedUniqueRecords<T extends { id: string }>(records: readonly T[], label: string): T[] {
  const sorted = [...records].sort((left, right) => left.id.localeCompare(right.id));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]!.id === sorted[index]!.id) {
      throw new Error(`Duplicate exploration ${label} id: ${sorted[index]!.id}`);
    }
  }
  return sorted;
}

function assertReferencesExist(
  owner: string,
  references: readonly string[],
  available: ReadonlySet<string>,
  targetKind: string,
): void {
  const missing = uniqueSorted(references.filter((reference) => !available.has(reference)));
  if (missing.length > 0)
    throw new Error(`Exploration ${owner} references missing ${targetKind}(s): ${missing.join(', ')}`);
}

function dispositionCounts(records: readonly { disposition: ExplorationDisposition }[]): ExplorationDispositionCounts {
  return {
    total: records.length,
    emitted: records.filter((record) => record.disposition === 'emitted').length,
    folded: records.filter((record) => record.disposition === 'folded').length,
    excluded: records.filter((record) => record.disposition === 'excluded').length,
    unsupported: records.filter((record) => record.disposition === 'unsupported').length,
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
