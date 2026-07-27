import { describe, expect, it } from 'vitest';
import { runWatchServiceLoopIteration, watchServiceLoopDelayMs } from '../../src/runtime/watch-server.js';

describe('watchServiceLoopDelayMs', () => {
  it('backs off while both mailboxes are idle', () => {
    expect(watchServiceLoopDelayMs(0)).toBe(50);
    expect(watchServiceLoopDelayMs(0, 2)).toBe(100);
    expect(watchServiceLoopDelayMs(0, 3)).toBe(200);
    expect(watchServiceLoopDelayMs(0, 4)).toBe(250);
    expect(watchServiceLoopDelayMs(0, 100)).toBe(250);
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
