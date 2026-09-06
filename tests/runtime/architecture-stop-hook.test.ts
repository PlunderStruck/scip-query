import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evidenceFixtureDb } from '../fixtures/evidence-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
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

describe('architecture hook Git path transport', () => {
  it.each(['modified', 'deleted'] as const)('observes a %s quoted Unicode source path', (change) => {
    const root = mkdtempSync(join(tmpdir(), 'scip-hook-paths-'));
    const file = 'Café".ts';
    try {
      writeFileSync(join(root, file), 'export const value = 1;\n');
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
      git('init', '-q');
      git('add', '--', file);
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
      if (change === 'deleted') rmSync(join(root, file));
      else writeFileSync(join(root, file), 'export const value = 2;\n');
      const dbPath = join(root, 'index.db');
      evidenceFixtureDb(dbPath).write();
      const db = new ScipDatabase({ dbPath, projectRoot: root });
      try {
        expect(evaluateArchitectureStop(root, db).checkedSourceFiles).toEqual([file]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
