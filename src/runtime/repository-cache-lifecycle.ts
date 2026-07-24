import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  automaticSharedCacheEnabled,
  resolveDefaultCacheDir,
  resolveScipQueryCacheRoot,
  type resolveIndexStoragePaths,
} from '../platform/cache-layout.js';
import { listGitWorktrees, resolveGitWorktreeContext } from '../platform/git-worktree.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import { watchServicePaths } from '../platform/watch-service-state.js';
import { stopWatchService } from './watch-service.js';
import { acquireProcessFileLock, acquireRepositoryCacheLock } from '../platform/repository-cache-lock.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import { maintainSharedEvidenceCache } from '../storage/evidence-cache.js';
import {
  resolveSharedEvidenceDbPath,
  sharedCacheBypassReason,
  worktreeLeaseOwnershipChecksum,
  type WorktreeCacheLease,
} from '../reindex/shared-generation-store.js';
import type { ProjectConfig } from '../domain/types.js';

export const DEFAULT_SHARED_GENERATION_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_REPOSITORY_CACHE_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_REPOSITORY_SWEEP_INTERVAL_MS = 5 * 60 * 1_000;

export interface RepositoryCacheSweepPolicy {
  generationTtlMs: number;
  budgetBytes: number;
}

export interface RepositoryCacheLeaseInventory {
  leasePath: string;
  lease: WorktreeCacheLease;
  live: boolean;
  busy: boolean;
  managed: boolean;
}

export interface RepositoryCacheGenerationInventory {
  generationId: string;
  path: string;
  size: number;
  unreferencedAt?: number;
}

export interface RepositoryCacheLockInventory {
  generationId: string;
  path: string;
  live: boolean;
}

export interface RepositoryCacheTemporaryInventory {
  path: string;
  size: number;
  live: boolean;
}

export interface RepositoryCacheSweepInput {
  nowMs: number;
  leases: RepositoryCacheLeaseInventory[];
  generations: RepositoryCacheGenerationInventory[];
  locks: RepositoryCacheLockInventory[];
  temporaries: RepositoryCacheTemporaryInventory[];
  policy: RepositoryCacheSweepPolicy;
}

export interface RepositoryCacheSweepPlan {
  deleteWorktrees: RepositoryCacheLeaseInventory[];
  deleteGenerations: RepositoryCacheGenerationInventory[];
  deleteLocks: RepositoryCacheLockInventory[];
  deleteTemporaries: RepositoryCacheTemporaryInventory[];
  protectedGenerationIds: string[];
  unreferencedSince: Record<string, number>;
}

export interface RepositoryCacheSweepResult {
  kind: 'swept' | 'throttled' | 'disabled' | 'unavailable' | 'busy' | 'failed';
  sweptAt?: string;
  deletedWorktrees?: number;
  deletedGenerations?: number;
  deletedBytes?: number;
  protectedGenerations?: number;
  error?: string;
}

export interface RepositoryGcState {
  version: 1;
  lastSweepAt: string;
  unreferencedSince: Record<string, number>;
  lastResult: RepositoryCacheSweepResult;
}

export interface SharedCacheStatus {
  state: 'managed' | 'bypassed' | 'unavailable';
  reason?: string;
  repositoryId?: string;
  worktreeId?: string;
  localCacheDir: string;
  baseGenerationId?: string;
  activeGenerationId?: string;
  lastAction?: WorktreeCacheLease['lastAction'];
  lastSeenAt?: string;
  generations: number;
  generationBytes: number;
  protectedGenerations: number;
  unreferencedGenerations: number;
  unreferencedBytes: number;
  temporaryGenerations: number;
  sharedEvidence: { path?: string; exists: boolean; bytes: number };
  cleanup?: RepositoryGcState['lastResult'];
}

