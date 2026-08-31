import { describe, expect, it } from 'vitest';

import { boundedExponentialLoopDelayMs, monotonicDeadlineMs, monotonicRemainingMs } from '../../src/domain/time.js';

describe('monotonic elapsed-time helpers', () => {
  it('derives deadlines and remaining duration only from the supplied monotonic source', () => {
    let monotonic = 40;
    const now = (): number => monotonic;
    const deadline = monotonicDeadlineMs(100, now);

    monotonic = 90;
    expect(monotonicRemainingMs(deadline, now)).toBe(50);
    monotonic = 200;
    expect(monotonicRemainingMs(deadline, now)).toBe(0);
  });

  it('clamps negative durations and expired deadlines', () => {
    expect(monotonicDeadlineMs(-10, () => 5)).toBe(5);
    expect(monotonicRemainingMs(4, () => 5)).toBe(0);
  });

  it('keeps busy polling responsive and bounds exponential idle backoff', () => {
    expect(boundedExponentialLoopDelayMs(1, 20, 5, 50, 10_000, 8)).toBe(5);
    expect(boundedExponentialLoopDelayMs(0, 1, 5, 50, 10_000, 8)).toBe(50);
    expect(boundedExponentialLoopDelayMs(0, 4, 5, 50, 10_000, 8)).toBe(400);
    expect(boundedExponentialLoopDelayMs(0, 100, 5, 50, 10_000, 8)).toBe(10_000);
  });
});
