import { describe, expect, it } from 'vitest';
import type { ArchitectureConfig } from '../../../src/domain/config-types.js';
import {
  analyzeArchitectureGraph,
  detectCoarseBoundaries,
  architectureFindingIdentities,
  hasEnforceableArchitecturePolicy,
} from '../../../src/queries/graph/architecture.js';

function graph(entries: Array<[string, string[]]>): Map<string, Set<string>> {
  return new Map(entries.map(([file, dependencies]) => [file, new Set(dependencies)]));
}

const baseConfig: ArchitectureConfig = {
  boundaries: [
    { name: 'domain', paths: ['src/domain/**'] },
    { name: 'runtime', paths: ['src/runtime/**'] },
  ],
};

describe('architecture graph analysis', () => {
  it('does not infer repository policy when architecture is unconfigured', () => {
    const report = analyzeArchitectureGraph(graph([['src/domain/model.ts', ['src/runtime/start.ts']]]), [
      'src/domain/model.ts',
      'src/runtime/start.ts',
    ]);

    expect(report).toMatchObject({
      configured: false,
      edges: [],
      forbiddenEdges: [],
      policyCoverage: {
        declaredRows: 0,
        totalBoundaries: 0,
        missingRows: [],
        requiresCompletePolicy: false,
      },
    });
    expect(report.coverage).toMatchObject({ totalFiles: 2, mappedFiles: 0 });
  });

  it('groups file dependencies by boundary and applies only declared closed rows', () => {
    const report = analyzeArchitectureGraph(
      graph([
        ['src/domain/model.ts', ['src/runtime/start.ts']],
        ['src/runtime/start.ts', ['src/domain/model.ts']],
        ['src/runtime/worker.ts', ['src/domain/model.ts']],
      ]),
      ['src/domain/model.ts', 'src/runtime/start.ts', 'src/runtime/worker.ts'],
      {
        ...baseConfig,
        allowedDependencies: {
          domain: [],
          runtime: ['domain'],
        },
      },
    );

    expect(report.edges).toEqual([
      expect.objectContaining({
        from: 'domain',
        to: 'runtime',
        policyStatus: 'forbidden',
        fileEdgeCount: 1,
        importerCount: 1,
        importedFileCount: 1,
        examples: [{ fromFile: 'src/domain/model.ts', toFile: 'src/runtime/start.ts' }],
      }),
      expect.objectContaining({
        from: 'runtime',
        to: 'domain',
        policyStatus: 'allowed',
        fileEdgeCount: 2,
        importerCount: 2,
        importedFileCount: 1,
      }),
    ]);
    expect(report.forbiddenEdges).toHaveLength(1);
    expect(report.reciprocalPairs).toHaveLength(1);
    expect(report.cycles[0]).toMatchObject({
      boundaries: ['domain', 'runtime'],
      violatesPolicy: false,
      narrowestEdges: [expect.objectContaining({ from: 'domain', to: 'runtime', fileEdgeCount: 1 })],
    });
  });

  it('keeps outgoing edges undeclared when their source boundary has no policy row', () => {
    const report = analyzeArchitectureGraph(
      graph([['src/runtime/start.ts', ['src/domain/model.ts']]]),
      ['src/domain/model.ts', 'src/runtime/start.ts'],
      {
        ...baseConfig,
        allowedDependencies: { domain: [] },
      },
    );

    expect(report.edges).toEqual([
      expect.objectContaining({
        from: 'runtime',
        to: 'domain',
        policyStatus: 'undeclared',
      }),
    ]);
    expect(report.forbiddenEdges).toEqual([]);
    expect(report.policyCoverage).toEqual({
      declaredRows: 1,
      totalBoundaries: 2,
      missingRows: ['runtime'],
      requiresCompletePolicy: false,
      requiresCompleteCoverage: false,
      requiresMinimalPolicy: false,
    });
  });

  it('surfaces unmapped and ambiguous files instead of evaluating their edges', () => {
    const report = analyzeArchitectureGraph(
      graph([
        ['src/features/orders/model.ts', ['src/runtime/start.ts']],
        ['scripts/generate.ts', ['src/runtime/start.ts']],
      ]),
      ['src/features/orders/model.ts', 'src/runtime/start.ts', 'scripts/generate.ts'],
      {
        boundaries: [
          { name: 'features', paths: ['src/features/**'] },
          { name: 'orders', paths: ['src/features/orders/**'] },
          { name: 'runtime', paths: ['src/runtime/**'] },
        ],
        allowedDependencies: { features: [], orders: [], runtime: [] },
      },
    );

    expect(report.edges).toEqual([]);
    expect(report.coverage.mappedFiles).toBe(1);
    expect(report.coverage.unmappedFiles).toEqual(['scripts/generate.ts']);
    expect(report.coverage.ambiguousFiles).toEqual([
      {
        file: 'src/features/orders/model.ts',
        boundaries: ['features', 'orders'],
      },
    ]);
  });

  it('turns unmapped and ambiguous ownership into policy findings only when complete coverage is required', () => {
    const dependencyGraph = graph([
      ['src/features/orders/model.ts', ['src/runtime/start.ts']],
      ['scripts/generate.ts', ['src/runtime/start.ts']],
    ]);
    const files = ['src/features/orders/model.ts', 'src/runtime/start.ts', 'scripts/generate.ts'];
    const config: ArchitectureConfig = {
      boundaries: [
        { name: 'features', paths: ['src/features/**'] },
        { name: 'orders', paths: ['src/features/orders/**'] },
        { name: 'runtime', paths: ['src/runtime/**'] },
      ],
    };
    const descriptive = analyzeArchitectureGraph(dependencyGraph, files, config);
    const enforced = analyzeArchitectureGraph(dependencyGraph, files, {
      ...config,
      requireCompleteCoverage: true,
    });

    expect(architectureFindingIdentities(descriptive)).toEqual([]);
    expect(architectureFindingIdentities(enforced)).toEqual([
      'architecture:ambiguous-file:src%2Ffeatures%2Forders%2Fmodel.ts:features|orders',
      'architecture:unmapped-file:scripts%2Fgenerate.ts',
    ]);
  });

  it('marks boundary cycles as violations only when acyclicity is declared', () => {
    const dependencyGraph = graph([
      ['src/domain/model.ts', ['src/runtime/start.ts']],
      ['src/runtime/start.ts', ['src/domain/model.ts']],
    ]);
    const files = ['src/domain/model.ts', 'src/runtime/start.ts'];

    const advisory = analyzeArchitectureGraph(dependencyGraph, files, baseConfig);
    const prohibited = analyzeArchitectureGraph(dependencyGraph, files, {
      ...baseConfig,
      requireAcyclic: true,
    });

    expect(advisory.cycles[0]?.violatesPolicy).toBe(false);
    expect(prohibited.cycles[0]?.violatesPolicy).toBe(true);
    expect(architectureFindingIdentities(advisory)).toEqual([]);
    expect(architectureFindingIdentities(prohibited)).toEqual(['architecture:cycle:domain|runtime']);
  });

  it('turns missing dependency rows into stable findings only when complete policy is required', () => {
    const advisory = analyzeArchitectureGraph(new Map(), [], {
      ...baseConfig,
      allowedDependencies: { domain: [] },
    });
    const prohibited = analyzeArchitectureGraph(new Map(), [], {
      ...baseConfig,
      allowedDependencies: { domain: [] },
      requireCompletePolicy: true,
    });

    expect(advisory.policyCoverage.missingRows).toEqual(['runtime']);
    expect(architectureFindingIdentities(advisory)).toEqual([]);
    expect(architectureFindingIdentities(prohibited)).toEqual(['architecture:missing-policy-row:runtime']);
  });

  it('uses boundary relationships rather than example files as baseline identities', () => {
    const first = analyzeArchitectureGraph(
      graph([['src/domain/model.ts', ['src/runtime/start.ts']]]),
      ['src/domain/model.ts', 'src/runtime/start.ts'],
      { ...baseConfig, allowedDependencies: { domain: [] } },
    );
    const moved = analyzeArchitectureGraph(
      graph([['src/domain/entity.ts', ['src/runtime/bootstrap.ts']]]),
      ['src/domain/entity.ts', 'src/runtime/bootstrap.ts'],
      { ...baseConfig, allowedDependencies: { domain: [] } },
    );

    expect(architectureFindingIdentities(first)).toEqual(['architecture:forbidden-edge:domain:runtime']);
    expect(architectureFindingIdentities(moved)).toEqual(architectureFindingIdentities(first));
  });

  it('treats closed rows and explicit architecture rules as enforceable policy', () => {
    expect(hasEnforceableArchitecturePolicy(baseConfig)).toBe(false);
    expect(hasEnforceableArchitecturePolicy({ ...baseConfig, allowedDependencies: { domain: [] } })).toBe(true);
    expect(hasEnforceableArchitecturePolicy({ ...baseConfig, requireCompletePolicy: true })).toBe(true);
    expect(hasEnforceableArchitecturePolicy({ ...baseConfig, requireCompleteCoverage: true })).toBe(true);
    expect(hasEnforceableArchitecturePolicy({ ...baseConfig, requireAcyclic: true })).toBe(true);
    expect(
      hasEnforceableArchitecturePolicy({
        boundaries: [{ name: 'domain', paths: ['src/domain/**'], maxFiles: 10 }],
      }),
    ).toBe(true);
  });
});

