import { describe, expect, it } from 'vitest';
import type {
  FileDependencyGraph,
  ProjectFileFingerprint,
  ProjectInputSnapshot,
} from '../../../src/domain/project-input.js';
import {
  buildTypeScriptSemanticIdentity,
  createTypeScriptSemanticIdentityBuilder,
} from '../../../src/semantic/typescript/semantic-identity.js';

const PROJECT_FILES = ['src/consumer.ts', 'src/isolated.ts', 'src/leaf.ts'];

describe('TypeScript semantic identity', () => {
  it('preserves an unrelated file key while invalidating a transitive consumer', () => {
    const graph = dependencyGraph([
      ['src/consumer.ts', ['src/leaf.ts']],
      ['src/leaf.ts', []],
      ['src/isolated.ts', []],
    ]);
    const before = snapshot();
    const after = snapshot({ 'src/leaf.ts': 'leaf-v2' });

    expect(identity('src/isolated.ts', before, graph).key).toBe(identity('src/isolated.ts', after, graph).key);
    expect(identity('src/leaf.ts', before, graph).key).not.toBe(identity('src/leaf.ts', after, graph).key);
    expect(identity('src/consumer.ts', before, graph).key).not.toBe(identity('src/consumer.ts', after, graph).key);
  });

  it('traverses dependency cycles once and orders identity inputs canonically', () => {
    const left = identity(
      'src/consumer.ts',
      snapshot(),
      dependencyGraph([
        ['src/leaf.ts', ['src/consumer.ts']],
        ['src/consumer.ts', ['src/leaf.ts']],
      ]),
    );
    const right = identity(
      'src/consumer.ts',
      { ...snapshot(), files: [...snapshot().files].reverse() },
      dependencyGraph([
        ['src/consumer.ts', ['src/leaf.ts']],
        ['src/leaf.ts', ['src/consumer.ts']],
      ]),
      [...PROJECT_FILES].reverse(),
    );

    expect(left).toEqual(right);
    expect(left.inputFiles).toEqual([
      'package.json',
      'src/consumer.ts',
      'src/globals.d.ts',
      'src/leaf.ts',
      'tsconfig.json',
    ]);
  });

  it('changes every file key when configuration or ambient declarations change', () => {
    const graph = dependencyGraph(PROJECT_FILES.map((file) => [file, []]));
    for (const changedPath of ['tsconfig.json', 'package.json', 'src/globals.d.ts']) {
      const before = snapshot();
      const after = snapshot({ [changedPath]: `${changedPath}-v2` });
      for (const target of PROJECT_FILES) {
        expect(identity(target, before, graph).key).not.toBe(identity(target, after, graph).key);
      }
    }
  });

  it('changes every key when TypeScript project membership changes', () => {
    const graph = dependencyGraph(PROJECT_FILES.map((file) => [file, []]));
    const before = identity('src/isolated.ts', snapshot(), graph);
    const after = identity('src/isolated.ts', snapshot({ 'src/added.ts': 'added' }), graph, [
      ...PROJECT_FILES,
      'src/added.ts',
    ]);
    expect(before.key).not.toBe(after.key);
  });

  it('uses a readable whole-project identity when graph evidence is unavailable', () => {
    const result = identity('src/isolated.ts', snapshot(), null);
    expect(result).toEqual(
      expect.objectContaining({
        key: expect.any(String),
        mode: 'whole-project',
        reasons: ['dependency-graph-unavailable'],
      }),
    );
    expect(result.inputFiles).toEqual([
      'package.json',
      'src/consumer.ts',
      'src/globals.d.ts',
      'src/isolated.ts',
      'src/leaf.ts',
      'tsconfig.json',
    ]);
  });

  it('refuses to key absent, unreadable, or duplicate required inputs', () => {
    const graph = dependencyGraph([['src/consumer.ts', ['src/leaf.ts']]]);
    expect(identity('src/missing.ts', snapshot(), graph)).toEqual(
      expect.objectContaining({ key: null, reasons: ['target-outside-project'] }),
    );
    expect(identity('src/consumer.ts', snapshot({ 'src/leaf.ts': 'unreadable' }, true), graph)).toEqual(
      expect.objectContaining({ key: null, reasons: ['unreadable-input'] }),
    );
    const duplicate = snapshot();
    duplicate.files.push({ ...duplicate.files[0]! });
    expect(identity('src/consumer.ts', duplicate, graph)).toEqual(
      expect.objectContaining({ key: null, reasons: ['duplicate-input-path'] }),
    );
  });

  it('refuses a dependency without a canonical fingerprint', () => {
    const graph = dependencyGraph([['src/consumer.ts', ['generated/missing.ts']]]);
    expect(identity('src/consumer.ts', snapshot(), graph)).toEqual(
      expect.objectContaining({ key: null, reasons: ['missing-input-fingerprint'] }),
    );
  });

  it('includes compiler engine, schema, and TypeScript project identity', () => {
    const graph = dependencyGraph([['src/isolated.ts', []]]);
    const baseline = identity('src/isolated.ts', snapshot(), graph);
    expect(identity('src/isolated.ts', snapshot(), graph, PROJECT_FILES, 'engine-v2').key).not.toBe(baseline.key);
    expect(identity('src/isolated.ts', snapshot(), graph, PROJECT_FILES, 'engine-v1', 'schema-v2').key).not.toBe(
      baseline.key,
    );
    expect(identity('src/isolated.ts', { ...snapshot(), typescriptProjects: ['apps/web'] }, graph).key).not.toBe(
      baseline.key,
    );
  });

  it('prepares shared project evidence without changing per-file identities', () => {
    const inputSnapshot = snapshot();
    const graph = dependencyGraph([
      ['src/consumer.ts', ['src/leaf.ts']],
      ['src/leaf.ts', []],
      ['src/isolated.ts', []],
    ]);
    const builder = createTypeScriptSemanticIdentityBuilder({
      projectFiles: PROJECT_FILES,
      snapshot: inputSnapshot,
      graph,
      engineIdentity: 'engine-v1',
    });

    for (const target of PROJECT_FILES) {
      expect(builder.identityFor(target, 'schema-v1')).toEqual(identity(target, inputSnapshot, graph));
    }
    expect(builder.identityFor('src/leaf.ts', 'schema-v2').key).not.toBe(
      builder.identityFor('src/leaf.ts', 'schema-v1').key,
    );
  });

  it('preserves relationship identities when only TypeScript trivia changes', () => {
    const graph = dependencyGraph([
      ['src/consumer.ts', ['src/leaf.ts']],
      ['src/leaf.ts', []],
    ]);
    const before = snapshot();
    const after = snapshot({ 'src/leaf.ts': 'leaf-v2-with-different-bytes' });
    const beforeLeaf = before.files.find((file) => file.path === 'src/leaf.ts') as ProjectFileFingerprint;
    const afterLeaf = after.files.find((file) => file.path === 'src/leaf.ts') as ProjectFileFingerprint;
    beforeLeaf.semanticHash = 'same-tokens-and-lines';
    afterLeaf.semanticHash = 'same-tokens-and-lines';

    expect(identity('src/leaf.ts', before, graph).key).toBe(identity('src/leaf.ts', after, graph).key);
    expect(identity('src/consumer.ts', before, graph).key).toBe(identity('src/consumer.ts', after, graph).key);
  });

  it('retains only the most recent dependency closure', () => {
    const inputSnapshot = snapshot();
    const graph = dependencyGraph([
      ['src/consumer.ts', ['src/leaf.ts']],
      ['src/leaf.ts', []],
      ['src/isolated.ts', []],
    ]);
    const builder = createTypeScriptSemanticIdentityBuilder({
      projectFiles: PROJECT_FILES,
      snapshot: inputSnapshot,
      graph,
      engineIdentity: 'engine-v1',
    });

    const original = builder.identityFor('src/consumer.ts', 'schema-v1');
    builder.identityFor('src/isolated.ts', 'schema-v1');
    graph.set('src/consumer.ts', new Set());

    expect(builder.identityFor('src/consumer.ts', 'schema-v1').key).not.toBe(original.key);
  });
});