export function planRepositoryCacheSweep(input: RepositoryCacheSweepInput): RepositoryCacheSweepPlan {
  const deleteWorktrees = input.leases.filter((entry) => entry.managed && !entry.live && !entry.busy);
  const protectedIds = protectedGenerationIds(input.leases, input.locks);

  const unreferencedSince: Record<string, number> = {};
  for (const generation of input.generations) {
    if (!protectedIds.has(generation.generationId)) {
      unreferencedSince[generation.generationId] = generation.unreferencedAt ?? input.nowMs;
    }
  }
  const unprotected = input.generations
    .filter((generation) => !protectedIds.has(generation.generationId))
    .sort((left, right) => {
      const age = unreferencedSince[left.generationId]! - unreferencedSince[right.generationId]!;
      return age || left.generationId.localeCompare(right.generationId);
    });
  const selected = new Set<string>();
  for (const generation of unprotected) {
    if (input.nowMs - unreferencedSince[generation.generationId]! >= input.policy.generationTtlMs) {
      selected.add(generation.generationId);
    }
  }
  let remainingBytes = input.generations
    .filter((generation) => !selected.has(generation.generationId))
    .reduce((total, generation) => total + generation.size, 0);
  for (const generation of unprotected) {
    if (remainingBytes <= input.policy.budgetBytes) break;
    if (selected.has(generation.generationId)) continue;
    selected.add(generation.generationId);
    remainingBytes -= generation.size;
  }
  for (const generationId of selected) delete unreferencedSince[generationId];

  return {
    deleteWorktrees,
    deleteGenerations: input.generations.filter((generation) => selected.has(generation.generationId)),
    deleteLocks: input.locks.filter((lock) => !lock.live),
    deleteTemporaries: input.temporaries.filter((temporary) => !temporary.live),
    protectedGenerationIds: [...protectedIds].sort(),
    unreferencedSince,
  };
}

function protectedGenerationIds(
  leases: readonly RepositoryCacheLeaseInventory[],
  locks: readonly RepositoryCacheLockInventory[],
): Set<string> {
  const protectedIds = new Set(
    leases
      .filter((entry) => entry.managed && (entry.live || entry.busy))
      .flatMap((entry) => [entry.lease.baseGenerationId, entry.lease.activeGenerationId])
      .filter((generationId): generationId is string => generationId !== undefined),
  );
  for (const lock of locks) {
    if (lock.live) protectedIds.add(lock.generationId);
  }
  return protectedIds;
}

