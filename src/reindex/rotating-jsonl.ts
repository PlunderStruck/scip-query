import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';

import { monotonicNowMs } from '../domain/time.js';
import { tryAcquireProcessFileLock } from '../platform/process-file-lock.js';

export const ROTATING_JSONL_PREVIOUS_SUFFIX = '.previous';
export const ROTATING_JSONL_LOCK_SUFFIX = '.rotation.lock';
export const ROTATING_JSONL_LOCK_TIMEOUT_MS = 2_000;

export type RotatingJsonlPhase = 'tail-repaired' | 'previous-pruned' | 'current-rotated' | 'record-appended';

export interface RotatingJsonlLock {
  release(): boolean;
}

export type RotatingJsonlLockAttempt = { kind: 'acquired'; lock: RotatingJsonlLock } | { kind: 'contended' };

export interface RotatingJsonlRuntime {
  monotonicNow(): number;
  wait(delayMs: number): void;
  tryAcquireLock(path: string, targetPath: string): RotatingJsonlLockAttempt;
  makeDirectory(path: string): void;
  exists(path: string): boolean;
  readBytes(path: string): Buffer;
  size(path: string): number;
  truncate(path: string, size: number): void;
  remove(path: string): void;
  rename(from: string, to: string): void;
  append(path: string, bytes: Buffer): void;
}

export interface AppendRotatingJsonlOptions {
  maxSegmentBytes: number;
  previousSuffix?: string;
  lockTimeoutMs?: number;
  runtime?: RotatingJsonlRuntime;
  onPhase?: (phase: RotatingJsonlPhase) => void;
}

export interface ReadRotatingJsonlOptions {
  previousSuffix?: string;
  lockTimeoutMs?: number;
  runtime?: RotatingJsonlRuntime;
}

export interface AppendRotatingJsonlResult {
  lineBytes: number;
  segmentLimitBytes: number;
  repairedTailBytes: number;
  rotated: boolean;
  prunedPrevious: boolean;
}

export interface ReadRotatingJsonlResult {
  lines: string[];
  ignoredPartialTailBytes: number;
}

export class RotatingJsonlLockTimeoutError extends Error {
  readonly code = 'ROTATING_JSONL_LOCK_TIMEOUT';

  constructor(
    readonly lockPath: string,
    readonly timeoutMs: number,
  ) {
    super(`Timed out after ${timeoutMs}ms waiting for rotating JSONL lock: ${lockPath}`);
    this.name = 'RotatingJsonlLockTimeoutError';
  }
}

export class RotatingJsonlLockReleaseError extends Error {
  readonly code = 'ROTATING_JSONL_LOCK_RELEASE_FAILED';

  constructor(readonly lockPath: string) {
    super(`Rotating JSONL lock ownership changed before release: ${lockPath}`);
    this.name = 'RotatingJsonlLockReleaseError';
  }
}

const NODE_ROTATING_JSONL_RUNTIME = Object.freeze<RotatingJsonlRuntime>({
  monotonicNow: monotonicNowMs,
  wait(delayMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  },
  tryAcquireLock(path, targetPath) {
    const result = tryAcquireProcessFileLock(path, {
      kind: 'rotating-jsonl',
      detail: { target: basename(targetPath) },
    });
    return result.kind === 'acquired' ? { kind: 'acquired', lock: result.lock } : { kind: 'contended' };
  },
  makeDirectory(path) {
    mkdirSync(path, { recursive: true });
  },
  exists: existsSync,
  readBytes(path) {
    return readFileSync(path);
  },
  size(path) {
    return statSync(path).size;
  },
  truncate: truncateSync,
  remove(path) {
    rmSync(path, { force: true });
  },
  rename: renameSync,
  append: appendFileSync,
});

/**
 * Appends one complete JSON record while serializing tail repair, retention,
 * rotation, and append beneath a process-instance lock. A configured segment
 * limit smaller than one record expands to that record's size so a successful
 * append is retained as a complete line rather than immediately becoming an
 * oversized legacy segment.
 */
