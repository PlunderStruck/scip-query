import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPathChangeWake,
  createWatchServiceShutdown,
  runWatchServiceLoopIteration,
  terminateWatchServiceProcess,
  watchServiceLoopDelayMs,
} from '../../src/runtime/watch-server.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('watchServiceLoopDelayMs', () => {
  it('backs off while both mailboxes are idle', () => {
    expect(watchServiceLoopDelayMs(0)).toBe(50);
    expect(watchServiceLoopDelayMs(0, 2)).toBe(100);
    expect(watchServiceLoopDelayMs(0, 3)).toBe(200);
    expect(watchServiceLoopDelayMs(0, 4)).toBe(400);
    expect(watchServiceLoopDelayMs(0, 7)).toBe(3_200);
    expect(watchServiceLoopDelayMs(0, 9)).toBe(10_000);
    expect(watchServiceLoopDelayMs(0, 100)).toBe(10_000);
  });

  it('keeps low latency while draining mailbox work', () => {
    expect(watchServiceLoopDelayMs(1)).toBe(10);
    expect(watchServiceLoopDelayMs(12, 100)).toBe(10);
  });
});

describe('runWatchServiceLoopIteration', () => {
  it('processes both mailboxes, records the poll, and waits with adaptive idle backoff', async () => {
    const events: string[] = [];
    const result = await runWatchServiceLoopIteration(2, {
      processIndexRequests: () => {
        events.push('index');
        return 0;
      },
      processSemanticRequests: () => {
        events.push('semantic');
        return 0;
      },
      afterMailboxPoll: ({ processedRequests }) => events.push(`after:${processedRequests}`),
      shouldStop: () => {
        events.push('stop-check');
        return false;
      },
      wait: async (durationMs) => {
        events.push(`wait:${durationMs}`);
      },
    });

    expect(events).toEqual(['index', 'semantic', 'after:0', 'stop-check', 'wait:200']);
    expect(result).toEqual({
      indexRequests: 0,
      semanticRequests: 0,
      processedRequests: 0,
      consecutiveIdlePolls: 3,
      stopped: false,
      delayMs: 200,
    });
  });

  it('resets idle state after work and stops without sleeping when shutdown is requested', async () => {
    let waited = false;
    const result = await runWatchServiceLoopIteration(99, {
      processIndexRequests: () => 2,
      processSemanticRequests: () => 1,
      afterMailboxPoll: () => {},
      shouldStop: () => true,
      wait: async () => {
        waited = true;
      },
    });

    expect(result).toEqual({
      indexRequests: 2,
      semanticRequests: 1,
      processedRequests: 3,
      consecutiveIdlePolls: 0,
      stopped: true,
    });
    expect(waited).toBe(false);
  });

  it('propagates processor failures without running later loop effects', async () => {
    const events: string[] = [];
    await expect(
      runWatchServiceLoopIteration(0, {
        processIndexRequests: () => {
          events.push('index');
          throw new Error('mailbox corrupt');
        },
        processSemanticRequests: () => {
          events.push('semantic');
          return 0;
        },
        afterMailboxPoll: () => events.push('after'),
        shouldStop: () => false,
        wait: async () => {
          events.push('wait');
        },
      }),
    ).rejects.toThrow('mailbox corrupt');
    expect(events).toEqual(['index']);
  });
});

describe('createWatchServiceShutdown', () => {
  it('starts watcher cancellation immediately and shares one completion across shutdown phases', async () => {
    const events: string[] = [];
    let resolveStop: ((result: { state: 'stopped' }) => void) | undefined;
    const completion = new Promise<{ state: 'stopped' }>((resolve) => {
      resolveStop = resolve;
    });
    const shutdown = createWatchServiceShutdown(
      {
        stop() {
          events.push('watcher-stop');
          return completion;
        },
      },
      {
        requestStop() {
          events.push('request-stop');
        },
        closeWake() {
          events.push('wake-close');
        },
      },
    );

    const signalPhase = shutdown.begin();
    const finallyPhase = shutdown.begin();

    expect(signalPhase).toBe(completion);
    expect(finallyPhase).toBe(completion);
    expect(events).toEqual(['request-stop', 'wake-close', 'watcher-stop']);

    resolveStop?.({ state: 'stopped' });
    await expect(signalPhase).resolves.toEqual({ state: 'stopped' });
  });
});

describe('terminateWatchServiceProcess', () => {
  it('reports the shutdown failure before forcing the dedicated process to exit', () => {
    const events: string[] = [];
    const exit = new Error('process exited');

    expect(() =>
      terminateWatchServiceProcess(new Error('shutdown remained degraded'), {
        report: (message) => events.push(`report:${message}`),
        exit(code) {
          events.push(`exit:${code}`);
          throw exit;
        },
      }),
    ).toThrow(exit);
    expect(events).toEqual(['report:watch-service: shutdown remained degraded', 'exit:1']);
  });
});

describe('createPathChangeWake', () => {
  it('wakes a pending wait when a watched path changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-query-watch-wake-'));
    tempDirs.push(dir);
    const wake = createPathChangeWake([dir]);
    try {
      const pending = wake.wait(2_000);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      const startedAt = Date.now();
      writeFileSync(join(dir, 'request.json'), '{}');
      await pending;
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      wake.close();
    }
  });

  it('returns immediately when a watched path changed before wait', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-query-watch-latch-'));
    tempDirs.push(dir);
    const wake = createPathChangeWake([dir]);
    try {
      writeFileSync(join(dir, 'request.json'), '{}');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      const startedAt = Date.now();
      await wake.wait(2_000);
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      wake.close();
    }
  });

  it('aborts a pending wait when closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-query-watch-close-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'pending'));
    const wake = createPathChangeWake([join(dir, 'pending')]);
    const startedAt = Date.now();
    const pending = wake.wait(2_000);
    wake.close();
    await pending;
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
