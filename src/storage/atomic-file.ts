import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  ensureDirectoryDurable,
  mergeDirectorySyncStatus,
  syncDirectoryDurable,
  type DirectoryDurabilityRuntime,
  type DirectorySyncStatus,
} from '../filesystem/durable-path.js';
import { writeFileCompletely } from '../filesystem/file-descriptor.js';

export type AtomicFileDurability = 'visibility' | 'durable';
export type AchievedFileDurability = 'visibility' | 'file-flushed' | 'directory-durable';
export type { DirectoryDurabilityRuntime, DirectorySyncStatus } from '../filesystem/durable-path.js';

export interface AtomicFileWriteResult {
  requestedDurability: AtomicFileDurability;
  achievedDurability: AchievedFileDurability;
  directorySync: DirectorySyncStatus;
}

export interface AtomicFileRuntime extends DirectoryDurabilityRuntime {
  randomToken(): string;
  writeFile(fd: number, bytes: Buffer, offset: number, length: number): number;
  renameFile(source: string, target: string): void;
  linkFile?(source: string, target: string): void;
  removeFile(path: string): void;
}

export const NODE_ATOMIC_FILE_RUNTIME: AtomicFileRuntime = Object.freeze({
  platform: process.platform,
  randomToken: () => randomUUID(),
  pathExists: (path: string) => existsSync(path),
  makeDirectory: (path: string) => mkdirSync(path, { recursive: true }),
  openFile: (path: string, flags: string, mode?: number) => openSync(path, flags, mode),
  writeFile: (fd: number, bytes: Buffer, offset: number, length: number) => writeSync(fd, bytes, offset, length),
  syncFile: (fd: number) => fsyncSync(fd),
  closeFile: (fd: number) => closeSync(fd),
  renameFile: (source: string, target: string) => renameSync(source, target),
  linkFile: (source: string, target: string) => linkSync(source, target),
  removeFile: (path: string) => unlinkSync(path),
});

export interface ReplaceFileAtomicOptions {
  durability?: AtomicFileDurability;
  mode?: number;
  runtime?: AtomicFileRuntime;
}

/**
 * Replaces one file through an exclusive random-token staging path. Visibility
 * mode guarantees old-or-new complete bytes to concurrent readers. Durable
 * mode additionally flushes the staged file and, where the host supports it,
 * the containing directory entry before reporting success.
 */
export function replaceFileAtomic(
  targetPath: string,
  bytes: string | Buffer,
  options: ReplaceFileAtomicOptions = {},
): AtomicFileWriteResult {
  const durability = options.durability ?? 'visibility';
  const runtime = options.runtime ?? NODE_ATOMIC_FILE_RUNTIME;
  const parentDirectory = dirname(targetPath);
  const parentSync =
    durability === 'durable'
      ? ensureDirectoryDurable(parentDirectory, runtime)
      : (runtime.makeDirectory(parentDirectory), 'not-requested');
  const temporaryPath = `${targetPath}.tmp-${runtime.randomToken()}`;
  const payload = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  let fd: number | undefined;
  let temporaryOwned = false;
  try {
    fd = runtime.openFile(temporaryPath, 'wx', options.mode ?? 0o600);
    temporaryOwned = true;
    writeFileCompletely(fd, payload, runtime, 'atomic file');
    if (durability === 'durable') runtime.syncFile(fd);
    runtime.closeFile(fd);
    fd = undefined;
    runtime.renameFile(temporaryPath, targetPath);
    temporaryOwned = false;
    const directorySync =
      durability === 'durable'
        ? mergeDirectorySyncStatus(parentSync, syncDirectoryDurable(parentDirectory, runtime))
        : 'not-requested';
    return atomicFileWriteResult(durability, directorySync);
  } finally {
    if (fd !== undefined) {
      try {
        runtime.closeFile(fd);
      } catch {
        // Preserve the primary write/sync error; owned staging cleanup below
        // still attempts to remove the incomplete file.
      }
    }
    if (temporaryOwned) {
      try {
        runtime.removeFile(temporaryPath);
      } catch {
        // Only the random-token owner removes this path. A failed create or
        // injected filesystem fault may mean no owned path remains.
      }
    }
  }
}

/**
 * Publishes complete bytes only when the target does not exist. The staged
 * inode is flushed before an exclusive hard-link creates the public name, so
 * competing creators cannot replace one another and readers never observe a
 * partially written first version.
 */
export function createFileAtomicExclusive(
  targetPath: string,
  bytes: string | Buffer,
  options: ReplaceFileAtomicOptions = {},
): AtomicFileWriteResult {
  const durability = options.durability ?? 'visibility';
  const runtime = options.runtime ?? NODE_ATOMIC_FILE_RUNTIME;
  if (!runtime.linkFile) {
    throw new Error('Exclusive atomic file publication requires hard-link support.');
  }
  const parentDirectory = dirname(targetPath);
  const parentSync =
    durability === 'durable'
      ? ensureDirectoryDurable(parentDirectory, runtime)
      : (runtime.makeDirectory(parentDirectory), 'not-requested');
  const temporaryPath = `${targetPath}.tmp-${runtime.randomToken()}`;
  const payload = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  let fd: number | undefined;
  let temporaryOwned = false;
  try {
    fd = runtime.openFile(temporaryPath, 'wx', options.mode ?? 0o600);
    temporaryOwned = true;
    writeFileCompletely(fd, payload, runtime, 'exclusive atomic file');
    if (durability === 'durable') runtime.syncFile(fd);
    runtime.closeFile(fd);
    fd = undefined;
    runtime.linkFile(temporaryPath, targetPath);
    const publicationDirectorySync =
      durability === 'durable' ? syncDirectoryDurable(parentDirectory, runtime) : 'not-requested';
    runtime.removeFile(temporaryPath);
    temporaryOwned = false;
    const directorySync =
      durability === 'durable'
        ? mergeDirectorySyncStatus(parentSync, publicationDirectorySync, syncDirectoryDurable(parentDirectory, runtime))
        : 'not-requested';
    return atomicFileWriteResult(durability, directorySync);
  } finally {
    if (fd !== undefined) {
      try {
        runtime.closeFile(fd);
      } catch {
        // Preserve the primary write/sync error.
      }
    }
    if (temporaryOwned) {
      try {
        runtime.removeFile(temporaryPath);
      } catch {
        // Only the random-token owner removes this path.
      }
    }
  }
}

function atomicFileWriteResult(
  requestedDurability: AtomicFileDurability,
  directorySync: DirectorySyncStatus,
): AtomicFileWriteResult {
  return {
    requestedDurability,
    achievedDurability:
      requestedDurability === 'visibility'
        ? 'visibility'
        : directorySync === 'synced'
          ? 'directory-durable'
          : 'file-flushed',
    directorySync,
  };
}

export { ensureDirectoryDurable, mergeDirectorySyncStatus, syncDirectoryDurable } from '../filesystem/durable-path.js';
export {
  cloneFileDurable,
  NODE_DURABLE_FILE_CLONE_RUNTIME,
  type DurableFileCloneOptions,
  type DurableFileCloneRuntime,
} from '../filesystem/durable-file.js';
