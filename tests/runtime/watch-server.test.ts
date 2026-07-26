import { describe, expect, it } from 'vitest';
import { watchServiceLoopDelayMs } from '../../src/runtime/watch-server.js';

describe('watchServiceLoopDelayMs', () => {
  it('backs off while both mailboxes are idle', () => {
    expect(watchServiceLoopDelayMs(0)).toBe(50);
  });

  it('keeps low latency while draining mailbox work', () => {
    expect(watchServiceLoopDelayMs(1)).toBe(10);
    expect(watchServiceLoopDelayMs(12)).toBe(10);
  });
});
