import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDirectorySyncUnsupported, writeFileCompletely } from '../filesystem/file-descriptor.js';
import {
  parseProcessIdentity,
  readProcessIdentity,
  sameProcessIdentity,
  type ProcessIdentity,
} from './process-identity.js';
import { isProcessAlive } from './process-liveness.js';
import { readSmallArtifactText } from './bounded-file.js';

export const PROCESS_FILE_LOCK_PROTOCOL = 'scip-query-process-lock';
export const PROCESS_FILE_LOCK_VERSION = 1;
/** @deprecated Complete candidate publication made malformed-record age recovery unsafe and unnecessary. */
export const PROCESS_FILE_LOCK_CREATION_GRACE_MS = 5_000;

export interface ProcessFileLockRecord {
  protocol: typeof PROCESS_FILE_LOCK_PROTOCOL;
  version: typeof PROCESS_FILE_LOCK_VERSION;
  kind: string;
  pid: number;
  token: string;
  processIdentity?: ProcessIdentity;
  startedAt: string;
  detail?: Record<string, unknown>;
}

export interface ProcessFileLockOwner {
  pid: number;
  processIdentity?: ProcessIdentity;
}

interface LockFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export type ProcessFileLockObservation =
  | {
      state: 'missing';
      raw?: never;
      identity?: never;
      record?: never;
      owner?: never;
      parsed?: never;
    }
  | {
      state: 'valid';
      raw: string;
      identity: LockFileIdentity;
      record: ProcessFileLockRecord;
      owner: ProcessFileLockOwner;
      parsed: unknown;
    }
  | {
      state: 'legacy';
      raw: string;
      identity: LockFileIdentity;
      record?: never;
      owner: ProcessFileLockOwner;
      parsed: unknown;
    }
  | {
      state: 'malformed';
      raw?: never;
      identity?: never;
      record?: never;
      owner?: never;
      parsed?: never;
    }
  | {
      state: 'malformed';
      raw: string;
      identity: LockFileIdentity;
      record?: never;
      owner?: never;
      parsed?: unknown;
    };

export interface ProcessFileLock {
  readonly path: string;
  readonly record: ProcessFileLockRecord;
  release(): boolean;
}

// scip-query: ignore-stale -- Capability port isolates process and filesystem effects for fault testing.
export interface ProcessFileLockRuntime {
  wallNow(): number;
  isProcessAlive(pid: number): boolean;
  readProcessIdentity(pid: number): ProcessIdentity | null;
  randomToken(): string;
  makeDirectory(path: string): void;
  openFile(path: string, flags: string, mode?: number): number;
  writeFile(fd: number, bytes: Buffer, offset: number, length: number): number;
  syncFile(fd: number): void;
  closeFile(fd: number): void;
  linkFile(existingPath: string, newPath: string): void;
  readFile(path: string): string;
  statFile(path: string): LockFileIdentity;
  removeFile(path: string): void;
}

export const NODE_PROCESS_FILE_LOCK_RUNTIME: ProcessFileLockRuntime = Object.freeze({
  wallNow: () => Date.now(),
  isProcessAlive,
  readProcessIdentity,
  randomToken: () => randomUUID(),
  makeDirectory: (path: string) => mkdirSync(path, { recursive: true }),
  openFile: (path: string, flags: string, mode?: number) => openSync(path, flags, mode),
  writeFile: (fd: number, bytes: Buffer, offset: number, length: number) => writeSync(fd, bytes, offset, length),
  syncFile: (fd: number) => fsyncSync(fd),
  closeFile: (fd: number) => closeSync(fd),
  linkFile: (existingPath: string, newPath: string) => linkSync(existingPath, newPath),
  readFile: (path: string) => readSmallArtifactText(path, 'process lock record'),
  statFile: (path: string) => {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  },
  removeFile: (path: string) => unlinkSync(path),
});

export type LegacyProcessLockDecoder = (value: unknown) => ProcessFileLockOwner | null;

export interface TryAcquireProcessFileLockOptions {
  kind: string;
  detail?: Record<string, unknown>;
  pid?: number;
  processIdentity?: ProcessIdentity | null;
  /** @deprecated Accepted for source compatibility; malformed public locks now fail closed. */
  creationGraceMs?: number;
  parseLegacy?: LegacyProcessLockDecoder;
  runtime?: ProcessFileLockRuntime;
}

export type TryAcquireProcessFileLockResult =
  | { kind: 'acquired'; lock: ProcessFileLock; reclaimed?: ProcessFileLockObservation }
  | { kind: 'contended'; observation: ProcessFileLockObservation };

/**
 * Attempts one exclusive lock acquisition. A stale, attributable owner is
 * reclaimed only while holding a token-owned reclaim guard and only after raw
 * bytes plus file identity still match. Malformed public records fail closed:
 * complete records are assembled privately before exclusive publication, so
 * civil-clock age is neither necessary nor sufficient reclamation evidence.
 */
