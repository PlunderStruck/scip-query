import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WatcherStatus } from '../../src/domain/types.js';
import type { GitWorktreeContext } from '../../src/platform/git-worktree.js';
import type { ProcessIdentity } from '../../src/platform/process-identity.js';
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
  recordWatchServiceActivity,
  readWatchServiceActivityAt,
  requestWatchServiceRefresh,
  resolveWatchServiceIdentity,
  shouldStopWatchServiceForIdle,
  stopWatchService,
  trustedWatchServiceIndexGeneration,
  watchServiceAutoStartEligible,
  writeWatchServiceState,
  type WatchServiceRuntime,
} from '../../src/runtime/watch-service.js';
import { startupRefreshTrigger } from '../../src/runtime/watch-server.js';
import { claimWatchRefreshRequests, inspectWatchRefreshRequests } from '../../src/storage/watch-refresh-requests.js';
import { NODE_ATOMIC_FILE_RUNTIME } from '../../src/storage/atomic-file.js';

const NOW = Date.parse('2026-07-09T20:00:00.000Z');
const IDENTITY = { projectRoot: tmpdir(), worktreeKind: 'non-git', cliVersion: '0.15.0' } as const;
const WATCH_PROCESS_IDENTITY: ProcessIdentity = {
  version: 1,
  pid: 123,
  platform: 'darwin',
  startToken: 'Sat Jul 25 12:34:56 2026',
};

