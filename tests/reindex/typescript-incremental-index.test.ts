import { describe, expect, test } from 'vitest';
import type { ProjectInputSnapshot } from '../../src/domain/project-input.js';
import { planTypeScriptIncrementalUpdate } from '../../src/reindex/typescript-incremental-index.js';

describe('TypeScript incremental index eligibility', () => {
  test('accepts one modified source and includes its reverse dependency closure', () => {
    const previous = snapshot({ a: 'a1', b: 'b1', config: 'c1' });
    const current = snapshot({ a: 'a2', b: 'b1', config: 'c1' });
    const result = planTypeScriptIncrementalUpdate({
      projectMode: 'single',
      previousSnapshot: previous,
      currentSnapshot: current,
      projectFiles: ['src/a.ts', 'src/b.ts'],
      graph: new Map([['src/b.ts', new Set(['src/a.ts'])]]),
      producerIdentity: 'scip-typescript:0.4.0:test',
      rootTsconfigExists: true,
    });
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.plan).toEqual(
      expect.objectContaining({
        mode: 'closure',
        changedFiles: ['src/a.ts'],
        affectedFiles: ['src/a.ts', 'src/b.ts'],
      }),
    );
    expect(result.previousFragmentGeneration).not.toBe(result.nextFragmentGeneration);
    expect(result.projectIdentity).toMatch(/^typescript-project-v2:/);

    const rootWorkspace = planTypeScriptIncrementalUpdate({
      ...fixture(),
      projectMode: 'workspace',
      workspaceProjects: ['.'],
    });
    expect(rootWorkspace.eligible).toBe(true);
  });

  test('accepts an added TypeScript source without other compiler edits', () => {
    const previous = snapshot({ a: 'a1', b: 'b1', config: 'c1' });
    const result = planTypeScriptIncrementalUpdate({
      projectMode: 'single',
      previousSnapshot: previous,
      currentSnapshot: {
        ...previous,
        files: [...previous.files, { path: 'src/added.ts', size: 1, hash: 'added' }],
      },
      projectFiles: ['src/a.ts', 'src/b.ts'],
      graph: new Map([['src/b.ts', new Set(['src/a.ts'])]]),
      producerIdentity: 'scip-typescript:0.4.0:test',
      rootTsconfigExists: true,
    });
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.plan).toEqual(
      expect.objectContaining({
        mode: 'closure',
        changedFiles: ['src/added.ts'],
        affectedFiles: ['src/added.ts'],
      }),
    );
  });

  test('accepts an added TypeScript source and includes reverse dependents of modified files', () => {
    const input = fixture();
    const result = planTypeScriptIncrementalUpdate({
      ...input,
      currentSnapshot: {
        ...input.currentSnapshot,
        files: [...input.currentSnapshot.files, { path: 'src/added.ts', size: 1, hash: 'added' }],
      },
    });
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.plan).toEqual(
      expect.objectContaining({
        mode: 'closure',
        changedFiles: ['src/a.ts', 'src/added.ts'],
        affectedFiles: ['src/a.ts', 'src/added.ts', 'src/b.ts'],
      }),
    );
  });

  test.each([
    {
      label: 'missing graph',
      mutate: (input: EligibilityFixture) => ({ ...input, graph: null }),
      reason: 'dependency graph unavailable',
    },
    {
      label: 'missing tsconfig',
      mutate: (input: EligibilityFixture) => ({ ...input, rootTsconfigExists: false }),
      reason: 'root tsconfig unavailable',
    },
  ])('falls back for $label', ({ mutate, reason }) => {
    const result = planTypeScriptIncrementalUpdate(mutate(fixture()));
    expect(result).toEqual({ eligible: false, reason });
  });

  test('ignores non-compiler inputs when the TypeScript delta is only modified source files', () => {
    const previous = snapshot({ a: 'a1', b: 'b1', config: 'c1' });
    const current = snapshot({ a: 'a2', b: 'b1', config: 'c1' });
    const result = planTypeScriptIncrementalUpdate({
      projectMode: 'single',
      previousSnapshot: {
        ...previous,
        files: [...previous.files, { path: 'README.md', size: 1, hash: 'readme-1' }],
      },
      currentSnapshot: {
        ...current,
        files: [...current.files, { path: 'README.md', size: 1, hash: 'readme-2' }],
      },
      projectFiles: ['src/a.ts', 'src/b.ts'],
      graph: new Map([['src/b.ts', new Set(['src/a.ts'])]]),
      producerIdentity: 'scip-typescript:0.4.0:test',
      rootTsconfigExists: true,
    });

    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.plan.changedFiles).toEqual(['src/a.ts']);
  });

  test('replaces the bounded TypeScript project for a configuration edit', () => {
    const result = planTypeScriptIncrementalUpdate({
      ...fixture(),
      currentSnapshot: snapshot({ a: 'a1', b: 'b1', config: 'c2' }),
    });
    expect(result).toEqual(
      expect.objectContaining({
        eligible: true,
        replaceProject: true,
        plan: expect.objectContaining({ mode: 'full-project', affectedFiles: ['src/a.ts', 'src/b.ts'] }),
      }),
    );
  });

  test('uses bounded project replacement when a large source delta exceeds the graph-closure limit', () => {
    const projectFiles = Array.from({ length: 257 }, (_, index) => `src/file-${index}.ts`);
    const base = snapshot({ a: 'unused', b: 'unused', config: 'c1' });
    const previousSnapshot = {
      ...base,
      files: [
        { path: 'tsconfig.json', size: 1, hash: 'c1' },
        ...projectFiles.map((path) => ({ path, size: 1, hash: `old-${path}` })),
      ],
    };
    const currentSnapshot = {
      ...previousSnapshot,
      files: [
        { path: 'tsconfig.json', size: 1, hash: 'c1' },
        ...projectFiles.map((path) => ({ path, size: 1, hash: `new-${path}` })),
      ],
    };

    const result = planTypeScriptIncrementalUpdate({
      projectMode: 'single',
      previousSnapshot,
      currentSnapshot,
      projectFiles,
      graph: new Map(),
      producerIdentity: 'scip-typescript:0.4.0:test',
      rootTsconfigExists: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        eligible: true,
        replaceProject: true,
        plan: expect.objectContaining({ mode: 'full-project', affectedFiles: [...projectFiles].sort() }),
      }),
    );
  });

  test('represents a deleted source as a tombstone without retaining its document identity', () => {
    const input = fixture();
    const sourceEdit = planTypeScriptIncrementalUpdate(input);
    const previous = snapshot({ a: 'a1', b: 'b1', config: 'c1' });
    const result = planTypeScriptIncrementalUpdate({
      ...input,
      previousSnapshot: previous,
      currentSnapshot: {
        ...previous,
        files: previous.files.filter((file) => file.path !== 'src/b.ts'),
      },
    });
    expect(result).toEqual(
      expect.objectContaining({
        eligible: true,
        replaceProject: false,
        deletedFiles: ['src/b.ts'],
        projects: [expect.objectContaining({ removedFiles: ['src/b.ts'], affectedFiles: [] })],
      }),
    );
    expect(sourceEdit.eligible).toBe(true);
    if (!result.eligible || !sourceEdit.eligible) return;
    expect(result.projectIdentity).toBe(sourceEdit.projectIdentity);
  });

  test('uses bounded project replacement when tsconfig changes alongside modified TypeScript source', () => {
    const result = planTypeScriptIncrementalUpdate({
      projectMode: 'single',
      previousSnapshot: snapshot({ a: 'a1', b: 'b1', config: 'c1' }),
      currentSnapshot: snapshot({ a: 'a2', b: 'b1', config: 'c2' }),
      projectFiles: ['src/a.ts', 'src/b.ts'],
      graph: new Map([['src/b.ts', new Set(['src/a.ts'])]]),
      producerIdentity: 'scip-typescript:0.4.0:test',
      rootTsconfigExists: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        eligible: true,
        replaceProject: true,
        plan: expect.objectContaining({ mode: 'full-project', affectedFiles: ['src/a.ts', 'src/b.ts'] }),
      }),
    );
  });

  test('partitions a cross-project closure and carries changed dependencies into each compiler request', () => {
    const previous = workspaceSnapshot('a1');
    const current = workspaceSnapshot('a2');
    const base = {
      projectMode: 'workspace' as const,
      workspaceProjects: ['apps/api', 'apps/web'],
      previousSnapshot: previous,
      currentSnapshot: current,
      projectFiles: ['apps/api/src/a.ts', 'apps/web/src/b.ts'],
      producerIdentity: 'scip-typescript:0.4.0:test',
      rootTsconfigExists: false,
    };
    const owned = planTypeScriptIncrementalUpdate({ ...base, graph: new Map() });
    expect(owned).toEqual(
      expect.objectContaining({
        eligible: true,
        tsconfigPath: 'apps/api/tsconfig.json',
        projectArgument: 'apps/api',
      }),
    );

    const crossing = planTypeScriptIncrementalUpdate({
      ...base,
      graph: new Map([['apps/web/src/b.ts', new Set(['apps/api/src/a.ts'])]]),
    });
    expect(crossing).toEqual(
      expect.objectContaining({
        eligible: true,
        projects: [
          {
            tsconfigPath: 'apps/api/tsconfig.json',
            projectArgument: 'apps/api',
            modifiedFiles: ['apps/api/src/a.ts'],
            removedFiles: [],
            affectedFiles: ['apps/api/src/a.ts'],
          },
          {
            tsconfigPath: 'apps/web/tsconfig.json',
            projectArgument: 'apps/web',
            modifiedFiles: ['apps/api/src/a.ts'],
            removedFiles: [],
            affectedFiles: ['apps/web/src/b.ts'],
          },
        ],
      }),
    );
  });

  test('uses the most specific nested project when a root workspace project also matches', () => {
    const previous = workspaceSnapshot('a1');
    const current = workspaceSnapshot('a2');
    const result = planTypeScriptIncrementalUpdate({
      projectMode: 'workspace',
      workspaceProjects: ['.', 'apps/api', 'apps/web'],
      previousSnapshot: previous,
      currentSnapshot: current,
      projectFiles: ['apps/api/src/a.ts', 'apps/web/src/b.ts'],
      graph: new Map([['apps/web/src/b.ts', new Set(['apps/api/src/a.ts'])]]),
      producerIdentity: 'scip-typescript:0.4.0:test',
      rootTsconfigExists: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        eligible: true,
        projects: [
          expect.objectContaining({ projectArgument: 'apps/api', affectedFiles: ['apps/api/src/a.ts'] }),
          expect.objectContaining({ projectArgument: 'apps/web', affectedFiles: ['apps/web/src/b.ts'] }),
        ],
      }),
    );
  });
});

