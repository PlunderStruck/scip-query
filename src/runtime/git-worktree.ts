import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface GitReader {
  run(projectRoot: string, args: readonly string[]): string | undefined;
  runResult(projectRoot: string, args: readonly string[]): GitCommandResult;
}

export type GitCommandResult =
  | { kind: 'success'; output: string }
  | { kind: 'not-repository' }
  | { kind: 'error'; message: string };

export interface GitWorktreeRecord {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
  locked: boolean;
}

export interface GitWorktreeContext {
  projectRoot: string;
  gitDir: string;
  commonDir: string;
  repositoryId: string;
  worktreeId: string;
  headCommit?: string;
  treeOid?: string;
  clean: boolean;
}

export type GitWorktreeIdentity = Pick<GitWorktreeContext, 'projectRoot' | 'gitDir' | 'worktreeId'>;

export type GitWorktreeIdentityResolution =
  | { kind: 'worktree'; identity: GitWorktreeIdentity }
  | { kind: 'non-git' }
  | { kind: 'error'; message: string };

export const DEFAULT_GIT_READER: GitReader = {
  run(projectRoot, args) {
    const result = runGitCommand(projectRoot, args);
    return result.kind === 'success' ? result.output : undefined;
  },
  runResult: runGitCommand,
};

export function findGitRoot(cwd: string, git: GitReader = DEFAULT_GIT_READER): string | undefined {
  const root = git.run(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  return root ? canonicalPath(root) : undefined;
}

export function resolveGitWorktreeContext(
  projectRoot: string,
  git: GitReader = DEFAULT_GIT_READER,
): GitWorktreeContext | undefined {
  const resolution = resolveGitWorktreeIdentity(projectRoot, git);
  if (resolution.kind !== 'worktree') return undefined;
  const identity = resolution.identity;
  const root = identity.projectRoot;
  const rawCommonDir = git.run(root, ['rev-parse', '--git-common-dir'])?.trim();
  if (!rawCommonDir) return undefined;

  const commonDir = canonicalPath(resolveGitPath(root, rawCommonDir));
  const headCommit = nonEmpty(git.run(root, ['rev-parse', '--verify', 'HEAD']));
  const treeOid = nonEmpty(git.run(root, ['rev-parse', '--verify', 'HEAD^{tree}']));
  const status = git.run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status === undefined) return undefined;

  return {
    ...identity,
    commonDir,
    repositoryId: stablePathId('repository', commonDir),
    headCommit,
    treeOid,
    clean: status.length === 0,
  };
}

export function resolveGitWorktreeIdentity(
  projectRoot: string,
  git: GitReader = DEFAULT_GIT_READER,
): GitWorktreeIdentityResolution {
  const rootResult = git.runResult(projectRoot, ['rev-parse', '--show-toplevel']);
  if (rootResult.kind === 'not-repository') return { kind: 'non-git' };
  if (rootResult.kind === 'error') return rootResult;
  const rootOutput = rootResult.output.trim();
  if (!rootOutput) return { kind: 'error', message: 'Git returned an empty worktree root.' };
  const root = canonicalPath(rootOutput);
  const rawGitDir = git.run(root, ['rev-parse', '--absolute-git-dir'])?.trim();
  if (!rawGitDir) return { kind: 'error', message: 'Git did not return an absolute worktree directory.' };
  const gitDir = canonicalPath(resolveGitPath(root, rawGitDir));
  return {
    kind: 'worktree',
    identity: {
      projectRoot: root,
      gitDir,
      worktreeId: stablePathId('worktree', `${root}\0${gitDir}`),
    },
  };
}

export function listGitWorktrees(projectRoot: string, git: GitReader = DEFAULT_GIT_READER): GitWorktreeRecord[] {
  const output = git.run(projectRoot, ['worktree', 'list', '--porcelain', '-z']);
  return output === undefined ? [] : parseGitWorktreeList(output);
}

export function parseGitWorktreeList(output: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = [];
  let current: GitWorktreeRecord | undefined;
  for (const field of output.split('\0')) {
    if (field === '') {
      if (current) records.push(current);
      current = undefined;
      continue;
    }
    const separator = field.indexOf(' ');
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? '' : field.slice(separator + 1);
    if (key === 'worktree') {
      if (current) records.push(current);
      current = {
        path: canonicalPath(value),
        detached: false,
        bare: false,
        prunable: false,
        locked: false,
      };
      continue;
    }
    if (!current) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'prunable') current.prunable = true;
    else if (key === 'locked') current.locked = true;
  }
  if (current) records.push(current);
  return records;
}

export function gitOutput(
  projectRoot: string,
  args: readonly string[],
  git: GitReader = DEFAULT_GIT_READER,
): string | undefined {
  return nonEmpty(git.run(projectRoot, args));
}

export function resolveGitPath(projectRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}

export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function stablePathId(kind: string, value: string): string {
  return createHash('sha256').update(`${kind}\0${value}`).digest('hex').slice(0, 24);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function runGitCommand(projectRoot: string, args: readonly string[]): GitCommandResult {
  const result = spawnSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return { kind: 'success', output: result.stdout.trimEnd() };
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  const message = stderr || result.error?.message || `git exited with status ${result.status ?? 'unknown'}`;
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const confirmsNonGit =
    /not a git repository/i.test(message) || (errorCode === 'ENOENT' && existsSync(resolve(projectRoot)));
  return confirmsNonGit && !gitControlMetadataMayExist(projectRoot)
    ? { kind: 'not-repository' }
    : { kind: 'error', message };
}

function gitControlMetadataMayExist(projectRoot: string): boolean {
  if (process.env['GIT_DIR'] || process.env['GIT_COMMON_DIR']) return true;
  let current = resolve(projectRoot);
  while (true) {
    try {
      lstatSync(join(current, '.git'));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
