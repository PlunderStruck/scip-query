import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WatcherStatus } from '../../src/domain/types.js';
import {
  WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS,
  WATCH_SERVICE_PROTOCOL_VERSION,
  classifyWatchServiceState,
  ensureWatchService,
  parseWatchServiceState,
  planWatchServiceAction,
  readWatchServiceActivityAt,
  shouldStopWatchServiceForIdle,
  stopWatchService,
  watchServicePaths,
  writeWatchServiceState,
  type WatchServiceRuntime,
  type WatchServiceState,
} from '../../src/runtime/watch-service.js';

const NOW = Date.parse('2026-07-09T20:00:00.000Z');
const IDENTITY = { projectRoot: '/repo', cliVersion: '0.15.0' };

describe('watch service contract', () => {
  it('parses only complete versioned state', () => {
    expect(parseWatchServiceState(liveState())).toEqual(liveState());
    expect(parseWatchServiceState({ ...liveState(), pid: 0 })).toBeNull();
    expect(parseWatchServiceState({ ...liveState(), heartbeatAt: 'not-a-date' })).toBeNull();
    expect(parseWatchServiceState({ ...liveState(), watcher: { state: 'waiting' } })).toBeNull();
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
    expect(classifyWatchServiceState({ ...state, protocolVersion: 99 }, IDENTITY, NOW, () => true)).toEqual(
      expect.objectContaining({ kind: 'incompatible', reason: 'protocol' }),
    );
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

  it('allows idle shutdown only from clean idle and lets zero mean always-on', () => {
    expect(shouldStop({ state: 'idle' }, 10_000, 10_000)).toBe(true);
    expect(shouldStop({ state: 'idle' }, 9_999, 10_000)).toBe(false);
    expect(shouldStop({ state: 'waiting', changedFiles: 1, reindexAt: NOW + 1_000 }, 20_000, 10_000)).toBe(false);
    expect(shouldStop({ state: 'indexing', startedAt: NOW }, 20_000, 10_000)).toBe(false);
    expect(shouldStop({ state: 'cooldown', until: NOW + 1_000, dirty: true }, 20_000, 10_000)).toBe(false);
    expect(shouldStop({ state: 'idle' }, 20_000, 0)).toBe(false);
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

  it('signals a live service and removes its observation files on stop', () => {
    withTempCache((cacheDir) => {
      const paths = watchServicePaths(cacheDir);
      const runtime = fakeRuntime(paths.statePath);
      runtime.alive.add(123);
      writeWatchServiceState(paths.statePath, liveState());

      expect(stopWatchService(controllerOptions(cacheDir, runtime))).toEqual({ disposition: 'stopped', pid: 123 });
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
}

function fakeRuntime(statePath: string): FakeRuntime {
  const alive = new Set<number>();
  const signaled: number[] = [];
  let nextPid = 456;
  const runtime: FakeRuntime = {
    alive,
    signaled,
    spawned: 0,
    now: () => NOW,
    isProcessAlive: (pid) => alive.has(pid),
    spawnServer: (_serverPath, projectRoot, cliVersion) => {
      runtime.spawned += 1;
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