describe('watch service contract', () => {
  it('flushes authority transitions but keeps heartbeat telemetry visibility-atomic', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-watch-state-durability-'));
    const path = join(root, 'state.json');
    let syncs = 0;
    let token = 0;
    const runtime = {
      ...NODE_ATOMIC_FILE_RUNTIME,
      randomToken: () => `watch-state-${++token}`,
      syncFile(fd: number) {
        syncs += 1;
        NODE_ATOMIC_FILE_RUNTIME.syncFile(fd);
      },
    };
    try {
      writeWatchServiceState(path, liveState(), { durability: 'visibility', runtime });
      expect(syncs).toBe(0);
      writeWatchServiceState(path, liveState(), { durability: 'durable', runtime });
      expect(syncs).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
      kind: 'refuse-replace',
      reason: 'old-heartbeat',
      state: liveState(),
    });
    expect(planWatchServiceAction('ensure', incompatible)).toEqual({ kind: 'replace', state: incompatible.state });
    expect(planWatchServiceAction('stop', { kind: 'stopped' })).toEqual({ kind: 'already-stopped' });
    expect(planWatchServiceAction('stop', stale)).toEqual({ kind: 'clean-stale', state: stale.state });
    expect(planWatchServiceAction('stop', live)).toEqual({ kind: 'signal-stop', state: live.state });
    expect(planWatchServiceAction('status', live)).toEqual({ kind: 'report', classification: live });
  });

  it('returns an idempotent stop result without inventing a process identity', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);

      expect(stopWatchService(controllerOptions(cacheDir, runtime))).toEqual({
        disposition: 'already-stopped',
      });
      expect(runtime.signaled).toEqual([]);
    });
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
    expect(shouldStop({ state: 'idle' }, 180_000, 180_000)).toBe(true);
    expect(shouldStop({ state: 'idle' }, 179_999, 180_000)).toBe(false);
    expect(shouldStop({ state: 'idle' }, 60_000, 180_000)).toBe(false);
    expect(shouldStop({ state: 'waiting', changedFiles: 1, reindexAt: NOW + 1_000 }, 20_000, 10_000)).toBe(false);
    expect(shouldStop({ state: 'indexing', startedAt: NOW }, 20_000, 10_000)).toBe(false);
    expect(shouldStop({ state: 'cooldown', until: NOW + 1_000, dirty: true }, 20_000, 10_000)).toBe(false);
    expect(
      shouldStop(
        {
          state: 'budget-paused',
          until: NOW + 1_000,
          dirty: true,
          reason: '8/8 automatic rebuild slots consumed',
          rebuilt: 8,
          estimatedWriteBytes: 512,
        },
        20_000,
        10_000,
      ),
    ).toBe(false);
    expect(shouldStop({ state: 'draining', startedAt: NOW, reason: 'worker still exiting' }, 20_000, 10_000)).toBe(
      false,
    );
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

  it('keeps an accepted refresh request independent of later activity replacement', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      recordWatchServiceActivity(paths.activityPath, NOW);
      requestWatchServiceRefresh(paths.activityPath, 'stale index', NOW + 1, {
        idempotencyKey: 'command-1',
      });
      recordWatchServiceActivity(paths.activityPath, NOW + 2);

      expect(readWatchServiceActivityAt(paths.activityPath)).toBe(NOW + 2);
      expect(inspectWatchRefreshRequests(paths.refreshRequestsPath)).toMatchObject({
        pending: 1,
        claimed: 0,
      });
      expect(
        claimWatchRefreshRequests(paths.refreshRequestsPath, {
          now: () => new Date(NOW + 3),
          randomId: () => 'consumer',
        }).requests.map((request) => request.detail),
      ).toEqual(['stale index']);
    });
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

  it('reuses a live service while its watcher is draining instead of starting an overlapping owner', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      runtime.alive.add(123);
      writeWatchServiceState(paths.statePath, {
        ...liveState(),
        projectRoot: realpathSync(IDENTITY.projectRoot),
        watcher: {
          state: 'draining',
          startedAt: NOW,
          reason: 'waiting for the active reindex worker to exit',
        },
      });

      const reused = ensureWatchService(controllerOptions(cacheDir, runtime));

      expect(reused).toEqual(
        expect.objectContaining({ disposition: 'reused', state: expect.objectContaining({ pid: 123 }) }),
      );
      expect(runtime.spawned).toBe(0);
      expect(runtime.signaled).toEqual([]);
    });
  });

  it.each(['EPERM', 'EACCES', 'EROFS'])(
    'reuses a live service when the activity mailbox is blocked with %s',
    (code) => {
      withTempCache((cacheDir) => {
        const paths = watchServicePaths(cacheDir);
        const runtime = fakeRuntime(paths.statePath);
        runtime.alive.add(123);
        runtime.recordActivity = () => {
          throw Object.assign(new Error('activity mailbox is not writable'), { code });
        };
        writeWatchServiceState(paths.statePath, {
          ...liveState(),
          projectRoot: realpathSync(IDENTITY.projectRoot),
        });

        expect(
          ensureWatchServiceForCommand({
            commandName: 'refs',
            projectRoot: IDENTITY.projectRoot,
            cacheDir,
            cliVersion: IDENTITY.cliVersion,
            config: { watch: { enabled: true } },
            env: {},
            runtime,
          }),
        ).toEqual(expect.objectContaining({ kind: 'reused', state: expect.objectContaining({ pid: 123 }) }));
        expect(runtime.spawned).toBe(0);
      });
    },
  );

  it('surfaces a non-permission activity mailbox failure', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      runtime.alive.add(123);
      runtime.recordActivity = () => {
        throw Object.assign(new Error('activity mailbox I/O failed'), { code: 'EIO' });
      };
      writeWatchServiceState(paths.statePath, {
        ...liveState(),
        projectRoot: realpathSync(IDENTITY.projectRoot),
      });

      expect(
        ensureWatchServiceForCommand({
          commandName: 'refs',
          projectRoot: IDENTITY.projectRoot,
          cacheDir,
          cliVersion: IDENTITY.cliVersion,
          config: { watch: { enabled: true } },
          env: {},
          runtime,
        }),
      ).toEqual({ kind: 'failed', message: 'activity mailbox I/O failed' });
      expect(runtime.spawned).toBe(0);
    });
  });

  it('auto-starts only eligible commands in enabled projects', () => {
    const excludedCommands = ['capabilities', 'check-deps', 'doctor', 'install-skills', 'status', 'suppress'];
    for (const commandName of excludedCommands) {
      expect(watchServiceAutoStartEligible(commandName, {}), commandName).toBe(false);
    }
    expect(watchServiceAutoStartEligible('refs', {})).toBe(true);
    expect(watchServiceAutoStartEligible('health', {})).toBe(true);
    expect(watchServiceAutoStartEligible('watch', {})).toBe(false);
    expect(watchServiceAutoStartEligible('__health-phase', {})).toBe(false);
    expect(watchServiceAutoStartEligible('refs', { SCIP_QUERY_SKIP_WATCH_SERVICE: '1' })).toBe(false);

    withTempCache((cacheDir) => {
      const runtime = fakeRuntime(watchServicePaths(cacheDir).statePath);
      for (const commandName of excludedCommands) {
        expect(
          ensureWatchServiceForCommand({
            commandName,
            projectRoot: IDENTITY.projectRoot,
            cacheDir,
            cliVersion: IDENTITY.cliVersion,
            config: { watch: { enabled: true } },
            env: {},
            runtime,
          }),
          commandName,
        ).toEqual({ kind: 'skipped', reason: 'excluded-command' });
      }
      expect(runtime.spawned).toBe(0);

      expect(
        ensureWatchServiceForCommand({
          commandName: 'refs',
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
          commandName: 'refs',
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

  it('refuses to replace a live owner from civil-clock heartbeat age alone', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      runtime.alive.add(123);
      writeWatchServiceState(paths.statePath, {
        ...liveState(),
        projectRoot: realpathSync(IDENTITY.projectRoot),
        heartbeatAt: new Date(NOW - WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS - 1).toISOString(),
      });

      expect(() => ensureWatchService(controllerOptions(cacheDir, runtime))).toThrow(
        /civil-clock age alone cannot authorize a process signal/,
      );
      expect(runtime.signaled).toEqual([]);
      expect(runtime.spawned).toBe(0);
    });
  });

  it('bounds stop waits with monotonic time while the civil clock jumps', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      runtime.alive.add(123);
      writeWatchServiceState(paths.statePath, {
        ...liveState(),
        projectRoot: realpathSync(IDENTITY.projectRoot),
      });
      let wallNow = NOW;
      let monotonicNow = 0;
      runtime.now = () => wallNow;
      runtime.monotonicNow = () => monotonicNow;
      runtime.signalProcess = (pid) => {
        runtime.signaled.push(pid);
      };
      runtime.sleep = (durationMs) => {
        monotonicNow += durationMs;
        wallNow = wallNow === NOW ? NOW - 86_400_000 : NOW + 86_400_000;
      };

      expect(() => stopWatchService({ ...controllerOptions(cacheDir, runtime), stopTimeoutMs: 20 })).toThrow(
        /did not stop within 20ms/,
      );
      expect(runtime.signaled).toEqual([123]);
      expect(monotonicNow).toBeGreaterThanOrEqual(20);
    });
  });

  it('revalidates process birth identity before forced stop and refuses a reused PID', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      runtime.alive.add(123);
      writeWatchServiceState(paths.statePath, {
        ...liveState(),
        projectRoot: realpathSync(IDENTITY.projectRoot),
      });
      let monotonicNow = 0;
      const forced: number[] = [];
      runtime.monotonicNow = () => monotonicNow;
      runtime.signalProcess = (pid) => runtime.signaled.push(pid);
      runtime.forceSignalProcess = (pid) => forced.push(pid);
      runtime.sleep = (durationMs) => {
        monotonicNow += durationMs;
        if (monotonicNow >= 20) {
          runtime.processIdentities.set(123, { ...WATCH_PROCESS_IDENTITY, startToken: 'pid-successor' });
        }
      };

      expect(() => stopWatchService({ ...controllerOptions(cacheDir, runtime), stopTimeoutMs: 20 })).toThrow(
        /process identity does not match/,
      );
      expect(runtime.signaled).toEqual([123]);
      expect(forced).toEqual([]);
      expect(existsSync(paths.statePath)).toBe(true);
    });
  });

  it('cleans stale ownership records without signaling a process that reused the PID', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      runtime.alive.add(123);
      runtime.processIdentities.set(123, { ...WATCH_PROCESS_IDENTITY, startToken: 'pid-successor' });
      writeWatchServiceState(paths.statePath, {
        ...liveState(),
        projectRoot: realpathSync(IDENTITY.projectRoot),
      });
      writeFileSync(
        paths.lockPath,
        `${JSON.stringify({
          version: 1,
          pid: 123,
          processIdentity: WATCH_PROCESS_IDENTITY,
          projectRoot: realpathSync(IDENTITY.projectRoot),
          startedAt: new Date(NOW - 60_000).toISOString(),
        })}\n`,
      );

      expect(stopWatchService(controllerOptions(cacheDir, runtime))).toEqual({
        disposition: 'stopped',
        pid: 123,
      });
      expect(runtime.signaled).toEqual([]);
      expect(existsSync(paths.statePath)).toBe(false);
      expect(existsSync(paths.lockPath)).toBe(false);
    });
  });

  it('forces an identity-verified stuck service, observes exit, then cleans ownership files', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      runtime.alive.add(123);
      writeWatchServiceState(paths.statePath, {
        ...liveState(),
        projectRoot: realpathSync(IDENTITY.projectRoot),
      });
      let monotonicNow = 0;
      const forced: number[] = [];
      runtime.monotonicNow = () => monotonicNow;
      runtime.signalProcess = (pid) => runtime.signaled.push(pid);
      runtime.forceSignalProcess = (pid) => {
        forced.push(pid);
        runtime.alive.delete(pid);
      };
      runtime.sleep = (durationMs) => {
        monotonicNow += durationMs;
      };

      expect(stopWatchService({ ...controllerOptions(cacheDir, runtime), stopTimeoutMs: 20 })).toEqual({
        disposition: 'stopped',
        pid: 123,
      });
      expect(runtime.signaled).toEqual([123]);
      expect(forced).toEqual([123]);
      expect(existsSync(paths.statePath)).toBe(false);
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
      requestWatchServiceRefresh(paths.activityPath, 'survive daemon replacement', NOW, {
        idempotencyKey: 'survive-stop',
      });

      expect(
        stopWatchService({
          ...controllerOptions(cacheDir, runtime),
          projectRoot: join(tmpdir(), `scip-query-removed-${process.pid}-${NOW}`),
        }),
      ).toEqual({ disposition: 'stopped', pid: 123 });
      expect(runtime.signaled).toEqual([123]);
      expect(existsSync(paths.statePath)).toBe(false);
      expect(existsSync(paths.activityPath)).toBe(false);
      expect(inspectWatchRefreshRequests(paths.refreshRequestsPath).pending).toBe(1);
    });
  });

  it('never signals a reused PID and cleans the stale watch record', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      runtime.alive.add(123);
      runtime.processIdentities.set(123, {
        ...WATCH_PROCESS_IDENTITY,
        startToken: 'Sat Jul 25 13:00:00 2026',
      });
      writeWatchServiceState(paths.statePath, liveState());

      expect(stopWatchService(controllerOptions(cacheDir, runtime))).toEqual({ disposition: 'stopped', pid: 123 });
      expect(runtime.signaled).toEqual([]);
      expect(existsSync(paths.statePath)).toBe(false);
    });
  });

  it('never signals a live legacy watch record that has no process identity', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      runtime.alive.add(123);
      runtime.processIdentities.set(123, WATCH_PROCESS_IDENTITY);
      const { processIdentity: _omitted, ...legacyState } = liveState();
      writeFileSync(paths.statePath, `${JSON.stringify(legacyState)}\n`);

      expect(() => stopWatchService(controllerOptions(cacheDir, runtime))).toThrow(/has no process identity/i);
      expect(runtime.signaled).toEqual([]);
    });
  });
});

