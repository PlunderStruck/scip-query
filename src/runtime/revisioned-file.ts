import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, rmSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname } from 'node:path';
import { tryAcquireProcessFileLock, type ProcessFileLock } from '../platform/process-file-lock.js';
import { createFileAtomicExclusive, replaceFileAtomic, syncDirectoryDurable } from '../storage/atomic-file.js';

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_MUTATION_RETRIES = 3;

export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mode: number;
}

export interface FileRevision {
  exists: boolean;
  hash: string;
  identity?: FileIdentity;
}

export interface RevisionedTextSnapshot {
  path: string;
  text: string;
  revision: FileRevision;
}

export type RevisionedTextMutation =
  | { kind: 'unchanged' }
  | { kind: 'write'; text: string; mode?: number }
  | { kind: 'delete' };

export interface RevisionedFileMutationOptions {
  maxRetries?: number;
  lockTimeoutMs?: number;
  /** @internal deterministic concurrency/fault-injection boundary. */
  onBeforeCommit?: (context: {
    attempt: number;
    snapshot: RevisionedTextSnapshot;
    mutation: Exclude<RevisionedTextMutation, { kind: 'unchanged' }>;
  }) => void;
}

export interface RevisionedFileMutationResult {
  changed: boolean;
  attempts: number;
  previous: RevisionedTextSnapshot;
  current: RevisionedTextSnapshot;
}

/**
 * Raised when a writer cannot prove that the bytes it transformed are still
 * the bytes at the public path. `original` identifies the transformed
 * revision; `latest` identifies the independent replacement that won.
 */
export class FileRevisionConflictError extends Error {
  constructor(
    readonly path: string,
    readonly original: FileRevision,
    readonly latest: FileRevision,
  ) {
    super(
      `Concurrent edit detected for ${path}; expected revision ${formatRevision(original)}, ` +
        `but found ${formatRevision(latest)}. The latest file was left untouched.`,
    );
    this.name = 'FileRevisionConflictError';
  }
}

/** A three-way domain merge found two different edits to the same owned field. */
export class FileContentConflictError extends Error {
  constructor(
    readonly path: string,
    readonly field: string,
  ) {
    super(
      `Concurrent edit detected for ${path}: ${field} changed since it was read. ` +
        'The latest file was left untouched; reload it and retry.',
    );
    this.name = 'FileContentConflictError';
  }
}

/**
 * Serializes cooperating writers, transforms a stable snapshot, and checks
 * that snapshot again immediately before a durable commit. Independent
 * editors need not understand the lock: a changed revision causes a bounded
 * retry or an explicit conflict instead of a blind overwrite.
 */
export function mutateTextFileRevisionAware(
  path: string,
  transform: (snapshot: RevisionedTextSnapshot, attempt: number) => RevisionedTextMutation,
  options: RevisionedFileMutationOptions = {},
): RevisionedFileMutationResult {
  const lock = acquireMutationLock(path, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  try {
    const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MUTATION_RETRIES));
    for (let attempt = 0; ; attempt += 1) {
      const snapshot = readStableTextSnapshot(path);
      const mutation = transform(snapshot, attempt);
      if (mutation.kind === 'unchanged') {
        return { changed: false, attempts: attempt + 1, previous: snapshot, current: snapshot };
      }
      options.onBeforeCommit?.({ attempt, snapshot, mutation });
      const latest = readStableTextSnapshot(path);
      if (!sameRevision(snapshot.revision, latest.revision)) {
        if (attempt < maxRetries) continue;
        throw new FileRevisionConflictError(path, snapshot.revision, latest.revision);
      }
      try {
        commitMutation(path, mutation, snapshot.revision);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const competing = readStableTextSnapshot(path);
          if (attempt < maxRetries) continue;
          throw new FileRevisionConflictError(path, snapshot.revision, competing.revision);
        }
        throw error;
      }
      return {
        changed: true,
        attempts: attempt + 1,
        previous: snapshot,
        current: readStableTextSnapshot(path),
      };
    }
  } finally {
    lock.release();
  }
}

export function readStableTextSnapshot(path: string): RevisionedTextSnapshot {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      const before = identityFromStat(fstatSync(fd));
      const text = readFileSync(fd, 'utf8');
      const after = identityFromStat(fstatSync(fd));
      if (!sameIdentity(before, after)) continue;
      return {
        path,
        text,
        revision: {
          exists: true,
          hash: createHash('sha256').update(text).digest('hex'),
          identity: after,
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { path, text: '', revision: { exists: false, hash: createHash('sha256').update('').digest('hex') } };
      }
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  throw new Error(`Could not read a stable revision of ${path}; the file is changing continuously.`);
}

function acquireMutationLock(path: string, timeoutMs: number): ProcessFileLock {
  const lockPath = `${path}.scip-query-write.lock`;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const result = tryAcquireProcessFileLock(lockPath, {
      kind: 'revisioned-file-mutation',
      detail: { target: path },
    });
    if (result.kind === 'acquired') return result.lock;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting to update ${path}; the file was left untouched.`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DEFAULT_LOCK_RETRY_MS);
  }
}

function commitMutation(
  path: string,
  mutation: Exclude<RevisionedTextMutation, { kind: 'unchanged' }>,
  revision: FileRevision,
): void {
  if (mutation.kind === 'delete') {
    if (!revision.exists) return;
    rmSync(path);
    syncDirectoryDurable(dirname(path));
    return;
  }
  const mode = mutation.mode ?? revision.identity?.mode;
  if (revision.exists) {
    replaceFileAtomic(path, mutation.text, { durability: 'durable', mode });
  } else {
    createFileAtomicExclusive(path, mutation.text, { durability: 'durable', mode });
  }
}

function sameRevision(left: FileRevision, right: FileRevision): boolean {
  return (
    left.exists === right.exists &&
    left.hash === right.hash &&
    (left.identity === undefined
      ? right.identity === undefined
      : right.identity !== undefined && sameIdentity(left.identity, right.identity))
  );
}

function identityFromStat(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.mode === right.mode
  );
}

function formatRevision(revision: FileRevision): string {
  return revision.exists ? revision.hash.slice(0, 12) : '<absent>';
}
