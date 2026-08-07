import type { ScipDatabase } from '../../storage/db.js';
import {
  sourceStateTemporalAnalysis,
  type SourceProgramConstruct,
} from '../../source/facts/state-temporal-analysis.js';
import type {
  ExplorationFrontierGroup,
  ExplorationTopologyEdge,
  ExplorationTopologyNode,
  ProgramEdgeSemantic,
} from '../internal/exploration-topology.js';

export interface ProgramStateTemporalElements {
  nodes: ExplorationTopologyNode[];
  edges: ExplorationTopologyEdge[];
  frontiers: ExplorationFrontierGroup[];
  blindSpots: string[];
}

export interface RuntimeStateObservation {
  observationId: string;
  action: string;
  strength: 'exact' | 'derived' | 'candidate';
  file: string;
  line: number;
  address: string;
  ownerShortName?: string | null;
  protocol?: string;
  role?: string;
  modality?: 'must' | 'may' | 'unknown';
  resolution?: 'locally-linked' | 'external' | 'unresolved' | 'ambiguous';
  keyParts?: ReadonlyArray<{ name: string; value: string; evidence: string }>;
}

export function programStateTemporalElementsForTopologyNodes(
  db: ScipDatabase,
  topologyNodes: readonly ExplorationTopologyNode[],
  runtimeStateObservations: readonly RuntimeStateObservation[] = [],
): ProgramStateTemporalElements {
  const nodes = new Map<string, ExplorationTopologyNode>();
  const edges = new Map<string, ExplorationTopologyEdge>();
  const frontiers = new Map<string, ExplorationFrontierGroup>();
  const blindSpots = new Set<string>();

  for (const owner of topologyNodes) {
    if (!owner.location || !['source-construct', 'symbol'].includes(owner.kind)) continue;
    const endLine = owner.location.endLine ?? owner.location.line;
    const analysis = sourceStateTemporalAnalysis(db, owner.location.file, owner.location.line, endLine);
    if (!analysis) {
      blindSpots.add(
        `State and temporal analysis unavailable for ${owner.location.file}:${owner.location.line + 1}-${endLine + 1}: no supported syntax tree or covering construct.`,
      );
      continue;
    }

    for (const mutation of analysis.mutations) {
      const event = topologySourceNode(owner, mutation.event);
      const resource = topologyResourceNode(owner, mutation.resource, mutation.durabilityClass);
      nodes.set(event.id, event);
      nodes.set(resource.id, resource);
      addOwnerEdge(edges, owner, event, 'contains-state-effect');
      addEdge(edges, {
        kind: 'state-resource',
        from: event,
        to: resource,
        semantics: [
          {
            family: 'state',
            subtype: mutation.operation === 'delete' ? 'deletes-resource' : 'writes-resource',
            attributes: {
              operation: mutation.operation,
              durabilityClass: mutation.durabilityClass,
              resource: mutation.resource.label,
              recordIdentity: mutation.recordIdentity,
              transactionMembership: 'unknown',
            },
          },
        ],
        method: 'parser-state-mutation',
        identity: mutation.event.label,
      });
      if (mutation.value && mutation.dataSubtype) {
        const value = topologySourceNode(owner, mutation.value);
        nodes.set(value.id, value);
        addEdge(edges, {
          kind: 'data-to-state',
          from: value,
          to: resource,
          semantics: [
            {
              family: 'data',
              subtype: mutation.dataSubtype,
              attributes: {
                operation: mutation.operation,
                resource: mutation.resource.label,
                recordIdentity: mutation.recordIdentity,
                value: mutation.value.label,
              },
            },
          ],
          method: 'parser-assignment-value',
          identity: `${mutation.value.label} -> ${mutation.resource.label}`,
        });
      }
    }

    for (const fact of analysis.temporal) {
      const from = topologySourceNode(owner, fact.from);
      const to = topologySourceNode(owner, fact.to);
      nodes.set(from.id, from);
      nodes.set(to.id, to);
      addOwnerEdge(edges, owner, from, fact.from.kind === 'lock' ? 'contains-lock-scope' : 'contains-event');
      addOwnerEdge(edges, owner, to, 'contains-event');
      addEdge(edges, {
        kind: 'temporal-order',
        from,
        to,
        semantics: [
          {
            family: 'temporal',
            subtype: fact.subtype,
            context: fact.synchronizationScope ? { synchronizationScope: fact.synchronizationScope } : undefined,
            attributes: { ...fact.attributes },
          },
        ],
        method: fact.subtype === 'inside-lock-scope' ? 'parser-synchronized-scope' : 'parser-program-order',
        identity: `${fact.from.label} -> ${fact.to.label}`,
      });
    }

    for (const unsupported of analysis.unsupported) {
      const unsupportedNodeId = id(
        `${unsupported.family}-unsupported`,
        owner.location.file,
        String(unsupported.startLine),
        String(unsupported.endLine),
        unsupported.reason,
      );
      nodes.set(unsupportedNodeId, {
        id: unsupportedNodeId,
        kind: `${unsupported.family}-unsupported`,
        label: unsupported.reason,
        disposition: 'unsupported',
        location: {
          file: owner.location.file,
          line: unsupported.startLine,
          endLine: unsupported.endLine,
        },
        anchorIds: [],
        attributes: { ownerNodeId: owner.id },
      });
      const edgeId = id('edge', `${unsupported.family}-unsupported`, owner.id, unsupportedNodeId);
      edges.set(edgeId, {
        id: edgeId,
        kind: `${unsupported.family}-unsupported`,
        fromNodeId: owner.id,
        toNodeId: unsupportedNodeId,
        directed: true,
        disposition: 'unsupported',
        semantics: [{ family: unsupported.family, subtype: `unresolved-${unsupported.family}-construct` }],
        evidence: [
          {
            method: `parser-${unsupported.family}-construct`,
            strength: 'exact',
            identity: unsupported.reason,
            location: {
              file: owner.location.file,
              line: unsupported.startLine,
              endLine: unsupported.endLine,
            },
          },
        ],
      });
      const frontierId = id('frontier', unsupported.family, unsupportedNodeId);
      frontiers.set(frontierId, {
        id: frontierId,
        kind: unsupported.family,
        direction: 'unresolved',
        fromNodeIds: [owner.id],
        edgeIds: [edgeId],
        memberNodeIds: [unsupportedNodeId],
        memberCount: 1,
        disposition: 'unsupported',
        reason: unsupported.reason,
        expansion: null,
      });
    }
  }

  for (const participant of topologyNodes.filter((node) => node.kind === 'runtime-boundary-participant')) {
    const protocol = stringAttribute(participant, 'protocol');
    const action = stringAttribute(participant, 'action');
    const address = stringAttribute(participant, 'address') ?? participant.label;
    if (!protocol || !action || !isStatefulRuntimeAction(protocol, action)) continue;
    addRuntimeStateObservation(nodes, edges, participant, {
      observationId: participant.id,
      action,
      strength: 'exact',
      file: participant.location?.file ?? '',
      line: participant.location?.line ?? 0,
      address,
      protocol,
      role: stringAttribute(participant, 'role') ?? undefined,
      resolution: 'locally-linked',
    });
  }

  for (const observation of runtimeStateObservations) {
    if (!observation.protocol || !isStatefulRuntimeAction(observation.protocol, observation.action)) continue;
    const owner = mostSpecificOwner(
      topologyNodes,
      observation.file,
      observation.line,
      observation.ownerShortName ?? null,
    );
    if (!owner) {
      blindSpots.add(
        `State observation ${observation.observationId} at ${observation.file}:${observation.line + 1} has no materialized owner node.`,
      );
      continue;
    }
    addRuntimeStateObservation(nodes, edges, owner, observation);
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    frontiers: [...frontiers.values()],
    blindSpots: [...blindSpots].sort(),
  };
}

