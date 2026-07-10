import { describe, expect, it } from 'vitest';
import {
  buildProjectChangeManifest,
  classifyAffectedSetFallback,
  planAffectedFiles,
  type FileDependencyGraph,
  type ProjectInputSnapshot,
} from '../../src/reindex/affected-set.js';
import { classifyProjectInputPath, type ProjectFileFingerprint } from '../../src/reindex/project-files.js';

function file(path: string, hash: string, size = hash.length): ProjectFileFingerprint {
  return { path, hash, size };
}

function snapshot(
  files: readonly ProjectFileFingerprint[],
  overrides: Partial<ProjectInputSnapshot> = {},
): ProjectInputSnapshot {
  return {
    version: 2,
    languages: ['typescript'],
    pnpmWorkspaces: false,
    typescriptProjectMode: 'single',
    typescriptProjects: [],
    files,
    ...overrides,
  };
}

describe('affected-set change manifest', () => {
  it('returns an empty deterministic manifest for identical snapshots', () => {
    const value = snapshot([file('src/a.ts', 'a')]);
    expect(buildProjectChangeManifest(value, value)).toEqual({
      version: 1,
      changes: [],
      projectIdentityChanged: false,
      uncertainty: [],
    });
  });

  it('sorts added, modified, and deleted inputs by canonical path', () => {
    const manifest = buildProjectChangeManifest(
      snapshot([file('src/z.ts', 'old-z'), file('src/delete.ts', 'old')]),
      snapshot([file('src/z.ts', 'new-z'), file('src/add.ts', 'new')]),
    );

    expect(manifest.changes.map(({ kind, path, inputKind }) => ({ kind, path, inputKind }))).toEqual([
      { kind: 'added', path: 'src/add.ts', inputKind: 'source' },
      { kind: 'deleted', path: 'src/delete.ts', inputKind: 'source' },
      { kind: 'modified', path: 'src/z.ts', inputKind: 'source' },
    ]);
  });

  it('classifies source, ambient, configuration, and unknown inputs', () => {
    expect(classifyProjectInputPath('src/value.ts', ['typescript'])).toBe('source');
    expect(classifyProjectInputPath('src/globals.d.ts', ['typescript'])).toBe('ambient');
    expect(classifyProjectInputPath('configs/tsconfig.app.json', ['typescript'])).toBe('config');
    expect(classifyProjectInputPath('.scipquery.json', ['typescript'])).toBe('config');
    expect(classifyProjectInputPath('docs/architecture.md', ['typescript'])).toBe('other');
  });

  it('keeps a modified ordinary source on the closure path', () => {
    const manifest = buildProjectChangeManifest(
      snapshot([file('src/a.ts', 'old')]),
      snapshot([file('src/a.ts', 'new')]),
    );
    expect(classifyAffectedSetFallback(manifest)).toEqual({ fullProject: false, reasons: [] });
  });

  it.each([
    ['ambient declaration', 'src/globals.d.ts', 'ambient-declaration-changed'],
    ['configuration', 'tsconfig.json', 'configuration-changed'],
    ['unclassified input', 'docs/architecture.md', 'unclassified-input'],
  ] as const)('widens a modified %s to the project', (_label, path, reason) => {
    const manifest = buildProjectChangeManifest(snapshot([file(path, 'old')]), snapshot([file(path, 'new')]));
    expect(classifyAffectedSetFallback(manifest)).toMatchObject({ fullProject: true });
    expect(classifyAffectedSetFallback(manifest).reasons).toContain(reason);
  });

  it('widens additions, deletions, and project identity changes', () => {
    const manifest = buildProjectChangeManifest(
      snapshot([file('src/delete.ts', 'old')]),
      snapshot([file('src/add.ts', 'new')], { pnpmWorkspaces: true }),
    );
    expect(classifyAffectedSetFallback(manifest)).toEqual({
      fullProject: true,
      reasons: ['file-added', 'file-deleted', 'project-identity-changed'],
    });
  });

  it('widens missing, version-mismatched, and unreadable snapshots', () => {
    const current = snapshot([file('src/a.ts', 'unreadable', -1)]);
    const missing = buildProjectChangeManifest(null, current);
    expect(classifyAffectedSetFallback(missing).reasons).toEqual([
      'file-added',
      'prior-snapshot-unavailable',
      'project-identity-changed',
      'unreadable-input',
    ]);

    const mismatched = buildProjectChangeManifest(snapshot([file('src/a.ts', 'old')], { version: 1 }), current);
    expect(classifyAffectedSetFallback(mismatched).reasons).toEqual(['snapshot-version-changed', 'unreadable-input']);
  });

  it('widens unchanged unreadable and duplicate identities because equality is not proof', () => {
    const unreadable = snapshot([file('src/a.ts', 'unreadable', -1)]);
    expect(classifyAffectedSetFallback(buildProjectChangeManifest(unreadable, unreadable)).reasons).toEqual([
      'unreadable-input',
    ]);

    const duplicate = snapshot([file('src/a.ts', 'same'), file('src/a.ts', 'same')]);
    expect(classifyAffectedSetFallback(buildProjectChangeManifest(duplicate, duplicate)).reasons).toEqual([
      'duplicate-input-path',
    ]);
  });
});