export function maybeSweepRepositoryCache(
  projectRoot: string,
  cliVersion: string,
  opts: {
    force?: boolean;
    now?: () => number;
    policy?: Partial<RepositoryCacheSweepPolicy>;
  } = {},
): RepositoryCacheSweepResult {
  if (!automaticSharedCacheEnabled()) return { kind: 'disabled' };
  const context = resolveGitWorktreeContext(projectRoot);
  if (!context) return { kind: 'unavailable' };
  const repositoryDir = join(resolveScipQueryCacheRoot(), 'repositories', context.repositoryId);
  if (!existsSync(repositoryDir)) return { kind: 'unavailable' };
  const nowMs = (opts.now ?? Date.now)();
  const statePath = join(repositoryDir, 'gc-state.json');
  const previous = readGcState(statePath);
  if (!opts.force && previous && nowMs - Date.parse(previous.lastSweepAt) < DEFAULT_REPOSITORY_SWEEP_INTERVAL_MS) {
    return { kind: 'throttled', sweptAt: previous.lastSweepAt };
  }

  const repositoryLock = acquireRepositoryCacheLock(repositoryDir, { now: () => nowMs });
  if (!repositoryLock) return { kind: 'busy' };
  try {
    const inventory = buildSweepInventory(
      projectRoot,
      repositoryDir,
      context.repositoryId,
      previous?.unreferencedSince ?? {},
    );
    const plan = planRepositoryCacheSweep({
      nowMs,
      ...inventory,
      policy: {
        generationTtlMs: opts.policy?.generationTtlMs ?? DEFAULT_SHARED_GENERATION_TTL_MS,
        budgetBytes: opts.policy?.budgetBytes ?? DEFAULT_REPOSITORY_CACHE_BUDGET_BYTES,
      },
    });
    let deletedBytes = 0;
    let deletedWorktrees = 0;
    for (const entry of plan.deleteWorktrees) {
      if (!safeManagedWorktreeCache(entry.lease)) continue;
      const localLock = acquireProcessFileLock(join(entry.lease.localCacheDir, 'cache-lifecycle.lock'));
      if (!localLock) continue;
      try {
        if (hasLiveLocalCacheProcess(entry.lease, true)) continue;
        try {
          stopWatchService({
            projectRoot: entry.lease.projectRoot,
            cacheDir: entry.lease.localCacheDir,
            cliVersion,
          });
        } catch {
          continue;
        }
        if (hasLiveLocalCacheProcess(entry.lease, true)) continue;
        rmSync(entry.lease.localCacheDir, { recursive: true, force: true });
        rmSync(entry.leasePath, { force: true });
        deletedWorktrees += 1;
      } finally {
        localLock.release();
      }
    }
    for (const lock of plan.deleteLocks) rmSync(lock.path, { force: true });
    for (const temporary of plan.deleteTemporaries) rmSync(temporary.path, { recursive: true, force: true });
    for (const generation of plan.deleteGenerations) {
      rmSync(generation.path, { recursive: true, force: true });
      deletedBytes += generation.size;
    }
    maintainSharedEvidenceCache(join(repositoryDir, 'evidence.db'));
    const result: RepositoryCacheSweepResult = {
      kind: 'swept',
      sweptAt: new Date(nowMs).toISOString(),
      deletedWorktrees,
      deletedGenerations: plan.deleteGenerations.length,
      deletedBytes,
      protectedGenerations: plan.protectedGenerationIds.length,
    };
    const state: RepositoryGcState = {
      version: 1,
      lastSweepAt: result.sweptAt!,
      unreferencedSince: plan.unreferencedSince,
      lastResult: result,
    };
    writeJsonAtomic(statePath, state, { spacing: 2, trailingNewline: true });
    return result;
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  } finally {
    repositoryLock.release();
  }
}

export function inspectSharedCacheStatus(
  projectRoot: string,
  config: ProjectConfig,
  paths: ReturnType<typeof resolveIndexStoragePaths>,
): SharedCacheStatus {
  const bypass = sharedCacheBypassReason(projectRoot, paths.dbPath, config);
  if (bypass) {
    return {
      state: 'bypassed',
      reason: bypass,
      localCacheDir: paths.cacheDir,
      generations: 0,
      generationBytes: 0,
      protectedGenerations: 0,
      unreferencedGenerations: 0,
      unreferencedBytes: 0,
      temporaryGenerations: 0,
      sharedEvidence: { exists: false, bytes: 0 },
    };
  }
  const context = resolveGitWorktreeContext(projectRoot);
  if (!context) {
    return {
      state: 'unavailable',
      reason: 'Git worktree identity is unavailable',
      localCacheDir: paths.cacheDir,
      generations: 0,
      generationBytes: 0,
      protectedGenerations: 0,
      unreferencedGenerations: 0,
      unreferencedBytes: 0,
      temporaryGenerations: 0,
      sharedEvidence: { exists: false, bytes: 0 },
    };
  }
  const repositoryDir = join(resolveScipQueryCacheRoot(), 'repositories', context.repositoryId);
  const lease = readLease(join(repositoryDir, 'worktrees', `${context.worktreeId}.json`));
  const gcState = readGcState(join(repositoryDir, 'gc-state.json'));
  const inventory = buildSweepInventory(
    projectRoot,
    repositoryDir,
    context.repositoryId,
    gcState?.unreferencedSince ?? {},
  );
  const protectedIds = protectedGenerationIds(inventory.leases, inventory.locks);
  const unreferenced = inventory.generations.filter((generation) => !protectedIds.has(generation.generationId));
  const generationBytes = inventory.generations.reduce((total, generation) => total + generation.size, 0);
  const evidencePath = resolveSharedEvidenceDbPath(projectRoot, config);
  let evidenceBytes = 0;
  if (evidencePath) {
    evidenceBytes = databaseFootprint(evidencePath);
  }
  return {
    state: 'managed',
    repositoryId: context.repositoryId,
    worktreeId: context.worktreeId,
    localCacheDir: paths.cacheDir,
    ...(lease
      ? {
          baseGenerationId: lease.baseGenerationId,
          activeGenerationId: lease.activeGenerationId,
          lastAction: lease.lastAction,
          reason: lease.lastReason,
          lastSeenAt: lease.lastSeenAt,
        }
      : {}),
    generations: inventory.generations.length,
    generationBytes,
    protectedGenerations: inventory.generations.filter((generation) => protectedIds.has(generation.generationId))
      .length,
    unreferencedGenerations: unreferenced.length,
    unreferencedBytes: unreferenced.reduce((total, generation) => total + generation.size, 0),
    temporaryGenerations: inventory.temporaries.length,
    sharedEvidence: { path: evidencePath, exists: evidenceBytes > 0, bytes: evidenceBytes },
    cleanup: gcState?.lastResult,
  };
}

