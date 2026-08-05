import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SHARED_GENERATION_TTL_MS,
  maybeSweepRepositoryCache,
  planRepositoryCacheSweep,
  type RepositoryCacheGenerationInventory,
  type RepositoryCacheLeaseInventory,
} from '../../src/runtime/repository-cache-lifecycle.js';
import { resolveDefaultCacheDir } from '../../src/platform/cache-layout.js';
import { resolveGitWorktreeContext } from '../../src/platform/git-worktree.js';
import {
  SHARED_GENERATION_PRODUCER_IDENTITY,
  worktreeLeaseOwnershipChecksum,
  writeWorktreeLease,
  type SharedGenerationSnapshot,
  type WorktreeCacheLease,
} from '../../src/reindex/shared-generation-store.js';
import type { ProjectInputFingerprint } from '../../src/platform/project-files.js';
import { acquireProcessFileLockAsync, acquireRepositoryCacheLock } from '../../src/platform/repository-cache-lock.js';

const HOUR = 60 * 60 * 1_000;
const tempDirs: string[] = [];
const originalXdgCacheHome = process.env['XDG_CACHE_HOME'];

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env['XDG_CACHE_HOME'];
  else process.env['XDG_CACHE_HOME'] = originalXdgCacheHome;
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('repository cache lifecycle policy', () => {
  it('serializes lease reachability changes with repository cleanup', () => {
    const repositoryDir = temporaryDirectory('scip-query-repository-lock-');
    const owner = acquireRepositoryCacheLock(repositoryDir);
    expect(owner).not.toBeNull();
    expect(acquireRepositoryCacheLock(repositoryDir)).toBeNull();
    owner!.release();
    const next = acquireRepositoryCacheLock(repositoryDir);
    expect(next).not.toBeNull();
    next!.release();
  });

  it('waits for a process lock without blocking the current event loop', async () => {
    const repositoryDir = temporaryDirectory('scip-query-async-process-lock-');
    const owner = acquireRepositoryCacheLock(repositoryDir);
    expect(owner).not.toBeNull();
    const repositoryLockPath = join(repositoryDir, 'gc.lock');
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
      owner!.release();
    }, 5);

    const waiter = await acquireProcessFileLockAsync(repositoryLockPath, { waitMs: 100, pollMs: 1 });

    expect(timerFired).toBe(true);
    expect(waiter).not.toBeNull();
    waiter!.release();
    expect(existsSync(repositoryLockPath)).toBe(false);
  });

  it('bounds a contended lock wait with the injected monotonic source', () => {
    const repositoryDir = temporaryDirectory('scip-query-monotonic-process-lock-');
    const owner = acquireRepositoryCacheLock(repositoryDir);
    expect(owner).not.toBeNull();
    let monotonicNow = 0;

    try {
      expect(
        acquireRepositoryCacheLock(repositoryDir, {
          waitMs: 15,
          pollMs: 1,
          now: () => {
            const observed = monotonicNow;
            monotonicNow += 10;
            return observed;
          },
        }),
      ).toBeNull();
      expect(monotonicNow).toBeGreaterThan(15);
    } finally {
      owner!.release();
    }
  });

  it('protects live leases and immediately schedules disappeared managed worktrees', () => {
    const plan = planRepositoryCacheSweep({
      nowMs: 2 * HOUR,
      leases: [lease('live', true, true, 'generation-live'), lease('gone', false, true, 'generation-gone')],
      generations: [generation('generation-live', 10), generation('generation-gone', 20)],
      locks: [],
      temporaries: [],
      policy: { generationTtlMs: HOUR, budgetBytes: 1_000 },
    });

    expect(plan.deleteWorktrees.map((entry) => entry.lease.worktreeId)).toEqual(['gone']);
    expect(plan.protectedGenerationIds).toEqual(['generation-live']);
    expect(plan.deleteGenerations).toEqual([]);
    expect(plan.unreferencedSince['generation-gone']).toBe(2 * HOUR);
  });

  it('protects the baseline of a live private overlay without an active shared generation', () => {
    const overlay = lease('overlay', true, true, 'generation-base');
    delete overlay.lease.activeGenerationId;
    overlay.lease.lastAction = 'overlay';
    const plan = planRepositoryCacheSweep({
      nowMs: 2 * HOUR,
      leases: [overlay],
      generations: [generation('generation-base', 10, 0)],
      locks: [],
      temporaries: [],
      policy: { generationTtlMs: HOUR, budgetBytes: 0 },
    });

    expect(plan.protectedGenerationIds).toEqual(['generation-base']);
    expect(plan.deleteGenerations).toEqual([]);
  });

  it('expires a generation at one hour unreferenced but not one millisecond earlier', () => {
    const before = planRepositoryCacheSweep({
      nowMs: HOUR - 1,
      leases: [],
      generations: [generation('generation', 10, 0)],
      locks: [],
      temporaries: [],
      policy: { generationTtlMs: HOUR, budgetBytes: 1_000 },
    });
    const atBoundary = planRepositoryCacheSweep({
      nowMs: HOUR,
      leases: [],
      generations: [generation('generation', 10, 0)],
      locks: [],
      temporaries: [],
      policy: { generationTtlMs: HOUR, budgetBytes: 1_000 },
    });

    expect(before.deleteGenerations).toEqual([]);
    expect(atBoundary.deleteGenerations.map((entry) => entry.generationId)).toEqual(['generation']);
  });

  it('evicts oldest unprotected generations for budget pressure and retains live locks', () => {
    const plan = planRepositoryCacheSweep({
      nowMs: 100,
      leases: [],
      generations: [generation('oldest', 60, 10), generation('newer', 60, 20), generation('locked', 500, 0)],
      locks: [{ generationId: 'locked', path: '/locks/locked', live: true }],
      temporaries: [],
      policy: { generationTtlMs: 1_000, budgetBytes: 550 },
    });

    expect(plan.deleteGenerations.map((entry) => entry.generationId)).toEqual(['oldest', 'newer']);
    expect(plan.protectedGenerationIds).toEqual(['locked']);
  });

  it('never schedules unowned worktree caches and removes stale locks', () => {
    const plan = planRepositoryCacheSweep({
      nowMs: 0,
      leases: [lease('unowned', false, false, 'generation')],
      generations: [],
      locks: [{ generationId: 'generation', path: '/locks/generation', live: false }],
      temporaries: [],
      policy: { generationTtlMs: HOUR, budgetBytes: 1_000 },
    });

    expect(plan.deleteWorktrees).toEqual([]);
    expect(plan.deleteLocks).toHaveLength(1);
  });

  it('protects a removed worktree cache and generation while a local process is live', () => {
    const busy = lease('busy', false, true, 'generation-busy');
    busy.busy = true;
    const plan = planRepositoryCacheSweep({
      nowMs: 2 * HOUR,
      leases: [busy],
      generations: [generation('generation-busy', 10, 0)],
      locks: [],
      temporaries: [],
      policy: { generationTtlMs: HOUR, budgetBytes: 1_000 },
    });

    expect(plan.deleteWorktrees).toEqual([]);
    expect(plan.deleteGenerations).toEqual([]);
    expect(plan.protectedGenerationIds).toEqual(['generation-busy']);
  });

  it('removes only temporary generations whose publishing process is dead', () => {
    const plan = planRepositoryCacheSweep({
      nowMs: 0,
      leases: [],
      generations: [],
      locks: [],
      temporaries: [
        { path: '/tmp/dead', size: 10, live: false },
        { path: '/tmp/live', size: 20, live: true },
      ],
      policy: { generationTtlMs: HOUR, budgetBytes: 1_000 },
    });

    expect(plan.deleteTemporaries).toEqual([{ path: '/tmp/dead', size: 10, live: false }]);
  });

  it('waits for a live local build before deleting a removed worktree cache', () => {
    const root = temporaryDirectory('scip-query-cache-sweep-');
    process.env['XDG_CACHE_HOME'] = join(root, 'xdg-cache');
    const primary = join(root, 'primary');
    const linked = join(root, 'linked');
    mkdirSync(primary);
    git(primary, ['init', '-q', '-b', 'main']);
    git(primary, ['config', 'user.email', 'test@example.com']);
    git(primary, ['config', 'user.name', 'Test User']);
    writeFileSync(join(primary, 'value.ts'), 'export const value = 1;\n');
    git(primary, ['add', '.']);
    git(primary, ['commit', '-qm', 'initial']);
    git(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const context = resolveGitWorktreeContext(linked)!;
    const cacheDir = resolveDefaultCacheDir(context.projectRoot);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'owned'), 'cache');
    const snapshot = sweepSnapshot(context, cacheDir);
    const generationDir = join(snapshot.repositoryCacheDir, 'generations', snapshot.generationId);
    mkdirSync(generationDir, { recursive: true });
    writeFileSync(join(generationDir, 'artifact'), 'generation');
    writeWorktreeLease(snapshot, cacheDir, 'attached', () => new Date(0));

    git(primary, ['worktree', 'remove', '--force', linked]);
    writeFileSync(join(cacheDir, 'index.lock'), `${JSON.stringify({ pid: process.pid })}\n`);
    const first = maybeSweepRepositoryCache(primary, 'test', { force: true, now: () => 0 });
    expect(first).toEqual(expect.objectContaining({ kind: 'swept', deletedWorktrees: 0, deletedGenerations: 0 }));
    expect(existsSync(cacheDir)).toBe(true);
    expect(existsSync(generationDir)).toBe(true);

    rmSync(join(cacheDir, 'index.lock'));
    const second = maybeSweepRepositoryCache(primary, 'test', { force: true, now: () => 0 });
    expect(second).toEqual(expect.objectContaining({ kind: 'swept', deletedWorktrees: 1, deletedGenerations: 0 }));
    expect(existsSync(cacheDir)).toBe(false);

    const third = maybeSweepRepositoryCache(primary, 'test', {
      force: true,
      now: () => DEFAULT_SHARED_GENERATION_TTL_MS,
    });
    expect(third).toEqual(expect.objectContaining({ kind: 'swept', deletedGenerations: 1 }));
    expect(existsSync(generationDir)).toBe(false);
  });

  it('does not delete a cache when the ownership checksum no longer matches its recorded paths', () => {
    const fixture = removedWorktreeFixture('scip-query-cache-ownership-');
    const victimRoot = join(fixture.root, 'removed-victim');
    const victimCache = resolveDefaultCacheDir(victimRoot);
    mkdirSync(victimCache, { recursive: true });
    writeFileSync(join(victimCache, 'keep'), 'owned by nobody');
    const leasePath = join(fixture.snapshot.repositoryCacheDir, 'worktrees', `${fixture.snapshot.worktreeId}.json`);
    const leaseRecord = JSON.parse(readFileSync(leasePath, 'utf8')) as WorktreeCacheLease;
    writeFileSync(
      leasePath,
      `${JSON.stringify({ ...leaseRecord, projectRoot: victimRoot, localCacheDir: victimCache })}\n`,
    );

    const result = maybeSweepRepositoryCache(fixture.primary, 'test', { force: true, now: () => 0 });

    expect(result).toEqual(expect.objectContaining({ kind: 'swept', deletedWorktrees: 0 }));
    expect(existsSync(victimCache)).toBe(true);
  });

  it('does not delete through a symlinked managed projects directory', () => {
    const fixture = removedWorktreeFixture('scip-query-cache-symlink-');
    const projects = join(process.env['XDG_CACHE_HOME']!, 'scip-query', 'projects');
    const physicalProjects = `${projects}-physical`;
    renameSync(projects, physicalProjects);
    symlinkSync(physicalProjects, projects, 'dir');

    const result = maybeSweepRepositoryCache(fixture.primary, 'test', { force: true, now: () => 0 });

    expect(result).toEqual(expect.objectContaining({ kind: 'swept', deletedWorktrees: 0 }));
    expect(existsSync(fixture.cacheDir)).toBe(true);
  });

  it('revisits repository namespaces left behind by deleted independent clones', () => {
    const root = temporaryDirectory('scip-query-global-cache-sweep-');
    process.env['XDG_CACHE_HOME'] = join(root, 'xdg-cache');
    const active = managedRepositoryFixture(root, 'active');
    const orphan = managedRepositoryFixture(root, 'orphan');
    const orphanLeasePath = join(orphan.snapshot.repositoryCacheDir, 'worktrees', `${orphan.snapshot.worktreeId}.json`);
    const orphanGenerationDir = join(orphan.snapshot.repositoryCacheDir, 'generations', orphan.snapshot.generationId);

    rmSync(orphan.projectRoot, { recursive: true, force: true });

    maybeSweepRepositoryCache(active.projectRoot, 'test', { force: true, now: () => 0 });

    expect(existsSync(orphan.cacheDir)).toBe(false);
    expect(existsSync(orphanLeasePath)).toBe(false);
    expect(existsSync(orphanGenerationDir)).toBe(true);

    maybeSweepRepositoryCache(active.projectRoot, 'test', {
      force: true,
      now: () => DEFAULT_SHARED_GENERATION_TTL_MS,
    });

    expect(existsSync(orphanGenerationDir)).toBe(false);
  });
});

