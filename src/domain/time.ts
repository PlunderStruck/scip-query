/**
 * Returns process-local monotonic milliseconds for elapsed-time decisions.
 *
 * Unlike civil time, this value is not a timestamp and must never be
 * persisted or compared across process sessions. Its only contract is that
 * it does not move backward while this process is running.
 */
export function monotonicNowMs(): number {
  return performance.now();
}

/** Returns civil-clock milliseconds for persisted diagnostics and expiry hints. */
export function wallNowMs(): number {
  return Date.now();
}

/** Creates a bounded process-local deadline from a non-negative duration. */
export function monotonicDeadlineMs(durationMs: number, now: () => number = monotonicNowMs): number {
  return now() + Math.max(0, durationMs);
}

/** Returns the non-negative process-local duration left before a deadline. */
export function monotonicRemainingMs(deadlineMs: number, now: () => number = monotonicNowMs): number {
  return Math.max(0, deadlineMs - now());
}

/**
 * Returns a busy-loop delay or an exponentially increasing idle delay capped
 * by both an exponent and an absolute duration.
 */
export function boundedExponentialLoopDelayMs(
  processedRequests: number,
  consecutiveIdlePolls: number,
  busyDelayMs: number,
  initialIdleDelayMs: number,
  maxIdleDelayMs: number,
  maxExponent: number,
): number {
  if (processedRequests > 0) return busyDelayMs;
  const exponent = Math.max(0, Math.min(maxExponent, consecutiveIdlePolls - 1));
  return Math.min(maxIdleDelayMs, initialIdleDelayMs * 2 ** exponent);
}
