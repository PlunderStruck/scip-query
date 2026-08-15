import type {
  CausalCorridorObligation,
  CausalCorridorStatus,
  ExplorationFrontierGroup,
  ExplorationCausalCorridor,
  ExplorationSourceLocation,
  ExplorationTopology,
  ExplorationTopologyEdge,
  ExplorationTopologyNode,
  ProgramEdgeFamily,
  ProgramEdgeSemantic,
} from './exploration-topology.js';

export interface CausalCorridorAudit {
  status: CausalCorridorStatus;
  missingObligations: CausalCorridorObligation[];
  unexpectedNodeIds: string[];
  unexpectedEdgeIds: string[];
}

const TRAVERSAL_FAMILIES: ReadonlySet<ProgramEdgeFamily> = new Set(['control', 'data', 'state', 'temporal']);
const OWNERSHIP_SUBTYPES: ReadonlySet<string> = new Set([
  'contains-control',
  'contains-event',
  'contains-lock-scope',
  'contains-state-effect',
  'contains-runtime-state-effect',
  'contains',
  'owns-parameter',
  'owns-runtime-observation',
]);
const EXPLICIT_CONTROL_OUTCOMES: ReadonlySet<string> = new Set([
  'discriminator-dispatch',
  'result-callback',
  'returns',
  'runtime-handoff',
  'throws',
]);

export interface CausalCorridorOptions {
  /** Source lines selected by the preceding graph-ordered behavior pass. */
  focusLocations?: readonly ExplorationSourceLocation[];
}

/** Build the deterministic corridor implied by the topology's proved evidence. */
export function buildCausalCorridor(
  topology: ExplorationTopology,
  options: CausalCorridorOptions = {},
): ExplorationCausalCorridor {
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  const focusedNodeIds = focusedProgramNodeIds(topology.nodes, options.focusLocations);
  const focusedEdgeIds = focusedProgramEdgeIds(topology.edges, options.focusLocations);
  const focusedEdgeNodeIds = focusedProgramEdgeNodeIds(topology.edges, focusedEdgeIds);
  const pathEdgeIds = new Set(topology.paths.flatMap((path) => path.edgeIds));
  const starts = sortedUnique(
    topology.anchors.filter((anchor) => anchor.status === 'matched').flatMap((anchor) => anchor.nodeIds),
  );
  const reliableEdges = topology.edges.filter(isReliableCausalEdge);
  const selectedEvidenceEdges = reliableEdges.filter((edge) =>
    isSelectedCorridorEvidence(edge, focusedNodeIds, focusedEdgeIds, pathEdgeIds),
  );
  const traversableEdges = selectedEvidenceEdges.filter((edge) =>
    isTraversableEdge(edge, focusedNodeIds, focusedEdgeIds, focusedEdgeNodeIds, nodeById, pathEdgeIds),
  );
  const forward = reachable(starts, traversableEdges, 'forward');
  const outcomes = mechanicalOutcomeNodeIds(forward, traversableEdges);
  const backward = reachable(outcomes, traversableEdges, 'backward');
  const baseNodes = new Set([...forward].filter((nodeId) => backward.has(nodeId)));
  for (const start of starts) baseNodes.add(start);
  const baseEdges = new Set(
    traversableEdges
      .filter((edge) => baseNodes.has(edge.fromNodeId) && baseNodes.has(edge.toNodeId))
      .map((edge) => edge.id),
  );

  const protectedNodes = new Set(baseNodes);
  const protectedEdges = new Set(baseEdges);
  closeMaterialFacts(selectedEvidenceEdges, protectedNodes, protectedEdges, focusedNodeIds, focusedEdgeIds);

  const touchingFrontiers = topology.frontiers.filter((frontier) => frontierTouches(frontier, protectedNodes));
  const unresolvedFrontierIds = sortedUnique(
    touchingFrontiers.filter((frontier) => frontier.disposition === 'unsupported').map((frontier) => frontier.id),
  );
  const unresolvedEdgeIds = sortedUnique(
    topology.edges
      .filter(
        (edge) => !isReliableCausalEdge(edge) && isCausalOrOwnershipEdge(edge) && edgeTouches(edge, protectedNodes),
      )
      .map((edge) => edge.id),
  );
  const accountedFrontierIds = sortedUnique(touchingFrontiers.map((frontier) => frontier.id));
  const reasons: string[] = [];
  if (starts.length === 0) reasons.push('No matched anchor node starts the corridor.');
  if (outcomes.length === 0) reasons.push('No proved mechanical outcome is reachable from a matched anchor.');
  if (unresolvedFrontierIds.length > 0)
    reasons.push(`${unresolvedFrontierIds.length} unsupported frontier(s) touch the protected corridor.`);
  if (unresolvedEdgeIds.length > 0)
    reasons.push(`${unresolvedEdgeIds.length} candidate or unknown edge(s) touch the protected corridor.`);
  const status: CausalCorridorStatus = reasons.length === 0 ? 'complete' : 'incomplete';

  return {
    schemaVersion: 1,
    status,
    startNodeIds: starts,
    outcomeNodeIds: outcomes,
    baseNodeIds: sortedUnique([...baseNodes]),
    baseEdgeIds: sortedUnique([...baseEdges]),
    nodeIds: sortedUnique([...protectedNodes]),
    edgeIds: sortedUnique([...protectedEdges]),
    accountedFrontierIds,
    unresolvedFrontierIds,
    unresolvedEdgeIds,
    coverage: {
      protectedNodes: protectedNodes.size,
      protectedEdges: protectedEdges.size,
      baseNodes: baseNodes.size,
      baseEdges: baseEdges.size,
      accountedFrontiers: accountedFrontierIds.length,
      unresolvedFrontiers: unresolvedFrontierIds.length,
      unresolvedEdges: unresolvedEdgeIds.length,
    },
    explanation:
      status === 'complete'
        ? 'Every proved anchor-to-outcome path is closed over its material causal facts within reported coverage.'
        : reasons.join(' '),
  };
}

