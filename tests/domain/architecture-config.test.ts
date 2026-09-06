import { describe, expect, it } from 'vitest';
import { validateArchitectureConfig, type ArchitectureConfigDiagnostic } from '../../src/domain/architecture-config.js';
import type { ProjectConfig } from '../../src/domain/config-types.js';

function diagnostics(architecture: unknown): ArchitectureConfigDiagnostic[] {
  const result: ArchitectureConfigDiagnostic[] = [];
  validateArchitectureConfig({ architecture } as ProjectConfig, result);
  return result;
}

describe('architecture configuration subjects', () => {
  it('stops at an invalid root or missing boundary inventory', () => {
    expect(diagnostics(undefined)).toEqual([]);
    expect(diagnostics(null)).toEqual([{ level: 'error', path: 'architecture', message: 'Must be an object.' }]);
    expect(diagnostics({ boundaries: [], allowedDependencies: false, requireCompletePolicy: true })).toEqual([
      { level: 'error', path: 'architecture.boundaries', message: 'Must be a non-empty array.' },
    ]);
  });

  it('retains independent boundary, dependency and required-row diagnostics in subject order', () => {
    expect(
      diagnostics({
        boundaries: [
          null,
          { name: 'app', paths: ['src/app/**', 'src/app/**'], subUnits: 'files', maxFiles: -1 },
          { name: 'app', paths: [] },
          { name: 'lib', paths: ['src/lib/**'] },
        ],
        allowedDependencies: { typo: [null, 'missing', 'missing', 'app', 'app'], app: 'invalid' },
        requireAcyclic: 'true',
        testPaths: [null],
        requireCompletePolicy: true,
      }).map(({ path, message }) => [path, message]),
    ).toEqual([
      ['architecture.boundaries[0]', 'Architecture boundary must be an object.'],
      ['architecture.boundaries[1].subUnits', "Must be 'directory' or 'file'."],
      ['architecture.boundaries[1].maxFiles', 'Must be a non-negative integer.'],
      ['architecture.boundaries[1].paths[1]', 'Duplicate boundary path: src/app/**'],
      ['architecture.boundaries[2].name', 'Duplicate boundary name: app'],
      ['architecture.boundaries[2].paths', 'Boundary paths must be a non-empty array.'],
      ['architecture.allowedDependencies.typo', 'Unknown source boundary: typo'],
      ['architecture.allowedDependencies.typo[0]', 'Target boundary name is required.'],
      ['architecture.allowedDependencies.typo[1]', 'Unknown target boundary: missing'],
      ['architecture.allowedDependencies.typo[2]', 'Unknown target boundary: missing'],
      ['architecture.allowedDependencies.typo[4]', 'Duplicate target boundary: app'],
      ['architecture.allowedDependencies.app', 'Dependency row must be an array.'],
      ['architecture.requireAcyclic', 'Must be a boolean.'],
      ['architecture.testPaths', 'Must be an array of strings.'],
      ['architecture.allowedDependencies.lib', 'A dependency row is required by architecture.requireCompletePolicy.'],
    ]);
  });

  it('accepts zero ceilings, explicit false flags and complete empty dependency rows', () => {
    expect(
      diagnostics({
        boundaries: [{ name: 'app', paths: ['src/app/**'], subUnits: 'file', maxFiles: 0 }],
        allowedDependencies: { app: [] },
        requireCompletePolicy: true,
        requireCompleteCoverage: false,
        requireResolvedBoundaries: false,
        requireMinimalPolicy: false,
        requireAcyclic: false,
        maxBoundaryFiles: 0,
        maxBoundaryFanOut: 0,
        testPaths: [],
      }),
    ).toEqual([]);
  });

  it.each(['/outside/**', '../outside/**', 'C:/outside/**', 'C:\\outside\\**', 'src/**/nested'])(
    'rejects a boundary path outside the supported project-relative grammar: %s',
    (path) => {
      expect(diagnostics({ boundaries: [{ name: 'app', paths: [path] }] })).toEqual([
        {
          level: 'error',
          path: 'architecture.boundaries[0].paths[0]',
          message: 'Boundary path must be project-relative and may use only one trailing /* or /** glob.',
        },
      ]);
    },
  );
});
