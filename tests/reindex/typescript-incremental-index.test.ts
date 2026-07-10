import { describe, expect, test } from 'vitest';
import type { ProjectInputSnapshot } from '../../src/reindex/affected-set.js';
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
    expect([...result.previousDocumentIdentities.keys()]).toEqual(['src/a.ts', 'src/b.ts']);
    expect([...result.nextDocumentIdentities.keys()]).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.previousFragmentGeneration).not.toBe(result.nextFragmentGeneration);

    const rootWorkspace = planTypeScriptIncrementalUpdate({
      ...fixture(),
      projectMode: 'workspace',
      workspaceProjects: ['.'],
    });
    expect(rootWorkspace.eligible).toBe(true);
  });

  test.each([
    {
      label: 'multi-project workspace mode',
      mutate: (input: EligibilityFixture) => ({ ...input, projectMode: 'workspace' as const }),
      reason: 'workspace has multiple TypeScript projects',
    },
    {
      label: 'config edit',
      mutate: (input: EligibilityFixture) => ({
        ...input,
        currentSnapshot: snapshot({ a: 'a1', b: 'b1', config: 'c2' }),
      }),
      reason: 'change is not a modified TypeScript source file',
    },
    {
      label: 'added source',
      mutate: (input: EligibilityFixture) => ({
        ...input,
        currentSnapshot: {
          ...input.currentSnapshot,
          files: [...input.currentSnapshot.files, { path: 'src/added.ts', size: 1, hash: 'added' }],
        },
      }),
      reason: 'change is not a modified TypeScript source file',
    },
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
