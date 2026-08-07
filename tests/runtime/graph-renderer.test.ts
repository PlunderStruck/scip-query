import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createExplorationTopology,
  type ExplorationTopologyEdge,
  type ExplorationTopologyNode,
} from '../../src/queries/internal/exploration-topology.js';
import { renderCausalCorridor } from '../../src/runtime/query-commands/graph.js';

describe('causal corridor renderer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('groups repetitive transfer and temporal evidence while retaining material state facts', () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)));
    const owner = node('owner', 'execute()', 0);
    const callOne = node('call-one', 'dispatch(events)', 2, 'owner');
    const callTwo = node('call-two', 'dispatch(result)', 3, 'owner');
    const parameterOne = node('parameter-one', 'events', 10, 'owner', 'parameter');
    const parameterTwo = node('parameter-two', 'result', 10, 'owner', 'parameter');
    const awaitOne = node('await-one', 'await first()', 4, 'owner');
    const awaitTwo = node('await-two', 'await second()', 5, 'owner');
    const resource = node('resource', 'session.status', 6, 'owner', 'program-resource');
    const edges = [
      edge('transfer-one', 'call-one', 'parameter-one', 'data', 'argument-to-parameter'),
      edge('transfer-two', 'call-two', 'parameter-two', 'data', 'argument-to-parameter'),
      edge('await-one', 'call-one', 'await-one', 'temporal', 'awaits-completion'),
      edge('await-two', 'call-two', 'await-two', 'temporal', 'awaits-completion'),
      edge('write-status', 'call-two', 'resource', 'state', 'writes-resource'),
    ];
    const topology = createExplorationTopology({
      scope: 'renderer grouping fixture',
      anchors: [
        {
          id: 'anchor:owner',
          kind: 'symbol',
          query: 'execute',
          status: 'matched',
          nodeIds: ['owner'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
      ],
      nodes: [owner, callOne, callTwo, parameterOne, parameterTwo, awaitOne, awaitTwo, resource],
      edges,
    });
    topology.corridor = {
      schemaVersion: 1,
      status: 'complete',
      startNodeIds: ['owner'],
      outcomeNodeIds: ['resource'],
      baseNodeIds: ['owner', 'resource'],
      baseEdgeIds: ['write-status'],
      nodeIds: topology.nodes.map(({ id }) => id),
      edgeIds: edges.map(({ id }) => id),
      accountedFrontierIds: [],
      unresolvedFrontierIds: [],
      unresolvedEdgeIds: [],
      coverage: {
        protectedNodes: topology.nodes.length,
        protectedEdges: edges.length,
        baseNodes: 2,
        baseEdges: 1,
        accountedFrontiers: 0,
        unresolvedFrontiers: 0,
        unresolvedEdges: 0,
      },
      explanation: 'fixture',
    };

    renderCausalCorridor(topology);

    const transferLines = output.filter((line) => line.includes('[data:argument-to-parameter; grouped]'));
    const awaitLines = output.filter((line) => line.includes('[temporal:awaits-completion; grouped]'));
    expect(transferLines).toHaveLength(1);
    expect(transferLines[0]).toContain('2 proved edge(s); 2 parameter target(s)');
    expect(awaitLines).toHaveLength(1);
    expect(awaitLines[0]).toContain('2 proved edge(s)');
    expect(output.some((line) => line.includes('[state:writes-resource]'))).toBe(true);
    expect(output.some((line) => line.includes('[state:writes-resource; grouped]'))).toBe(false);
  });
});

function node(
  id: string,
  label: string,
  line: number,
  ownerNodeId?: string,
  kind: ExplorationTopologyNode['kind'] = 'program-event',
): ExplorationTopologyNode {
  return {
    id,
    kind,
    label,
    disposition: 'folded',
    location: { file: 'src/fixture.ts', line },
    anchorIds: id === 'owner' ? ['anchor:owner'] : [],
    attributes: ownerNodeId ? { ownerNodeId, ownerSymbol: 'execute' } : {},
  };
}

function edge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  family: 'data' | 'state' | 'temporal',
  subtype: string,
): ExplorationTopologyEdge {
  return {
    id,
    kind: `program:${family}`,
    fromNodeId,
    toNodeId,
    directed: true,
    disposition: 'folded',
    semantics: [{ family, subtype }],
    evidence: [{ method: 'fixture', strength: 'exact', identity: id, location: null }],
  };
}
