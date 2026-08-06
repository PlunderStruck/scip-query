import { describe, expect, it } from 'vitest';
import {
  createExplorationTopology,
  selectExplorationTopology,
  type ExplorationTopologyInput,
} from '../../../src/queries/internal/exploration-topology.js';

describe('universal exploration topology', () => {
  it('accounts for compiler and runtime edges without repository-specific node kinds', () => {
    const topology = createExplorationTopology(fixtureInput());

    expect(topology.schemaVersion).toBe(1);
    expect(topology.edges.map((edge) => [edge.kind, edge.evidence[0]?.strength])).toEqual([
      ['compiler:call', 'exact'],
      ['runtime:http.method-path', 'derived'],
    ]);
    expect(topology.coverage).toMatchObject({
      status: 'accounted',
      nodes: { total: 3, emitted: 2, folded: 1, excluded: 0, unsupported: 0 },
      edges: { total: 2, emitted: 1, folded: 1, excluded: 0, unsupported: 0 },
      matchedAnchors: 2,
      frontierGroups: 1,
    });
    expect(topology.frontiers[0]).toMatchObject({
      memberNodeIds: ['consumer'],
      memberCount: 1,
      edgeIds: ['runtime-edge'],
    });
  });

  it('rejects an edge whose endpoint cannot be recovered', () => {
    const input = fixtureInput();
    input.edges = [{ ...input.edges[0]!, toNodeId: 'missing-node' }, input.edges[1]!];

    expect(() => createExplorationTopology(input)).toThrow(
      'Exploration edge compiler-edge references missing node(s): missing-node',
    );
  });

  it('rejects a frontier whose count hides unidentified members', () => {
    const input = fixtureInput();
    input.frontiers = [{ ...input.frontiers![0]!, memberCount: 2 }];

    expect(() => createExplorationTopology(input)).toThrow(
      'Exploration frontier runtime-frontier reports 2 member(s) but identifies 1.',
    );
  });

  it('reports incomplete coverage without converting missing evidence into absence', () => {
    const topology = createExplorationTopology({
      ...fixtureInput(),
      incompleteReasons: ['one ambiguous compiler candidate was omitted'],
    });

    expect(topology.coverage.status).toBe('incomplete');
    expect(topology.coverage.explanation).toContain('one ambiguous compiler candidate was omitted');
  });

  it('selects anchor connectors and folds the remaining component with exact membership', () => {
    const selected = selectExplorationTopology(createExplorationTopology(fixtureInput()), { maxSelectedNodes: 2 });

    expect(selected.nodes.filter((node) => node.disposition === 'emitted').map((node) => node.id)).toEqual([
      'collector',
      'consumer',
    ]);
    expect(selected.paths).toEqual([
      expect.objectContaining({
        status: 'connected',
        nodeIds: ['collector', 'consumer'],
        edgeIds: ['runtime-edge'],
      }),
    ]);
    expect(selected.frontiers).toEqual([
      expect.objectContaining({
        fromNodeIds: ['collector'],
        memberNodeIds: ['stage'],
        memberCount: 1,
        edgeIds: ['compiler-edge'],
      }),
    ]);
    expect(selected.coverage).toMatchObject({
      nodes: { total: 3, emitted: 2, folded: 1 },
      edges: { total: 2, emitted: 1, folded: 1 },
    });
  });

  it('expands a frontier losslessly and reconstructs the oracle graph', () => {
    const topology = createExplorationTopology(fixtureInput());
    const selected = selectExplorationTopology(topology, { maxSelectedNodes: 2 });
    const expanded = selectExplorationTopology(topology, {
      maxSelectedNodes: 2,
      expandedFrontierIds: selected.frontiers.map((frontier) => frontier.id),
    });

    expect(expanded.nodes.filter((node) => node.disposition === 'emitted').map((node) => node.id)).toEqual(
      topology.nodes.map((node) => node.id),
    );
    expect(expanded.edges.filter((edge) => edge.disposition === 'emitted').map((edge) => edge.id)).toEqual(
      topology.edges.map((edge) => edge.id),
    );
    expect(expanded.frontiers).toEqual([]);
  });

  it('accounts for edges deeper than the first folded frontier edge', () => {
    const input = fixtureInput();
    input.nodes = [
      ...input.nodes,
      {
        id: 'bootstrap',
        kind: 'symbol',
        label: 'bootstrapRuntimeBoundaries',
        disposition: 'folded',
        location: { file: 'src/reindex/bootstrap.ts', line: 5 },
        anchorIds: [],
        attributes: {},
      },
    ];
    input.edges = [
      ...input.edges,
      {
        id: 'bootstrap-edge',
        kind: 'compiler:call',
        fromNodeId: 'bootstrap',
        toNodeId: 'stage',
        directed: true,
        disposition: 'folded',
        evidence: [
          {
            method: 'semantic-callee',
            strength: 'exact',
            identity: 'bootstrap -> stage',
            location: { file: 'src/reindex/bootstrap.ts', line: 8 },
          },
        ],
      },
    ];

    const selected = selectExplorationTopology(createExplorationTopology(input), { maxSelectedNodes: 2 });

    expect(selected.frontiers).toEqual([
      expect.objectContaining({
        memberNodeIds: ['bootstrap', 'stage'],
        edgeIds: ['bootstrap-edge', 'compiler-edge'],
      }),
    ]);
  });
});