export function appendRotatingJsonlRecord(
  path: string,
  record: unknown,
  options: AppendRotatingJsonlOptions,
): AppendRotatingJsonlResult {
  const runtime = options.runtime ?? NODE_ROTATING_JSONL_RUNTIME;
  const serialized = JSON.stringify(record);
  if (serialized === undefined) throw new TypeError('Rotating JSONL records must be JSON-serializable values.');
  const line = Buffer.from(`${serialized}\n`);
  const segmentLimitBytes = Math.max(1, Math.floor(options.maxSegmentBytes), line.length);
  return withRotatingJsonlLock(path, options.lockTimeoutMs, runtime, () => {
    runtime.makeDirectory(dirname(path));
    const repairedTailBytes = repairIncompleteCurrentTail(path, runtime);
    options.onPhase?.('tail-repaired');

    const previousPath = `${path}${options.previousSuffix ?? ROTATING_JSONL_PREVIOUS_SUFFIX}`;
    let rotated = false;
    let prunedPrevious = false;
    if (runtime.exists(path) && runtime.size(path) + line.length > segmentLimitBytes) {
      if (runtime.exists(previousPath)) {
        runtime.remove(previousPath);
        prunedPrevious = true;
      }
      options.onPhase?.('previous-pruned');
      runtime.rename(path, previousPath);
      rotated = true;
      options.onPhase?.('current-rotated');
    }
    runtime.append(path, line);
    options.onPhase?.('record-appended');
    return {
      lineBytes: line.length,
      segmentLimitBytes,
      repairedTailBytes,
      rotated,
      prunedPrevious,
    };
  });
}

/**
 * Reads the retained segment set under the writer lock in deterministic
 * previous-then-current order. A final non-newline tail is an incomplete
 * append, not a record, and is reported by byte count rather than parsed.
 */
export function readRotatingJsonlLines(path: string, options: ReadRotatingJsonlOptions = {}): ReadRotatingJsonlResult {
  const runtime = options.runtime ?? NODE_ROTATING_JSONL_RUNTIME;
  return withRotatingJsonlLock(path, options.lockTimeoutMs, runtime, () => {
    const lines: string[] = [];
    let ignoredPartialTailBytes = 0;
    const previousPath = `${path}${options.previousSuffix ?? ROTATING_JSONL_PREVIOUS_SUFFIX}`;
    for (const segmentPath of [previousPath, path]) {
      if (!runtime.exists(segmentPath)) continue;
      const decoded = completeJsonlLines(runtime.readBytes(segmentPath));
      lines.push(...decoded.lines);
      ignoredPartialTailBytes += decoded.partialTailBytes;
    }
    return { lines, ignoredPartialTailBytes };
  });
}

function withRotatingJsonlLock<T>(
  path: string,
  timeoutMs: number | undefined,
  runtime: RotatingJsonlRuntime,
  operation: () => T,
): T {
  const lockPath = `${path}${ROTATING_JSONL_LOCK_SUFFIX}`;
  const waitBudgetMs = Math.max(0, timeoutMs ?? ROTATING_JSONL_LOCK_TIMEOUT_MS);
  const deadline = runtime.monotonicNow() + waitBudgetMs;
  let lock: RotatingJsonlLock;
  for (;;) {
    const attempt = runtime.tryAcquireLock(lockPath, path);
    if (attempt.kind === 'acquired') {
      lock = attempt.lock;
      break;
    }
    const remainingMs = deadline - runtime.monotonicNow();
    if (remainingMs <= 0) throw new RotatingJsonlLockTimeoutError(lockPath, waitBudgetMs);
    runtime.wait(Math.min(5, remainingMs));
  }
  let operationFailed = false;
  let operationError: unknown;
  let result: T | undefined;
  try {
    result = operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let released = false;
  try {
    released = lock.release();
  } catch (releaseError) {
    if (!operationFailed) throw releaseError;
  }
  if (operationFailed) throw operationError;
  if (!released) throw new RotatingJsonlLockReleaseError(lockPath);
  return result as T;
}

function repairIncompleteCurrentTail(path: string, runtime: RotatingJsonlRuntime): number {
  if (!runtime.exists(path)) return 0;
  const bytes = runtime.readBytes(path);
  if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return 0;
  const lastNewline = bytes.lastIndexOf(0x0a);
  const retainedBytes = lastNewline < 0 ? 0 : lastNewline + 1;
  runtime.truncate(path, retainedBytes);
  return bytes.length - retainedBytes;
}

function completeJsonlLines(bytes: Buffer): { lines: string[]; partialTailBytes: number } {
  const lastNewline = bytes.lastIndexOf(0x0a);
  const completeBytes = lastNewline < 0 ? 0 : lastNewline + 1;
  const complete = bytes.subarray(0, completeBytes).toString('utf8');
  return {
    lines: complete.split('\n').filter((line) => line.length > 0),
    partialTailBytes: bytes.length - completeBytes,
  };
}
