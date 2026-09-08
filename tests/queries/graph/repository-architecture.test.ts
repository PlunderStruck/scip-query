import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../../../src/domain/config-types.js';
import { analyzeArchitectureGraph } from '../../../src/queries/graph/architecture.js';

const policy = (JSON.parse(readFileSync(new URL('../../../.scipquery.json', import.meta.url), 'utf8')) as ProjectConfig)
  .architecture;

function analyzeEdges(edges: Array<[string, string[]]>) {
  const files = [...new Set(edges.flatMap(([file, targets]) => [file, ...targets]))];
  return analyzeArchitectureGraph(new Map(edges.map(([file, targets]) => [file, new Set(targets)])), files, policy);
}

describe('repository runtime responsibility policy', () => {
  it.each([
    {
      from: 'src/runtime/query-service.ts',
      to: 'src/runtime/setup.ts',
      owner: 'runtime-query-service',
      dependency: 'runtime-installation',
    },
    {
      from: 'src/runtime/config.ts',
      to: 'src/runtime/query-service-server.ts',
      owner: 'runtime-project',
      dependency: 'runtime-query-service',
    },
    {
      from: 'src/runtime/query-invocation-policy.ts',
      to: 'src/runtime/config.ts',
      owner: 'runtime-contracts',
      dependency: 'runtime-project',
    },
  ])('rejects $owner importing $dependency', ({ from, to, owner, dependency }) => {
    const report = analyzeEdges([[from, [to]]]);
    expect(report.coverage).toMatchObject({ totalFiles: 2, mappedFiles: 2, ambiguousFiles: [] });
    expect(report.forbiddenEdges).toEqual([
      expect.objectContaining({ from: owner, to: dependency, policyStatus: 'forbidden' }),
    ]);
  });

  it('allows query delivery to compose project context and watch control', () => {
    const report = analyzeEdges([
      ['src/runtime/query-service.ts', ['src/runtime/cli-context.ts', 'src/runtime/watch-service.ts']],
    ]);
    expect(report.edges).toHaveLength(2);
    expect(report.edges.every((edge) => edge.policyStatus === 'allowed')).toBe(true);
  });

  it.each([
    { boundary: 'runtime-project', files: ['src/runtime/config.ts', 'src/runtime/cli-context.ts'] },
    { boundary: 'reindex', files: ['src/reindex/affected-set.ts', 'src/reindex/typescript-incremental-index.ts'] },
  ])('exposes cycles between files in the flat $boundary directory', ({ boundary, files }) => {
    const [first, second] = files as [string, string];
    const report = analyzeEdges([
      [first, [second]],
      [second, [first]],
    ]);
    expect(report.cycles).toEqual([]);
    expect(report.coarseBoundaries).toEqual([expect.objectContaining({ boundary, subUnits: [...files].sort() })]);
  });
});