function managedRepositoryFixture(
  root: string,
  name: string,
): {
  projectRoot: string;
  cacheDir: string;
  snapshot: SharedGenerationSnapshot;
} {
  const projectRoot = join(root, name);
  mkdirSync(projectRoot);
  git(projectRoot, ['init', '-q', '-b', 'main']);
  git(projectRoot, ['config', 'user.email', 'test@example.com']);
  git(projectRoot, ['config', 'user.name', 'Test User']);
  writeFileSync(join(projectRoot, 'value.ts'), 'export const value = 1;\n');
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-qm', 'initial']);
  const context = resolveGitWorktreeContext(projectRoot)!;
  const cacheDir = resolveDefaultCacheDir(projectRoot);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'owned'), 'cache');
  const snapshot = sweepSnapshot(context, cacheDir);
  const generationDir = join(snapshot.repositoryCacheDir, 'generations', snapshot.generationId);
  mkdirSync(generationDir, { recursive: true });
  writeFileSync(join(generationDir, 'artifact'), 'generation');
  writeWorktreeLease(snapshot, cacheDir, 'attached', () => new Date(0));
  return { projectRoot, cacheDir, snapshot };
}

function removedWorktreeFixture(prefix: string): {
  root: string;
  primary: string;
  cacheDir: string;
  snapshot: SharedGenerationSnapshot;
} {
  const root = temporaryDirectory(prefix);
  process.env['XDG_CACHE_HOME'] = join(root, 'xdg-cache');
  const primary = join(root, 'primary');
  const linked = join(root, 'linked');
  mkdirSync(primary);
  git(primary, ['init', '-q', '-b', 'main']);
  git(primary, ['config', 'user.email', 'test@example.com']);
  git(primary, ['config', 'user.name', 'Test User']);
  writeFileSync(join(primary, 'value.ts'), 'export const value = 1;\n');
  git(primary, ['add', '.']);
  git(primary, ['commit', '-qm', 'initial']);
  git(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);
  const context = resolveGitWorktreeContext(linked)!;
  const cacheDir = resolveDefaultCacheDir(context.projectRoot);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'owned'), 'cache');
  const snapshot = sweepSnapshot(context, cacheDir);
  const generationDir = join(snapshot.repositoryCacheDir, 'generations', snapshot.generationId);
  mkdirSync(generationDir, { recursive: true });
  writeFileSync(join(generationDir, 'artifact'), 'generation');
  writeWorktreeLease(snapshot, cacheDir, 'attached', () => new Date(0));
  git(primary, ['worktree', 'remove', '--force', linked]);
  return { root, primary, cacheDir, snapshot };
}

