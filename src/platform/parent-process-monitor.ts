import { readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from './process-identity.js';

export interface ParentProcessMonitorRuntime {
  readIdentity(pid: number): ProcessIdentity | null;
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export interface ParentProcessMonitor {
  stop(): void;
}

const DEFAULT_PARENT_PROCESS_MONITOR_RUNTIME: ParentProcessMonitorRuntime = {
  readIdentity: readProcessIdentity,
  setInterval(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    return timer;
  },
  clearInterval,
};

/**
 * Observe one exact parent process instance. The monitor fires once when that
 * process exits or its PID is reused, then releases its timer.
 */
export function monitorParentProcess(
  expected: ProcessIdentity,
  onLost: (reason: string) => void,
  options: {
    intervalMs?: number;
    runtime?: ParentProcessMonitorRuntime;
  } = {},
): ParentProcessMonitor {
  const runtime = options.runtime ?? DEFAULT_PARENT_PROCESS_MONITOR_RUNTIME;
  const intervalMs = options.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError('parent process monitor interval must be a positive safe integer');
  }
  let active = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  const check = (): void => {
    if (!active) return;
    const observed = runtime.readIdentity(expected.pid);
    if (observed && sameProcessIdentity(expected, observed)) return;
    active = false;
    if (timer) runtime.clearInterval(timer);
    onLost(observed ? `parent process ${expected.pid} changed identity` : `parent process ${expected.pid} exited`);
  };
  check();
  if (active) timer = runtime.setInterval(check, intervalMs);
  return {
    stop() {
      if (!active) return;
      active = false;
      if (timer) runtime.clearInterval(timer);
    },
  };
}
