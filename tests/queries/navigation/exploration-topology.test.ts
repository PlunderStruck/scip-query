import { describe, expect, it } from 'vitest';
import {
  createExplorationTopology,
  projectProgramEdges,
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
      programEdges: {
        sourceEdges: 2,
        mappedSourceEdges: 2,
        projectedEdges: 2,
        unmappedSourceEdges: 0,
        unmappedKinds: [],
        families: { control: { sourceEdges: 2, projectedEdges: 2, subtypes: ['call', 'runtime-handoff'] } },
      },
    });
    expect(projectProgramEdges(topology.edges)).toMatchObject([
      {
        sourceEdgeId: 'compiler-edge',
        sourceKind: 'compiler:call',
        family: 'control',
        subtype: 'call',
        evidence: [{ method: 'semantic-callee', strength: 'exact' }],
      },
      {
        sourceEdgeId: 'runtime-edge',
        sourceKind: 'runtime:http.method-path',
        family: 'control',
        subtype: 'runtime-handoff',
        context: { crossesRuntimeBoundary: true, protocol: 'http' },
        evidence: [{ method: 'framework-adapter:http.method-path', strength: 'derived' }],
      },
    ]);
    expect(topology.frontiers[0]).toMatchObject({
      memberNodeIds: ['consumer'],
      memberCount: 1,
      edgeIds: ['runtime-edge'],
    });
    expect(topology.completion).toMatchObject({ status: 'frontier-accounted' });
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
    expect(topology.completion?.status).toBe('coverage-incomplete');
  });

  it('selects anchor connectors and folds the remaining component with exact membership', () => {
    const selected = selectExplorationTopology(createExplorationTopology(fixtureInput()), {
      maxSelectedNodes: 2,
      maxUpstreamCausalPaths: 0,
    });

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
    expect(selected.completion?.status).toBe('connector-complete');
  });

  it('expands a frontier losslessly and reconstructs the oracle graph', () => {
    const topology = createExplorationTopology(fixtureInput());
    const selected = selectExplorationTopology(topology, {
      maxSelectedNodes: 2,
      maxUpstreamCausalPaths: 0,
    });
    const expanded = selectExplorationTopology(topology, {
      maxSelectedNodes: 2,
      maxUpstreamCausalPaths: 0,
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

    const selected = selectExplorationTopology(createExplorationTopology(input), {
      maxSelectedNodes: 2,
      maxUpstreamCausalPaths: 0,
    });

    expect(selected.frontiers).toEqual([
      expect.objectContaining({
        memberNodeIds: ['bootstrap', 'stage'],
        edgeIds: ['bootstrap-edge', 'compiler-edge'],
      }),
    ]);
  });

  it('selects a query-aligned causal spine before unrelated junctions', () => {
    const input: ExplorationTopologyInput = {
      scope: 'one literal query with multiple exact owners',
      anchors: [
        {
          id: 'anchor:stream-events',
          kind: 'literal',
          query: 'work_session_stream_events',
          status: 'matched',
          nodeIds: ['producer', 'config'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
      ],
      nodes: [
        node('producer', 'appendWorkSessionStreamEvents', ['anchor:stream-events']),
        node('config', 'workSessionScopes', ['anchor:stream-events']),
        node('registry', 'workSessionStreamEvents'),
        node('controller', 'workSessionStreamEventsController'),
        node('service', 'appendWorkSessionStreamEventsService'),
        node('unrelated', 'buildRequest'),
        node('schema', 'agentWorkSessionEvents'),
      ],
      edges: [
        edge('runtime', 'runtime-boundary', 'producer', 'registry', 'derived'),
        edge('controller-call', 'call', 'registry', 'controller', 'candidate'),
        edge('service-call', 'call', 'controller', 'service', 'exact'),
        edge('unrelated-call', 'call', 'config', 'unrelated', 'exact'),
        edge('schema-reference', 'reference', 'service', 'schema', 'exact'),
      ],
    };

    const selected = selectExplorationTopology(createExplorationTopology(input), { maxSelectedNodes: 5 });

    expect(selected.nodes.filter((entry) => entry.disposition === 'emitted').map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['producer', 'config', 'registry', 'controller', 'service']),
    );
    expect(selected.nodes.find((entry) => entry.id === 'unrelated')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'schema')?.disposition).toBe('folded');
  });

  it('selects a proved upstream path through the nearest runtime boundary', () => {
    const input: ExplorationTopologyInput = {
      scope: 'one implementation anchor with a proved external activation path',
      anchors: [
        {
          id: 'anchor:compact',
          kind: 'symbol',
          query: 'compact',
          status: 'matched',
          nodeIds: ['compact'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
      ],
      nodes: [
        node('endpoint', 'POST /session/prompt'),
        node('handler', 'promptHandler'),
        node('service', 'Sessions.prompt'),
        node('compact', 'processCompaction', ['anchor:compact']),
        node('noise', 'unrelatedCaller'),
      ],
      edges: [
        edge('http-boundary', 'runtime-boundary', 'endpoint', 'handler', 'derived'),
        edge('handler-call', 'call', 'handler', 'service', 'exact'),
        edge('service-call', 'call', 'service', 'compact', 'exact'),
        edge('noise-call', 'call', 'noise', 'handler', 'candidate'),
      ],
    };

    const selected = selectExplorationTopology(createExplorationTopology(input), {
      maxSelectedNodes: 1,
      maxUpstreamCausalPaths: 1,
      maxUpstreamCausalNodes: 3,
    });

    expect(selected.nodes.filter((entry) => entry.disposition === 'emitted').map((entry) => entry.id)).toEqual([
      'compact',
      'endpoint',
      'handler',
      'service',
    ]);
    expect(selected.nodes.find((entry) => entry.id === 'endpoint')?.attributes).toMatchObject({
      upstreamCausalPath: true,
      upstreamCausalDistance: 3,
      upstreamCausalEndpoint: 'runtime-boundary',
    });
    expect(selected.nodes.find((entry) => entry.id === 'noise')?.disposition).toBe('folded');
    expect(selected.edges.filter((entry) => entry.disposition === 'emitted').map((entry) => entry.id)).toEqual([
      'handler-call',
      'http-boundary',
      'service-call',
    ]);
  });

  it('labels the earliest proved caller as a traversal root without crossing candidate-only evidence', () => {
    const input: ExplorationTopologyInput = {
      scope: 'one implementation anchor whose earlier runtime relationship is only a candidate',
      anchors: [
        {
          id: 'anchor:effect',
          kind: 'symbol',
          query: 'effect',
          status: 'matched',
          nodeIds: ['effect'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
      ],
      nodes: [
        node('candidate-endpoint', 'POST /candidate'),
        node('root', 'runRequest'),
        node('effect', 'writeEffect', ['anchor:effect']),
      ],
      edges: [
        edge('candidate-boundary', 'runtime-boundary', 'candidate-endpoint', 'root', 'candidate'),
        edge('root-call', 'call', 'root', 'effect', 'exact'),
      ],
    };

    const selected = selectExplorationTopology(createExplorationTopology(input), {
      maxSelectedNodes: 1,
      maxUpstreamCausalPaths: 1,
      maxUpstreamCausalNodes: 2,
    });

    expect(selected.nodes.find((entry) => entry.id === 'root')?.attributes).toMatchObject({
      upstreamCausalEndpoint: 'traversal-root',
      upstreamCausalDistance: 1,
    });
    expect(selected.nodes.find((entry) => entry.id === 'candidate-endpoint')?.disposition).toBe('folded');
    expect(selected.edges.find((entry) => entry.id === 'candidate-boundary')?.disposition).toBe('folded');
  });

  it('prefers a proved public entry path over a nearer internal traversal root', () => {
    const input: ExplorationTopologyInput = {
      scope: 'one effect with internal and externally reachable causal owners',
      anchors: [
        {
          id: 'anchor:effect',
          kind: 'symbol',
          query: 'effect',
          status: 'matched',
          nodeIds: ['effect'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
      ],
      nodes: [
        { ...node('public', 'OpenCode.sessions.prompt'), attributes: { publicEntry: true } },
        node('adapter', 'sessions.prompt'),
        node('effect', 'writeEffect', ['anchor:effect']),
        node('internal-root', 'runTurn'),
      ],
      edges: [
        edge('public-call', 'call', 'public', 'adapter', 'exact'),
        edge('adapter-call', 'call', 'adapter', 'effect', 'exact'),
        edge('internal-call', 'call', 'internal-root', 'effect', 'exact'),
      ],
    };

    const selected = selectExplorationTopology(createExplorationTopology(input), {
      maxSelectedNodes: 1,
      maxUpstreamCausalPaths: 1,
      maxUpstreamCausalNodes: 2,
    });

    expect(selected.nodes.find((entry) => entry.id === 'public')?.attributes).toMatchObject({
      upstreamCausalEndpoint: 'public-entry',
      upstreamCausalDistance: 2,
    });
    expect(selected.nodes.find((entry) => entry.id === 'adapter')?.disposition).toBe('emitted');
    expect(selected.nodes.find((entry) => entry.id === 'internal-root')?.disposition).toBe('folded');
  });

  it('prefers an explicit public entry over a shorter wildcard package surface', () => {
    const input: ExplorationTopologyInput = {
      scope: 'one effect with two public ownership paths of different precision',
      anchors: [
        {
          id: 'anchor:effect',
          kind: 'symbol',
          query: 'effect',
          status: 'matched',
          nodeIds: ['effect'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
      ],
      nodes: [
        { ...node('explicit', 'OpenCode.sessions.prompt'), attributes: { publicEntry: true, publicEntryPriority: 2 } },
        { ...node('wildcard', 'internalLayer'), attributes: { publicEntry: true, publicEntryPriority: 1 } },
        node('effect', 'writeEffect', ['anchor:effect']),
      ],
      edges: [
        edge('explicit-call', 'call', 'explicit', 'wildcard', 'exact'),
        edge('wildcard-call', 'call', 'wildcard', 'effect', 'exact'),
      ],
    };

    const selected = selectExplorationTopology(createExplorationTopology(input), {
      maxSelectedNodes: 1,
      maxUpstreamCausalPaths: 1,
      maxUpstreamCausalNodes: 2,
    });

    expect(selected.nodes.find((entry) => entry.id === 'explicit')?.attributes).toMatchObject({
      upstreamCausalEndpoint: 'public-entry',
      upstreamCausalDistance: 2,
    });
    expect(selected.nodes.find((entry) => entry.id === 'wildcard')?.disposition).toBe('emitted');
  });

  it('does not let area diversity displace stronger entry evidence', () => {
    const input: ExplorationTopologyInput = {
      scope: 'two exact operations in one API area and one weaker operation elsewhere',
      anchors: [
        {
          id: 'anchor:effect',
          kind: 'symbol',
          query: 'effect',
          status: 'matched',
          nodeIds: ['effect'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
      ],
      nodes: [
        {
          ...node('prompt', 'POST /session/:id/prompt'),
          location: { file: 'packages/api/src/prompt.ts', line: 0 },
          attributes: { publicEntry: true, publicEntryPriority: 2 },
        },
        {
          ...node('prompt-async', 'POST /session/:id/prompt_async'),
          location: { file: 'packages/api/src/prompt-async.ts', line: 0 },
          attributes: { publicEntry: true, publicEntryPriority: 2 },
        },
        {
          ...node('compat', 'compatibilityLayer'),
          location: { file: 'packages/core/src/compat.ts', line: 0 },
          attributes: { publicEntry: true, publicEntryPriority: 1 },
        },
        node('effect', 'processCompaction', ['anchor:effect']),
      ],
      edges: [
        edge('prompt-call', 'call', 'prompt', 'effect', 'exact'),
        edge('prompt-async-call', 'call', 'prompt-async', 'effect', 'exact'),
        edge('compat-call', 'call', 'compat', 'effect', 'exact'),
      ],
    };

    const selected = selectExplorationTopology(createExplorationTopology(input), {
      maxSelectedNodes: 1,
      maxUpstreamCausalPaths: 2,
      maxUpstreamCausalNodes: 2,
    });

    expect(selected.nodes.find((entry) => entry.id === 'prompt')?.disposition).toBe('emitted');
    expect(selected.nodes.find((entry) => entry.id === 'prompt-async')?.disposition).toBe('emitted');
    expect(selected.nodes.find((entry) => entry.id === 'compat')?.disposition).toBe('folded');
  });
});

function node(id: string, label: string, anchorIds: string[] = []) {
  return {
    id,
    kind: 'symbol',
    label,
    disposition: 'folded' as const,
    location: { file: `src/${id}.ts`, line: 0 },
    anchorIds,
    attributes: {},
  };
}

function edge(
  id: string,
  kind: string,
  fromNodeId: string,
  toNodeId: string,
  strength: 'exact' | 'derived' | 'candidate',
) {
  return {
    id,
    kind,
    fromNodeId,
    toNodeId,
    directed: true as const,
    disposition: 'folded' as const,
    evidence: [{ method: id, strength, identity: id, location: null }],
  };
}

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
        semantics: [{ family: 'control', subtype: 'call' }],
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
        semantics: [
          {
            family: 'control',
            subtype: 'runtime-handoff',
            context: { crossesRuntimeBoundary: true, protocol: 'http' },
          },
        ],
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
