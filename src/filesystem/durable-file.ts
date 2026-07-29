import { chmodSync, constants, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ensureDirectoryDurable,
  mergeDirectorySyncStatus,
  NODE_DIRECTORY_DURABILITY_RUNTIME,
  syncDirectoryDurable,
  type DirectoryDurabilityRuntime,
  type DirectorySyncStatus,
} from './durable-path.js';

export interface DurableFileCloneRuntime extends DirectoryDurabilityRuntime {
  copyFile(source: string, target: string): void;
  chmodFile(path: string, mode: number): void;
}

export const NODE_DURABLE_FILE_CLONE_RUNTIME: DurableFileCloneRuntime = Object.freeze({
  ...NODE_DIRECTORY_DURABILITY_RUNTIME,
  copyFile: (source: string, target: string) => copyFileSync(source, target, constants.COPYFILE_FICLONE),
  chmodFile: (path: string, mode: number) => chmodSync(path, mode),
});

export interface DurableFileCloneOptions {
  mode?: number;
  runtime?: DurableFileCloneRuntime;
}

/**
 * Copies one file into its final bytes and metadata, flushes that inode, then
 * persists the target name. The returned directory status is the strongest
 * namespace guarantee the host established.
 */
export function cloneFileDurable(
  source: string,
  target: string,
  options: DurableFileCloneOptions = {},
): Exclude<DirectorySyncStatus, 'not-requested'> {
  const runtime = options.runtime ?? NODE_DURABLE_FILE_CLONE_RUNTIME;
  const parent = dirname(target);
  const parentSync = ensureDirectoryDurable(parent, runtime);
  runtime.copyFile(source, target);
  if (options.mode !== undefined) runtime.chmodFile(target, options.mode);
  const fd = runtime.openFile(target, 'r');
  try {
    runtime.syncFile(fd);
  } finally {
    runtime.closeFile(fd);
  }
  return mergeDirectorySyncStatus(parentSync, syncDirectoryDurable(parent, runtime));
}
