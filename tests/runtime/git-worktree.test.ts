import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findGitRoot,
  listGitWorktrees,
  parseGitWorktreeList,
  resolveGitWorktreeContext,
  type GitReader,
} from '../../src/runtime/git-worktree.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Git worktree identity', () => {
  it('gives linked worktrees one repository identity and distinct worktree identities', () => {
    const primary = createRepository();
    const linked = temporaryDirectory('scip-query-linked-');
    rmSync(linked, { recursive: true, force: true });
    git(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);

    const primaryContext = resolveGitWorktreeContext(primary);
    const linkedContext = resolveGitWorktreeContext(linked);

    expect(primaryContext).toEqual(expect.objectContaining({ clean: true }));
    expect(linkedContext).toEqual(expect.objectContaining({ clean: true }));
    expect(linkedContext?.repositoryId).toBe(primaryContext?.repositoryId);
    expect(linkedContext?.treeOid).toBe(primaryContext?.treeOid);
    expect(linkedContext?.worktreeId).not.toBe(primaryContext?.worktreeId);
    expect(findGitRoot(join(linked, 'src'))).toBe(realpathSync(linked));
    expect(listGitWorktrees(linked).map((record) => record.path)).toEqual(
      expect.arrayContaining([realpathSync(primary), realpathSync(linked)]),
    );

    writeFileSync(join(primary, 'src/value.ts'), 'export const value = 2;\n');
    expect(resolveGitWorktreeContext(primary)?.clean).toBe(false);
    expect(resolveGitWorktreeContext(linked)?.clean).toBe(true);
  });

  it('returns undefined when required Git facts are unavailable', () => {
    const gitReader: GitReader = { run: () => undefined };
    expect(resolveGitWorktreeContext('/missing', gitReader)).toBeUndefined();
    expect(findGitRoot('/missing', gitReader)).toBeUndefined();
  });

  it('parses NUL-delimited porcelain records without treating attributes as paths', () => {
    const records = parseGitWorktreeList(
      'worktree /tmp/primary\0HEAD abc\0branch refs/heads/main\0\0' +
        'worktree /tmp/linked tree\0HEAD def\0detached\0locked reason\0prunable reason\0\0',
    );

    expect(records).toEqual([
      expect.objectContaining({ path: '/tmp/primary', head: 'abc', branch: 'refs/heads/main', detached: false }),
      expect.objectContaining({ path: '/tmp/linked tree', head: 'def', detached: true, locked: true, prunable: true }),
    ]);
  });
});

function createRepository(): string {
  const root = temporaryDirectory('scip-query-git-worktree-');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/value.ts'), 'export const value = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'initial']);
  return root;
}

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}
