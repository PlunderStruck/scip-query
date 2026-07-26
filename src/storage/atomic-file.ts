import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDirectorySyncUnsupported, writeFileCompletely } from '../filesystem/file-descriptor.js';

export type AtomicFileDurability = 'visibility' | 'durable';
export type DirectorySyncStatus = 'not-requested' | 'synced' | 'unsupported';

export interface AtomicFileWriteResult {
  durability: AtomicFileDurability;
  directorySync: DirectorySyncStatus;
}

export interface AtomicFileRuntime {
  platform: NodeJS.Platform;
  randomToken(): string;
  makeDirectory(path: string): void;
  openFile(path: string, flags: string, mode?: number): number;
  writeFile(fd: number, bytes: Buffer, offset: number, length: number): number;
  syncFile(fd: number): void;
  closeFile(fd: number): void;
  renameFile(source: string, target: string): void;
  removeFile(path: string): void;
}

export const NODE_ATOMIC_FILE_RUNTIME: AtomicFileRuntime = Object.freeze({
  platform: process.platform,
  randomToken: () => randomUUID(),
  makeDirectory: (path: string) => mkdirSync(path, { recursive: true }),
  openFile: (path: string, flags: string, mode?: number) => openSync(path, flags, mode),
  writeFile: (fd: number, bytes: Buffer, offset: number, length: number) => writeSync(fd, bytes, offset, length),
  syncFile: (fd: number) => fsyncSync(fd),
  closeFile: (fd: number) => closeSync(fd),
  renameFile: (source: string, target: string) => renameSync(source, target),
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
  runtime.makeDirectory(parentDirectory);
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
    return {
      durability,
      directorySync: durability === 'durable' ? syncDirectoryDurable(parentDirectory, runtime) : 'not-requested',
    };
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
 * Flushes a directory entry when the host exposes that durability primitive.
 * Storage publishers share this boundary so platform-specific unsupported
 * errors are classified consistently.
 */
export function syncDirectoryDurable(
  path: string,
  runtime: AtomicFileRuntime = NODE_ATOMIC_FILE_RUNTIME,
): Exclude<DirectorySyncStatus, 'not-requested'> {
  let fd: number;
  try {
    fd = runtime.openFile(path, 'r');
  } catch (error) {
    if (isDirectorySyncUnsupported(error, runtime.platform)) return 'unsupported';
    throw error;
  }
  try {
    runtime.syncFile(fd);
    return 'synced';
  } catch (error) {
    if (isDirectorySyncUnsupported(error, runtime.platform)) return 'unsupported';
    throw error;
  } finally {
    runtime.closeFile(fd);
  }
}
