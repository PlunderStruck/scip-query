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

  it('renders complete local control decisions instead of replacing predicates and sibling outcomes with counts', () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)));
    const owner = node('owner', 'execute()', 0);
    const predicate = node('predicate', 'if (!allowed)', 2, 'owner', 'control-predicate');
    const blocked = node('blocked', "return { action: 'block' }", 3, 'owner', 'control-outcome');
    const allowed = node('allowed', "return { action: 'allow' }", 5, 'owner', 'control-outcome');
    const edges = [
      edge('blocked-edge', 'predicate', 'blocked', 'control', 'branch-consequence'),
      edge('allowed-edge', 'predicate', 'allowed', 'control', 'branch-alternative'),
    ];
    const topology = createExplorationTopology({
      scope: 'renderer control fixture',
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
      nodes: [owner, predicate, blocked, allowed],
      edges,
    });
    topology.corridor = {
      schemaVersion: 1,
      status: 'complete',
      startNodeIds: ['owner'],
      outcomeNodeIds: ['blocked', 'allowed'],
      baseNodeIds: ['owner', 'predicate', 'blocked', 'allowed'],
      baseEdgeIds: edges.map(({ id }) => id),
      nodeIds: topology.nodes.map(({ id }) => id),
      edgeIds: edges.map(({ id }) => id),
      accountedFrontierIds: [],
      unresolvedFrontierIds: [],
      unresolvedEdgeIds: [],
      coverage: {
        protectedNodes: topology.nodes.length,
        protectedEdges: edges.length,
        baseNodes: 4,
        baseEdges: 2,
        accountedFrontiers: 0,
        unresolvedFrontiers: 0,
        unresolvedEdges: 0,
      },
      explanation: 'fixture',
    };

    renderCausalCorridor(topology);

    const decision = output.find((line) => line.includes('[local-control]')) ?? '';
    expect(decision).toContain('if (!allowed)');
    expect(decision).toContain("branch-consequence → return { action: 'block' }");
    expect(decision).toContain("branch-alternative → return { action: 'allow' }");

    output.length = 0;
    renderCausalCorridor(topology, {
      status: 'connected',
      steps: [
        {
          id: 'step:owner',
          nodeId: 'owner',
          order: 0,
          role: 'anchor',
          kind: 'symbol',
          label: 'execute()',
          location: owner.location,
          behavior: {
            kind: 'connector-slice',
            constructKind: 'function',
            signature: 'execute()',
            lines: [
              { line: 2, endLine: 2, depth: 0, signals: ['branch'], text: 'if (!allowed)', copied: true },
              {
                line: 3,
                endLine: 3,
                depth: 1,
                signals: ['return'],
                text: "return { action: 'block' }",
                copied: true,
              },
              {
                line: 5,
                endLine: 5,
                depth: 0,
                signals: ['return'],
                text: "return { action: 'allow' }",
                copied: true,
              },
            ],
            coverage: { sourceStatements: 3, representedStatements: 3, copiedStatements: 3, omittedStatements: 0 },
            rawCharacters: 80,
            renderedCharacters: 70,
          },
        },
      ],
      transitions: [],
      paths: [],
      coverage: {
        candidateNodes: 1,
        returnedNodes: 1,
        omittedNodeIds: [],
        returnedTransitions: 0,
        withheldStatements: 0,
        requestedFocusLocations: [],
        matchedFocusLocations: [],
        unmatchedFocusLocations: [],
      },
      behaviorCommand: null,
      exactSourceCommand: null,
    });
    const summarized = output.find((line) => line.includes('[local-control]')) ?? '';
    expect(summarized).toContain('branch-alternative×1');
    expect(summarized).toContain('branch-consequence×1');
    expect(summarized).not.toContain('if (!allowed)');
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
    family: 'control' | 'data' | 'state' | 'temporal',
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
