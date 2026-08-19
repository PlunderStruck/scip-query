import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findGitRoot,
  gitIndexAllowsTreeFingerprintReuse,
  listGitWorktrees,
  parseGitWorktreeList,
  refreshGitWorktreeContext,
  resolveGitCommit,
  resolveGitWorktreeContext,
  resolveGitWorktreeIdentity,
  type GitReader,
} from '../../src/platform/git-worktree.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Git worktree identity', () => {
  it('resolves revision syntax to one full commit identity behind an end-of-options marker', () => {
    const root = createRepository();
    const expected = git(root, ['rev-parse', 'HEAD']);
    const calls: string[][] = [];
    const gitReader: GitReader = {
      run: () => undefined,
      runResult: (_projectRoot, args) => {
        calls.push([...args]);
        return { kind: 'success', output: expected };
      },
    };

    expect(resolveGitCommit(root, 'HEAD~0', gitReader)).toBe(expected);
    expect(calls).toEqual([['rev-parse', '--verify', '--end-of-options', 'HEAD~0^{commit}']]);
  });

  it('accepts branches, tags, abbreviated hashes, full hashes, and ancestry expressions', () => {
    const root = createRepository();
    const firstCommit = git(root, ['rev-parse', 'HEAD']);
    git(root, ['tag', 'baseline']);
    writeFileSync(join(root, 'src/value.ts'), 'export const value = 2;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'second']);
    const secondCommit = git(root, ['rev-parse', 'HEAD']);

    expect(resolveGitCommit(root, 'main')).toBe(secondCommit);
    expect(resolveGitCommit(root, 'baseline')).toBe(firstCommit);
    expect(resolveGitCommit(root, secondCommit.slice(0, 12))).toBe(secondCommit);
    expect(resolveGitCommit(root, secondCommit)).toBe(secondCommit);
    expect(resolveGitCommit(root, 'HEAD~1')).toBe(firstCommit);
    expect(() => resolveGitCommit(root, 'does-not-exist')).toThrow('does not resolve to exactly one commit');
  });

  it('rejects option-like and control-bearing revisions before invoking Git', () => {
    const calls: string[][] = [];
    const gitReader: GitReader = {
      run: () => undefined,
      runResult: (_projectRoot, args) => {
        calls.push([...args]);
        return { kind: 'success', output: 'a'.repeat(40) };
      },
    };

    for (const revision of ['--output=/tmp/owned', '-p', 'HEAD\n--output=/tmp/owned', 'HEAD\0other']) {
      expect(() => resolveGitCommit('/repo', revision, gitReader)).toThrow('Invalid Git revision');
    }
    expect(calls).toEqual([]);
  });

  it('rejects unknown or ambiguous Git output instead of forwarding it', () => {
    const outputs = ['', 'not-an-object', `${'a'.repeat(40)}\n${'b'.repeat(40)}`];
    for (const output of outputs) {
      const gitReader: GitReader = {
        run: () => undefined,
        runResult: () => ({ kind: 'success', output }),
      };
      expect(() => resolveGitCommit('/repo', 'topic', gitReader)).toThrow('does not resolve to exactly one commit');
    }
  });

  it('reads complete worktree context with one metadata lookup and one status lookup', () => {
    const root = temporaryDirectory('scip-query-batched-git-context-');
    const gitDir = join(root, '.git');
    mkdirSync(gitDir);
    const headCommit = 'a'.repeat(40);
    const treeOid = 'b'.repeat(40);
    const calls: Array<{ method: 'run' | 'runResult'; args: readonly string[] }> = [];
    const gitReader: GitReader = {
      run: (_projectRoot, args) => {
        calls.push({ method: 'run', args });
        return ' M src/value.ts';
      },
      runResult: (_projectRoot, args) => {
        calls.push({ method: 'runResult', args });
        return { kind: 'success', output: [root, gitDir, '.git', headCommit, treeOid].join('\n') };
      },
    };

    expect(resolveGitWorktreeContext(root, gitReader)).toEqual(
      expect.objectContaining({
        projectRoot: realpathSync(root),
        gitDir: realpathSync(gitDir),
        commonDir: realpathSync(gitDir),
        headCommit,
        treeOid,
        clean: false,
      }),
    );
    expect(calls).toEqual([
      {
        method: 'runResult',
        args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', 'HEAD', 'HEAD^{tree}'],
      },
      { method: 'run', args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'] },
    ]);
  });

  it('falls back to individual lookups when batched metadata is ambiguous', () => {
    const root = temporaryDirectory('scip-query-fallback-git-context-');
    const gitDir = join(root, '.git');
    mkdirSync(gitDir);
    const headCommit = 'c'.repeat(40);
    const treeOid = 'd'.repeat(40);
    const gitReader: GitReader = {
      run: (_projectRoot, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --absolute-git-dir') return gitDir;
        if (command === 'rev-parse --git-common-dir') return '.git';
        if (command === 'rev-parse --verify HEAD') return headCommit;
        if (command === 'rev-parse --verify HEAD^{tree}') return treeOid;
        if (command === 'status --porcelain=v1 -z --untracked-files=all') return '';
        return undefined;
      },
      runResult: (_projectRoot, args) =>
        args.length > 2
          ? { kind: 'success', output: [root, gitDir, '.git', headCommit, treeOid, 'extra'].join('\n') }
          : { kind: 'success', output: root },
    };

    expect(resolveGitWorktreeContext(root, gitReader)).toEqual(
      expect.objectContaining({ headCommit, treeOid, clean: true }),
    );
  });

  it('refreshes status and HEAD together while preserving commit-bound identity', () => {
    const context = {
      projectRoot: '/repo',
      gitDir: '/repo/.git',
      commonDir: '/repo/.git',
      repositoryId: 'repository',
      worktreeId: 'worktree',
      headCommit: 'a'.repeat(40),
      treeOid: 'b'.repeat(40),
      clean: true,
    };
    const calls: string[][] = [];
    const gitReader: GitReader = {
      run: (_projectRoot, args) => {
        calls.push([...args]);
        return `# branch.oid ${context.headCommit}\0# branch.head main\0? src/new.ts\0`;
      },
      runResult: () => ({ kind: 'error', message: 'unexpected' }),
    };

    expect(refreshGitWorktreeContext(context, gitReader)).toEqual({ ...context, clean: false });
    expect(calls).toEqual([['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']]);
  });

  it('fails closed when the live status omits or changes HEAD', () => {
    const context = {
      projectRoot: '/repo',
      gitDir: '/repo/.git',
      commonDir: '/repo/.git',
      repositoryId: 'repository',
      worktreeId: 'worktree',
      headCommit: 'a'.repeat(40),
      treeOid: 'b'.repeat(40),
      clean: true,
    };
    const outputs = [
      `# branch.oid ${'c'.repeat(40)}\0# branch.head main\0`,
      '# branch.oid not-an-object\0# branch.head main\0',
      '# branch.head main\0',
      undefined,
    ];

    for (const output of outputs) {
      const gitReader: GitReader = {
        run: () => output,
        runResult: () => ({ kind: 'error', message: 'unexpected' }),
      };
      expect(refreshGitWorktreeContext(context, gitReader)).toBeUndefined();
    }

    const unbornContext = { ...context, headCommit: undefined, treeOid: undefined };
    const gitReader: GitReader = {
      run: () => '# branch.oid (initial)\0# branch.head main\0',
      runResult: () => ({ kind: 'error', message: 'unexpected' }),
    };
    expect(refreshGitWorktreeContext(unbornContext, gitReader)).toBeUndefined();
  });

  it('refreshes a real worktree and rejects a later commit', () => {
    const root = createRepository();
    const context = resolveGitWorktreeContext(root);

    expect(context).toBeDefined();
    expect(refreshGitWorktreeContext(context!)).toEqual(context);

    writeFileSync(join(root, 'src/value.ts'), 'export const value = 2;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'second']);

    expect(refreshGitWorktreeContext(context!)).toBeUndefined();
  });

  it('preserves worktree identity before the repository has a first commit', () => {
    const root = temporaryDirectory('scip-query-unborn-git-context-');
    git(root, ['init', '-q', '-b', 'main']);

    expect(resolveGitWorktreeContext(root)).toEqual(
      expect.objectContaining({
        projectRoot: realpathSync(root),
        headCommit: undefined,
        treeOid: undefined,
        clean: true,
      }),
    );
  });

  it('rejects index flags that can hide tracked-file changes from clean status', () => {
    const root = createRepository();
    const sourcePath = 'src/value.ts';

    expect(gitIndexAllowsTreeFingerprintReuse(root)).toBe(true);

    git(root, ['update-index', '--assume-unchanged', sourcePath]);
    expect(gitIndexAllowsTreeFingerprintReuse(root)).toBe(false);
    git(root, ['update-index', '--no-assume-unchanged', sourcePath]);

    git(root, ['update-index', '--skip-worktree', sourcePath]);
    expect(gitIndexAllowsTreeFingerprintReuse(root)).toBe(false);
    git(root, ['update-index', '--no-skip-worktree', sourcePath]);
    expect(gitIndexAllowsTreeFingerprintReuse(root)).toBe(true);
  });

  it('gives linked worktrees one repository identity and distinct worktree identities', () => {
    const primary = createRepository();
    const linked = temporaryDirectory('scip-query-linked-');
    rmSync(linked, { recursive: true, force: true });
    git(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);

    const primaryContext = resolveGitWorktreeContext(primary);
    const linkedContext = resolveGitWorktreeContext(linked);
    const primaryIdentity = resolveGitWorktreeIdentity(primary);
    const linkedIdentity = resolveGitWorktreeIdentity(linked);

    expect(primaryContext).toEqual(expect.objectContaining({ clean: true }));
    expect(linkedContext).toEqual(expect.objectContaining({ clean: true }));
    expect(linkedContext?.repositoryId).toBe(primaryContext?.repositoryId);
    expect(linkedContext?.treeOid).toBe(primaryContext?.treeOid);
    expect(linkedContext?.worktreeId).not.toBe(primaryContext?.worktreeId);
    expect(primaryIdentity).toEqual(expect.objectContaining({ kind: 'worktree' }));
    expect(linkedIdentity).toEqual(expect.objectContaining({ kind: 'worktree' }));
    expect(primaryIdentity.kind === 'worktree' ? primaryIdentity.identity.worktreeId : undefined).toBe(
      primaryContext?.worktreeId,
    );
    expect(linkedIdentity.kind === 'worktree' ? linkedIdentity.identity.worktreeId : undefined).toBe(
      linkedContext?.worktreeId,
    );
    expect(findGitRoot(join(linked, 'src'))).toBe(realpathSync(linked));
    expect(listGitWorktrees(linked).map((record) => record.path)).toEqual(
      expect.arrayContaining([realpathSync(primary), realpathSync(linked)]),
    );

    writeFileSync(join(primary, 'src/value.ts'), 'export const value = 2;\n');
    expect(resolveGitWorktreeContext(primary)?.clean).toBe(false);
    expect(resolveGitWorktreeContext(linked)?.clean).toBe(true);
  });

  it('distinguishes confirmed non-Git roots from Git lookup failures', () => {
    const gitReader: GitReader = {
      run: () => undefined,
      runResult: () => ({ kind: 'error', message: 'git unavailable' }),
    };
    expect(resolveGitWorktreeContext('/missing', gitReader)).toBeUndefined();
    expect(resolveGitWorktreeIdentity('/missing', gitReader)).toEqual({ kind: 'error', message: 'git unavailable' });
    expect(findGitRoot('/missing', gitReader)).toBeUndefined();

    const nonGitRoot = temporaryDirectory('scip-query-non-git-');
    expect(resolveGitWorktreeIdentity(nonGitRoot)).toEqual({ kind: 'non-git' });

    const damagedGitRoot = temporaryDirectory('scip-query-damaged-git-');
    mkdirSync(join(damagedGitRoot, '.git'));
    expect(resolveGitWorktreeIdentity(damagedGitRoot)).toEqual({
      kind: 'error',
      message: expect.stringMatching(/not a git repository/i),
    });
  });

  it('keeps existing non-Git projects usable when the Git executable is unavailable', () => {
    const nonGitRoot = temporaryDirectory('scip-query-non-git-without-git-');
    withoutGit(() => expect(resolveGitWorktreeIdentity(nonGitRoot)).toEqual({ kind: 'non-git' }));

    const damagedGitRoot = temporaryDirectory('scip-query-damaged-git-without-git-');
    mkdirSync(join(damagedGitRoot, '.git'));
    withoutGit(() =>
      expect(resolveGitWorktreeIdentity(damagedGitRoot)).toEqual({
        kind: 'error',
        message: expect.stringMatching(/ENOENT/i),
      }),
    );

    withoutGit(() =>
      expect(resolveGitWorktreeIdentity(join(nonGitRoot, 'missing'))).toEqual({
        kind: 'error',
        message: expect.stringMatching(/ENOENT/i),
      }),
    );
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

function withoutGit(run: () => void): void {
  const originalPath = process.env['PATH'];
  process.env['PATH'] = '';
  try {
    run();
  } finally {
    if (originalPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = originalPath;
  }
}
