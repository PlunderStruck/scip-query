import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface GitReader {
  run(projectRoot: string, args: readonly string[]): string | undefined;
}

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

export const DEFAULT_GIT_READER: GitReader = {
  run(projectRoot, args) {
    try {
      return execFileSync('git', ['-C', projectRoot, ...args], {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trimEnd();
    } catch {
      return undefined;
    }
  },
};

export function findGitRoot(cwd: string, git: GitReader = DEFAULT_GIT_READER): string | undefined {
  const root = git.run(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  return root ? canonicalPath(root) : undefined;
}

export function resolveGitWorktreeContext(
  projectRoot: string,
  git: GitReader = DEFAULT_GIT_READER,
): GitWorktreeContext | undefined {
  const root = findGitRoot(projectRoot, git);
  if (!root) return undefined;

  const rawGitDir = git.run(root, ['rev-parse', '--absolute-git-dir'])?.trim();
  const rawCommonDir = git.run(root, ['rev-parse', '--git-common-dir'])?.trim();
  if (!rawGitDir || !rawCommonDir) return undefined;

  const gitDir = canonicalPath(resolveGitPath(root, rawGitDir));
  const commonDir = canonicalPath(resolveGitPath(root, rawCommonDir));
  const headCommit = nonEmpty(git.run(root, ['rev-parse', '--verify', 'HEAD']));
  const treeOid = nonEmpty(git.run(root, ['rev-parse', '--verify', 'HEAD^{tree}']));
  const status = git.run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status === undefined) return undefined;

  return {
    projectRoot: root,
    gitDir,
    commonDir,
    repositoryId: stablePathId('repository', commonDir),
    worktreeId: stablePathId('worktree', `${root}\0${gitDir}`),
    headCommit,
    treeOid,
    clean: status.length === 0,
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

function resolveGitPath(projectRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}

function canonicalPath(path: string): string {
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