describe('coarse boundary detection', () => {
  // One boundary owning two sub-directories that depend on each other. The
  // boundary graph cannot express this: both endpoints resolve to `app`, so
  // the edge is discarded before the acyclicity check runs.
  const coarseConfig: ArchitectureConfig = {
    boundaries: [{ name: 'app', paths: ['src/app/**'] }],
    requireAcyclic: true,
  };
  const cyclicFiles = ['src/app/reader/read.ts', 'src/app/writer/write.ts'];
  const cyclicGraph = graph([
    ['src/app/reader/read.ts', ['src/app/writer/write.ts']],
    ['src/app/writer/write.ts', ['src/app/reader/read.ts']],
  ]);

  it('reports a cycle hidden inside a single boundary', () => {
    const report = analyzeArchitectureGraph(cyclicGraph, cyclicFiles, coarseConfig);

    expect(report.cycles).toEqual([]); // the boundary graph sees nothing
    expect(report.coarseBoundaries).toHaveLength(1);
    expect(report.coarseBoundaries[0]).toMatchObject({
      boundary: 'app',
      subUnits: ['src/app/reader', 'src/app/writer'],
    });
    expect(report.coarseBoundaries[0]!.narrowestEdges).toHaveLength(2);
  });

  it('stays silent when the boundary owns a single sub-unit', () => {
    const report = analyzeArchitectureGraph(
      graph([['src/app/a.ts', ['src/app/b.ts']]]),
      ['src/app/a.ts', 'src/app/b.ts'],
      coarseConfig,
    );

    expect(report.coarseBoundaries).toEqual([]);
  });

  it('ignores files the caller classifies as module-hierarchy bookkeeping', () => {
    const report = analyzeArchitectureGraph(cyclicGraph, cyclicFiles, coarseConfig, {
      isModuleHierarchyFile: (file) => file === 'src/app/writer/write.ts',
    });

    expect(report.coarseBoundaries).toEqual([]);
  });

  // Regression: a path-based barrel rule treats every `index.ts` as
  // bookkeeping, which hides real cycles whose back edge targets a module
  // that merely happens to be named `index.ts` while carrying real logic.
  // The classifier is injected so "is this a barrel" stays content-aware.
  it('still reports a cycle whose back edge targets a logic-bearing index.ts', () => {
    const files = ['src/app/core/evidence.ts', 'src/app/parsers/index.ts'];
    const report = analyzeArchitectureGraph(
      graph([
        ['src/app/core/evidence.ts', ['src/app/parsers/index.ts']],
        ['src/app/parsers/index.ts', ['src/app/core/evidence.ts']],
      ]),
      files,
      coarseConfig,
      { isModuleHierarchyFile: () => false },
    );

    expect(report.coarseBoundaries).toHaveLength(1);
    expect(report.coarseBoundaries[0]!.subUnits).toEqual(['src/app/core', 'src/app/parsers']);
  });

  // Directory nesting alone must not suppress: a boundary's root files
  // depending on one of its own sub-directories (and back) is the most common
  // real intra-boundary cycle. Only re-export bookkeeping is excluded, and
  // that is decided per file by the injected classifier.
  it('reports a cycle between a boundary root and its own sub-directory', () => {
    const report = analyzeArchitectureGraph(
      graph([
        ['src/app/registry.ts', ['src/app/child/leaf.ts']],
        ['src/app/child/leaf.ts', ['src/app/registry.ts']],
      ]),
      ['src/app/registry.ts', 'src/app/child/leaf.ts'],
      coarseConfig,
    );

    expect(report.coarseBoundaries).toHaveLength(1);
    expect(report.coarseBoundaries[0]!.subUnits).toEqual(['src/app', 'src/app/child']);
  });

  it('excludes a pure re-export module declaration from the quotient', () => {
    const report = analyzeArchitectureGraph(
      graph([
        ['src/app/mod.ts', ['src/app/child/leaf.ts']],
        ['src/app/child/leaf.ts', ['src/app/mod.ts']],
      ]),
      ['src/app/mod.ts', 'src/app/child/leaf.ts'],
      coarseConfig,
      { isModuleHierarchyFile: (file) => file === 'src/app/mod.ts' },
    );

    expect(report.coarseBoundaries).toEqual([]);
  });
});

