import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalProjectInputSnapshot,
  canonicalRepositoryContentSnapshot,
  captureProjectObservationSnapshot,
} from '../../src/platform/project-observation-snapshot.js';
import { withProjectSnapshot } from '../../src/platform/project-snapshot-context.js';
import { readProjectFileText } from '../../src/platform/project-files.js';
import { resolveGitWorktreeContext } from '../../src/platform/git-worktree.js';
import { stableJson } from '../../src/domain/stable-json.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('fixed project observation snapshots', () => {
  it('captures clone-independent repository content and redirects project reads to fixed bytes', () => {
    const firstRoot = repositoryFixture('first');
    const secondRoot = repositoryFixture('second');
    const first = captureProjectObservationSnapshot(
      firstRoot,
      ['typescript'],
      {
        projectRoot: firstRoot,
        dbPath: join(firstRoot, 'index.db'),
        indexPath: join(firstRoot, 'index.scip'),
        languages: ['typescript'],
        indexer: { typescript: { projects: ['ignored-tsconfig.json'] } },
        docs: { snapshotPaths: ['docs/benchmarks/**'] },
      },
      resolveGitWorktreeContext(firstRoot),
    );
    const second = captureProjectObservationSnapshot(
      secondRoot,
      ['typescript'],
      {
        projectRoot: secondRoot,
        dbPath: join(secondRoot, 'index.db'),
        indexPath: join(secondRoot, 'index.scip'),
        languages: ['typescript'],
        indexer: { typescript: { projects: ['ignored-tsconfig.json'] } },
        docs: { snapshotPaths: ['docs/benchmarks/**'] },
      },
      resolveGitWorktreeContext(secondRoot),
    );
    try {
      expect(canonicalRepositoryContentSnapshot(first.repositoryContent)).toBe(
        canonicalRepositoryContentSnapshot(second.repositoryContent),
      );
      expect(canonicalProjectInputSnapshot(first.indexInputs)).toBe(canonicalProjectInputSnapshot(second.indexInputs));
      expect(canonicalProjectInputSnapshot(first.indexInputs)).toBe(
        stableJson({
          version: first.indexInputs.version,
          languages: [...first.indexInputs.languages].sort(),
          pnpmWorkspaces: first.indexInputs.pnpmWorkspaces,
          typescriptProjectMode: first.indexInputs.typescriptProjectMode,
          typescriptProjects: [...first.indexInputs.typescriptProjects].sort(),
          ...(first.indexInputs.clojureConfigPath ? { clojureConfigPath: first.indexInputs.clojureConfigPath } : {}),
          files: [...first.indexInputs.files].sort((left, right) => left.path.localeCompare(right.path)),
        }),
      );
      expect(first.paths).toContain('.scipquery/suppressions/review.json');
      expect(first.paths).not.toContain('.scipquery/events/outcome.json');
      expect(first.paths).not.toContain('ignored.txt');
      expect(first.paths).toContain('ignored-tsconfig.json');
      expect(first.indexInputs.files.some((file) => file.path === 'ignored-tsconfig.json')).toBe(true);
      expect(first.paths).not.toContain('docs/benchmarks/historical.json');
      expect(first.repositoryContent.files.find((entry) => entry.path === 'script.sh')).toMatchObject({
        kind: 'file',
        executable: true,
      });
      expect(first.paths).toContain('source-link.ts');

      writeFileSync(join(firstRoot, 'source.ts'), 'export const value = 2;\n');
      withProjectSnapshot(first, () => {
        expect(readProjectFileText(firstRoot, 'source.ts')).toBe('export const value = 1;\n');
      });
      expect(readFileSync(join(firstRoot, 'source.ts'), 'utf8')).toBe('export const value = 2;\n');
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('fails closed when the repository changes during capture', () => {
    const root = repositoryFixture('racing');
    const config = {
      projectRoot: root,
      dbPath: join(root, 'index.db'),
      indexPath: join(root, 'index.scip'),
      languages: ['typescript'] as const,
    };

    expect(() =>
      captureProjectObservationSnapshot(root, ['typescript'], config, resolveGitWorktreeContext(root), undefined, {
        beforeValidation() {
          writeFileSync(join(root, 'source.ts'), 'export const value = 2;\n');
        },
      }),
    ).toThrow(/changed|moved/);
  });

  it('keeps concurrent command snapshots isolated', async () => {
    const firstRoot = repositoryFixture('concurrent-first');
    const secondRoot = repositoryFixture('concurrent-second');
    writeFileSync(join(secondRoot, 'source.ts'), 'export const value = 9;\n');
    const first = captureProjectObservationSnapshot(
      firstRoot,
      ['typescript'],
      {
        projectRoot: firstRoot,
        dbPath: join(firstRoot, 'index.db'),
        indexPath: join(firstRoot, 'index.scip'),
        languages: ['typescript'],
      },
      resolveGitWorktreeContext(firstRoot),
    );
    const second = captureProjectObservationSnapshot(
      secondRoot,
      ['typescript'],
      {
        projectRoot: secondRoot,
        dbPath: join(secondRoot, 'index.db'),
        indexPath: join(secondRoot, 'index.scip'),
        languages: ['typescript'],
      },
      resolveGitWorktreeContext(secondRoot),
    );
    try {
      const [firstText, secondText] = await Promise.all([
        withProjectSnapshot(first, async () => {
          await Promise.resolve();
          return readProjectFileText(firstRoot, 'source.ts');
        }),
        withProjectSnapshot(second, async () => {
          await Promise.resolve();
          return readProjectFileText(secondRoot, 'source.ts');
        }),
      ]);
      expect(firstText).toBe('export const value = 1;\n');
      expect(secondText).toBe('export const value = 9;\n');
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('preserves deletions as tombstones for the whole command', () => {
    const root = repositoryFixture('deleted');
    rmSync(join(root, 'README.md'));
    const snapshot = captureProjectObservationSnapshot(
      root,
      ['typescript'],
      {
        projectRoot: root,
        dbPath: join(root, 'index.db'),
        indexPath: join(root, 'index.scip'),
        languages: ['typescript'],
      },
      resolveGitWorktreeContext(root),
    );
    try {
      withProjectSnapshot(snapshot, () => {
        expect(snapshot.paths).not.toContain('README.md');
        expect(snapshot.missing.has('README.md')).toBe(true);
        expect(() => readProjectFileText(root, 'README.md')).toThrow(/does not exist/);
      });
    } finally {
      snapshot.dispose();
    }
  });
});

function repositoryFixture(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `scip-query-fixed-${label}-`));
  tempDirs.push(root);
  execFileSync('git', ['init', '--quiet', root]);
  mkdirSync(join(root, '.scipquery', 'events'), { recursive: true });
  mkdirSync(join(root, '.scipquery', 'suppressions'), { recursive: true });
  mkdirSync(join(root, 'docs', 'benchmarks'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\nignored-tsconfig.json\n');
  writeFileSync(join(root, '.scipquery.json'), '{}\n');
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'source-link.ts'), 'placeholder');
  rmSync(join(root, 'source-link.ts'));
  symlinkSync('source.ts', join(root, 'source-link.ts'));
  writeFileSync(join(root, 'README.md'), '# Fixture\n');
  writeFileSync(join(root, 'script.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'script.sh'), 0o644);
  writeFileSync(join(root, 'ignored.txt'), 'machine state\n');
  writeFileSync(join(root, 'ignored-tsconfig.json'), '{"compilerOptions":{}}\n');
  writeFileSync(join(root, '.scipquery', 'events', 'outcome.json'), '{}\n');
  writeFileSync(join(root, '.scipquery', 'suppressions', 'review.json'), '{}\n');
  writeFileSync(join(root, 'docs', 'benchmarks', 'historical.json'), '{"large":"snapshot"}\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Snapshot Test',
    '-c',
    'user.email=snapshot@example.com',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  chmodSync(join(root, 'script.sh'), 0o755);
  return root;
}