/**
 * Keep the corridor subordinate to the preceding topology/behavior selection.
 * Folded repository evidence remains recoverable through frontiers unless its
 * exact source location was selected as a local material fact.
 */
function isSelectedCorridorEvidence(
  edge: ExplorationTopologyEdge,
  focusedNodeIds: ReadonlySet<string> | null,
  focusedEdgeIds: ReadonlySet<string> | null,
  pathEdgeIds: ReadonlySet<string>,
): boolean {
  if (focusedNodeIds === null) return true;
  if (edge.disposition === 'emitted' || pathEdgeIds.has(edge.id) || focusedEdgeIds?.has(edge.id) === true) {
    return true;
  }
  return (edge.semantics ?? []).some((semantic) => {
    if (semantic.family === 'identity' && OWNERSHIP_SUBTYPES.has(semantic.subtype)) {
      return focusedNodeIds.has(edge.toNodeId);
    }
    if (semantic.family === 'contract') {
      return focusedNodeIds.has(edge.fromNodeId) && focusedNodeIds.has(edge.toNodeId);
    }
    if (semantic.family === 'state') return focusedNodeIds.has(edge.fromNodeId);
    if (semantic.family === 'data' || semantic.family === 'temporal') {
      return focusedNodeIds.has(edge.fromNodeId) || focusedNodeIds.has(edge.toNodeId);
    }
    if (semantic.family === 'control') {
      if (isBranchSemantic(semantic)) return focusedNodeIds.has(edge.fromNodeId);
      if (['returns', 'throws'].includes(semantic.subtype)) return focusedNodeIds.has(edge.toNodeId);
      if (semantic.subtype === 'completion-callback') {
        return focusedNodeIds.has(edge.fromNodeId) || focusedNodeIds.has(edge.toNodeId);
      }
    }
    return false;
  });
}