export function tryAcquireProcessFileLock(
  path: string,
  options: TryAcquireProcessFileLockOptions,
): TryAcquireProcessFileLockResult {
  const runtime = options.runtime ?? NODE_PROCESS_FILE_LOCK_RUNTIME;
  runtime.makeDirectory(dirname(path));
  let reclaimed: ProcessFileLockObservation | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return {
        kind: 'acquired',
        lock: createOwnedLock(path, options, runtime),
        ...(reclaimed ? { reclaimed } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const observation = readProcessFileLock(path, {
        parseLegacy: options.parseLegacy,
        runtime,
      });
      if (
        attempt === 0 &&
        reclaimProcessFileLock(path, observation, {
          creationGraceMs: options.creationGraceMs,
          parseLegacy: options.parseLegacy,
          runtime,
        })
      ) {
        reclaimed = observation;
        continue;
      }
      return { kind: 'contended', observation };
    }
  }
  return {
    kind: 'contended',
    observation: readProcessFileLock(path, { parseLegacy: options.parseLegacy, runtime }),
  };
}

export function readProcessFileLock(
  path: string,
  options: { parseLegacy?: LegacyProcessLockDecoder; runtime?: ProcessFileLockRuntime } = {},
): ProcessFileLockObservation {
  const runtime = options.runtime ?? NODE_PROCESS_FILE_LOCK_RUNTIME;
  let identity: LockFileIdentity;
  let raw: string;
  try {
    identity = runtime.statFile(path);
    raw = runtime.readFile(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'malformed' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { state: 'malformed', raw, identity };
  }
  const record = parseProcessFileLockRecord(parsed);
  if (record) return { state: 'valid', raw, identity, record, owner: ownerFromRecord(record), parsed };
  const owner = options.parseLegacy?.(parsed) ?? null;
  if (owner) return { state: 'legacy', raw, identity, owner, parsed };
  return { state: 'malformed', raw, identity, parsed };
}

export function parseProcessFileLockRecord(value: unknown): ProcessFileLockRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Partial<ProcessFileLockRecord>;
  if (
    parsed.protocol !== PROCESS_FILE_LOCK_PROTOCOL ||
    parsed.version !== PROCESS_FILE_LOCK_VERSION ||
    typeof parsed.kind !== 'string' ||
    parsed.kind.trim() === '' ||
    typeof parsed.pid !== 'number' ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.token !== 'string' ||
    parsed.token.trim() === '' ||
    typeof parsed.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.startedAt)) ||
    (parsed.detail !== undefined &&
      (typeof parsed.detail !== 'object' || parsed.detail === null || Array.isArray(parsed.detail)))
  ) {
    return null;
  }
  const processIdentity = parsed.processIdentity === undefined ? null : parseProcessIdentity(parsed.processIdentity);
  if (parsed.processIdentity !== undefined && (!processIdentity || processIdentity.pid !== parsed.pid)) return null;
  return {
    protocol: PROCESS_FILE_LOCK_PROTOCOL,
    version: PROCESS_FILE_LOCK_VERSION,
    kind: parsed.kind,
    pid: parsed.pid,
    token: parsed.token,
    ...(processIdentity ? { processIdentity } : {}),
    startedAt: parsed.startedAt,
    ...(parsed.detail ? { detail: parsed.detail } : {}),
  };
}

export function reclaimProcessFileLock(
  path: string,
  observed: ProcessFileLockObservation,
  options: {
    creationGraceMs?: number;
    parseLegacy?: LegacyProcessLockDecoder;
    runtime?: ProcessFileLockRuntime;
  } = {},
): boolean {
  const runtime = options.runtime ?? NODE_PROCESS_FILE_LOCK_RUNTIME;
  if (!isReclaimable(observed, runtime)) return false;
  const guard = acquireReclaimGuard(`${path}.reclaim`, runtime);
  if (!guard) return false;
  try {
    const current = readProcessFileLock(path, { parseLegacy: options.parseLegacy, runtime });
    if (!sameObservation(observed, current) || !isReclaimable(current, runtime)) return false;
    return removeLockFile(path, runtime);
  } finally {
    guard.release();
  }
}