describe('policy minimality, limits, and edge fragility', () => {
  const twoBoundaries: ArchitectureConfig = {
    boundaries: [
      { name: 'app', paths: ['src/app/**'] },
      { name: 'lib', paths: ['src/lib/**'] },
    ],
  };
  const oneEdge = graph([['src/app/a.ts', ['src/lib/b.ts']]]);
  const files = ['src/app/a.ts', 'src/lib/b.ts'];

  it('reports a declared allowance that no observed edge uses', () => {
    const report = analyzeArchitectureGraph(oneEdge, files, {
      ...twoBoundaries,
      allowedDependencies: { app: ['lib'], lib: ['app'] },
      requireMinimalPolicy: true,
    });

    expect(report.staleAllowances).toEqual([{ from: 'lib', to: 'app' }]);
    expect(architectureFindingIdentities(report)).toContain('architecture:stale-allowance:lib:app');
  });

  it('does not treat a missing row as a stale allowance', () => {
    const report = analyzeArchitectureGraph(oneEdge, files, {
      ...twoBoundaries,
      allowedDependencies: { app: ['lib'] },
      requireMinimalPolicy: true,
    });

    expect(report.staleAllowances).toEqual([]);
  });

  it('keeps stale allowances out of the baseline until the rule is enabled', () => {
    const report = analyzeArchitectureGraph(oneEdge, files, {
      ...twoBoundaries,
      allowedDependencies: { app: ['lib'], lib: ['app'] },
    });

    expect(report.staleAllowances).toHaveLength(1);
    expect(architectureFindingIdentities(report)).toEqual([]);
  });

  it('reports boundaries over the configured fan-out and file limits', () => {
    const report = analyzeArchitectureGraph(
      graph([['src/app/a.ts', ['src/lib/b.ts', 'src/app/c.ts']]]),
      ['src/app/a.ts', 'src/app/c.ts', 'src/lib/b.ts'],
      { ...twoBoundaries, maxBoundaryFanOut: 0, maxBoundaryFiles: 1 },
    );

    expect(report.boundaryLimits).toEqual([
      { boundary: 'app', kind: 'fan-out', observed: 1, limit: 0 },
      { boundary: 'app', kind: 'files', observed: 2, limit: 1 },
    ]);
  });

  it('uses a boundary-specific file limit without weakening the global limit', () => {
    const report = analyzeArchitectureGraph(new Map(), ['src/app/a.ts', 'src/app/b.ts', 'src/lib/c.ts'], {
      boundaries: [
        { name: 'app', paths: ['src/app/**'], maxFiles: 2 },
        { name: 'lib', paths: ['src/lib/**'] },
      ],
      maxBoundaryFiles: 0,
    });

    expect(report.boundaryLimits).toEqual([{ boundary: 'lib', kind: 'files', observed: 1, limit: 0 }]);
  });

  it('marks a boundary dependency resting on a single import as fragile', () => {
    const report = analyzeArchitectureGraph(oneEdge, files, twoBoundaries);

    expect(report.fragileEdges).toHaveLength(1);
    expect(report.fragileEdges[0]).toMatchObject({ from: 'app', to: 'lib', fileEdgeCount: 1 });
  });

  it('checks a single-directory boundary at file granularity when asked', () => {
    const inner = graph([
      ['src/app/a.ts', ['src/app/b.ts']],
      ['src/app/b.ts', ['src/app/a.ts']],
    ]);
    const members = ['src/app/a.ts', 'src/app/b.ts'];

    const byDirectory = analyzeArchitectureGraph(inner, members, {
      boundaries: [{ name: 'app', paths: ['src/app/**'] }],
    });
    expect(byDirectory.coarseBoundaries).toEqual([]); // one directory, one sub-unit

    const byFile = analyzeArchitectureGraph(inner, members, {
      boundaries: [{ name: 'app', paths: ['src/app/**'], subUnits: 'file' }],
    });
    expect(byFile.coarseBoundaries).toHaveLength(1);
    expect(byFile.coarseBoundaries[0]!.subUnits).toEqual(['src/app/a.ts', 'src/app/b.ts']);
  });
});