/** Recompute the required corridor and identify any protected fact omitted by a rendered packet. */
export function auditCausalCorridor(
  topology: ExplorationTopology,
  corridor: ExplorationCausalCorridor,
  options: CausalCorridorOptions = {},
): CausalCorridorAudit {
  const expected = buildCausalCorridor(topology, options);
  const actualStarts = new Set(corridor.startNodeIds);
  const actualOutcomes = new Set(corridor.outcomeNodeIds);
  const actualNodes = new Set(corridor.nodeIds);
  const actualEdges = new Set(corridor.edgeIds);
  const actualFrontiers = new Set(corridor.accountedFrontierIds);
  const actualUnresolvedFrontiers = new Set(corridor.unresolvedFrontierIds);
  const actualUnresolvedEdges = new Set(corridor.unresolvedEdgeIds);
  const obligations: CausalCorridorObligation[] = [];

  addMissing(
    obligations,
    'start',
    expected.startNodeIds,
    actualStarts,
    'matched anchor is absent from the start manifest',
  );
  addMissing(
    obligations,
    'outcome',
    expected.outcomeNodeIds,
    actualOutcomes,
    'mechanical outcome is absent from the outcome manifest',
  );
  addMissing(obligations, 'node', expected.nodeIds, actualNodes, 'material corridor node is absent');
  addMissing(obligations, 'edge', expected.edgeIds, actualEdges, 'material causal relationship is absent');
  addMissing(
    obligations,
    'frontier',
    expected.accountedFrontierIds,
    actualFrontiers,
    'touching frontier is not accounted',
  );
  addMissing(
    obligations,
    'frontier',
    expected.unresolvedFrontierIds,
    actualUnresolvedFrontiers,
    'unsupported frontier is absent from the unresolved manifest',
  );
  addMissing(
    obligations,
    'edge',
    expected.unresolvedEdgeIds,
    actualUnresolvedEdges,
    'candidate or unknown edge is absent from the unresolved manifest',
  );

  return {
    status: obligations.length === 0 && expected.status === 'complete' ? 'complete' : 'incomplete',
    missingObligations: uniqueObligations(obligations),
    unexpectedNodeIds: sortedUnique(corridor.nodeIds.filter((id) => !expected.nodeIds.includes(id))),
    unexpectedEdgeIds: sortedUnique(corridor.edgeIds.filter((id) => !expected.edgeIds.includes(id))),
  };
}

function closeMaterialFacts(
  reliableEdges: readonly ExplorationTopologyEdge[],
  protectedNodes: Set<string>,
  protectedEdges: Set<string>,
  focusedNodeIds: ReadonlySet<string> | null,
  focusedEdgeIds: ReadonlySet<string> | null,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of reliableEdges) {
      if (!isClosureEdge(edge, protectedNodes, focusedNodeIds, focusedEdgeIds)) continue;
      if (!protectedEdges.has(edge.id)) {
        protectedEdges.add(edge.id);
        changed = true;
      }
      if (!protectedNodes.has(edge.fromNodeId)) {
        protectedNodes.add(edge.fromNodeId);
        changed = true;
      }
      if (!protectedNodes.has(edge.toNodeId)) {
        protectedNodes.add(edge.toNodeId);
        changed = true;
      }
    }
  }
}

function isClosureEdge(
  edge: ExplorationTopologyEdge,
  protectedNodes: ReadonlySet<string>,
  focusedNodeIds: ReadonlySet<string> | null,
  focusedEdgeIds: ReadonlySet<string> | null,
): boolean {
  const fromProtected = protectedNodes.has(edge.fromNodeId);
  const toProtected = protectedNodes.has(edge.toNodeId);
  if (!fromProtected && !toProtected) return false;
  return (edge.semantics ?? []).some((semantic) => {
    if (semantic.family === 'identity') {
      return (
        OWNERSHIP_SUBTYPES.has(semantic.subtype) &&
        (toProtected || focusedNodeIds === null || focusedNodeIds.has(edge.toNodeId))
      );
    }
    if (semantic.family === 'contract') return true;
    if (semantic.family === 'state') {
      return fromProtected && (focusedNodeIds === null || focusedNodeIds.has(edge.fromNodeId));
    }
    if (semantic.family === 'temporal') {
      if (semantic.subtype === 'lexical-successor') return fromProtected && toProtected;
      return true;
    }
    if (semantic.family === 'data') {
      return (
        toProtected &&
        (fromProtected ||
          focusedNodeIds === null ||
          focusedNodeIds.has(edge.fromNodeId) ||
          focusedEdgeIds?.has(edge.id) === true)
      );
    }
    if (semantic.family === 'control') {
      if (isNavigationSemantic(semantic)) return false;
      if (
        ['returns', 'throws'].includes(semantic.subtype) &&
        !toProtected &&
        focusedNodeIds !== null &&
        !focusedNodeIds.has(edge.toNodeId)
      ) {
        return false;
      }
      return (
        EXPLICIT_CONTROL_OUTCOMES.has(semantic.subtype) ||
        isBranchSemantic(semantic) ||
        semantic.subtype === 'completion-callback'
      );
    }
    return false;
  });
}

