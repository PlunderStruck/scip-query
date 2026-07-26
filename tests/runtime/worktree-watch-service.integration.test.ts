import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import type * as NodeChildProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveIndexStoragePaths } from '../../src/platform/cache-layout.js';
import { resolveGitWorktreeContext } from '../../src/platform/git-worktree.js';
import type { ProcessIdentity } from '../../src/platform/process-identity.js';
import {
  WATCH_SERVICE_PROTOCOL_VERSION,
  watchServicePaths,
  type WatchServiceState,
} from '../../src/platform/watch-service-state.js';
import {
  ensureWatchServiceForCommand,
  writeWatchServiceState,
  type WatchServiceRuntime,
} from '../../src/runtime/watch-service.js';

const NOW = Date.parse('2026-07-14T20:00:00.000Z');
const tempDirs: string[] = [];
const originalXdgCacheHome = process.env['XDG_CACHE_HOME'];
const originalCacheOverride = process.env['SCIP_QUERY_CACHE_DIR'];

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvironment('XDG_CACHE_HOME', originalXdgCacheHome);
  restoreEnvironment('SCIP_QUERY_CACHE_DIR', originalCacheOverride);
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('per-worktree watch service', () => {
  it('keeps primary and linked nested-project lifecycle and unstaged source refreshes local', async () => {
    const primary = createRepository();
    const primaryProject = join(primary, 'src');
    const canonicalPrimaryProject = realpathSync(primaryProject);
    const primaryAlias = temporaryDirectory('scip-query-watch-alias-');
    rmSync(primaryAlias, { recursive: true, force: true });
    symlinkSync(primary, primaryAlias, 'dir');
    const primaryAliasProject = join(primaryAlias, 'src');
    const linked = temporaryDirectory('scip-query-watch-linked-');
    rmSync(linked, { recursive: true, force: true });
    git(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const linkedProject = join(linked, 'src');
    const canonicalLinkedProject = realpathSync(linkedProject);

    const cacheHome = temporaryDirectory('scip-query-watch-cache-');
    process.env['XDG_CACHE_HOME'] = cacheHome;
    delete process.env['SCIP_QUERY_CACHE_DIR'];

    const primaryIndex = resolveIndexStoragePaths(primaryProject, {});
    const primaryAliasIndex = resolveIndexStoragePaths(primaryAliasProject, {});
    const linkedIndex = resolveIndexStoragePaths(linkedProject, {});
    const primaryService = watchServicePaths(primaryIndex.cacheDir);
    const linkedService = watchServicePaths(linkedIndex.cacheDir);
    const runtime = worktreeRuntime();
    const config = { watch: { enabled: true } } as const;

    const primaryResult = ensureWatchServiceForCommand({
      commandName: 'status',
      projectRoot: primaryAliasProject,
      cacheDir: primaryAliasIndex.cacheDir,
      cliVersion: '0.17.0',
      config,
      env: {},
      runtime,
    });
    const linkedResult = ensureWatchServiceForCommand({
      commandName: 'status',
      projectRoot: linkedProject,
      cacheDir: linkedIndex.cacheDir,
      cliVersion: '0.17.0',
      config,
      env: {},
      runtime,
    });

    expect(primaryIndex.cacheDir).not.toBe(linkedIndex.cacheDir);
    expect(primaryAliasIndex).toEqual(primaryIndex);
    expect(primaryIndex.dbPath).not.toBe(linkedIndex.dbPath);
    expect(primaryIndex.indexPath).not.toBe(linkedIndex.indexPath);
    expect(primaryService.statePath).not.toBe(linkedService.statePath);
    expect(primaryService.lockPath).not.toBe(linkedService.lockPath);
    expect(primaryResult).toEqual(expect.objectContaining({ kind: 'started' }));
    expect(linkedResult).toEqual(expect.objectContaining({ kind: 'started' }));
    expect(canonicalPrimaryProject).not.toBe(realpathSync(primary));
    expect(runtime.spawnedRoots).toEqual([canonicalPrimaryProject, canonicalLinkedProject]);
    expect(runtime.signaled).toEqual([]);

    const primaryState = readState(primaryService.statePath);
    const linkedState = readState(linkedService.statePath);
    expect(primaryState.pid).not.toBe(linkedState.pid);
    expect(primaryState.projectRoot).toBe(canonicalPrimaryProject);
    expect(linkedState.projectRoot).toBe(canonicalLinkedProject);
    expect(primaryState.worktreeId).toBe(resolveGitWorktreeContext(primaryProject)?.worktreeId);
    expect(linkedState.worktreeId).toBe(resolveGitWorktreeContext(linkedProject)?.worktreeId);
    expect(primaryState.worktreeId).not.toBe(linkedState.worktreeId);

    const reusedPrimary = ensureWatchServiceForCommand({
      commandName: 'status',
      projectRoot: primaryProject,
      cacheDir: primaryIndex.cacheDir,
      cliVersion: '0.17.0',
      config,
      env: {},
      runtime,
    });
    expect(reusedPrimary).toEqual(expect.objectContaining({ kind: 'reused' }));
    if (reusedPrimary.kind !== 'reused') throw new Error(`Expected daemon reuse, received ${reusedPrimary.kind}`);
    expect(reusedPrimary.state.pid).toBe(primaryState.pid);
    expect(runtime.spawnedRoots).toEqual([canonicalPrimaryProject, canonicalLinkedProject]);
    expect(runtime.signaled).toEqual([]);

    const reindexEnvironments: NodeJS.ProcessEnv[] = [];
    mockReindexFork(reindexEnvironments);
    const { Watcher } = await import('../../src/runtime/watch.js');
    const watcherErrors: Error[] = [];
    const watcherConfig = { watch: { debounceMs: 50, cooldownMs: 0, gitPollMs: 60_000 } } as const;
    const primaryWatcher = new Watcher({
      projectRoot: canonicalPrimaryProject,
      config: watcherConfig,
      onError: (error) => watcherErrors.push(error),
    });
    const linkedWatcher = new Watcher({
      projectRoot: canonicalLinkedProject,
      config: watcherConfig,
      onError: (error) => watcherErrors.push(error),
    });

    try {
      primaryWatcher.start();
      linkedWatcher.start();
      await vi.waitFor(
        () => {
          expect(watchedDirectoryCount(primaryWatcher)).toBeGreaterThan(0);
          expect(watchedDirectoryCount(linkedWatcher)).toBeGreaterThan(0);
        },
        { timeout: 5_000, interval: 20 },
      );
      writeFileSync(join(primaryProject, 'value.ts'), 'export const value = 2;\n');
      await vi.waitFor(() => expect(reindexEnvironments).toHaveLength(1), { timeout: 5_000, interval: 20 });
      await delay(100);
      writeFileSync(join(linkedProject, 'value.ts'), 'export const value = 2;\n');
      await vi.waitFor(() => expect(reindexEnvironments).toHaveLength(2), { timeout: 5_000, interval: 20 });
      await delay(200);
    } finally {
      primaryWatcher.stop();
      linkedWatcher.stop();
    }

    expect(watcherErrors).toEqual([]);
    expect(reindexEnvironments).toHaveLength(2);
    expect(reindexEnvironments[0]).toEqual(
      expect.objectContaining({
        SCIP_REINDEX_PROJECT_ROOT: canonicalPrimaryProject,
        SCIP_REINDEX_OUTPUT_SCIP: primaryIndex.indexPath,
        SCIP_REINDEX_OUTPUT_DB: primaryIndex.dbPath,
      }),
    );
    expect(reindexEnvironments[1]).toEqual(
      expect.objectContaining({
        SCIP_REINDEX_PROJECT_ROOT: canonicalLinkedProject,
        SCIP_REINDEX_OUTPUT_SCIP: linkedIndex.indexPath,
        SCIP_REINDEX_OUTPUT_DB: linkedIndex.dbPath,
      }),
    );
  }, 30_000);

  it('subscribes each linked worktree watcher to its own source tree', async () => {
    const primary = createRepository();
    const primaryProject = realpathSync(join(primary, 'src'));
    const linked = temporaryDirectory('scip-query-watch-linked-');
    rmSync(linked, { recursive: true, force: true });
    git(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const linkedProject = realpathSync(join(linked, 'src'));

    const reindexEnvironments: NodeJS.ProcessEnv[] = [];
    mockReindexFork(reindexEnvironments);
    const { Watcher } = await import('../../src/runtime/watch.js');
    const config = { watch: { debounceMs: 50, cooldownMs: 0, gitPollMs: 60_000 } } as const;
    const primaryWatcher = new Watcher({ projectRoot: primaryProject, config });
    const linkedWatcher = new Watcher({ projectRoot: linkedProject, config });

    try {
      primaryWatcher.start();
      linkedWatcher.start();
      await vi.waitFor(
        () => {
          expect(watchedDirectoryCount(primaryWatcher)).toBeGreaterThan(0);
          expect(watchedDirectoryCount(linkedWatcher)).toBeGreaterThan(0);
        },
        { timeout: 5_000, interval: 20 },
      );

      writeFileSync(join(linkedProject, 'value.ts'), 'export const value = 3;\n');
      await vi.waitFor(() => expect(reindexEnvironments).toHaveLength(1), { timeout: 5_000, interval: 20 });
      await delay(200);
    } finally {
      primaryWatcher.stop();
      linkedWatcher.stop();
    }

    const linkedIndex = resolveIndexStoragePaths(linkedProject, {});
    expect(reindexEnvironments).toEqual([
      expect.objectContaining({
        SCIP_REINDEX_PROJECT_ROOT: linkedProject,
        SCIP_REINDEX_OUTPUT_SCIP: linkedIndex.indexPath,
        SCIP_REINDEX_OUTPUT_DB: linkedIndex.dbPath,
      }),
    ]);
  }, 20_000);

  it('polls nested primary and linked Git indexes from paths resolved against each project', async () => {
    const primary = createRepository();
    const primaryProject = realpathSync(join(primary, 'src'));
    const linked = temporaryDirectory('scip-query-watch-linked-');
    rmSync(linked, { recursive: true, force: true });
    git(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const linkedProject = realpathSync(join(linked, 'src'));
    expect(isAbsolute(git(primaryProject, ['rev-parse', '--git-path', 'index']))).toBe(false);
    expect(isAbsolute(git(linkedProject, ['rev-parse', '--git-path', 'index']))).toBe(true);

    process.env['XDG_CACHE_HOME'] = temporaryDirectory('scip-query-watch-cache-');
    delete process.env['SCIP_QUERY_CACHE_DIR'];
    const reindexEnvironments: NodeJS.ProcessEnv[] = [];
    mockReindexFork(reindexEnvironments);
    const { Watcher } = await import('../../src/runtime/watch.js');
    const config = { watch: { debounceMs: 50, cooldownMs: 0, gitPollMs: 20 } } as const;
    const primaryWatcher = new Watcher({ projectRoot: primaryProject, config });
    const linkedWatcher = new Watcher({ projectRoot: linkedProject, config });

    try {
      (primaryWatcher as unknown as { startGitStatePolling(): void }).startGitStatePolling();
      (linkedWatcher as unknown as { startGitStatePolling(): void }).startGitStatePolling();
      await delay(50);

      writeFileSync(join(primaryProject, 'value.ts'), 'export const value = 20;\n');
      git(primaryProject, ['add', 'value.ts']);
      await vi.waitFor(() => expect(reindexEnvironments).toHaveLength(1), { timeout: 5_000, interval: 20 });
      await delay(100);

      writeFileSync(join(linkedProject, 'value.ts'), 'export const value = 30;\n');
      git(linkedProject, ['add', 'value.ts']);
      await vi.waitFor(() => expect(reindexEnvironments).toHaveLength(2), { timeout: 5_000, interval: 20 });
      await delay(200);
    } finally {
      primaryWatcher.stop();
      linkedWatcher.stop();
    }

    const primaryIndex = resolveIndexStoragePaths(primaryProject, {});
    const linkedIndex = resolveIndexStoragePaths(linkedProject, {});
    expect(reindexEnvironments).toEqual([
      expect.objectContaining({
        SCIP_REINDEX_PROJECT_ROOT: primaryProject,
        SCIP_REINDEX_OUTPUT_SCIP: primaryIndex.indexPath,
        SCIP_REINDEX_OUTPUT_DB: primaryIndex.dbPath,
      }),
      expect.objectContaining({
        SCIP_REINDEX_PROJECT_ROOT: linkedProject,
        SCIP_REINDEX_OUTPUT_SCIP: linkedIndex.indexPath,
        SCIP_REINDEX_OUTPUT_DB: linkedIndex.dbPath,
      }),
    ]);
  }, 20_000);
});

interface WorktreeRuntime extends WatchServiceRuntime {
  alive: Set<number>;
  processIdentities: Map<number, ProcessIdentity>;
  signaled: number[];
  spawnedRoots: string[];
}

function worktreeRuntime(): WorktreeRuntime {
  const alive = new Set<number>();
  const processIdentities = new Map<number, ProcessIdentity>();
  const signaled: number[] = [];
  let nextPid = 40_000;
  const runtime: WorktreeRuntime = {
    alive,
    processIdentities,
    signaled,
    spawnedRoots: [],
    now: () => NOW,
    isProcessAlive: (pid) => alive.has(pid),
    readProcessIdentity: (pid) => processIdentities.get(pid) ?? null,
    spawnServer: (_serverPath, projectRoot, cliVersion) => {
      runtime.spawnedRoots.push(projectRoot);
      const pid = nextPid++;
      alive.add(pid);
      const processIdentity: ProcessIdentity = {
        version: 1,
        pid,
        platform: 'darwin',
        startToken: `spawn-${pid}`,
      };
      processIdentities.set(pid, processIdentity);
      const indexPaths = resolveIndexStoragePaths(projectRoot, {});
      const statePath = watchServicePaths(indexPaths.cacheDir).statePath;
      const worktreeId = resolveGitWorktreeContext(projectRoot)?.worktreeId;
      writeWatchServiceState(statePath, watcherState(pid, projectRoot, cliVersion, worktreeId, processIdentity));
    },
    signalProcess: (pid) => {
      signaled.push(pid);
      alive.delete(pid);
    },
    sleep: () => undefined,
  };
  return runtime;
}

function watcherState(
  pid: number,
  projectRoot: string,
  cliVersion: string,
  worktreeId: string | undefined,
  processIdentity?: ProcessIdentity,
): WatchServiceState {
  return {
    version: 1,
    protocolVersion: WATCH_SERVICE_PROTOCOL_VERSION,
    pid,
    ...(processIdentity ? { processIdentity } : {}),
    projectRoot,
    ...(worktreeId ? { worktreeId } : {}),
    cliVersion,
    startedAt: new Date(NOW - 2_000).toISOString(),
    heartbeatAt: new Date(NOW - 100).toISOString(),
    lastActivityAt: new Date(NOW - 100).toISOString(),
    watcher: { state: 'idle' },
  };
}

function readState(path: string): WatchServiceState {
  return JSON.parse(readFileSync(path, 'utf8')) as WatchServiceState;
}

function createRepository(): string {
  const root = temporaryDirectory('scip-query-watch-primary-');
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
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
}

function watchedDirectoryCount(watcher: unknown): number {
  const subscriptions = (
    watcher as {
      fsWatchers: Array<{ getWatched(): Record<string, string[]> }>;
    }
  ).fsWatchers;
  return subscriptions.reduce((count, subscription) => count + Object.keys(subscription.getWatched()).length, 0);
}

function mockReindexFork(reindexEnvironments: NodeJS.ProcessEnv[]): void {
  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof NodeChildProcess>('node:child_process');
    return {
      ...actual,
      fork: vi.fn((_workerPath: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        reindexEnvironments.push(options.env ?? {});
        const child = new EventEmitter();
        process.nextTick(() => child.emit('exit', 0));
        return child;
      }),
    };
  });
}
