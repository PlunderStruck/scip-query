import { behaviorControlAnalysis, type BehaviorControlConstruct } from '../../source/facts/behavior-skeleton.js';
import type { ScipDatabase } from '../../storage/db.js';
import type {
  ExplorationFrontierGroup,
  ExplorationTopologyEdge,
  ExplorationTopologyNode,
} from '../internal/exploration-topology.js';

export interface ProgramControlElements {
  nodes: ExplorationTopologyNode[];
  edges: ExplorationTopologyEdge[];
  frontiers: ExplorationFrontierGroup[];
  blindSpots: string[];
}

/** Project parser-proved control regions for the selected topology owners. */
export function programControlElementsForTopologyNodes(
  db: ScipDatabase,
  topologyNodes: readonly ExplorationTopologyNode[],
): ProgramControlElements {
  const nodes = new Map<string, ExplorationTopologyNode>();
  const edges = new Map<string, ExplorationTopologyEdge>();
  const frontiers = new Map<string, ExplorationFrontierGroup>();
  const blindSpots = new Set<string>();

  for (const owner of topologyNodes) {
    if (!owner.location || !['source-construct', 'symbol'].includes(owner.kind)) continue;
    const endLine = owner.location.endLine ?? owner.location.line;
    const analysis = behaviorControlAnalysis(db, owner.location.file, owner.location.line, endLine);
    if (!analysis) {
      blindSpots.add(
        `Control dependence unavailable for ${owner.location.file}:${owner.location.line + 1}-${endLine + 1}: no supported syntax tree or covering construct.`,
      );
      continue;
    }

    for (const fact of analysis.facts) {
      const controller = topologyControlNode(owner, fact.controller);
      const outcome = topologyControlNode(owner, fact.outcome);
      nodes.set(controller.id, controller);
      nodes.set(outcome.id, outcome);
      addOwnerEdge(edges, owner, controller);
      const edgeId = id('edge', 'control-dependence', controller.id, outcome.id, fact.subtype);
      edges.set(edgeId, {
        id: edgeId,
        kind: 'control-dependence',
        fromNodeId: controller.id,
        toNodeId: outcome.id,
        directed: true,
        disposition: 'folded',
        semantics: [{ family: 'control', subtype: fact.subtype, attributes: { ...fact.attributes } }],
        evidence: [
          {
            method: 'parser-control-dependence',
            strength: 'exact',
            identity: `${owner.location.file}:${fact.controller.startLine + 1}-${fact.outcome.startLine + 1}`,
            location: {
              file: owner.location.file,
              line: fact.controller.startLine,
              endLine: fact.controller.endLine,
            },
          },
        ],
      });
    }

    for (const terminal of analysis.terminals) {
      const terminalNode = topologyControlNode(owner, terminal);
      nodes.set(terminalNode.id, terminalNode);
      const terminalKind =
        terminal.label.startsWith('throw') || terminal.label.startsWith('raise') ? 'throw' : 'return';
      const edgeId = id('edge', 'control-terminal', owner.id, terminalNode.id, terminalKind);
      edges.set(edgeId, {
        id: edgeId,
        kind: 'control-terminal',
        fromNodeId: owner.id,
        toNodeId: terminalNode.id,
        directed: true,
        disposition: 'folded',
        semantics: [{ family: 'control', subtype: terminalKind === 'throw' ? 'throws' : 'returns' }],
        evidence: [
          {
            method: 'parser-terminal-statement',
            strength: 'exact',
            identity: terminal.label,
            location: {
              file: owner.location.file,
              line: terminal.startLine,
              endLine: terminal.endLine,
            },
          },
        ],
      });
    }

    for (const unsupported of analysis.unsupported) {
      const unsupportedNodeId = id(
        'control-unsupported',
        owner.location.file,
        String(unsupported.startLine),
        String(unsupported.endLine),
        unsupported.reason,
      );
      nodes.set(unsupportedNodeId, {
        id: unsupportedNodeId,
        kind: 'control-unsupported',
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
      const edgeId = id('edge', 'control-unsupported', owner.id, unsupportedNodeId);
      edges.set(edgeId, {
        id: edgeId,
        kind: 'control-dependence',
        fromNodeId: owner.id,
        toNodeId: unsupportedNodeId,
        directed: true,
        disposition: 'unsupported',
        semantics: [{ family: 'control', subtype: 'unresolved-control-construct' }],
        evidence: [
          {
            method: 'parser-control-construct',
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
      const frontierId = id('frontier', 'control-dependence', unsupportedNodeId);
      frontiers.set(frontierId, {
        id: frontierId,
        kind: 'control-dependence',
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

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    frontiers: [...frontiers.values()],
    blindSpots: [...blindSpots].sort(),
  };
}

function topologyControlNode(
  owner: ExplorationTopologyNode,
  construct: BehaviorControlConstruct,
): ExplorationTopologyNode {
  const file = owner.location!.file;
  return {
    id: id(`control-${construct.kind}`, file, String(construct.startLine), String(construct.endLine), construct.label),
    kind: `control-${construct.kind}`,
    label: construct.label,
    disposition: 'folded',
    location: { file, line: construct.startLine, endLine: construct.endLine },
    anchorIds: [],
    attributes: {
      ownerNodeId: owner.id,
      constructKind: construct.kind,
      implicit: construct.implicit,
    },
  };
}

function addOwnerEdge(
  edges: Map<string, ExplorationTopologyEdge>,
  owner: ExplorationTopologyNode,
  controller: ExplorationTopologyNode,
): void {
  const edgeId = id('edge', 'control-owner', owner.id, controller.id);
  if (edges.has(edgeId)) return;
  edges.set(edgeId, {
    id: edgeId,
    kind: 'control-owner',
    fromNodeId: owner.id,
    toNodeId: controller.id,
    directed: true,
    disposition: 'folded',
    semantics: [{ family: 'identity', subtype: 'contains-control' }],
    evidence: [
      {
        method: 'parser-control-owner',
        strength: 'exact',
        identity: owner.id,
        location: owner.location,
      },
    ],
  });
}

function id(...parts: readonly string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}