function databaseFootprint(path: string): number {
  return [path, `${path}-wal`, `${path}-shm`].reduce((total, file) => {
    try {
      return total + statSync(file).size;
    } catch {
      return total;
    }
  }, 0);
}

function buildSweepInventory(
  projectRoot: string,
  repositoryDir: string,
  repositoryId: string,
  previousUnreferencedSince: Record<string, number>,
): Pick<RepositoryCacheSweepInput, 'leases' | 'generations' | 'locks' | 'temporaries'> {
  const livePaths = new Set(listGitWorktrees(projectRoot).map((record) => resolve(record.path)));
  const leases: RepositoryCacheLeaseInventory[] = [];
  for (const entry of safeReadDirectory(join(repositoryDir, 'worktrees'))) {
    if (!entry.endsWith('.json')) continue;
    const leasePath = join(repositoryDir, 'worktrees', entry);
    const lease = readLease(leasePath);
    if (!lease) continue;
    const projectPath = resolve(lease.projectRoot);
    leases.push({
      leasePath,
      lease,
      managed: lease.repositoryId === repositoryId && safeManagedWorktreeCache(lease),
      live: livePaths.has(projectPath) || existsSync(projectPath),
      busy: hasLiveLocalCacheProcess(lease),
    });
  }

  const locks: RepositoryCacheLockInventory[] = [];
  for (const entry of safeReadDirectory(join(repositoryDir, 'locks'))) {
    const match = /^([a-f0-9]{64})\.lock$/.exec(entry);
    if (!match) continue;
    const path = join(repositoryDir, 'locks', entry);
    const pid = readPid(path);
    const live = pid !== undefined && isProcessAlive(pid);
    const generationId = match[1]!;
    locks.push({ generationId, path, live });
  }

  const generations: RepositoryCacheGenerationInventory[] = [];
  const temporaries: RepositoryCacheTemporaryInventory[] = [];
  for (const entry of safeReadDirectory(join(repositoryDir, 'generations'))) {
    const temporary = /^\.tmp-(\d+)-/.exec(entry);
    if (temporary) {
      const path = join(repositoryDir, 'generations', entry);
      const pid = Number(temporary[1]);
      try {
        temporaries.push({ path, size: directorySize(path), live: Number.isSafeInteger(pid) && isProcessAlive(pid) });
      } catch {
        // A publisher may have atomically renamed or removed its staging directory.
      }
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(entry)) continue;
    const path = join(repositoryDir, 'generations', entry);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    generations.push({
      generationId: entry,
      path,
      size: directorySize(path),
      ...(previousUnreferencedSince[entry] === undefined ? {} : { unreferencedAt: previousUnreferencedSince[entry] }),
    });
  }
  return { leases, generations, locks, temporaries };
}

