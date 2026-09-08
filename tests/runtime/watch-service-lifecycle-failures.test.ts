import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as service from '../../src/runtime/watch-service.js';
import { WatchRefreshCoordinator } from '../../src/runtime/watch-refresh-coordinator.js';
import { runWatchServiceLifecycle, runWatchServiceServer } from '../../src/runtime/watch-server.js';

afterEach(() => vi.restoreAllMocks());

describe('watch service acquisition and shutdown failures', () => {
  it('routes a heartbeat write failure through awaited shutdown instead of throwing from a timer', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    let heartbeat = false;
    let stopping = false;
    let finishWait = (): void => {};
    const finalized = vi.fn();
    const lifecycle = runWatchServiceLifecycle({
      watcher: { start() {} },
      shutdown: { begin: async () => ({ state: 'stopped' }) },
      stopSignal() {
        stopping = true;
        finishWait();
      },
      initializeFreshness: () => null,
      markReady() {},
      recordActivity() {},
      requestRefresh() {},
      persistState() {
        if (heartbeat) throw new Error('heartbeat write failed');
      },
      stopRequested: () => stopping,
      processIndexRequests: () => 0,
      processSemanticRequests: () => 0,
      afterMailboxPoll() {},
      shouldStop: () => false,
      wait: () =>
        new Promise<void>((resolveWait) => {
          finishWait = resolveWait;
        }),
      closeLanes: async () => {},
      mailboxFatalError: () => undefined,
      finalizeStopped: finalized,
      finalizeDegraded: (reasons) => new Error(reasons.join('; ')),
    });
    heartbeat = true;
    try {
      const tick = interval.mock.calls[0]![0] as () => void;
      expect(() => tick()).not.toThrow();
    } finally {
      stopping = true;
      finishWait();
      await expect(lifecycle).rejects.toThrow('heartbeat write failed');
    }
    expect(finalized).toHaveBeenCalledOnce();
  });

  it('releases ownership if initialization fails before the lifecycle starts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-watch-acquisition-'));
    const release = vi.fn();
    vi.spyOn(service, 'acquireWatchProcessLock').mockReturnValue({ acquired: true, release });
    vi.spyOn(WatchRefreshCoordinator.prototype, 'initializeAfterOwnershipAcquired').mockImplementation(() => {
      throw new Error('refresh initialization failed');
    });
    try {
      await expect(runWatchServiceServer(root, 'test', { enabled: true })).rejects.toThrow(
        'refresh initialization failed',
      );
      expect(release).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('joins watcher shutdown and reports degraded ownership when lane close rejects', async () => {
    const events: string[] = [];
    const stopSignal = (): void => {};
    const runtime: Parameters<typeof runWatchServiceLifecycle>[0] = {
      watcher: { start() {} },
      shutdown: {
        begin: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          events.push('watcher-stopped');
          return { state: 'stopped' };
        },
      },
      stopSignal,
      initializeFreshness: () => null,
      markReady() {},
      recordActivity() {},
      persistState() {},
      requestRefresh() {},
      stopRequested: () => true,
      processIndexRequests: () => 0,
      processSemanticRequests: () => 0,
      afterMailboxPoll() {},
      shouldStop: () => true,
      wait: async () => {},
      closeLanes: async () => {
        throw new Error('lane close failed');
      },
      mailboxFatalError: () => undefined,
      finalizeStopped: () => {
        events.push('released');
      },
      finalizeDegraded: (reasons) => {
        events.push('degraded');
        return new Error(reasons.join('; '));
      },
    };
    await expect(runWatchServiceLifecycle(runtime)).rejects.toThrow('lane close failed');
    expect(events).toEqual(['watcher-stopped', 'degraded']);
    expect(process.listeners('SIGINT')).not.toContain(stopSignal);
    expect(process.listeners('SIGTERM')).not.toContain(stopSignal);
  });
});
