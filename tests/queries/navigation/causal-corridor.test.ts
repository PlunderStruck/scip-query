import { describe, expect, it } from 'vitest';
import { auditCausalCorridor, buildCausalCorridor } from '../../../src/queries/internal/causal-corridor.js';
import {
  createExplorationTopology,
  type ExplorationTopology,
  type ExplorationTopologyEdge,
  type ExplorationTopologyNode,
} from '../../../src/queries/internal/exploration-topology.js';

describe('causal corridor', () => {
  it('closes a proved anchor-to-outcome path over predicates, sibling outcomes, values, state, and time', () => {
    const topology = causalFixture();

    const corridor = buildCausalCorridor(topology);

    expect(corridor.status).toBe('complete');
    expect(corridor.startNodeIds).toEqual(['handler']);
    expect(corridor.outcomeNodeIds).toEqual(expect.arrayContaining(['accepted', 'rejected', 'resource']));
    expect(corridor.nodeIds).toEqual(
      expect.arrayContaining([
        'handler',
        'predicate',
        'accepted',
        'rejected',
        'state-event',
        'resource',
        'constant',
        'await-event',
        'notification',
      ]),
    );
    expect(corridor.edgeIds).toEqual(
      expect.arrayContaining([
        'owns-predicate',
        'predicate-accepted',
        'predicate-rejected',
        'returns-accepted',
        'throws-rejected',
        'owns-state',
        'writes-resource',
        'constant-to-resource',
        'owns-await',
        'await-before-notification',
      ]),
    );
    expect(corridor.nodeIds).not.toContain('unrelated');
    expect(corridor.edgeIds).not.toContain('candidate-noise');
    expect(corridor.coverage).toMatchObject({ protectedNodes: 9, unresolvedEdges: 0 });
  });

  it.each([
    ['predicate node', 'node', 'predicate'],
    ['sibling branch', 'edge', 'predicate-rejected'],
    ['terminal outcome', 'edge', 'throws-rejected'],
    ['assigned value', 'edge', 'constant-to-resource'],
    ['state effect', 'edge', 'writes-resource'],
    ['temporal order', 'edge', 'await-before-notification'],
  ] as const)('fails its completeness audit when the %s is removed', (_label, kind, id) => {
    const topology = causalFixture();
    const corridor = buildCausalCorridor(topology);
    const damaged = {
      ...corridor,
      nodeIds: kind === 'node' ? corridor.nodeIds.filter((nodeId) => nodeId !== id) : corridor.nodeIds,
      edgeIds: kind === 'edge' ? corridor.edgeIds.filter((edgeId) => edgeId !== id) : corridor.edgeIds,
    };

    const audit = auditCausalCorridor(topology, damaged);

    expect(audit.status).toBe('incomplete');
    expect(audit.missingObligations).toEqual(expect.arrayContaining([expect.objectContaining({ kind, id })]));
  });

  it.each([
    ['start', 'handler'],
    ['outcome', 'resource'],
  ] as const)('fails its completeness audit when the %s manifest omits %s', (kind, id) => {
    const topology = causalFixture();
    const corridor = buildCausalCorridor(topology);
    const damaged = {
      ...corridor,
      startNodeIds: kind === 'start' ? corridor.startNodeIds.filter((nodeId) => nodeId !== id) : corridor.startNodeIds,
      outcomeNodeIds:
        kind === 'outcome' ? corridor.outcomeNodeIds.filter((nodeId) => nodeId !== id) : corridor.outcomeNodeIds,
    };

    const audit = auditCausalCorridor(topology, damaged);

    expect(audit.status).toBe('incomplete');
    expect(audit.missingObligations).toEqual(expect.arrayContaining([expect.objectContaining({ kind, id })]));
  });

  it('does not traverse candidate-only evidence and reports the unresolved direction', () => {
    const topology = causalFixture();
    topology.edges.push(
      semanticEdge('candidate-effect', 'handler', 'candidate-outcome', 'control', 'call', 'candidate'),
    );
    topology.nodes.push(programNode('candidate-outcome', 'candidateEffect()'));

    const corridor = buildCausalCorridor(topology);

    expect(corridor.nodeIds).not.toContain('candidate-outcome');
    expect(corridor.edgeIds).not.toContain('candidate-effect');
    expect(corridor.unresolvedEdgeIds).toContain('candidate-effect');
    expect(corridor.status).toBe('incomplete');

    const audit = auditCausalCorridor(topology, { ...corridor, unresolvedEdgeIds: [] });
    expect(audit.status).toBe('incomplete');
    expect(audit.missingObligations).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'edge', id: 'candidate-effect' })]),
    );
  });
});

