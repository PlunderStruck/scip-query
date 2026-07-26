import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireProcessFileLockAsync } from './repository-cache-lock.js';

/**
 * Shared download/checksum-verify/cache primitive behind `tla fetch-tools`
 * (src/tla/tool-runner.ts's tla2tools.jar fetch) and the Windows scip.exe
 * fetch. It belongs to the host-platform boundary because checksum validation,
 * filesystem installation, and network retrieval do not own TLA policy.
 */

export const VERIFIED_BINARY_FETCH_TIMEOUT_MS = 300_000;
export const VERIFIED_BINARY_FETCH_MAX_BYTES = 256 * 1024 * 1024;

// scip-query: ignore-twin — checksum helpers intentionally accept different binary input contracts.
export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Resolve `<cache-root>/<filename>` under the scip-query cache dir:
 * `$SCIP_QUERY_CACHE_DIR`, else `$XDG_CACHE_HOME/scip-query`, else
 * `~/.cache/scip-query`.
 */
export function resolveScipQueryCachePath(filename: string, env: NodeJS.ProcessEnv = process.env): string {
  const cacheRoot =
    env['SCIP_QUERY_CACHE_DIR'] ??
    (env['XDG_CACHE_HOME'] ? join(env['XDG_CACHE_HOME'], 'scip-query') : join(homedir(), '.cache', 'scip-query'));
  return join(cacheRoot, filename);
}

export interface VerifiedBinaryFetchOptions {
  /** Absolute path to cache the downloaded bytes at (and to check first). */
  cachePath: string;
  url: string;
  expectedSha256: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  lockWaitMs?: number;
  signal?: AbortSignal;
  /** Failure-injection seam; production uses node:fs.writeSync. */
  writeImpl?: typeof writeSync;
  /** Failure-injection seam; Slice 08 replaces this visibility-atomic promotion with durable promotion. */
  renameImpl?: typeof renameSync;
}

export interface VerifiedBinaryFetchResult {
  status: 'cached' | 'downloaded';
  path: string;
  sha256: string;
}

export type VerifiedBinaryFetchFailureKind =
  | 'aborted'
  | 'timeout'
  | 'lock-timeout'
  | 'http'
  | 'length'
  | 'stream'
  | 'checksum'
  | 'install';

export class VerifiedBinaryFetchError extends Error {
  constructor(
    readonly kind: VerifiedBinaryFetchFailureKind,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VerifiedBinaryFetchError';
  }
}

interface FetchLifetime {
  controller: AbortController;
  timeout: NodeJS.Timeout;
  detachExternalAbort(): void;
}

/**
 * Reuse a cache entry whose checksum matches, or serialize one bounded,
 * streamed download for the target path. The accepted bytes become visible by
 * atomic rename only after their declared/observed size and SHA-256 pass.
 */