function mechanicalOutcomeNodeIds(forward: ReadonlySet<string>, edges: readonly ExplorationTopologyEdge[]): string[] {
  const explicit = new Set<string>();
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const edge of edges) {
    if (!forward.has(edge.fromNodeId) || !forward.has(edge.toNodeId)) continue;
    outgoing.set(edge.fromNodeId, (outgoing.get(edge.fromNodeId) ?? 0) + 1);
    incoming.set(edge.toNodeId, (incoming.get(edge.toNodeId) ?? 0) + 1);
    if (
      (edge.semantics ?? []).some(
        (semantic) =>
          semantic.family === 'state' ||
          (semantic.family === 'control' && EXPLICIT_CONTROL_OUTCOMES.has(semantic.subtype)),
      )
    ) {
      explicit.add(edge.toNodeId);
    }
  }
  for (const nodeId of forward) {
    if ((incoming.get(nodeId) ?? 0) > 0 && (outgoing.get(nodeId) ?? 0) === 0) explicit.add(nodeId);
  }
  return sortedUnique([...explicit]);
}

function reachable(
  starts: readonly string[],
  edges: readonly ExplorationTopologyEdge[],
  direction: 'forward' | 'backward',
): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const from = direction === 'forward' ? edge.fromNodeId : edge.toNodeId;
    const to = direction === 'forward' ? edge.toNodeId : edge.fromNodeId;
    const targets = adjacency.get(from) ?? [];
    targets.push(to);
    adjacency.set(from, targets);
  }
  const visited = new Set(starts);
  const queue = [...starts];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return visited;
}

function isTraversableEdge(
  edge: ExplorationTopologyEdge,
  focusedNodeIds: ReadonlySet<string> | null,
  focusedEdgeIds: ReadonlySet<string> | null,
  focusedEdgeNodeIds: ReadonlySet<string> | null,
  nodeById: ReadonlyMap<string, ExplorationTopologyNode>,
  pathEdgeIds: ReadonlySet<string>,
): boolean {
  return (edge.semantics ?? []).some((semantic) => {
    if (edge.disposition === 'emitted' || pathEdgeIds.has(edge.id)) return true;
    if (semantic.family === 'identity' && OWNERSHIP_SUBTYPES.has(semantic.subtype)) {
      return (
        focusedNodeIds === null || focusedNodeIds.has(edge.toNodeId) || focusedEdgeNodeIds?.has(edge.toNodeId) === true
      );
    }
    if (!TRAVERSAL_FAMILIES.has(semantic.family)) return false;
    if (isNavigationSemantic(semantic)) return false;
    if (semantic.family === 'control' && ['returns', 'throws'].includes(semantic.subtype) && focusedNodeIds !== null) {
      return focusedNodeIds.has(edge.toNodeId);
    }
    if (focusedNodeIds === null) return true;
    if (semantic.family === 'state') return focusedNodeIds.has(edge.fromNodeId);
    if (semantic.family === 'data') {
      return (
        focusedNodeIds.has(edge.fromNodeId) ||
        focusedNodeIds.has(edge.toNodeId) ||
        focusedEdgeIds?.has(edge.id) === true
      );
    }
    if (semantic.family === 'temporal') {
      if (semantic.subtype === 'lexical-successor') {
        return focusedNodeIds.has(edge.fromNodeId) && focusedNodeIds.has(edge.toNodeId);
      }
      return focusedNodeIds.has(edge.fromNodeId) || focusedNodeIds.has(edge.toNodeId);
    }
    if (semantic.family === 'control') {
      return (
        isSameOwnerProgramEdge(edge, nodeById) &&
        (focusedNodeIds.has(edge.fromNodeId) || focusedNodeIds.has(edge.toNodeId))
      );
    }
    return false;
  });
}

function isNavigationSemantic(semantic: ProgramEdgeSemantic): boolean {
  return (
    semantic.family === 'control' &&
    ['call', 'discriminator-dispatch', 'result-callback', 'runtime-handoff'].includes(semantic.subtype)
  );
}

function isSameOwnerProgramEdge(
  edge: ExplorationTopologyEdge,
  nodeById: ReadonlyMap<string, ExplorationTopologyNode>,
): boolean {
  const from = nodeById.get(edge.fromNodeId);
  const to = nodeById.get(edge.toNodeId);
  if (!from || !to) return false;
  const fromOwner = stringNodeAttribute(from, 'ownerNodeId') ?? (from.kind === 'symbol' ? from.id : null);
  const toOwner = stringNodeAttribute(to, 'ownerNodeId') ?? (to.kind === 'symbol' ? to.id : null);
  return fromOwner !== null && fromOwner === toOwner;
}

