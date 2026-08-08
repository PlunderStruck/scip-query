import { describe, expect, it } from 'vitest';
import {
  catalogExplorationRoutes,
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

  it('keeps topology selection invariant when only anchor query vocabulary changes', () => {
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
    const relabeledInput: ExplorationTopologyInput = {
      ...input,
      anchors: input.anchors.map((anchor) => ({ ...anchor, query: 'completely unrelated vocabulary' })),
    };
    const relabeled = selectExplorationTopology(createExplorationTopology(relabeledInput), { maxSelectedNodes: 5 });

    expect(selected.nodes.map((entry) => [entry.id, entry.disposition])).toEqual(
      relabeled.nodes.map((entry) => [entry.id, entry.disposition]),
    );
    expect(selected.nodes.filter((entry) => entry.disposition === 'emitted').map((entry) => entry.id)).toEqual([
      'config',
      'producer',
      'registry',
    ]);
    expect(selected.nodes.find((entry) => entry.id === 'controller')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'service')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'unrelated')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'schema')?.disposition).toBe('folded');
  });

  it('adds a true connector junction without crawling through a merely high-degree neighbor', () => {
    const input: ExplorationTopologyInput = {
      scope: 'two selected owners with one shared connector and one popular neighbor',
      anchors: [
        {
          id: 'anchor:paths',
          kind: 'symbol',
          query: 'left right paths',
          status: 'matched',
          nodeIds: ['left', 'right'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
      ],
      nodes: [
        node('left', 'leftPath', ['anchor:paths']),
        node('right', 'rightPath', ['anchor:paths']),
        node('junction', 'sharedConnector'),
        node('popular', 'genericHelper'),
        node('other', 'otherCaller'),
      ],
      edges: [
        edge('left-junction', 'call', 'left', 'junction', 'exact'),
        edge('right-junction', 'call', 'right', 'junction', 'exact'),
        edge('left-popular', 'call', 'left', 'popular', 'exact'),
        edge('other-popular', 'call', 'other', 'popular', 'exact'),
      ],
    };

    const selected = selectExplorationTopology(createExplorationTopology(input), {
      maxSelectedNodes: 3,
      maxUpstreamCausalPaths: 0,
    });

    expect(selected.nodes.find((entry) => entry.id === 'junction')?.disposition).toBe('emitted');
    expect(selected.nodes.find((entry) => entry.id === 'popular')?.disposition).toBe('folded');
  });

  it('does not emit a callee merely because its name overlaps anchor query vocabulary', () => {
    const input: ExplorationTopologyInput = {
      scope: 'an agent request anchor with an unrelated same-directory callee',
      anchors: [
        {
          id: 'anchor:request',
          kind: 'symbol',
          query: 'compact messages summary',
          status: 'matched',
          nodeIds: ['request'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
      ],
      nodes: [
        node('request', 'src:agent:runRequest', ['anchor:request']),
        node('compact', 'src:agent:compactMessagesWithSummary'),
      ],
      edges: [edge('request-compact', 'call', 'request', 'compact', 'exact')],
    };

    const selected = selectExplorationTopology(createExplorationTopology(input), {
      maxUpstreamCausalPaths: 0,
    });

    expect(selected.nodes.find((entry) => entry.id === 'compact')?.disposition).toBe('folded');
  });

  it('does not prepend unrelated callers when multiple anchors already define the exploration corridor', () => {
    const input: ExplorationTopologyInput = {
      scope: 'a public entry anchor connected to its downstream operation',
      anchors: [
        {
          id: 'anchor:entry',
          kind: 'symbol',
          query: 'request dispatch',
          status: 'matched',
          nodeIds: ['entry'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
        {
          id: 'anchor:operation',
          kind: 'symbol',
          query: 'operation execute',
          status: 'matched',
          nodeIds: ['operation'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
      ],
      nodes: [
        node('unrelated-caller', 'unrelatedCaller'),
        node('entry', 'dispatchRequest', ['anchor:entry']),
        node('operation', 'executeOperation', ['anchor:operation']),
      ],
      edges: [
        edge('caller-entry', 'call', 'unrelated-caller', 'entry', 'exact'),
        edge('entry-operation', 'call', 'entry', 'operation', 'exact'),
      ],
    };

    const selected = selectExplorationTopology(createExplorationTopology(input));

    expect(selected.nodes.find((entry) => entry.id === 'entry')?.disposition).toBe('emitted');
    expect(selected.nodes.find((entry) => entry.id === 'operation')?.disposition).toBe('emitted');
    expect(selected.nodes.find((entry) => entry.id === 'unrelated-caller')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'unrelated-caller')?.attributes).not.toHaveProperty(
      'upstreamCausalPath',
    );
  });

  it('catalogues upstream public paths without selecting any unrequested route', () => {
    const input: ExplorationTopologyInput = {
      scope: 'two independent implementations with public callers',
      anchors: [
        {
          id: 'anchor:first',
          kind: 'symbol',
          query: 'first implementation',
          status: 'matched',
          nodeIds: ['first'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
        {
          id: 'anchor:second',
          kind: 'symbol',
          query: 'second implementation',
          status: 'matched',
          nodeIds: ['second'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
      ],
      nodes: [
        {
          ...node('public-first', 'POST /first'),
          attributes: { publicEntry: true, publicEntryPriority: 2 },
        },
        {
          ...node('public-first-alt', 'POST /first_async'),
          attributes: { publicEntry: true, publicEntryPriority: 2 },
        },
        {
          ...node('public-second', 'OpenCode.second'),
          attributes: { publicEntry: true, publicEntryPriority: 2 },
        },
        node('first', 'firstImplementation', ['anchor:first']),
        node('second', 'secondImplementation', ['anchor:second']),
        node('internal-first', 'internalFirstCaller'),
      ],
      edges: [
        edge('public-first-call', 'call', 'public-first', 'first', 'exact'),
        edge('public-first-alt-call', 'call', 'public-first-alt', 'first', 'exact'),
        edge('public-second-call', 'call', 'public-second', 'second', 'exact'),
        edge('internal-first-call', 'call', 'internal-first', 'first', 'exact'),
      ],
    };

    const selected = selectExplorationTopology(createExplorationTopology(input));

    expect(selected.routeCatalog?.routes.map((route) => route.endpointNodeId)).toEqual([
      'public-first-alt',
      'public-first',
      'public-second',
    ]);
    expect(selected.nodes.find((entry) => entry.id === 'public-first')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'public-first-alt')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'public-second')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'internal-first')?.disposition).toBe('folded');
    expect(selected.nodes.every((entry) => entry.attributes['upstreamCausalEndpoint'] === undefined)).toBe(true);
  });

  it('does not connect unrelated anchors by walking backward through a structural region', () => {
    const input: ExplorationTopologyInput = {
      scope: 'two anchors exported from one structural region without a causal path between them',
      anchors: [
        {
          id: 'anchor:left',
          kind: 'symbol',
          query: 'left operation',
          status: 'matched',
          nodeIds: ['left'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
        {
          id: 'anchor:right',
          kind: 'symbol',
          query: 'right operation',
          status: 'matched',
          nodeIds: ['right'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
      ],
      nodes: [
        { ...node('region', 'root:feature'), kind: 'structural-region' },
        node('left', 'leftOperation', ['anchor:left']),
        node('right', 'rightOperation', ['anchor:right']),
      ],
      edges: [
        edge('region-left', 'call', 'region', 'left', 'derived'),
        edge('region-right', 'call', 'region', 'right', 'derived'),
      ],
    };

    const selected = selectExplorationTopology(createExplorationTopology(input));

    expect(selected.paths).toEqual([expect.objectContaining({ status: 'partial', nodeIds: [], edgeIds: [] })]);
    expect(selected.nodes.find((entry) => entry.id === 'region')?.disposition).toBe('folded');
  });

  it('does not connect anchors by zig-zagging backward through a shared callee', () => {
    const input: ExplorationTopologyInput = {
      scope: 'two callers share a callee but neither causes the other',
      anchors: [
        {
          id: 'anchor:left',
          kind: 'symbol',
          query: 'left operation',
          status: 'matched',
          nodeIds: ['left'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
        {
          id: 'anchor:right',
          kind: 'symbol',
          query: 'right operation',
          status: 'matched',
          nodeIds: ['right'],
          candidateNodeIds: [],
          omittedCandidates: 0,
        },
      ],
      nodes: [
        node('left', 'leftOperation', ['anchor:left']),
        node('right', 'rightOperation', ['anchor:right']),
        node('shared', 'sharedCallee'),
      ],
      edges: [
        edge('left-shared', 'call', 'left', 'shared', 'exact'),
        edge('right-shared', 'call', 'right', 'shared', 'exact'),
      ],
    };

    const selected = selectExplorationTopology(createExplorationTopology(input));

    expect(selected.paths).toEqual([expect.objectContaining({ status: 'partial', nodeIds: [], edgeIds: [] })]);
    expect(selected.nodes.find((entry) => entry.id === 'shared')?.disposition).toBe('folded');
  });

  it('keeps a proved runtime route folded until its route id is requested', () => {
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

    expect(selected.routeCatalog?.routes).toEqual([
      expect.objectContaining({ endpointNodeId: 'endpoint', endpointKind: 'runtime-boundary' }),
    ]);
    expect(selected.nodes.filter((entry) => entry.disposition === 'emitted').map((entry) => entry.id)).toEqual([
      'compact',
    ]);
    expect(selected.nodes.find((entry) => entry.id === 'endpoint')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'handler')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'service')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'noise')?.disposition).toBe('folded');
    expect(selected.edges.filter((entry) => entry.disposition === 'emitted')).toEqual([]);
  });

  it('does not invent an upstream route to a traversal root', () => {
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

    expect(selected.routeCatalog?.routes).toEqual([]);
    expect(selected.nodes.find((entry) => entry.id === 'root')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'root')?.attributes).not.toHaveProperty(
      'upstreamCausalEndpoint',
    );
    expect(selected.nodes.find((entry) => entry.id === 'candidate-endpoint')?.disposition).toBe('folded');
    expect(selected.edges.find((entry) => entry.id === 'candidate-boundary')?.disposition).toBe('folded');
  });

  it('catalogues a proved public entry without automatically preferring it', () => {
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

    expect(selected.routeCatalog?.routes).toEqual([
      expect.objectContaining({ endpointNodeId: 'public', endpointKind: 'public-entry' }),
    ]);
    expect(selected.nodes.find((entry) => entry.id === 'public')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'adapter')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'internal-root')?.disposition).toBe('folded');
  });

  it('catalogues explicit and wildcard public entries without choosing between them', () => {
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

    expect(selected.routeCatalog?.routes.map((route) => route.endpointNodeId)).toEqual(['explicit', 'wildcard']);
    expect(selected.nodes.find((entry) => entry.id === 'explicit')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'wildcard')?.disposition).toBe('folded');
  });

  it('catalogues every public entry without applying repository-area diversity selection', () => {
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

    expect(selected.routeCatalog?.routes.map((route) => route.endpointNodeId)).toEqual([
      'prompt-async',
      'compat',
      'prompt',
    ]);
    expect(selected.nodes.find((entry) => entry.id === 'prompt')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'prompt-async')?.disposition).toBe('folded');
    expect(selected.nodes.find((entry) => entry.id === 'compat')?.disposition).toBe('folded');
  });

  it('catalogues every distinct proved endpoint and selects several stable routes together', () => {
    const input: ExplorationTopologyInput = {
      scope: 'one effect with two public routes, one runtime route, and non-control evidence',
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
        { ...node('prompt', 'POST /prompt'), attributes: { publicEntry: true, publicEntryPriority: 2 } },
        { ...node('prompt-async', 'POST /prompt_async'), attributes: { publicEntry: true, publicEntryPriority: 2 } },
        node('adapter', 'promptAdapter'),
        node('runtime-producer', 'work_session_stream_events'),
        node('effect', 'persistPrompt', ['anchor:effect']),
        node('state', 'promptStore'),
      ],
      edges: [
        {
          ...edge('prompt-call', 'call', 'prompt', 'adapter', 'exact'),
          semantics: [{ family: 'control', subtype: 'call' }],
        },
        {
          ...edge('adapter-call', 'call', 'adapter', 'effect', 'derived'),
          semantics: [{ family: 'control', subtype: 'call' }],
        },
        {
          ...edge('prompt-async-call', 'call', 'prompt-async', 'effect', 'exact'),
          semantics: [{ family: 'control', subtype: 'call' }],
        },
        {
          ...edge('runtime-call', 'runtime-boundary', 'runtime-producer', 'effect', 'derived'),
          semantics: [
            { family: 'control', subtype: 'runtime-handoff', context: { crossesRuntimeBoundary: true } },
            { family: 'data', subtype: 'serialized-transfer', context: { crossesRuntimeBoundary: true } },
            { family: 'temporal', subtype: 'enqueue-before-consume' },
          ],
        },
        {
          ...edge('state-write', 'state-write', 'effect', 'state', 'exact'),
          semantics: [{ family: 'state', subtype: 'write' }],
        },
        {
          ...edge('contract', 'contract-symbol', 'effect', 'state', 'exact'),
          semantics: [{ family: 'contract', subtype: 'implements' }],
        },
      ],
    };
    const topology = createExplorationTopology(input);
    const catalog = catalogExplorationRoutes(topology);

    expect(catalog.coverage).toMatchObject({
      status: 'accounted',
      enumeration: 'one-shortest-proved-path-per-endpoint',
      anchorsWithRoutes: ['effect'],
      anchorsWithoutRoutes: [],
      routeCount: 3,
    });
    expect(catalog.routes.map((route) => route.endpointNodeId)).toEqual(['prompt-async', 'runtime-producer', 'prompt']);
    expect(catalog.routes.find((route) => route.endpointNodeId === 'runtime-producer')).toMatchObject({
      endpointKind: 'runtime-boundary',
      crossesRuntimeBoundary: true,
      spineEdgeFamilies: ['control', 'data', 'temporal'],
      relatedEdgeFamilies: ['contract', 'control', 'data', 'state', 'temporal'],
    });

    const selectedRouteIds = catalog.routes
      .filter((route) => route.endpointNodeId !== 'prompt-async')
      .map((route) => route.id);
    const selected = selectExplorationTopology(topology, {
      routeIds: selectedRouteIds,
      maxSelectedNodes: 1,
      maxUpstreamCausalPaths: 0,
      maxUpstreamCausalNodes: 0,
    });

    expect(selected.routeCatalog?.selectedRouteIds).toEqual([...selectedRouteIds].sort());
    expect(selected.nodes.find((entry) => entry.id === 'prompt')?.disposition).toBe('emitted');
    expect(selected.nodes.find((entry) => entry.id === 'runtime-producer')?.disposition).toBe('emitted');
    expect(selected.nodes.find((entry) => entry.id === 'prompt-async')?.disposition).toBe('folded');
    expect(() => selectExplorationTopology(topology, { routeIds: ['route:missing'] })).toThrow(
      'Unknown exploration route id(s): route:missing',
    );
    expect(
      catalogExplorationRoutes(createExplorationTopology({ ...input, nodes: [...input.nodes].reverse() })).routes,
    ).toEqual(catalog.routes);
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