function liveState(): WatchServiceState {
  return {
    version: 1,
    protocolVersion: WATCH_SERVICE_PROTOCOL_VERSION,
    pid: 123,
    processIdentity: WATCH_PROCESS_IDENTITY,
    projectRoot: IDENTITY.projectRoot,
    cliVersion: IDENTITY.cliVersion,
    startedAt: new Date(NOW - 60_000).toISOString(),
    heartbeatAt: new Date(NOW - 1_000).toISOString(),
    lastActivityAt: new Date(NOW - 2_000).toISOString(),
    idleDeadlineAt: new Date(NOW + 178_000).toISOString(),
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
  processIdentities: Map<number, ProcessIdentity>;
  signaled: number[];
  spawned: number;
  filesAtSpawn: Array<{ state: boolean; lock: boolean; activity: boolean }>;
}

function fakeRuntime(statePath: string): FakeRuntime {
  const paths = watchServicePaths(dirname(statePath));
  const alive = new Set<number>();
  const processIdentities = new Map<number, ProcessIdentity>([[123, WATCH_PROCESS_IDENTITY]]);
  const signaled: number[] = [];
  let nextPid = 456;
  const runtime: FakeRuntime = {
    alive,
    processIdentities,
    signaled,
    spawned: 0,
    filesAtSpawn: [],
    now: () => NOW,
    isProcessAlive: (pid) => alive.has(pid),
    readProcessIdentity: (pid) => processIdentities.get(pid) ?? null,
    spawnServer: (_serverPath, projectRoot, cliVersion) => {
      runtime.spawned += 1;
      runtime.filesAtSpawn.push({
        state: existsSync(paths.statePath),
        lock: existsSync(paths.lockPath),
        activity: existsSync(paths.activityPath),
      });
      const pid = nextPid++;
      alive.add(pid);
      const processIdentity: ProcessIdentity = {
        ...WATCH_PROCESS_IDENTITY,
        pid,
        startToken: `spawn-${pid}`,
      };
      processIdentities.set(pid, processIdentity);
      writeWatchServiceState(statePath, { ...liveState(), pid, processIdentity, projectRoot, cliVersion });
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
