import { describe, expect, it, vi } from 'vitest';
import type { ScipDatabase } from '../../src/storage/db.js';
import {
  evaluateArchitectureStop,
  renderArchitectureStopOutput,
  type ArchitectureStopDependencies,
} from '../../src/runtime/commands/architecture-stop-hook.js';

const fakeDb = {} as ScipDatabase;

function dependencies(overrides: Partial<ArchitectureStopDependencies> = {}): ArchitectureStopDependencies {
  return {
    changedPaths: () => [],
    indexedPaths: () => ['src/a.ts', 'src/b.ts'],
    architectureFindings: () => [],
    ...overrides,
  };
}

describe('architecture Stop hook', () => {
  it('does nothing when no indexed source changed', () => {
    const architectureFindings = vi.fn(() => ['should-not-run']);
    const result = evaluateArchitectureStop(
      '/repo',
      fakeDb,
      dependencies({ changedPaths: () => ['README.md'], architectureFindings }),
    );

    expect(result).toEqual({ kind: 'allow', checkedSourceFiles: [], findings: [] });
    expect(architectureFindings).not.toHaveBeenCalled();
    expect(renderArchitectureStopOutput(result)).toEqual({});
  });

  it('blocks an architecture policy edit made beside implementation work', () => {
    const result = evaluateArchitectureStop(
      '/repo',
      fakeDb,
      dependencies({ changedPaths: () => ['.scipquery.json', 'src/a.ts'] }),
    );

    expect(result.kind).toBe('block');
    expect(result.reason).toContain('separate reviewed change');
  });

  it('blocks enforced findings after indexed source changes', () => {
    const result = evaluateArchitectureStop(
      '/repo',
      fakeDb,
      dependencies({
        changedPaths: () => ['src/a.ts', 'notes.md'],
        architectureFindings: () => ['architecture:forbidden-edge:ui:data'],
      }),
    );

    expect(result.checkedSourceFiles).toEqual(['src/a.ts']);
    expect(renderArchitectureStopOutput(result)).toEqual({
      decision: 'block',
      reason: expect.stringContaining('architecture:forbidden-edge:ui:data'),
    });
  });

  it('allows a source change when the declared policy remains clean', () => {
    const result = evaluateArchitectureStop('/repo', fakeDb, dependencies({ changedPaths: () => ['src/b.ts'] }));

    expect(result).toEqual({ kind: 'allow', checkedSourceFiles: ['src/b.ts'], findings: [] });
  });

  it('still checks newly added or deleted supported source files', () => {
    const result = evaluateArchitectureStop(
      '/repo',
      fakeDb,
      dependencies({
        changedPaths: () => ['src/new.vue'],
        indexedPaths: () => [],
      }),
    );

    expect(result.checkedSourceFiles).toEqual(['src/new.vue']);
  });
});
