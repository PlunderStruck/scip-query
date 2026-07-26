import { describe, expect, it } from 'vitest';

import { monotonicDeadlineMs, monotonicRemainingMs } from '../../src/domain/time.js';

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
});