function fixtureInput(): ExplorationTopologyInput {
  return {
    scope: 'two explicit anchors, depth 2, compiler calls and supported runtime boundaries',
    anchors: [
      {
        id: 'anchor:collector',
        kind: 'symbol',
        query: 'collectRuntimeBoundaryGraph',
        status: 'matched',
        nodeIds: ['collector'],
        candidateNodeIds: [],
        omittedCandidates: 0,
      },
      {
        id: 'anchor:consumer',
        kind: 'symbol',
        query: 'systemMap',
        status: 'matched',
        nodeIds: ['consumer'],
        candidateNodeIds: [],
        omittedCandidates: 0,
      },
    ],
    nodes: [
      {
        id: 'stage',
        kind: 'symbol',
        label: 'runtimeBoundaryAugmentationStage',
        disposition: 'emitted',
        location: { file: 'src/reindex/post-index.ts', line: 40 },
        anchorIds: [],
        attributes: {},
      },
      {
        id: 'collector',
        kind: 'symbol',
        label: 'collectRuntimeBoundaryGraph',
        disposition: 'emitted',
        location: { file: 'src/analysis/runtime-boundaries/collect.ts', line: 10 },
        anchorIds: ['anchor:collector'],
        attributes: {},
      },
      {
        id: 'consumer',
        kind: 'symbol',
        label: 'systemMap',
        disposition: 'folded',
        location: { file: 'src/queries/graph/system-map.ts', line: 335 },
        anchorIds: ['anchor:consumer'],
        attributes: {},
      },
    ],
    edges: [
      {
        id: 'compiler-edge',
        kind: 'compiler:call',
        fromNodeId: 'stage',
        toNodeId: 'collector',
        directed: true,
        disposition: 'emitted',
        evidence: [
          {
            method: 'semantic-callee',
            strength: 'exact',
            identity: 'stage -> collector',
            location: { file: 'src/reindex/post-index.ts', line: 44 },
          },
        ],
      },
      {
        id: 'runtime-edge',
        kind: 'runtime:http.method-path',
        fromNodeId: 'collector',
        toNodeId: 'consumer',
        directed: true,
        disposition: 'folded',
        evidence: [
          {
            method: 'framework-adapter:http.method-path',
            strength: 'derived',
            identity: 'POST /api/v1/runtime-boundaries',
            location: { file: 'src/analysis/runtime-boundaries/collect.ts', line: 80 },
          },
        ],
      },
    ],
    paths: [],
    frontiers: [
      {
        id: 'runtime-frontier',
        kind: 'runtime:http.method-path',
        direction: 'outgoing',
        fromNodeIds: ['collector'],
        edgeIds: ['runtime-edge'],
        memberNodeIds: ['consumer'],
        memberCount: 1,
        disposition: 'folded',
        reason: 'not selected in the current packet',
        expansion: 'scip-query explore --frontier runtime-frontier',
      },
    ],
  };
}
