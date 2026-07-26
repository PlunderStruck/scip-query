import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  WATCH_ACTIVITY_FILE,
  WATCH_LOCK_FILE,
  WATCH_SERVICE_PROTOCOL_VERSION,
  WATCH_STATE_FILE,
  parseWatchServiceState,
  readWatchServiceState,
  watchServicePaths,
  type WatchServiceState,
} from '../../src/platform/watch-service-state.js';

describe('watch service persisted state', () => {
  it('parses only complete versioned state', () => {
    expect(parseWatchServiceState(liveState())).toEqual(liveState());
    expect(parseWatchServiceState({ ...liveState(), pid: 0 })).toBeNull();
    expect(parseWatchServiceState({ ...liveState(), worktreeId: '' })).toBeNull();
    expect(parseWatchServiceState({ ...liveState(), heartbeatAt: 'not-a-date' })).toBeNull();
    expect(parseWatchServiceState({ ...liveState(), watcher: { state: 'waiting' } })).toBeNull();
    expect(
      parseWatchServiceState({
        ...liveState(),
        watcher: { state: 'draining', startedAt: 123, reason: 'worker still exiting' },
      }),
    ).toEqual({
      ...liveState(),
      watcher: { state: 'draining', startedAt: 123, reason: 'worker still exiting' },
    });
    expect(
      parseWatchServiceState({
        ...liveState(),
        watcher: { state: 'draining', startedAt: 123 },
      }),
    ).toBeNull();
    expect(
      parseWatchServiceState({
        ...liveState(),
        reindexActivity: { ...liveState().reindexActivity!, runs: -1 },
      }),
    ).toBeNull();
    expect(parseWatchServiceState({ ...liveState(), indexGeneration: 'a'.repeat(64) })).toEqual({
      ...liveState(),
      indexGeneration: 'a'.repeat(64),
    });
    expect(parseWatchServiceState({ ...liveState(), indexGeneration: 'not-a-generation' })).toBeNull();
    expect(
      parseWatchServiceState({
        ...liveState(),
        typescriptSemantic: { ...liveState().typescriptSemantic!, state: 'mystery' },
      }),
    ).toBeNull();
    expect(
      parseWatchServiceState({
        ...liveState(),
        typescriptIndex: { ...liveState().typescriptIndex!, documentsEmitted: -1 },
      }),
    ).toBeNull();
  });

  it('reads valid state and treats missing or malformed files as unavailable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'scip-query-watch-state-'));
    const statePath = join(directory, WATCH_STATE_FILE);
    try {
      expect(readWatchServiceState(statePath)).toBeNull();
      writeFileSync(statePath, '{malformed');
      expect(readWatchServiceState(statePath)).toBeNull();
      writeFileSync(statePath, JSON.stringify(liveState()));
      expect(readWatchServiceState(statePath)).toEqual(liveState());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('resolves the persisted watch files without changing their layout', () => {
    expect(watchServicePaths('/cache')).toEqual({
      lockPath: join('/cache', WATCH_LOCK_FILE),
      statePath: join('/cache', WATCH_STATE_FILE),
      activityPath: join('/cache', WATCH_ACTIVITY_FILE),
    });
  });
});

function liveState(): WatchServiceState {
  return {
    version: 1,
    protocolVersion: WATCH_SERVICE_PROTOCOL_VERSION,
    pid: 123,
    projectRoot: '/project',
    cliVersion: '0.15.0',
    startedAt: '2026-07-09T19:59:00.000Z',
    heartbeatAt: '2026-07-09T19:59:59.000Z',
    lastActivityAt: '2026-07-09T19:59:58.000Z',
    idleDeadlineAt: '2026-07-09T20:09:58.000Z',
    watcher: { state: 'idle' },
    reindexActivity: {
      windowStartedAt: '2026-07-08T20:00:00.000Z',
      windowEndedAt: '2026-07-09T20:00:00.000Z',
      runs: 3,
      rebuilt: 1,
      reused: 2,
      failed: 0,
      suppressed: 4,
      estimatedLogicalOutputBytes: 1024,
      byTrigger: { 'watch-source': 7 },
    },
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
