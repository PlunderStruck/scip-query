import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isProcessAlive } from './process-liveness.js';

interface ProcessLockRecord {
  version: 1;
  pid: number;
  token: string;
  startedAt: string;
}

export interface RepositoryCacheLock {
  release(): void;
}

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

/** Acquires one token-owned process lock without ever unlinking a changed owner record. */
// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
export function acquireProcessFileLock(
  lockPath: string,
  opts: { waitMs?: number; pollMs?: number; now?: () => number } = {},
): RepositoryCacheLock | null {
  const waitMs = opts.waitMs ?? 0;
  const pollMs = opts.pollMs ?? 10;
  const now = opts.now ?? Date.now;
  const deadline = Date.now() + waitMs;
  mkdirSync(dirname(lockPath), { recursive: true });

  do {
    const token = randomUUID();
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        const record: ProcessLockRecord = {
          version: 1,
          pid: process.pid,
          token,
          startedAt: new Date(now()).toISOString(),
        };
        writeFileSync(fd, `${JSON.stringify(record)}\n`);
      } finally {
        closeSync(fd);
      }
      return {
        release: () => releaseOwnedLock(lockPath, token),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const observed = readLockObservation(lockPath);
      if (observed && (observed.pid === undefined || !isProcessAlive(observed.pid))) {
        reclaimObservedLock(lockPath, observed);
        continue;
      }
      if (Date.now() >= deadline) return null;
      sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  } while (Date.now() <= deadline);
  return null;
}

/**
 * Wait for a token-owned process lock without blocking unrelated asynchronous
 * work in the current process. Each attempt retains the synchronous helper's
 * dead-owner reclamation and token-checked release semantics.
 */
export async function acquireProcessFileLockAsync(
  lockPath: string,
  opts: { waitMs?: number; pollMs?: number; now?: () => number; signal?: AbortSignal } = {},
): Promise<RepositoryCacheLock | null> {
  const waitMs = opts.waitMs ?? 0;
  const pollMs = opts.pollMs ?? 10;
  const now = opts.now ?? Date.now;
  const deadline = now() + waitMs;

  do {
    throwIfAborted(opts.signal);
    const lock = acquireProcessFileLock(lockPath, { now });
    if (lock) return lock;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return null;
    await sleepAsync(Math.min(pollMs, remainingMs), opts.signal);
  } while (now() <= deadline);
  return null;
}

interface LockObservation {
  raw: string;
  pid?: number;
}

function readLockObservation(path: string): LockObservation | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: unknown };
    const pid =
      typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined;
    return { raw, ...(pid === undefined ? {} : { pid }) };
  } catch {
    return null;
  }
}

function reclaimObservedLock(lockPath: string, observed: LockObservation): boolean {
  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimToken = randomUUID();
  let fd: number;
  try {
    fd = openSync(reclaimPath, 'wx');
  } catch {
    return false;
  }
  try {
    writeFileSync(
      fd,
      `${JSON.stringify({ version: 1, pid: process.pid, token: reclaimToken, startedAt: new Date().toISOString() })}\n`,
    );
  } finally {
    closeSync(fd);
  }
  try {
    const current = readLockObservation(lockPath);
    if (!current || current.raw !== observed.raw) return false;
    if (current.pid !== undefined && isProcessAlive(current.pid)) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    releaseOwnedLock(reclaimPath, reclaimToken);
  }
}

function releaseOwnedLock(path: string, token: string): void {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; token?: unknown };
    if (parsed.pid === process.pid && parsed.token === token) unlinkSync(path);
  } catch {
    // A crashed or reclaimed owner may already have removed the file.
  }
}

function sleepSync(durationMs: number): void {
  const view = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(view, 0, 0, durationMs);
}

function sleepAsync(durationMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal ? abortReason(signal) : new Error('Lock acquisition was aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Lock acquisition was aborted.');
}