export async function fetchVerifiedBinary(opts: VerifiedBinaryFetchOptions): Promise<VerifiedBinaryFetchResult> {
  const { cachePath, url, expectedSha256 } = opts;
  const timeoutMs = opts.timeoutMs ?? VERIFIED_BINARY_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? VERIFIED_BINARY_FETCH_MAX_BYTES;
  const lockWaitMs = opts.lockWaitMs ?? timeoutMs;
  validateBudgets(timeoutMs, maxBytes, lockWaitMs);
  const lifetime = createFetchLifetime(url, timeoutMs, opts.signal);

  try {
    const cached = await cachedDigest(cachePath, expectedSha256, maxBytes, lifetime.controller.signal);
    if (cached) return { status: 'cached', path: cachePath, sha256: cached };

    mkdirSync(dirname(cachePath), { recursive: true });
    const lock = await acquireProcessFileLockAsync(`${cachePath}.fetch.lock`, {
      waitMs: lockWaitMs,
      pollMs: 25,
      signal: lifetime.controller.signal,
    });
    if (!lock) {
      throw new VerifiedBinaryFetchError(
        'lock-timeout',
        `timed out waiting ${lockWaitMs}ms for verified binary cache ownership at ${cachePath}`,
      );
    }
    try {
      const rechecked = await cachedDigest(cachePath, expectedSha256, maxBytes, lifetime.controller.signal);
      if (rechecked) return { status: 'cached', path: cachePath, sha256: rechecked };
      return await downloadVerifiedBinary(opts, lifetime.controller, maxBytes);
    } finally {
      lock.release();
    }
  } catch (error) {
    if (lifetime.controller.signal.aborted) throw abortReason(lifetime.controller.signal, url);
    if (error instanceof VerifiedBinaryFetchError) throw error;
    throw new VerifiedBinaryFetchError('stream', `failed to download ${url}: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(lifetime.timeout);
    lifetime.detachExternalAbort();
    if (!lifetime.controller.signal.aborted) lifetime.controller.abort();
  }
}

function validateBudgets(timeoutMs: number, maxBytes: number, lockWaitMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive finite number.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer.');
  }
  if (!Number.isFinite(lockWaitMs) || lockWaitMs < 0) {
    throw new TypeError('lockWaitMs must be a non-negative finite number.');
  }
}

function createFetchLifetime(url: string, timeoutMs: number, externalSignal: AbortSignal | undefined): FetchLifetime {
  const controller = new AbortController();
  const onExternalAbort = (): void => {
    controller.abort(
      new VerifiedBinaryFetchError('aborted', `download of ${url} was aborted`, {
        cause: externalSignal?.reason,
      }),
    );
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  if (externalSignal?.aborted) onExternalAbort();
  const timeout = setTimeout(() => {
    controller.abort(new VerifiedBinaryFetchError('timeout', `download of ${url} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timeout.unref();
  return {
    controller,
    timeout,
    detachExternalAbort: () => externalSignal?.removeEventListener('abort', onExternalAbort),
  };
}

async function cachedDigest(
  cachePath: string,
  expectedSha256: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string | null> {
  if (!existsSync(cachePath)) return null;
  const digest = createHash('sha256');
  let observedBytes = 0;
  try {
    for await (const raw of createReadStream(cachePath, { signal })) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      observedBytes += chunk.length;
      if (observedBytes > maxBytes) return null;
      digest.update(chunk);
    }
  } catch {
    if (signal.aborted) throw abortReason(signal, cachePath);
    return null;
  }
  const actual = digest.digest('hex');
  return actual === expectedSha256 ? actual : null;
}

async function downloadVerifiedBinary(
  opts: VerifiedBinaryFetchOptions,
  controller: AbortController,
  maxBytes: number,
): Promise<VerifiedBinaryFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await raceWithAbort(fetchImpl(opts.url, { signal: controller.signal }), controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw abortReason(controller.signal, opts.url);
    throw new VerifiedBinaryFetchError('stream', `failed to download ${opts.url}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    const error = new VerifiedBinaryFetchError('http', `failed to download ${opts.url}: HTTP ${response.status}`);
    controller.abort(error);
    throw error;
  }

  const declaredBytes = declaredContentLength(response, maxBytes, opts.url);
  if (!response.body) {
    throw new VerifiedBinaryFetchError('stream', `downloaded ${opts.url} response has no readable body`);
  }

  const tmpPath = `${opts.cachePath}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  let stagingOwned = false;
  try {
    fd = openSync(tmpPath, 'wx', 0o600);
    stagingOwned = true;
    const reader = response.body.getReader();
    const digest = createHash('sha256');
    let observedBytes = 0;
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), controller.signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new VerifiedBinaryFetchError('stream', `downloaded ${opts.url} produced a non-byte stream chunk`);
      }
      observedBytes += value.byteLength;
      if (observedBytes > maxBytes || (declaredBytes !== undefined && observedBytes > declaredBytes)) {
        const error = new VerifiedBinaryFetchError(
          'length',
          `downloaded ${opts.url} exceeded its ${declaredBytes ?? maxBytes} byte limit`,
        );
        controller.abort(error);
        throw error;
      }
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      digest.update(chunk);
      writeChunk(fd, chunk, opts.writeImpl ?? writeSync);
    }
    if (declaredBytes !== undefined && observedBytes !== declaredBytes) {
      throw new VerifiedBinaryFetchError(
        'length',
        `downloaded ${opts.url} length mismatch: declared ${declaredBytes} bytes, received ${observedBytes}`,
      );
    }
    const actualSha256 = digest.digest('hex');
    if (actualSha256 !== opts.expectedSha256) {
      throw new VerifiedBinaryFetchError(
        'checksum',
        `downloaded ${opts.url} checksum mismatch: expected ${opts.expectedSha256}, got ${actualSha256}`,
      );
    }
    closeSync(fd);
    fd = undefined;
    try {
      (opts.renameImpl ?? renameSync)(tmpPath, opts.cachePath);
    } catch (error) {
      throw new VerifiedBinaryFetchError('install', `failed to install verified binary at ${opts.cachePath}`, {
        cause: error,
      });
    }
    stagingOwned = false;
    return { status: 'downloaded', path: opts.cachePath, sha256: actualSha256 };
  } catch (error) {
    if (controller.signal.aborted) throw abortReason(controller.signal, opts.url);
    if (error instanceof VerifiedBinaryFetchError) throw error;
    throw new VerifiedBinaryFetchError('install', `failed to stage verified binary at ${opts.cachePath}`, {
      cause: error,
    });
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The write failure may already have invalidated the descriptor.
      }
    }
    if (stagingOwned) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Only the random-token owner attempts cleanup; a prior failure may
        // already have removed the staging file.
      }
    }
  }
}

function declaredContentLength(response: Response, maxBytes: number, url: string): number | undefined {
  const raw = response.headers?.get('content-length');
  if (raw === null || raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new VerifiedBinaryFetchError('length', `downloaded ${url} has an invalid Content-Length header`);
  }
  const declared = Number(raw);
  if (!Number.isSafeInteger(declared) || declared < 0) {
    throw new VerifiedBinaryFetchError('length', `downloaded ${url} has an invalid Content-Length header`);
  }
  if (declared > maxBytes) {
    throw new VerifiedBinaryFetchError(
      'length',
      `downloaded ${url} declares ${declared} bytes, above the ${maxBytes} byte limit`,
    );
  }
  return declared;
}

function writeChunk(fd: number, chunk: Buffer, writeImpl: typeof writeSync): void {
  let offset = 0;
  while (offset < chunk.length) {
    const written = writeImpl(fd, chunk, offset, chunk.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0 || written > chunk.length - offset) {
      throw new Error('staging write did not make valid forward progress');
    }
    offset += written;
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal, 'operation'));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal, 'operation'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal, referent: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new VerifiedBinaryFetchError('aborted', `verified binary operation for ${referent} was aborted`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
