import { join } from 'node:path';
import { monotonicNowMs } from '../domain/time.js';
import { abortSignalReason, throwIfSignalAborted } from './abort-signal.js';
import { tryAcquireProcessFileLock, type LegacyProcessLockDecoder, type ProcessFileLock } from './process-file-lock.js';

export interface RepositoryCacheLock {
  release(): void;
}

const parseLegacyGenericLock: LegacyProcessLockDecoder = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pid = (value as { pid?: unknown }).pid;
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? { pid } : null;
};

/**
 * Serializes repository-cache reachability changes with garbage collection.
 * A lease writer and a sweeper must observe one another through this file, so
 * a generation cannot be deleted between the sweep's mark phase and a new
 * reference becoming durable.
 */
export function acquireRepositoryCacheLock(
  repositoryDir: string,
  opts: { waitMs?: number; pollMs?: number; now?: () => number } = {},
): RepositoryCacheLock | null {
  return acquireProcessFileLock(join(repositoryDir, 'gc.lock'), opts);
}

/** Acquires one durable token-owned process lock with conservative recovery. */
export function acquireProcessFileLock(
  lockPath: string,
  opts: { waitMs?: number; pollMs?: number; now?: () => number } = {},
): RepositoryCacheLock | null {
  const waitMs = opts.waitMs ?? 0;
  const pollMs = opts.pollMs ?? 10;
  const now = opts.now ?? monotonicNowMs;
  const deadline = now() + waitMs;

  do {
    const result = tryAcquireGenericLock(lockPath);
    if (result) return asRepositoryLock(result);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return null;
    sleepSync(Math.min(pollMs, remainingMs));
  } while (now() <= deadline);
  return null;
}

/**
 * Wait for a token-owned process lock without blocking unrelated asynchronous
 * work in the current process.
 */
export async function acquireProcessFileLockAsync(
  lockPath: string,
  opts: { waitMs?: number; pollMs?: number; now?: () => number; signal?: AbortSignal } = {},
): Promise<RepositoryCacheLock | null> {
  const waitMs = opts.waitMs ?? 0;
  const pollMs = opts.pollMs ?? 10;
  const now = opts.now ?? monotonicNowMs;
  const deadline = now() + waitMs;

  do {
    throwIfSignalAborted(opts.signal, 'Lock acquisition was aborted.');
    const result = tryAcquireGenericLock(lockPath);
    if (result) return asRepositoryLock(result);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return null;
    await sleepAsync(Math.min(pollMs, remainingMs), opts.signal);
  } while (now() <= deadline);
  return null;
}

function tryAcquireGenericLock(lockPath: string): ProcessFileLock | null {
  const result = tryAcquireProcessFileLock(lockPath, {
    kind: 'generic',
    parseLegacy: parseLegacyGenericLock,
  });
  return result.kind === 'acquired' ? result.lock : null;
}

function asRepositoryLock(lock: ProcessFileLock): RepositoryCacheLock {
  return {
    release: () => {
      lock.release();
    },
  };
}

function sleepSync(durationMs: number): void {
  const view = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(view, 0, 0, durationMs);
}

function sleepAsync(durationMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortSignalReason(signal, 'Lock acquisition was aborted.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(
        signal
          ? abortSignalReason(signal, 'Lock acquisition was aborted.')
          : new Error('Lock acquisition was aborted.'),
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
