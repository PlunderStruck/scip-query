import { describe, expect, it } from 'vitest';
import type { ArchitectureConfig } from '../../../src/domain/config-types.js';
import {
  analyzeArchitectureGraph,
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

  it('treats only closed rows and explicit completeness or acyclicity as enforceable policy', () => {
    expect(hasEnforceableArchitecturePolicy(baseConfig)).toBe(false);
    expect(hasEnforceableArchitecturePolicy({ ...baseConfig, allowedDependencies: { domain: [] } })).toBe(true);
    expect(hasEnforceableArchitecturePolicy({ ...baseConfig, requireCompletePolicy: true })).toBe(true);
    expect(hasEnforceableArchitecturePolicy({ ...baseConfig, requireAcyclic: true })).toBe(true);
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