describe('coarse-boundary baseline identity stability', () => {
  const config: ArchitectureConfig = {
    boundaries: [{ name: 'app', paths: ['src/app/**'] }],
    requireResolvedBoundaries: true,
  };

  // The identity is the persistent baseline comparison key. If it encoded the
  // cycle's current members, adding one file to the tangle would read as the
  // old finding being fixed plus a new one appearing — churn on a problem that
  // never went away.
  it('keeps one identity per boundary as the cycle membership grows', () => {
    const twoUnits = analyzeArchitectureGraph(
      graph([
        ['src/app/a/x.ts', ['src/app/b/y.ts']],
        ['src/app/b/y.ts', ['src/app/a/x.ts']],
      ]),
      ['src/app/a/x.ts', 'src/app/b/y.ts'],
      config,
    );
    const threeUnits = analyzeArchitectureGraph(
      graph([
        ['src/app/a/x.ts', ['src/app/b/y.ts']],
        ['src/app/b/y.ts', ['src/app/c/z.ts']],
        ['src/app/c/z.ts', ['src/app/a/x.ts']],
      ]),
      ['src/app/a/x.ts', 'src/app/b/y.ts', 'src/app/c/z.ts'],
      config,
    );

    expect(twoUnits.coarseBoundaries[0]!.subUnits).toHaveLength(2);
    expect(threeUnits.coarseBoundaries[0]!.subUnits).toHaveLength(3);
    expect(architectureFindingIdentities(twoUnits)).toEqual(['architecture:coarse-boundary:app']);
    expect(architectureFindingIdentities(threeUnits)).toEqual(architectureFindingIdentities(twoUnits));
  });

  it('adds a stable cardinality identity for a second independent cycle', () => {
    const report = analyzeArchitectureGraph(
      graph([
        ['src/app/a/x.ts', ['src/app/b/y.ts']],
        ['src/app/b/y.ts', ['src/app/a/x.ts']],
        ['src/app/c/x.ts', ['src/app/d/y.ts']],
        ['src/app/d/y.ts', ['src/app/c/x.ts']],
      ]),
      ['src/app/a/x.ts', 'src/app/b/y.ts', 'src/app/c/x.ts', 'src/app/d/y.ts'],
      config,
    );

    expect(architectureFindingIdentities(report)).toEqual([
      'architecture:coarse-boundary:app',
      'architecture:coarse-boundary:app:component:2',
    ]);
  });

  it('does not classify a logic-bearing index file as a barrel by path alone', () => {
    const findings = detectCoarseBoundaries(
      new Map([
        ['src/app/index.ts', new Set(['src/app/child/leaf.ts'])],
        ['src/app/child/leaf.ts', new Set(['src/app/index.ts'])],
      ]),
      new Map([['app', new Set(['src/app/index.ts', 'src/app/child/leaf.ts'])]]),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.subUnits).toEqual(['src/app', 'src/app/child']);
  });
});
