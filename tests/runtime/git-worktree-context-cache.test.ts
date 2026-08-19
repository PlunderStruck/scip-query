import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureOwnedCacheDir } from '../../src/platform/cache-layout.js';
import type { GitReader } from '../../src/platform/git-worktree.js';
import { observeGitWorktreeContextWithCache } from '../../src/runtime/git-worktree-context-cache.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0).reverse()) rmSync(path, { recursive: true, force: true });
});

describe('cached Git worktree context', () => {
  it('uses one live status process after seeding a cache-owned receipt', () => {
    const root = createRepository();
    const cacheDir = createOwnedCache(root);
    const calls: string[][] = [];
    const git = countingGitReader(calls);

    const seeded = observeGitWorktreeContextWithCache(root, cacheDir, git);
    expect(seeded?.context.headCommit).toBe(gitOutput(root, ['rev-parse', 'HEAD']));
    expect(calls).toEqual([
      ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', 'HEAD', 'HEAD^{tree}'],
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
    ]);

    calls.length = 0;
    expect(observeGitWorktreeContextWithCache(root, cacheDir, git)).toEqual(seeded);
    expect(calls).toEqual([['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']]);
  });

  it('falls back on a moved HEAD, replaces the receipt, then returns to one status process', () => {
    const root = createRepository();
    const cacheDir = createOwnedCache(root);
    const calls: string[][] = [];
    const git = countingGitReader(calls);
    const before = observeGitWorktreeContextWithCache(root, cacheDir, git)!;

    writeFileSync(join(root, 'src/value.ts'), 'export const value = 2;\n');
    gitOutput(root, ['add', '.']);
    gitOutput(root, ['commit', '-qm', 'second']);
    calls.length = 0;

    const after = observeGitWorktreeContextWithCache(root, cacheDir, git)!;
    expect(after.context.headCommit).not.toBe(before.context.headCommit);
    expect(after.context.treeOid).not.toBe(before.context.treeOid);
    expect(calls).toEqual([
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
      ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', 'HEAD', 'HEAD^{tree}'],
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
    ]);

    calls.length = 0;
    expect(observeGitWorktreeContextWithCache(root, cacheDir, git)).toEqual(after);
    expect(calls).toEqual([['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']]);
  });

  it('fails closed on a corrupted receipt and repairs it from a full observation', () => {
    const root = createRepository();
    const cacheDir = createOwnedCache(root);
    const calls: string[][] = [];
    const git = countingGitReader(calls);
    const expected = observeGitWorktreeContextWithCache(root, cacheDir, git)!;
    const receiptPath = join(cacheDir, 'git-worktree-context.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt['treeOid'] = 'f'.repeat(40);
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    calls.length = 0;

    expect(observeGitWorktreeContextWithCache(root, cacheDir, git)).toEqual(expected);
    expect(calls).toEqual([
      ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', 'HEAD', 'HEAD^{tree}'],
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
    ]);

    calls.length = 0;
    expect(observeGitWorktreeContextWithCache(root, cacheDir, git)).toEqual(expected);
    expect(calls).toEqual([['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']]);
  });

  it('reuses a linked-worktree receipt while preserving the shared repository identity', () => {
    const primary = createRepository();
    const linked = temporaryDirectory('scip-query-context-cache-linked-');
    rmSync(linked, { recursive: true, force: true });
    gitOutput(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const cacheDir = createOwnedCache(linked);
    const calls: string[][] = [];
    const git = countingGitReader(calls);
    const seeded = observeGitWorktreeContextWithCache(linked, cacheDir, git)!;
    calls.length = 0;

    expect(observeGitWorktreeContextWithCache(linked, cacheDir, git)).toEqual(seeded);
    expect(calls).toEqual([['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']]);
  });
});

function createRepository(): string {
  const root = temporaryDirectory('scip-query-context-cache-repo-');
  gitOutput(root, ['init', '-q', '-b', 'main']);
  gitOutput(root, ['config', 'user.email', 'test@example.com']);
  gitOutput(root, ['config', 'user.name', 'Test User']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/value.ts'), 'export const value = 1;\n');
  gitOutput(root, ['add', '.']);
  gitOutput(root, ['commit', '-qm', 'initial']);
  return root;
}

function createOwnedCache(projectRoot: string): string {
  const cacheDir = temporaryDirectory('scip-query-context-cache-dir-');
  return ensureOwnedCacheDir(projectRoot, cacheDir);
}

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function countingGitReader(calls: string[][]): GitReader {
  return {
    run: (projectRoot, args) => {
      calls.push([...args]);
      return gitOutput(projectRoot, args);
    },
    runResult: (projectRoot, args) => {
      calls.push([...args]);
      return { kind: 'success', output: gitOutput(projectRoot, args) };
    },
  };
}

function gitOutput(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trimEnd();
}