function addRuntimeStateObservation(
  nodes: Map<string, ExplorationTopologyNode>,
  edges: Map<string, ExplorationTopologyEdge>,
  owner: ExplorationTopologyNode,
  observation: RuntimeStateObservation,
): void {
  const resource = runtimeResource(observation);
  const eventId = id('runtime-state-event', observation.observationId);
  const event: ExplorationTopologyNode = {
    id: eventId,
    kind: 'runtime-state-event',
    label: `${observation.action} ${resource}`,
    disposition: 'folded',
    location: { file: observation.file, line: observation.line },
    anchorIds: [],
    attributes: {
      action: observation.action,
      protocol: observation.protocol ?? null,
      modality: observation.modality ?? null,
      resolution: observation.resolution ?? null,
    },
  };
  const durabilityClass = observation.protocol === 'database' ? 'external-durable-intent' : 'external';
  const resourceNode: ExplorationTopologyNode = {
    id: id('runtime-state-resource', observation.protocol ?? 'unknown', resource),
    kind: 'runtime-state-resource',
    label: resource,
    disposition: 'folded',
    location: { file: observation.file, line: observation.line },
    anchorIds: [],
    attributes: { protocol: observation.protocol ?? null, durabilityClass },
  };
  nodes.set(event.id, event);
  nodes.set(resourceNode.id, resourceNode);
  addOwnerEdge(edges, owner, event, 'contains-runtime-state-effect');
  const subtype = runtimeStateSubtype(observation.action);
  addEdge(edges, {
    kind: 'runtime-state-resource',
    from: event,
    to: resourceNode,
    semantics: [
      {
        family: 'state',
        subtype,
        context: { crossesRuntimeBoundary: true, protocol: observation.protocol },
        attributes: {
          operation: observation.action,
          durabilityClass,
          resource,
          recordIdentity: runtimeRecordIdentity(observation),
          modality: observation.modality ?? null,
          resolution: observation.resolution ?? null,
          transactionMembership: 'unknown',
          commitState: observation.protocol === 'database' ? 'unknown' : null,
        },
      },
    ],
    method: `runtime-boundary-${observation.strength}`,
    identity: observation.observationId,
  });
}

