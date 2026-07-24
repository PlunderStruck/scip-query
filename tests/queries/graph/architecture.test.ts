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