function causalFixture(): ExplorationTopology {
  return createExplorationTopology({
    scope: 'one handler and every proved material outcome',
    anchors: [
      {
        id: 'anchor:handler',
        kind: 'symbol',
        query: 'handleRequest',
        status: 'matched',
        nodeIds: ['handler'],
        candidateNodeIds: [],
        omittedCandidates: 0,
      },
    ],
    nodes: [
      programNode('handler', 'handleRequest()', ['anchor:handler']),
      programNode('predicate', 'if (authorized)'),
      programNode('accepted', 'return response'),
      programNode('rejected', 'throw unauthorized'),
      programNode('state-event', 'record.status = "accepted"'),
      { ...programNode('resource', 'record.status'), kind: 'program-resource' },
      programNode('constant', '"accepted"'),
      programNode('await-event', 'await publish(record)'),
      programNode('notification', 'notify(record)'),
      programNode('unrelated', 'unrelatedHelper()'),
      programNode('unrelated-two', 'anotherUnrelatedHelper()'),
    ],
    edges: [
      semanticEdge('owns-predicate', 'handler', 'predicate', 'identity', 'contains-control'),
      semanticEdge('predicate-accepted', 'predicate', 'accepted', 'control', 'predicate-consequence'),
      semanticEdge('predicate-rejected', 'predicate', 'rejected', 'control', 'predicate-alternative'),
      semanticEdge('returns-accepted', 'handler', 'accepted', 'control', 'returns'),
      semanticEdge('throws-rejected', 'handler', 'rejected', 'control', 'throws'),
      semanticEdge('owns-state', 'handler', 'state-event', 'identity', 'contains-state-effect'),
      semanticEdge('writes-resource', 'state-event', 'resource', 'state', 'writes-resource'),
      semanticEdge('constant-to-resource', 'constant', 'resource', 'data', 'constant-to-state'),
      semanticEdge('owns-await', 'handler', 'await-event', 'identity', 'contains-event'),
      semanticEdge('await-before-notification', 'await-event', 'notification', 'temporal', 'await-completion-before'),
      semanticEdge('candidate-noise', 'unrelated', 'unrelated-two', 'control', 'call', 'candidate'),
    ],
  });
}

function programNode(id: string, label: string, anchorIds: string[] = []): ExplorationTopologyNode {
  return {
    id,
    kind: id === 'handler' ? 'symbol' : 'program-event',
    label,
    disposition: 'folded',
    location: { file: 'src/fixture.ts', line: 0 },
    anchorIds,
    attributes: id === 'handler' ? {} : { ownerNodeId: 'handler' },
  };
}

function semanticEdge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  family: 'identity' | 'control' | 'data' | 'state' | 'temporal',
  subtype: string,
  strength: 'exact' | 'derived' | 'candidate' = 'exact',
): ExplorationTopologyEdge {
  return {
    id,
    kind: `program:${family}`,
    fromNodeId,
    toNodeId,
    directed: true,
    disposition: 'folded',
    semantics: [{ family, subtype }],
    evidence: [{ method: 'fixture', strength, identity: id, location: null }],
  };
}
