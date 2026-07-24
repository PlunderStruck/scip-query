import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WatcherStatus } from '../../src/domain/types.js';
import type { GitWorktreeContext } from '../../src/platform/git-worktree.js';
import {
  WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS,
  WATCH_SERVICE_PROTOCOL_VERSION,
  watchServicePaths,
  type WatchServiceState,
} from '../../src/platform/watch-service-state.js';
import {
  acquireWatchProcessLock,
  classifyWatchServiceState,
  ensureWatchService,
  ensureWatchServiceForCommand,
  planWatchServiceAction,
  readWatchServiceActivityAt,
  resolveWatchServiceIdentity,
  shouldStopWatchServiceForIdle,
  stopWatchService,
  trustedWatchServiceIndexGeneration,
  watchServiceAutoStartEligible,
  writeWatchServiceState,
  type WatchServiceRuntime,
} from '../../src/runtime/watch-service.js';
import { startupRefreshTrigger } from '../../src/runtime/watch-server.js';

const NOW = Date.parse('2026-07-09T20:00:00.000Z');
const IDENTITY = { projectRoot: tmpdir(), worktreeKind: 'non-git', cliVersion: '0.15.0' } as const;

describe('watch service contract', () => {
  it('trusts a watcher generation only while the matching live watcher is idle and error-free', () => {
    const generation = 'a'.repeat(64);
    const liveInspection = {
      identity: IDENTITY,
      classification: { kind: 'live', state: { ...liveState(), indexGeneration: generation } },
      lock: null,
      lockIsLive: false,
      paths: watchServicePaths('/tmp/scip-query-watch-generation'),
    } as const;

    expect(trustedWatchServiceIndexGeneration(liveInspection)).toBe(generation);
    expect(
      trustedWatchServiceIndexGeneration({
        ...liveInspection,
        classification: {
          kind: 'live',
          state: { ...liveState(), indexGeneration: generation, watcher: { state: 'indexing', startedAt: NOW } },
        },
      }),
    ).toBeUndefined();
    expect(
      trustedWatchServiceIndexGeneration({
        ...liveInspection,
        classification: { kind: 'stale', state: liveInspection.classification.state, reason: 'old-heartbeat' },
      }),
    ).toBeUndefined();
  });

  it('trusts only matching, recently-heartbeating live processes', () => {
    const state = liveState();
    expect(classifyWatchServiceState(state, IDENTITY, NOW, () => true)).toEqual({ kind: 'live', state });
    expect(classifyWatchServiceState(state, IDENTITY, NOW, () => false)).toEqual({
      kind: 'stale',
      state,
      reason: 'dead-process',
    });
    expect(
      classifyWatchServiceState(
        { ...state, heartbeatAt: new Date(NOW - WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS - 1).toISOString() },
        IDENTITY,
        NOW,
        () => true,
      ),
    ).toEqual(expect.objectContaining({ kind: 'stale', reason: 'old-heartbeat' }));
    expect(classifyWatchServiceState({ ...state, cliVersion: '0.16.0' }, IDENTITY, NOW, () => true)).toEqual(
      expect.objectContaining({ kind: 'incompatible', reason: 'cli-version' }),
    );
    expect(classifyWatchServiceState({ ...state, projectRoot: '/other' }, IDENTITY, NOW, () => true)).toEqual(
      expect.objectContaining({ kind: 'incompatible', reason: 'project' }),
    );
    expect(
      classifyWatchServiceState(
        { ...state, worktreeId: 'worktree-a' },
        { ...IDENTITY, worktreeKind: 'git', worktreeId: 'worktree-b' },
        NOW,
        () => true,
      ),
    ).toEqual(expect.objectContaining({ kind: 'incompatible', reason: 'worktree' }));
    expect(classifyWatchServiceState({ ...state, worktreeId: 'unexpected' }, IDENTITY, NOW, () => true)).toEqual(
      expect.objectContaining({ kind: 'incompatible', reason: 'worktree' }),
    );
    expect(classifyWatchServiceState({ ...state, protocolVersion: 99 }, IDENTITY, NOW, () => true)).toEqual(
      expect.objectContaining({ kind: 'incompatible', reason: 'protocol' }),
    );
  });

  it('forms an ID-less identity only for a confirmed non-Git root and fails on lookup errors', () => {
    withTempCache((nonGitRoot) => {
      expect(resolveWatchServiceIdentity(nonGitRoot, IDENTITY.cliVersion)).toEqual({
        projectRoot: realpathSync(nonGitRoot),
        worktreeKind: 'non-git',
        cliVersion: IDENTITY.cliVersion,
      });
    });
    withTempCache((nonGitRoot) => {
      withoutGit(() =>
        expect(resolveWatchServiceIdentity(nonGitRoot, IDENTITY.cliVersion)).toEqual({
          projectRoot: realpathSync(nonGitRoot),
          worktreeKind: 'non-git',
          cliVersion: IDENTITY.cliVersion,
        }),
      );
    });
    expect(() =>
      resolveWatchServiceIdentity(join(tmpdir(), `scip-query-missing-${process.pid}-${NOW}`), IDENTITY.cliVersion),
    ).toThrow(/Could not establish Git worktree identity/);
    withTempCache((damagedGitRoot) => {
      mkdirSync(join(damagedGitRoot, '.git'));
      expect(() => resolveWatchServiceIdentity(damagedGitRoot, IDENTITY.cliVersion)).toThrow(
        /Could not establish Git worktree identity.*not a git repository/i,
      );
    });
  });

  it('projects a matching resolved Git context without another repository lookup', () => {
    withTempCache((projectRoot) => {
      const context: GitWorktreeContext = {
        projectRoot,
        gitDir: join(projectRoot, '.git'),
        commonDir: join(projectRoot, '.git'),
        repositoryId: 'a'.repeat(24),
        worktreeId: 'worktree-from-context',
        clean: false,
      };

      expect(resolveWatchServiceIdentity(projectRoot, IDENTITY.cliVersion, context)).toEqual({
        projectRoot: realpathSync(projectRoot),
        worktreeKind: 'git',
        worktreeId: 'worktree-from-context',
        cliVersion: IDENTITY.cliVersion,
      });
    });
  });

  it('plans idempotent lifecycle actions', () => {
    const live = { kind: 'live', state: liveState() } as const;
    const stale = { kind: 'stale', state: liveState(), reason: 'dead-process' } as const;
    const incompatible = { kind: 'incompatible', state: liveState(), reason: 'cli-version' } as const;

    expect(planWatchServiceAction('ensure', { kind: 'stopped' })).toEqual({ kind: 'start' });
    expect(planWatchServiceAction('ensure', live)).toEqual({ kind: 'reuse', state: live.state });
    expect(planWatchServiceAction('ensure', stale)).toEqual({ kind: 'start' });
    expect(planWatchServiceAction('ensure', { kind: 'stale', state: liveState(), reason: 'old-heartbeat' })).toEqual({
      kind: 'replace',
      state: liveState(),
    });
    expect(planWatchServiceAction('ensure', incompatible)).toEqual({ kind: 'replace', state: incompatible.state });
    expect(planWatchServiceAction('stop', { kind: 'stopped' })).toEqual({ kind: 'already-stopped' });
    expect(planWatchServiceAction('stop', stale)).toEqual({ kind: 'clean-stale', state: stale.state });
    expect(planWatchServiceAction('stop', live)).toEqual({ kind: 'signal-stop', state: live.state });
    expect(planWatchServiceAction('status', live)).toEqual({ kind: 'report', classification: live });
  });

  it('uses shared process liveness for the default lock owner check', () => {
    withTempCache((cacheDir) => {
      const lockPath = join(cacheDir, 'watch.lock');
      const owner = acquireWatchProcessLock(lockPath, IDENTITY.projectRoot);
      try {
        expect(owner.acquired).toBe(true);
        expect(acquireWatchProcessLock(lockPath, IDENTITY.projectRoot).acquired).toBe(false);
      } finally {
        owner.release();
      }
    });
  });

  it('allows idle shutdown only from clean idle and lets zero mean always-on', () => {
    expect(shouldStop({ state: 'idle' }, 10_000, 10_000)).toBe(true);
    expect(shouldStop({ state: 'idle' }, 9_999, 10_000)).toBe(false);
    expect(shouldStop({ state: 'waiting', changedFiles: 1, reindexAt: NOW + 1_000 }, 20_000, 10_000)).toBe(false);
    expect(shouldStop({ state: 'indexing', startedAt: NOW }, 20_000, 10_000)).toBe(false);
    expect(shouldStop({ state: 'cooldown', until: NOW + 1_000, dirty: true }, 20_000, 10_000)).toBe(false);
    expect(shouldStop({ state: 'idle' }, 20_000, 0)).toBe(false);
  });

  it('requests immediate startup refresh for every non-fresh index state', () => {
    expect(startupRefreshTrigger('fresh')).toBeNull();
    for (const state of ['stale', 'missing', 'unknown'] as const) {
      expect(startupRefreshTrigger(state)).toEqual({
        kind: 'watch-startup',
        detail: `index ${state} when watch service started`,
      });
    }
  });

  it('starts once, records command activity, and reuses the live service', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      const opts = controllerOptions(cacheDir, runtime);

      const started = ensureWatchService(opts);
      expect(started.disposition).toBe('started');
      expect(runtime.spawned).toBe(1);
      expect(readWatchServiceActivityAt(paths.activityPath)).toBe(NOW);

      const reused = ensureWatchService(opts);
      expect(reused.disposition).toBe('reused');
      expect(reused.state.pid).toBe(started.state.pid);
      expect(runtime.spawned).toBe(1);
    });
  });

  it('auto-starts only eligible commands in enabled projects', () => {
    expect(watchServiceAutoStartEligible('status', {})).toBe(true);
    expect(watchServiceAutoStartEligible('watch', {})).toBe(false);
    expect(watchServiceAutoStartEligible('bench', {})).toBe(false);
    expect(watchServiceAutoStartEligible('work-audit', {})).toBe(false);
    expect(watchServiceAutoStartEligible('__health-phase', {})).toBe(false);
    expect(watchServiceAutoStartEligible('status', { SCIP_QUERY_SKIP_WATCH_SERVICE: '1' })).toBe(false);

    withTempCache((cacheDir) => {
      const runtime = fakeRuntime(watchServicePaths(cacheDir).statePath);
      expect(
        ensureWatchServiceForCommand({
          commandName: 'status',
          projectRoot: IDENTITY.projectRoot,
          cacheDir,
          cliVersion: IDENTITY.cliVersion,
          config: { watch: { enabled: false } },
          env: {},
          runtime,
        }),
      ).toEqual({ kind: 'skipped', reason: 'disabled' });
      expect(
        ensureWatchServiceForCommand({
          commandName: 'status',
          projectRoot: IDENTITY.projectRoot,
          cacheDir,
          cliVersion: IDENTITY.cliVersion,
          config: { watch: { enabled: true } },
          env: {},
          runtime,
        }),
      ).toEqual(expect.objectContaining({ kind: 'started' }));
    });
  });

  it('replaces a live service with an old heartbeat before spawning', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      runtime.alive.add(123);
      writeWatchServiceState(paths.statePath, {
        ...liveState(),
        heartbeatAt: new Date(NOW - WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS - 1).toISOString(),
      });

      const result = ensureWatchService(controllerOptions(cacheDir, runtime));

      expect(result.disposition).toBe('started');
      expect(runtime.signaled).toEqual([123]);
      expect(result.state.pid).not.toBe(123);
    });
  });

  it('stops, cleans, and replaces a live protocol-3 service', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      runtime.alive.add(123);
      writeFileSync(paths.statePath, `${JSON.stringify({ ...liveState(), protocolVersion: 3 })}\n`);
      writeFileSync(
        paths.lockPath,
        `${JSON.stringify({
          version: 1,
          pid: 123,
          projectRoot: IDENTITY.projectRoot,
          startedAt: new Date(NOW - 60_000).toISOString(),
        })}\n`,
      );
      writeFileSync(paths.activityPath, '{}\n');

      const result = ensureWatchService(controllerOptions(cacheDir, runtime));

      expect(runtime.signaled).toEqual([123]);
      expect(runtime.spawned).toBe(1);
      expect(runtime.filesAtSpawn).toEqual([{ state: false, lock: false, activity: false }]);
      expect(result).toEqual(
        expect.objectContaining({
          disposition: 'started',
          state: expect.objectContaining({ protocolVersion: WATCH_SERVICE_PROTOCOL_VERSION }),
        }),
      );
      expect(result.state.pid).not.toBe(123);
    });
  });

  it('signals a live service and removes its observation files after the project root disappears', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      runtime.alive.add(123);
      writeWatchServiceState(paths.statePath, liveState());

      expect(
        stopWatchService({
          ...controllerOptions(cacheDir, runtime),
          projectRoot: join(tmpdir(), `scip-query-removed-${process.pid}-${NOW}`),
        }),
      ).toEqual({ disposition: 'stopped', pid: 123 });
      expect(runtime.signaled).toEqual([123]);
      expect(existsSync(paths.statePath)).toBe(false);
      expect(existsSync(paths.activityPath)).toBe(false);
    });
  });
});

