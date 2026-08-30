import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, statSync } from 'node:fs';
import { platform } from 'node:os';

export type FileCloneMethod = 'reflink' | 'copy';

export interface FileCloneResult {
  method: FileCloneMethod;
  bytes: number;
}

export interface FileCloneRuntime {
  size(path: string): number;
  clone(source: string, target: string): void;
  copy(source: string, target: string): void;
}

const NODE_FILE_CLONE_RUNTIME = Object.freeze<FileCloneRuntime>({
  size: (path) => statSync(path).size,
  clone: cloneFileOnHost,
  copy: (source, target) => copyFileSync(source, target),
});

const REFLINK_UNAVAILABLE_CODES = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL', 'EXDEV', 'ENOTTY']);

/**
 * Clone a staging artifact without rewriting its payload when the filesystem
 * supports copy-on-write. Only capability failures authorize a byte-copy
 * fallback; permission and I/O failures remain real failures.
 */
export function cloneFileWithFallback(
  source: string,
  target: string,
  runtime: FileCloneRuntime = NODE_FILE_CLONE_RUNTIME,
): FileCloneResult {
  const bytes = runtime.size(source);
  try {
    runtime.clone(source, target);
    return { method: 'reflink', bytes };
  } catch (error) {
    if (!reflinkUnavailable(error)) throw error;
  }
  runtime.copy(source, target);
  return { method: 'copy', bytes };
}

function cloneFileOnHost(source: string, target: string): void {
  if (platform() !== 'darwin') {
    copyFileSync(source, target, constants.COPYFILE_FICLONE_FORCE);
    return;
  }
  try {
    // Node/libuv reports COPYFILE_FICLONE_FORCE as ENOSYS on macOS even on
    // APFS. macOS cp -c calls clonefile(2) and fails instead of silently
    // falling back, which preserves both the disk-saving behavior and honest
    // telemetry.
    execFileSync('/bin/cp', ['-c', source, target], {
      timeout: 60_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    throw classifyDarwinCloneFailure(error);
  }
}

function classifyDarwinCloneFailure(error: unknown): unknown {
  const stderr = (error as { stderr?: Buffer | string } | undefined)?.stderr;
  const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : (stderr ?? '');
  if (/operation not supported|not supported/i.test(detail)) {
    return Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'ENOTSUP' });
  }
  if (/cross-device link/i.test(detail)) {
    return Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'EXDEV' });
  }
  return error;
}

export function reflinkUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && REFLINK_UNAVAILABLE_CODES.has(code);
}

export interface ReindexWriteTelemetry {
  reflinkedBytes: number;
  fallbackCopiedBytes: number;
  /** Conservative physical bytes written by bounded incremental database work. */
  incrementalWrittenBytes?: number;
}

export function createReindexWriteTelemetry(): ReindexWriteTelemetry {
  return { reflinkedBytes: 0, fallbackCopiedBytes: 0, incrementalWrittenBytes: 0 };
}

export function recordFileClone(telemetry: ReindexWriteTelemetry, result: FileCloneResult): void {
  if (result.method === 'reflink') telemetry.reflinkedBytes += result.bytes;
  else telemetry.fallbackCopiedBytes += result.bytes;
}

export function recordIncrementalWrite(telemetry: ReindexWriteTelemetry, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error('incremental write bytes must be a non-negative integer');
  telemetry.incrementalWrittenBytes = (telemetry.incrementalWrittenBytes ?? 0) + bytes;
}