function identity(
  targetFile: string,
  inputSnapshot: ProjectInputSnapshot,
  graph: FileDependencyGraph | null,
  projectFiles = PROJECT_FILES,
  engineIdentity = 'engine-v1',
  schemaVersion = 'schema-v1',
) {
  return buildTypeScriptSemanticIdentity({
    targetFile,
    projectFiles,
    snapshot: inputSnapshot,
    graph,
    engineIdentity,
    schemaVersion,
  });
}

function snapshot(
  changes: Record<string, string> = {},
  unreadableMarker = false,
): ProjectInputSnapshot & { files: Array<{ path: string; size: number; hash: string }> } {
  const values: Record<string, string> = {
    'src/consumer.ts': 'consumer-v1',
    'src/isolated.ts': 'isolated-v1',
    'src/leaf.ts': 'leaf-v1',
    'src/globals.d.ts': 'ambient-v1',
    'tsconfig.json': 'tsconfig-v1',
    'package.json': 'package-v1',
    ...changes,
  };
  return {
    version: 2,
    languages: ['typescript'],
    pnpmWorkspaces: false,
    typescriptProjectMode: 'single',
    typescriptProjects: [],
    files: Object.entries(values).map(([path, hash]) => ({
      path,
      size: unreadableMarker && hash === 'unreadable' ? -1 : hash.length,
      hash,
    })),
  };
}

function dependencyGraph(entries: ReadonlyArray<readonly [string, readonly string[]]>): FileDependencyGraph {
  return new Map(entries.map(([file, dependencies]) => [file, new Set(dependencies)]));
}
