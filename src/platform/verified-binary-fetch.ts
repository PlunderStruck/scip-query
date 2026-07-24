import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Shared download/checksum-verify/cache primitive behind `tla fetch-tools`
 * (src/tla/tool-runner.ts's tla2tools.jar fetch) and the Windows scip.exe
 * fetch. It belongs to the host-platform boundary because checksum validation,
 * filesystem installation, and network retrieval do not own TLA policy.
 */

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
}

export interface VerifiedBinaryFetchResult {
  status: 'cached' | 'downloaded';
  path: string;
  sha256: string;
}

/**
 * Reuse a cached file whose sha256 still matches; otherwise fetch, verify
 * the checksum, and atomically rename a temp file into place. Throws on a
 * non-OK response or a checksum mismatch — callers decide how to surface
 * that (e.g. an actionable "run X to fetch" message).
 */
export async function fetchVerifiedBinary(opts: VerifiedBinaryFetchOptions): Promise<VerifiedBinaryFetchResult> {
  const { cachePath, url, expectedSha256 } = opts;
  if (existsSync(cachePath)) {
    const existingHash = sha256(readFileSync(cachePath));
    if (existingHash === expectedSha256) {
      return { status: 'cached', path: cachePath, sha256: existingHash };
    }
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== expectedSha256) {
    throw new Error(`downloaded ${url} checksum mismatch: expected ${expectedSha256}, got ${digest}`);
  }

  mkdirSync(dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, bytes);
  renameSync(tmpPath, cachePath);
  return { status: 'downloaded', path: cachePath, sha256: digest };
}
