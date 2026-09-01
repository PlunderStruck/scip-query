import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, linkSync, rmSync, statSync } from 'node:fs';
import { platform } from 'node:os';

/** `link` shares the source inode: no bytes are rewritten, like a reflink. */
export type FileCloneMethod = 'reflink' | 'link' | 'copy';

export interface FileCloneResult {
  method: FileCloneMethod;
  bytes: number;
}

export interface FileCloneRuntime {
  size(path: string): number;
  clone(source: string, target: string): void;
  copy(source: string, target: string): void;
  /** Hard-link `source` at `target`; absent runtimes never share inodes. */
  link?(source: string, target: string): void;
  /** Remove `target` if present so no method writes through an existing inode. */
  remove?(target: string): void;
}

export interface FileCloneOptions {
  /**
   * The source is an immutable artifact (a cached SCIP shard, a published
   * generation file) that nothing opens for writing in place, so sharing its
   * inode with a hard link is as safe as a reflink and costs no bytes on
   * filesystems without copy-on-write. Never set this for a file that is
   * patched in place afterwards, such as a SQLite candidate.
   */
  shareImmutable?: boolean;
}

const NODE_FILE_CLONE_RUNTIME = Object.freeze<FileCloneRuntime>({
  size: (path) => statSync(path).size,
  clone: cloneFileOnHost,
  copy: (source, target) => copyFileSync(source, target),
  link: (source, target) => linkSync(source, target),
  remove: (target) => rmSync(target, { force: true }),
});

const LINK_UNAVAILABLE_CODES = new Set(['EXDEV', 'EPERM', 'EMLINK', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL']);

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
  options: FileCloneOptions = {},
): FileCloneResult {
  const bytes = runtime.size(source);
  // An existing target may be a hard link of an artifact another generation
  // still reads; every method below must create a new inode, never write
  // through the old one.
  runtime.remove?.(target);
  try {
    runtime.clone(source, target);
    return { method: 'reflink', bytes };
  } catch (error) {
    if (!reflinkUnavailable(error)) throw error;
  }
  if (options.shareImmutable && runtime.link) {
    try {
      runtime.link(source, target);
      return { method: 'link', bytes };
    } catch (error) {
      if (!linkUnavailable(error)) throw error;
    }
  }
  runtime.copy(source, target);
  return { method: 'copy', bytes };
}

function linkUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && LINK_UNAVAILABLE_CODES.has(code);
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
  // A hard link rewrites no bytes either; both count as shared, not copied.
  if (result.method === 'reflink' || result.method === 'link') telemetry.reflinkedBytes += result.bytes;
  else telemetry.fallbackCopiedBytes += result.bytes;
}

export function recordIncrementalWrite(telemetry: ReindexWriteTelemetry, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error('incremental write bytes must be a non-negative integer');
  telemetry.incrementalWrittenBytes = (telemetry.incrementalWrittenBytes ?? 0) + bytes;
}
