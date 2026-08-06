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
      blindSpots: uniqueSorted(input.blindSpots ?? []),
      explanation:
        status === 'accounted'
          ? 'Every node and edge discovered within the declared query scope is emitted, folded with recoverable identity, explicitly excluded, or reported unsupported.'
          : `The declared query scope is not fully accounted for: ${incompleteReasons.join('; ')}`,
    },
  };
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