function liveState(): WatchServiceState {
  return {
    version: 1,
    protocolVersion: WATCH_SERVICE_PROTOCOL_VERSION,
    pid: 123,
    projectRoot: IDENTITY.projectRoot,
    cliVersion: IDENTITY.cliVersion,
    startedAt: new Date(NOW - 60_000).toISOString(),
    heartbeatAt: new Date(NOW - 1_000).toISOString(),
    lastActivityAt: new Date(NOW - 2_000).toISOString(),
    idleDeadlineAt: new Date(NOW + 598_000).toISOString(),
    watcher: { state: 'idle' },
    typescriptSemantic: {
      protocolVersion: 1,
      state: 'idle',
      requests: 0,
      sessionsCreated: 0,
      sessionsReused: 0,
      sessionsRefreshed: 0,
      sessionsReplaced: 0,
      projectsCreated: 0,
    },
    typescriptIndex: {
      protocolVersion: 1,
      state: 'idle',
      requests: 0,
      sessionsCreated: 0,
      sessionsReplaced: 0,
      initializations: 0,
      programUpdates: 0,
      documentsEmitted: 0,
      documentsRemoved: 0,
    },
  };
}

function shouldStop(watcher: WatcherStatus, idleForMs: number, idleTimeoutMs: number): boolean {
  return shouldStopWatchServiceForIdle({
    watcher,
    nowMs: NOW,
    lastActivityAtMs: NOW - idleForMs,
    idleTimeoutMs,
  });
}

