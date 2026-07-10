import { describe, expect, it } from 'vitest';
import {
  buildProjectChangeManifest,
  classifyAffectedSetFallback,
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
