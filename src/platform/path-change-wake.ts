import { statSync, type FSWatcher, watch } from 'node:fs';

export interface PathChangeWake {
  wait(durationMs: number): Promise<void>;
  close(): void;
}

/**
 * Sleep until `durationMs` elapses, a watched path changes, or `close()` runs.
 * A change that arrives between polls is latched so the next wait returns
 * immediately instead of sleeping a full idle interval.
 */
export function createPathChangeWake(paths: readonly string[]): PathChangeWake {
  let closed = false;
  let pendingNotify = false;
  let wake: (() => void) | undefined;
  const watchers: FSWatcher[] = [];
  const watched = [...new Set(paths)];
  // Filesystem events arrive late or not at all on some hosts (FSEvents under
  // load, network mounts), so a wait also compares each path's modification
  // time with the last one it settled on; a change that already happened
  // resolves immediately instead of waiting for the timeout.
  const settledMtimes = new Map<string, number | null>();
  const readMtime = (path: string): number | null => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  };
  const settle = (): void => {
    for (const path of watched) settledMtimes.set(path, readMtime(path));
  };
  const changedSinceSettled = (): boolean => watched.some((path) => readMtime(path) !== settledMtimes.get(path));
  settle();
  const notify = (): void => {
    pendingNotify = true;
    const current = wake;
    wake = undefined;
    current?.();
  };
  for (const path of watched) {
    try {
      const watcher = watch(path, { persistent: false }, notify);
      watcher.on('error', () => undefined);
      watchers.push(watcher);
    } catch {
      // Missing or unsupported paths still poll when the timeout fires.
    }
  }
  return {
    wait(durationMs) {
      if (closed || durationMs <= 0) {
        pendingNotify = false;
        return Promise.resolve();
      }
      return new Promise((resolvePromise) => {
        const timer = setTimeout(() => {
          if (wake === resolveAndClear) wake = undefined;
          resolvePromise();
        }, durationMs);
        const resolveAndClear = (): void => {
          clearTimeout(timer);
          if (wake === resolveAndClear) wake = undefined;
          resolvePromise();
        };
        wake = resolveAndClear;
        if (pendingNotify || closed || changedSinceSettled()) {
          pendingNotify = false;
          settle();
          resolveAndClear();
        }
      });
    },
    close() {
      if (!closed) {
        closed = true;
        for (const watcher of watchers) {
          try {
            watcher.close();
          } catch {
            // already closed
          }
        }
        watchers.length = 0;
      }
      notify();
    },
  };
}