function lease(
  worktreeId: string,
  live: boolean,
  managed: boolean,
  generationId: string,
): RepositoryCacheLeaseInventory {
  return {
    leasePath: `/leases/${worktreeId}.json`,
    live,
    busy: false,
    managed,
    lease: cacheLease({
      version: 1,
      repositoryId: 'repository',
      worktreeId,
      projectRoot: `/worktrees/${worktreeId}`,
      treeOid: 'tree',
      localCacheDir: `/cache/${worktreeId}`,
      baseGenerationId: generationId,
      activeGenerationId: generationId,
      lastAction: 'attached',
      lastSeenAt: '2026-07-14T00:00:00.000Z',
    }),
  };
}

function generation(generationId: string, size: number, unreferencedAt?: number): RepositoryCacheGenerationInventory {
  return {
    generationId,
    path: `/generations/${generationId}`,
    size,
    ...(unreferencedAt === undefined ? {} : { unreferencedAt }),
  };
}

function sweepSnapshot(
  context: NonNullable<ReturnType<typeof resolveGitWorktreeContext>>,
  _cacheDir: string,
): SharedGenerationSnapshot {
  return {
    repositoryId: context.repositoryId,
    worktreeId: context.worktreeId,
    projectRoot: context.projectRoot,
    treeOid: context.treeOid!,
    fingerprint: fingerprint(),
    producerIdentity: SHARED_GENERATION_PRODUCER_IDENTITY,
    generationId: 'f'.repeat(64),
    repositoryCacheDir: join(process.env['XDG_CACHE_HOME']!, 'scip-query', 'repositories', context.repositoryId),
  };
}

function cacheLease(lease: Omit<WorktreeCacheLease, 'ownershipChecksum'>): WorktreeCacheLease {
  return { ...lease, ownershipChecksum: worktreeLeaseOwnershipChecksum(lease) };
}

function fingerprint(): ProjectInputFingerprint {
  return {
    version: 3,
    languages: ['typescript'],
    pnpmWorkspaces: false,
    typescriptProjectMode: 'single',
    typescriptProjects: [],
    files: [],
  };
}

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}