interface EligibilityFixture {
  projectMode: 'single' | 'workspace';
  previousSnapshot: ProjectInputSnapshot;
  currentSnapshot: ProjectInputSnapshot;
  projectFiles: string[];
  graph: Map<string, Set<string>> | null;
  producerIdentity: string;
  rootTsconfigExists: boolean;
}

function fixture(): EligibilityFixture {
  return {
    projectMode: 'single',
    previousSnapshot: snapshot({ a: 'a1', b: 'b1', config: 'c1' }),
    currentSnapshot: snapshot({ a: 'a2', b: 'b1', config: 'c1' }),
    projectFiles: ['src/a.ts', 'src/b.ts'],
    graph: new Map([['src/b.ts', new Set(['src/a.ts'])]]),
    producerIdentity: 'scip-typescript:0.4.0:test',
    rootTsconfigExists: true,
  };
}

function snapshot(hashes: { a: string; b: string; config: string }): ProjectInputSnapshot {
  return {
    version: 4,
    languages: ['typescript'],
    pnpmWorkspaces: false,
    typescriptProjectMode: 'single',
    typescriptProjects: [],
    files: [
      { path: 'src/a.ts', size: 1, hash: hashes.a },
      { path: 'src/b.ts', size: 1, hash: hashes.b },
      { path: 'tsconfig.json', size: 1, hash: hashes.config },
    ],
  };
}

function workspaceSnapshot(apiHash: string): ProjectInputSnapshot {
  return {
    version: 4,
    languages: ['typescript'],
    pnpmWorkspaces: false,
    typescriptProjectMode: 'workspace',
    typescriptProjects: ['apps/api', 'apps/web'],
    files: [
      { path: 'apps/api/src/a.ts', size: 1, hash: apiHash },
      { path: 'apps/web/src/b.ts', size: 1, hash: 'b1' },
      { path: 'apps/api/tsconfig.json', size: 1, hash: 'api-config' },
      { path: 'apps/web/tsconfig.json', size: 1, hash: 'web-config' },
    ],
  };
}