function graph(entries: Record<string, readonly string[]>): FileDependencyGraph {
  return new Map(Object.entries(entries).map(([path, dependencies]) => [path, new Set(dependencies)]));
}

describe('affected file planning', () => {
  it('does no work for an empty proven manifest even when graph evidence is unavailable', () => {
    const value = snapshot([file('src/a.ts', 'same')]);
    expect(planAffectedFiles(buildProjectChangeManifest(value, value), null, ['src/a.ts'])).toEqual({
      mode: 'none',
      changedFiles: [],
      affectedFiles: [],
      reasons: [],
    });
  });

  it('includes the changed leaf and every transitive consumer', () => {
    const manifest = buildProjectChangeManifest(
      snapshot([file('src/a.ts', 'old'), file('src/b.ts', 'same'), file('src/c.ts', 'same')]),
      snapshot([file('src/a.ts', 'new'), file('src/b.ts', 'same'), file('src/c.ts', 'same')]),
    );
    expect(
      planAffectedFiles(manifest, graph({ 'src/b.ts': ['src/a.ts'], 'src/c.ts': ['src/b.ts'] }), [
        'src/c.ts',
        'src/a.ts',
        'src/b.ts',
      ]),
    ).toEqual({
      mode: 'closure',
      changedFiles: ['src/a.ts'],
      affectedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      reasons: [],
    });
  });

  it('de-duplicates diamonds, terminates cycles, and ignores outside-project edges', () => {
    const before = snapshot([
      file('src/a.ts', 'old'),
      file('src/b.ts', 'same'),
      file('src/c.ts', 'same'),
      file('src/d.ts', 'same'),
    ]);
    const after = snapshot([
      file('src/a.ts', 'new'),
      file('src/b.ts', 'same'),
      file('src/c.ts', 'same'),
      file('src/d.ts', 'same'),
    ]);
    const dependencies = graph({
      'src/a.ts': ['src/d.ts'],
      'src/b.ts': ['src/a.ts'],
      'src/c.ts': ['src/a.ts'],
      'src/d.ts': ['src/b.ts', 'src/c.ts'],
      'external.ts': ['src/a.ts'],
    });
    expect(
      planAffectedFiles(
        buildProjectChangeManifest(before, after),
        dependencies,
        before.files.map((f) => f.path),
      ),
    ).toMatchObject({
      mode: 'closure',
      affectedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
    });
  });

  it('keeps a disconnected changed indexed file as a one-file closure', () => {
    const manifest = buildProjectChangeManifest(
      snapshot([file('src/leaf.ts', 'old'), file('src/other.ts', 'same')]),
      snapshot([file('src/leaf.ts', 'new'), file('src/other.ts', 'same')]),
    );
    expect(planAffectedFiles(manifest, graph({}), ['src/other.ts', 'src/leaf.ts'])).toMatchObject({
      mode: 'closure',
      affectedFiles: ['src/leaf.ts'],
    });
  });

  it('unions multiple changed-file closures deterministically', () => {
    const manifest = buildProjectChangeManifest(
      snapshot([file('src/a.ts', 'old'), file('src/b.ts', 'old'), file('src/c.ts', 'same')]),
      snapshot([file('src/a.ts', 'new'), file('src/b.ts', 'new'), file('src/c.ts', 'same')]),
    );
    expect(
      planAffectedFiles(manifest, graph({ 'src/c.ts': ['src/b.ts'] }), ['src/c.ts', 'src/b.ts', 'src/a.ts']),
    ).toMatchObject({
      mode: 'closure',
      changedFiles: ['src/a.ts', 'src/b.ts'],
      affectedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
  });

  it('widens manifest fallbacks, missing graphs, and out-of-project changes', () => {
    const sourceManifest = buildProjectChangeManifest(
      snapshot([file('src/a.ts', 'old')]),
      snapshot([file('src/a.ts', 'new')]),
    );
    expect(planAffectedFiles(sourceManifest, null, ['src/a.ts', 'src/b.ts'])).toMatchObject({
      mode: 'full-project',
      affectedFiles: ['src/a.ts', 'src/b.ts'],
      reasons: ['dependency-graph-unavailable'],
    });
    expect(planAffectedFiles(sourceManifest, graph({}), ['src/b.ts'])).toMatchObject({
      mode: 'full-project',
      affectedFiles: ['src/b.ts'],
      reasons: ['changed-file-outside-project'],
    });

    const ambientManifest = buildProjectChangeManifest(
      snapshot([file('src/global.d.ts', 'old'), file('src/a.ts', 'same')]),
      snapshot([file('src/global.d.ts', 'new'), file('src/a.ts', 'same')]),
    );
    expect(planAffectedFiles(ambientManifest, graph({}), ['src/global.d.ts', 'src/a.ts'])).toMatchObject({
      mode: 'full-project',
      affectedFiles: ['src/a.ts', 'src/global.d.ts'],
      reasons: ['ambient-declaration-changed'],
    });
  });
});