function runtimeStateSubtype(action: string): string {
  if (action === 'database.read') return 'reads-resource';
  if (action === 'queue.send') return 'enqueues-resource';
  if (action === 'queue.consume') return 'consumes-resource';
  return 'writes-resource';
}

function runtimeResource(observation: RuntimeStateObservation): string {
  const resource = observation.keyParts?.find((part) => ['address', 'resource'].includes(part.name));
  return (resource?.value ?? observation.address) || observation.observationId;
}

function runtimeRecordIdentity(observation: RuntimeStateObservation): string | null {
  const identity = observation.keyParts?.find((part) => /^(?:id|key|record)$/u.test(part.name));
  return identity?.value ?? null;
}

function isStatefulRuntimeAction(protocol: string, action: string): boolean {
  return (
    (protocol === 'database' && ['database.read', 'database.write'].includes(action)) ||
    (protocol === 'queue' && ['queue.consume', 'queue.send'].includes(action))
  );
}

function stringAttribute(node: ExplorationTopologyNode, name: string): string | null {
  const value = node.attributes[name];
  return typeof value === 'string' ? value : null;
}

function mostSpecificOwner(
  nodes: readonly ExplorationTopologyNode[],
  file: string,
  line: number,
  ownerShortName: string | null,
): ExplorationTopologyNode | null {
  const sourceOwners = nodes.filter(
    (node) => node.location?.file === file && ['source-construct', 'symbol'].includes(node.kind),
  );
  const containing = sourceOwners
    .filter((node) => node.location!.line <= line && (node.location!.endLine ?? node.location!.line) >= line)
    .sort(compareNodeSpan)[0];
  if (containing) return containing;
  if (ownerShortName) {
    const named = sourceOwners.find(
      (node) =>
        node.label === ownerShortName ||
        node.label.endsWith(`.${ownerShortName}`) ||
        node.label.includes(ownerShortName),
    );
    if (named) return named;
  }
  return sourceOwners.length === 1 ? sourceOwners[0]! : null;
}

function compareNodeSpan(left: ExplorationTopologyNode, right: ExplorationTopologyNode): number {
  const leftSpan = (left.location?.endLine ?? left.location?.line ?? 0) - (left.location?.line ?? 0);
  const rightSpan = (right.location?.endLine ?? right.location?.line ?? 0) - (right.location?.line ?? 0);
  return leftSpan - rightSpan;
}

function topologySourceNode(
  owner: ExplorationTopologyNode,
  construct: SourceProgramConstruct,
): ExplorationTopologyNode {
  const file = owner.location!.file;
  return {
    id: id(`program-${construct.kind}`, file, String(construct.startLine), String(construct.endLine), construct.label),
    kind: `program-${construct.kind}`,
    label: construct.label,
    disposition: 'folded',
    location: { file, line: construct.startLine, endLine: construct.endLine },
    anchorIds: [],
    attributes: { ownerNodeId: owner.id, constructKind: construct.kind },
  };
}

function topologyResourceNode(
  owner: ExplorationTopologyNode,
  construct: SourceProgramConstruct,
  durabilityClass: string,
): ExplorationTopologyNode {
  const file = owner.location!.file;
  return {
    id: id('program-resource', file, owner.id, construct.label, durabilityClass),
    kind: 'program-resource',
    label: construct.label,
    disposition: 'folded',
    location: { file, line: construct.startLine, endLine: construct.endLine },
    anchorIds: [],
    attributes: { ownerNodeId: owner.id, durabilityClass },
  };
}

function addOwnerEdge(
  edges: Map<string, ExplorationTopologyEdge>,
  owner: ExplorationTopologyNode,
  child: ExplorationTopologyNode,
  subtype: string,
): void {
  const edgeId = id('edge', 'program-owner', owner.id, child.id, subtype);
  if (edges.has(edgeId)) return;
  edges.set(edgeId, {
    id: edgeId,
    kind: 'program-owner',
    fromNodeId: owner.id,
    toNodeId: child.id,
    directed: true,
    disposition: 'folded',
    semantics: [{ family: 'identity', subtype }],
    evidence: [
      {
        method: 'parser-program-owner',
        strength: 'exact',
        identity: owner.id,
        location: child.location,
      },
    ],
  });
}

function addEdge(
  edges: Map<string, ExplorationTopologyEdge>,
  input: {
    kind: string;
    from: ExplorationTopologyNode;
    to: ExplorationTopologyNode;
    semantics: ProgramEdgeSemantic[];
    method: string;
    identity: string;
  },
): void {
  const edgeId = id('edge', input.kind, input.from.id, input.to.id, input.semantics[0]!.subtype);
  edges.set(edgeId, {
    id: edgeId,
    kind: input.kind,
    fromNodeId: input.from.id,
    toNodeId: input.to.id,
    directed: true,
    disposition: 'folded',
    semantics: input.semantics,
    evidence: [
      {
        method: input.method,
        strength: 'exact',
        identity: input.identity,
        location: input.from.location,
      },
    ],
  });
}

function id(...parts: readonly string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}