function safeManagedWorktreeCache(lease: WorktreeCacheLease): boolean {
  if (lease.ownershipChecksum !== worktreeLeaseOwnershipChecksum(lease)) return false;
  if (resolve(lease.localCacheDir) !== resolve(resolveDefaultCacheDir(lease.projectRoot))) return false;
  const managedRoot = resolve(resolveScipQueryCacheRoot());
  const projectsRoot = resolve(join(managedRoot, 'projects'));
  const cachePath = resolve(lease.localCacheDir);
  if (!cachePath.startsWith(`${projectsRoot}${sep}`)) return false;
  try {
    const managedStat = lstatSync(managedRoot);
    const projectsStat = lstatSync(projectsRoot);
    const cacheStat = lstatSync(cachePath);
    if (
      !managedStat.isDirectory() ||
      managedStat.isSymbolicLink() ||
      !projectsStat.isDirectory() ||
      projectsStat.isSymbolicLink() ||
      !cacheStat.isDirectory() ||
      cacheStat.isSymbolicLink()
    ) {
      return false;
    }
    const physicalProjectsRoot = realpathSync(projectsRoot);
    const physicalCachePath = realpathSync(cachePath);
    return physicalCachePath.startsWith(`${physicalProjectsRoot}${sep}`);
  } catch {
    return false;
  }
}

function hasLiveLocalCacheProcess(lease: WorktreeCacheLease, ignoreLifecycleLock = false): boolean {
  for (const file of ignoreLifecycleLock ? ['index.lock'] : ['index.lock', 'cache-lifecycle.lock']) {
    const buildPid = readPid(join(lease.localCacheDir, file));
    if (buildPid !== undefined && isProcessAlive(buildPid)) return true;
  }
  const watcherPid = readPid(watchServicePaths(lease.localCacheDir).lockPath);
  return watcherPid !== undefined && isProcessAlive(watcherPid);
}

function readLease(path: string): WorktreeCacheLease | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WorktreeCacheLease>;
    if (
      parsed.version !== 1 ||
      typeof parsed.repositoryId !== 'string' ||
      typeof parsed.worktreeId !== 'string' ||
      typeof parsed.projectRoot !== 'string' ||
      (parsed.treeOid !== undefined && typeof parsed.treeOid !== 'string') ||
      typeof parsed.localCacheDir !== 'string' ||
      (parsed.baseGenerationId !== undefined && typeof parsed.baseGenerationId !== 'string') ||
      (parsed.activeGenerationId !== undefined && typeof parsed.activeGenerationId !== 'string') ||
      typeof parsed.ownershipChecksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.ownershipChecksum) ||
      typeof parsed.lastAction !== 'string' ||
      (parsed.lastReason !== undefined && typeof parsed.lastReason !== 'string') ||
      typeof parsed.lastSeenAt !== 'string'
    ) {
      return null;
    }
    return parsed as WorktreeCacheLease;
  } catch {
    return null;
  }
}

function readPid(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function readGcState(path: string): RepositoryGcState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RepositoryGcState>;
    if (
      parsed.version !== 1 ||
      typeof parsed.lastSweepAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.lastSweepAt)) ||
      !parsed.unreferencedSince ||
      typeof parsed.unreferencedSince !== 'object' ||
      !parsed.lastResult
    ) {
      return null;
    }
    return parsed as RepositoryGcState;
  } catch {
    return null;
  }
}

function safeReadDirectory(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function directorySize(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const path = stack.pop()!;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) total += statSync(child).size;
    }
  }
  return total;
}