function createOwnedLock(
  path: string,
  options: TryAcquireProcessFileLockOptions,
  runtime: ProcessFileLockRuntime,
): ProcessFileLock {
  const pid = options.pid ?? process.pid;
  const token = runtime.randomToken();
  const processIdentity =
    options.processIdentity === undefined ? runtime.readProcessIdentity(pid) : options.processIdentity;
  const record: ProcessFileLockRecord = {
    protocol: PROCESS_FILE_LOCK_PROTOCOL,
    version: PROCESS_FILE_LOCK_VERSION,
    kind: options.kind,
    pid,
    token,
    ...(processIdentity ? { processIdentity } : {}),
    startedAt: new Date(runtime.wallNow()).toISOString(),
    ...(options.detail ? { detail: options.detail } : {}),
  };
  const candidatePath = `${path}.${token}.candidate`;
  const fd = runtime.openFile(candidatePath, 'wx', 0o600);
  let publicationError: unknown;
  try {
    writeFileCompletely(fd, Buffer.from(`${JSON.stringify(record)}\n`), runtime, 'process lock');
    runtime.syncFile(fd);
  } catch (error) {
    publicationError = error;
  }
  try {
    runtime.closeFile(fd);
  } catch (error) {
    publicationError ??= error;
  }
  if (publicationError !== undefined) {
    removeCandidateFile(candidatePath, runtime);
    throw publicationError;
  }
  try {
    // Hard-link publication is exclusive on every supported platform: it
    // cannot replace an existing owner, and the public name never exposes the
    // candidate's partially written bytes.
    runtime.linkFile(candidatePath, path);
  } catch (error) {
    removeCandidateFile(candidatePath, runtime);
    throw error;
  }
  removeCandidateFile(candidatePath, runtime);
  try {
    syncLockDirectory(dirname(path), runtime);
  } catch (error) {
    releaseOwnedProcessFileLock(path, record, runtime);
    throw error;
  }
  let released = false;
  return {
    path,
    record,
    release: () => {
      if (released) return false;
      released = true;
      return releaseOwnedProcessFileLock(path, record, runtime);
    },
  };
}

export function releaseOwnedProcessFileLock(
  path: string,
  expected: Pick<ProcessFileLockRecord, 'pid' | 'token' | 'processIdentity'>,
  runtime: ProcessFileLockRuntime = NODE_PROCESS_FILE_LOCK_RUNTIME,
): boolean {
  const current = readProcessFileLock(path, { runtime });
  if (current.state !== 'valid' || !current.record) return false;
  if (current.record.pid !== expected.pid || current.record.token !== expected.token) return false;
  if (
    expected.processIdentity &&
    (!current.record.processIdentity || !sameProcessIdentity(expected.processIdentity, current.record.processIdentity))
  ) {
    return false;
  }
  return removeLockFile(path, runtime);
}

function acquireReclaimGuard(path: string, runtime: ProcessFileLockRuntime): ProcessFileLock | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return createOwnedLock(path, { kind: 'reclaim-guard', runtime }, runtime);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const observed = readProcessFileLock(path, { runtime });
      if (attempt > 0 || !isReclaimable(observed, runtime)) return null;
      const current = readProcessFileLock(path, { runtime });
      if (!sameObservation(observed, current)) return null;
      if (!removeLockFile(path, runtime)) return null;
    }
  }
  return null;
}

function isReclaimable(observed: ProcessFileLockObservation, runtime: ProcessFileLockRuntime): boolean {
  if (observed.state === 'missing') return false;
  if (observed.owner) {
    if (!runtime.isProcessAlive(observed.owner.pid)) return true;
    if (!observed.owner.processIdentity) return false;
    const current = runtime.readProcessIdentity(observed.owner.pid);
    return current !== null && !sameProcessIdentity(observed.owner.processIdentity, current);
  }
  return false;
}

function sameObservation(left: ProcessFileLockObservation, right: ProcessFileLockObservation): boolean {
  return (
    left.state === right.state &&
    left.raw === right.raw &&
    left.identity !== undefined &&
    right.identity !== undefined &&
    left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino &&
    left.identity.size === right.identity.size &&
    left.identity.mtimeMs === right.identity.mtimeMs
  );
}

function ownerFromRecord(record: ProcessFileLockRecord): ProcessFileLockOwner {
  return {
    pid: record.pid,
    ...(record.processIdentity ? { processIdentity: record.processIdentity } : {}),
  };
}

function syncLockDirectory(path: string, runtime: ProcessFileLockRuntime): void {
  let fd: number;
  try {
    fd = runtime.openFile(path, 'r');
  } catch (error) {
    if (isDirectorySyncUnsupported(error, process.platform)) return;
    throw error;
  }
  try {
    runtime.syncFile(fd);
  } catch (error) {
    if (!isDirectorySyncUnsupported(error, process.platform)) throw error;
  } finally {
    runtime.closeFile(fd);
  }
}

function removeLockFile(path: string, runtime: ProcessFileLockRuntime): boolean {
  try {
    runtime.removeFile(path);
    syncLockDirectory(dirname(path), runtime);
    return true;
  } catch {
    return false;
  }
}

function removeCandidateFile(path: string, runtime: ProcessFileLockRuntime): void {
  try {
    runtime.removeFile(path);
  } catch {
    // A candidate name is unique and never consulted for ownership. Leaving a
    // private orphan is safer than deleting or weakening a published owner.
  }
}
