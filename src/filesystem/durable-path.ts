import { closeSync, existsSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDirectorySyncUnsupported } from './file-descriptor.js';

export type DirectorySyncStatus = 'not-requested' | 'synced' | 'unsupported';

export interface DirectoryDurabilityRuntime {
  platform: NodeJS.Platform;
  pathExists(path: string): boolean;
  makeDirectory(path: string): void;
  openFile(path: string, flags: string, mode?: number): number;
  syncFile(fd: number): void;
  closeFile(fd: number): void;
}

export const NODE_DIRECTORY_DURABILITY_RUNTIME: DirectoryDurabilityRuntime = Object.freeze({
  platform: process.platform,
  pathExists: (path: string) => existsSync(path),
  makeDirectory: (path: string) => mkdirSync(path, { recursive: true }),
  openFile: (path: string, flags: string, mode?: number) => openSync(path, flags, mode),
  syncFile: (fd: number) => fsyncSync(fd),
  closeFile: (fd: number) => closeSync(fd),
});

/**
 * Creates a directory path and persists every newly introduced name where the
 * host exposes directory synchronization. A raced creator is harmless: this
 * writer still synchronizes the directory containing the raced name.
 */
export function ensureDirectoryDurable(
  path: string,
  runtime: DirectoryDurabilityRuntime = NODE_DIRECTORY_DURABILITY_RUNTIME,
): Exclude<DirectorySyncStatus, 'not-requested'> {
  const missing: string[] = [];
  let current = path;
  while (!runtime.pathExists(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Cannot establish a durable directory path without an existing ancestor: ${path}`);
    }
    current = parent;
  }

  let result: Exclude<DirectorySyncStatus, 'not-requested'> = 'synced';
  for (const directory of missing.reverse()) {
    runtime.makeDirectory(directory);
    result = mergeDirectorySyncStatus(result, syncDirectoryDurable(dirname(directory), runtime));
  }
  return result;
}

/**
 * Flushes one directory's namespace when the host exposes that primitive.
 * Unsupported Windows directory handles produce an explicit bounded result;
 * every other error remains an operational failure.
 */
export function syncDirectoryDurable(
  path: string,
  runtime: DirectoryDurabilityRuntime = NODE_DIRECTORY_DURABILITY_RUNTIME,
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
  } catch (error) {
    try {
      runtime.closeFile(fd);
    } catch {
      // Preserve the synchronization failure that determines durability.
    }
    if (isDirectorySyncUnsupported(error, runtime.platform)) return 'unsupported';
    throw error;
  }
  runtime.closeFile(fd);
  return 'synced';
}

export function mergeDirectorySyncStatus(
  ...statuses: readonly Exclude<DirectorySyncStatus, 'not-requested'>[]
): Exclude<DirectorySyncStatus, 'not-requested'>;
export function mergeDirectorySyncStatus(...statuses: readonly DirectorySyncStatus[]): DirectorySyncStatus;
export function mergeDirectorySyncStatus(...statuses: readonly DirectorySyncStatus[]): DirectorySyncStatus {
  if (statuses.every((status) => status === 'not-requested')) return 'not-requested';
  return statuses.includes('unsupported') ? 'unsupported' : 'synced';
}