function focusedProgramNodeIds(
  nodes: readonly ExplorationTopologyNode[],
  locations: readonly ExplorationSourceLocation[] | undefined,
): Set<string> | null {
  if (!locations) return null;
  const linesByFile = new Map<string, number[]>();
  for (const location of locations) {
    const lines = linesByFile.get(location.file) ?? [];
    lines.push(location.line);
    linesByFile.set(location.file, lines);
  }
  return new Set(
    nodes
      .filter((node) => {
        if (!node.location) return false;
        // Parameter nodes currently inherit their callable's full source range.
        // Treating that range as a parameter-level focus would select every
        // parameter transfer in a large focused function. The transfer edge's
        // exact callsite evidence is the focus authority instead.
        if (node.kind === 'parameter') return false;
        const lines = linesByFile.get(node.location.file) ?? [];
        const endLine = node.location.endLine ?? node.location.line;
        return lines.some((line) => line >= node.location!.line && line <= endLine);
      })
      .map((node) => node.id),
  );
}

function focusedProgramEdgeIds(
  edges: readonly ExplorationTopologyEdge[],
  locations: readonly ExplorationSourceLocation[] | undefined,
): Set<string> | null {
  if (!locations) return null;
  const linesByFile = new Map<string, number[]>();
  for (const location of locations) {
    const lines = linesByFile.get(location.file) ?? [];
    lines.push(location.line);
    linesByFile.set(location.file, lines);
  }
  return new Set(
    edges
      .filter((edge) =>
        edge.evidence.some((evidence) => {
          if (!evidence.location) return false;
          const lines = linesByFile.get(evidence.location.file) ?? [];
          const endLine = evidence.location.endLine ?? evidence.location.line;
          return lines.some((line) => line >= evidence.location!.line && line <= endLine);
        }),
      )
      .map((edge) => edge.id),
  );
}

function focusedProgramEdgeNodeIds(
  edges: readonly ExplorationTopologyEdge[],
  focusedEdgeIds: ReadonlySet<string> | null,
): Set<string> | null {
  if (focusedEdgeIds === null) return null;
  return new Set(
    edges.filter((edge) => focusedEdgeIds.has(edge.id)).flatMap((edge) => [edge.fromNodeId, edge.toNodeId]),
  );
}

function stringNodeAttribute(node: ExplorationTopologyNode, name: string): string | null {
  const value = node.attributes[name];
  return typeof value === 'string' ? value : null;
}

function isReliableCausalEdge(edge: ExplorationTopologyEdge): boolean {
  if (edge.disposition === 'excluded' || edge.disposition === 'unsupported') return false;
  if (!isCausalOrOwnershipEdge(edge)) return false;
  return edge.evidence.some((evidence) => evidence.strength === 'exact' || evidence.strength === 'derived');
}

function isCausalOrOwnershipEdge(edge: ExplorationTopologyEdge): boolean {
  return (edge.semantics ?? []).some(
    (semantic) => semantic.family !== 'identity' || OWNERSHIP_SUBTYPES.has(semantic.subtype),
  );
}

function isBranchSemantic(semantic: ProgramEdgeSemantic): boolean {
  return (
    semantic.subtype.startsWith('predicate-') ||
    semantic.subtype.startsWith('loop-') ||
    semantic.subtype.startsWith('exception-') ||
    semantic.subtype.startsWith('finally-') ||
    semantic.subtype.startsWith('handler-')
  );
}

function edgeTouches(edge: ExplorationTopologyEdge, nodes: ReadonlySet<string>): boolean {
  return nodes.has(edge.fromNodeId) || nodes.has(edge.toNodeId);
}

function frontierTouches(frontier: ExplorationFrontierGroup, nodes: ReadonlySet<string>): boolean {
  return [...frontier.fromNodeIds, ...frontier.memberNodeIds].some((nodeId) => nodes.has(nodeId));
}

function addMissing(
  target: CausalCorridorObligation[],
  kind: CausalCorridorObligation['kind'],
  expectedIds: readonly string[],
  actualIds: ReadonlySet<string>,
  reason: string,
): void {
  for (const id of expectedIds) if (!actualIds.has(id)) target.push({ kind, id, reason });
}

function uniqueObligations(obligations: readonly CausalCorridorObligation[]): CausalCorridorObligation[] {
  const seen = new Set<string>();
  return obligations.filter((obligation) => {
    const key = `${obligation.kind}:${obligation.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