interface FakeRuntime extends WatchServiceRuntime {
  alive: Set<number>;
  signaled: number[];
  spawned: number;
  filesAtSpawn: Array<{ state: boolean; lock: boolean; activity: boolean }>;
}

function fakeRuntime(statePath: string): FakeRuntime {
  const paths = watchServicePaths(dirname(statePath));
  const alive = new Set<number>();
  const signaled: number[] = [];
  let nextPid = 456;
  const runtime: FakeRuntime = {
    alive,
    signaled,
    spawned: 0,
    filesAtSpawn: [],
    now: () => NOW,
    isProcessAlive: (pid) => alive.has(pid),
    spawnServer: (_serverPath, projectRoot, cliVersion) => {
      runtime.spawned += 1;
      runtime.filesAtSpawn.push({
        state: existsSync(paths.statePath),
        lock: existsSync(paths.lockPath),
        activity: existsSync(paths.activityPath),
      });
      const pid = nextPid++;
      alive.add(pid);
      writeWatchServiceState(statePath, { ...liveState(), pid, projectRoot, cliVersion });
    },
    signalProcess: (pid) => {
      signaled.push(pid);
      alive.delete(pid);
    },
    sleep: () => undefined,
  };
  return runtime;
}

function controllerOptions(cacheDir: string, runtime: WatchServiceRuntime) {
  return {
    projectRoot: IDENTITY.projectRoot,
    cacheDir,
    cliVersion: IDENTITY.cliVersion,
    serverPath: '/fake/watch-server.js',
    runtime,
  };
}

function withTempCache(run: (cacheDir: string) => void): void {
  const cacheDir = mkdtempSync(join(tmpdir(), 'scip-query-watch-service-'));
  try {
    run(cacheDir);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
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
