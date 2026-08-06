import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SANDBOX_PREFIX = 'scip-query-exploration-';

/**
 * Create a clean repository snapshot that cannot observe concurrent edits in
 * the source worktree. The cache lives under the same disposable parent so
 * one cleanup removes both repository bytes and generated index artifacts.
 */
export function createExplorationSandbox(sourceRoot, options = {}) {
  const sourceRepository = realpathSync(resolve(sourceRoot));
  const ref = options.ref ?? 'HEAD';
  const commit = runGit(sourceRepository, ['rev-parse', '--verify', `${ref}^{commit}`], 30_000).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`git resolved ${ref} to an invalid commit identity`);

  const parent = mkdtempSync(join(tmpdir(), SANDBOX_PREFIX));
  const repository = join(parent, 'repository');
  const cacheDir = join(parent, 'cache');
  let registeredWorktree = false;
  let removed = false;

  try {
    runGit(sourceRepository, ['worktree', 'add', '--detach', repository, commit], 120_000);
    registeredWorktree = true;
    mkdirSync(cacheDir, { recursive: true });
    linkDependencyDirectory(sourceRepository, repository, 'node_modules');
  } catch (error) {
    if (registeredWorktree) removeGitWorktree(sourceRepository, repository);
    removeSandboxParent(parent);
    throw error;
  }

  return {
    kind: 'detached-worktree',
    sourceRepository,
    repository,
    cacheDir,
    commit,
    remove() {
      if (removed) return;
      removed = true;
      removeGitWorktree(sourceRepository, repository);
      removeSandboxParent(parent);
    },
  };
}

function linkDependencyDirectory(sourceRepository, repository, name) {
  const source = join(sourceRepository, name);
  const target = join(repository, name);
  if (!existsSync(source) || existsSync(target)) return;
  symlinkSync(source, target, 'dir');
}

function removeGitWorktree(sourceRepository, repository) {
  const removed = spawnSync('git', ['worktree', 'remove', '--force', repository], {
    cwd: sourceRepository,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (removed.status !== 0 && existsSync(repository)) {
    rmSync(repository, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  spawnSync('git', ['worktree', 'prune'], {
    cwd: sourceRepository,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function removeSandboxParent(parent) {
  if (basename(parent).startsWith(SANDBOX_PREFIX)) {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function runGit(cwd, args, timeout) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`git ${args.join(' ')} exited ${String(result.status)}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}
