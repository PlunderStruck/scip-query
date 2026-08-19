import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// scip-query: ignore-stale — reviewed S1 owned contract; worktree resolution uses this injectable Git boundary.
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

const BATCHED_WORKTREE_CONTEXT_ARGS = [
  'rev-parse',
  '--show-toplevel',
  '--absolute-git-dir',
  '--git-common-dir',
  'HEAD',
  'HEAD^{tree}',
] as const;
const LIVE_WORKTREE_STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'] as const;
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;

export function resolveGitCommit(projectRoot: string, revision: string, git: GitReader = DEFAULT_GIT_READER): string {
  if (!revision || revision.startsWith('-') || /[\0\r\n]/.test(revision)) {
    throw new Error(`Invalid Git revision ${JSON.stringify(revision)}.`);
  }
  const result = git.runResult(projectRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
  if (result.kind !== 'success' || !GIT_OBJECT_ID.test(result.output)) {
    throw new Error(`Git revision ${JSON.stringify(revision)} does not resolve to exactly one commit.`);
  }
  return result.output;
}

export function findGitRoot(cwd: string, git: GitReader = DEFAULT_GIT_READER): string | undefined {
  const root = git.run(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  return root ? canonicalPath(root) : undefined;
}

export function resolveGitWorktreeContext(
  projectRoot: string,
  git: GitReader = DEFAULT_GIT_READER,
): GitWorktreeContext | undefined {
  const batchedResult = git.runResult(projectRoot, BATCHED_WORKTREE_CONTEXT_ARGS);
  if (batchedResult.kind === 'success') {
    const metadata = parseBatchedWorktreeContext(batchedResult.output);
    if (metadata) return resolveGitWorktreeContextFromMetadata(metadata, git);
  }
  return resolveGitWorktreeContextIndividually(projectRoot, git);
}

/**
 * Rechecks the mutable parts of a previously resolved worktree observation in
 * one Git process. A matching commit preserves the commit-bound tree and
 * identity fields; any changed, missing, or malformed HEAD fails closed.
 */
export function refreshGitWorktreeContext(
  context: GitWorktreeContext,
  git: GitReader = DEFAULT_GIT_READER,
): GitWorktreeContext | undefined {
  if (!context.headCommit) return undefined;
  const status = git.run(context.projectRoot, LIVE_WORKTREE_STATUS_ARGS);
  if (status === undefined) return undefined;
  const observation = parseLiveWorktreeStatus(status);
  if (!observation?.headCommit || observation.headCommit !== context.headCommit) return undefined;
  return { ...context, clean: observation.clean };
}

/**
 * True when Git observes every tracked path normally. Assume-unchanged and
 * skip-worktree entries can hide byte changes from a clean status result, so
 * they cannot support tree-only freshness reuse.
 */
export function gitIndexAllowsTreeFingerprintReuse(projectRoot: string, git: GitReader = DEFAULT_GIT_READER): boolean {
  const entries = git.run(projectRoot, ['ls-files', '-v', '-z']);
  if (entries === undefined) return false;
  return entries
    .split('\0')
    .filter(Boolean)
    .every((entry) => entry.startsWith('H '));
}

interface GitWorktreeContextMetadata {
  root: string;
  gitDir: string;
  commonDir: string;
  headCommit: string;
  treeOid: string;
}

function parseLiveWorktreeStatus(output: string): { headCommit?: string; clean: boolean } | undefined {
  const entries = output.split('\0').filter(Boolean);
  const oid = entries.find((entry) => entry.startsWith('# branch.oid '))?.slice('# branch.oid '.length);
  const headCommit = oid === '(initial)' ? undefined : oid;
  if (headCommit !== undefined && !GIT_OBJECT_ID.test(headCommit)) return undefined;
  if (oid === undefined) return undefined;
  return {
    headCommit,
    clean: entries.every((entry) => entry.startsWith('# ')),
  };
}

function parseBatchedWorktreeContext(output: string): GitWorktreeContextMetadata | undefined {
  const fields = output.split('\n').map((field) => field.trim());
  if (fields.length !== 5) return undefined;
  const [rootOutput, rawGitDir, rawCommonDir, headCommit, treeOid] = fields;
  if (!rootOutput || !rawGitDir || !rawCommonDir || !headCommit || !treeOid) return undefined;
  if (!GIT_OBJECT_ID.test(headCommit) || !GIT_OBJECT_ID.test(treeOid)) return undefined;
  const root = canonicalPath(rootOutput);
  return {
    root,
    gitDir: canonicalPath(resolveGitPath(root, rawGitDir)),
    commonDir: canonicalPath(resolveGitPath(root, rawCommonDir)),
    headCommit,
    treeOid,
  };
}

function resolveGitWorktreeContextFromMetadata(
  metadata: GitWorktreeContextMetadata,
  git: GitReader,
): GitWorktreeContext | undefined {
  const status = git.run(metadata.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status === undefined) return undefined;
  const identity = gitWorktreeIdentity(metadata.root, metadata.gitDir);
  return {
    ...identity,
    commonDir: metadata.commonDir,
    repositoryId: stablePathId('repository', metadata.commonDir),
    headCommit: metadata.headCommit,
    treeOid: metadata.treeOid,
    clean: status.length === 0,
  };
}

function resolveGitWorktreeContextIndividually(projectRoot: string, git: GitReader): GitWorktreeContext | undefined {
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

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
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
    identity: gitWorktreeIdentity(root, gitDir),
  };
}

function gitWorktreeIdentity(projectRoot: string, gitDir: string): GitWorktreeIdentity {
  return {
    projectRoot,
    gitDir,
    worktreeId: stablePathId('worktree', `${projectRoot}\0${gitDir}`),
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
    timeout: 30_000,
    killSignal: 'SIGKILL',
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
