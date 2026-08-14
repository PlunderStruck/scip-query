import { closeSync, existsSync, openSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readFileWithinLimit } from './bounded-file.js';
import { resolveCacheDirPath } from './cache-layout.js';
import { writeFileCompletely } from '../filesystem/file-descriptor.js';

export const FINGERPRINT_STAT_CACHE_FILE = 'fingerprint-stat-cache.json';
export const FINGERPRINT_STAT_CACHE_VERSION = 1 as const;
const FINGERPRINT_STAT_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface FileStatIdentity {
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}

export type FingerprintStatKind = 'file' | 'symlink';

export interface FingerprintStatRecord extends FileStatIdentity {
  kind: FingerprintStatKind;
  hash: string;
  fingerprintSize: number;
}

interface FingerprintStatCacheFile {
  version: typeof FINGERPRINT_STAT_CACHE_VERSION;
  files: Record<string, FingerprintStatRecord>;
}

interface ProjectFingerprintStatCache {
  cachePath: string | null;
  files: Map<string, FingerprintStatRecord>;
  dirty: boolean;
  hits: number;
  stores: number;
}

const projectCaches = new Map<string, ProjectFingerprintStatCache>();

/**
 * Reuse a content hash when the same path still has the same inode, size,
 * mtime, and ctime. Content bytes are hashed only after that identity changes.
 * ctime catches `cp -p` overwrites that preserve mtime.
 */
export function lookupProjectFileFingerprint(
  projectRoot: string,
  relativePath: string,
  kind: FingerprintStatKind,
  stats: FileStatIdentity,
): { hash: string; size: number } | undefined {
  const cache = projectFingerprintStatCache(projectRoot);
  const record = cache.files.get(relativePath);
  if (!record || !sameFingerprintStatIdentity(record, kind, stats)) return undefined;
  cache.hits += 1;
  return { hash: record.hash, size: record.fingerprintSize };
}

export function rememberProjectFileFingerprint(
  projectRoot: string,
  relativePath: string,
  kind: FingerprintStatKind,
  stats: FileStatIdentity,
  fingerprint: { hash: string; size: number },
): void {
  if (fingerprint.hash === 'unreadable' || fingerprint.size < 0 || !Number.isFinite(fingerprint.size)) return;
  const cache = projectFingerprintStatCache(projectRoot);
  const next: FingerprintStatRecord = {
    kind,
    dev: stats.dev,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    size: stats.size,
    hash: fingerprint.hash,
    fingerprintSize: fingerprint.size,
  };
  const previous = cache.files.get(relativePath);
  if (previous && sameFingerprintStatRecord(previous, next)) return;
  cache.files.set(relativePath, next);
  cache.stores += 1;
  cache.dirty = true;
}

export function persistProjectFileFingerprintCache(projectRoot: string): void {
  const cache = projectCaches.get(canonicalProjectRoot(projectRoot));
  if (!cache?.dirty || !cache.cachePath) return;
  try {
    const directory = dirname(cache.cachePath);
    if (!existsSync(directory)) return;
    writeFingerprintStatCacheFile(cache.cachePath, serializeFingerprintStatCache(cache));
    cache.dirty = false;
  } catch {
    // Best-effort: a missed persist still leaves the in-process cache correct.
  }
}

export function projectFileFingerprintCacheStats(projectRoot: string): { hits: number; stores: number; size: number } {
  const cache = projectCaches.get(canonicalProjectRoot(projectRoot));
  if (!cache) return { hits: 0, stores: 0, size: 0 };
  return { hits: cache.hits, stores: cache.stores, size: cache.files.size };
}

export function resetProjectFileFingerprintCacheForTest(projectRoot?: string): void {
  if (projectRoot === undefined) {
    projectCaches.clear();
    return;
  }
  projectCaches.delete(canonicalProjectRoot(projectRoot));
}

function projectFingerprintStatCache(projectRoot: string): ProjectFingerprintStatCache {
  const canonicalRoot = canonicalProjectRoot(projectRoot);
  const existing = projectCaches.get(canonicalRoot);
  if (existing) return existing;

  const cachePath = fingerprintStatCachePath(canonicalRoot);
  const files = loadFingerprintStatCache(cachePath);
  const created: ProjectFingerprintStatCache = {
    cachePath,
    files,
    dirty: false,
    hits: 0,
    stores: 0,
  };
  projectCaches.set(canonicalRoot, created);
  return created;
}

function fingerprintStatCachePath(canonicalRoot: string): string | null {
  try {
    const cacheDir = resolveCacheDirPath(canonicalRoot);
    // Never create a cache namespace just to persist hashes. Watch and reindex
    // already own that directory; tests and one-shot fingerprints stay in memory.
    if (!existsSync(cacheDir)) return null;
    return join(cacheDir, FINGERPRINT_STAT_CACHE_FILE);
  } catch {
    return null;
  }
}

function loadFingerprintStatCache(cachePath: string | null): Map<string, FingerprintStatRecord> {
  const files = new Map<string, FingerprintStatRecord>();
  if (!cachePath || !existsSync(cachePath)) return files;
  try {
    const parsed = JSON.parse(
      readFileWithinLimit(cachePath, {
        inputKind: 'fingerprint stat cache',
        maxBytes: FINGERPRINT_STAT_CACHE_MAX_BYTES,
      }).toString('utf8'),
    ) as unknown;
    if (!isFingerprintStatCacheFile(parsed)) return files;
    for (const [path, record] of Object.entries(parsed.files)) {
      if (record) files.set(path, record);
    }
  } catch {
    return files;
  }
  return files;
}

function serializeFingerprintStatCache(cache: ProjectFingerprintStatCache): FingerprintStatCacheFile {
  return {
    version: FINGERPRINT_STAT_CACHE_VERSION,
    files: Object.fromEntries(cache.files),
  };
}

function isFingerprintStatCacheFile(value: unknown): value is FingerprintStatCacheFile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate['version'] !== FINGERPRINT_STAT_CACHE_VERSION) return false;
  if (typeof candidate['files'] !== 'object' || candidate['files'] === null) return false;
  return Object.values(candidate['files'] as Record<string, unknown>).every(isFingerprintStatRecord);
}

function isFingerprintStatRecord(value: unknown): value is FingerprintStatRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record['kind'] === 'file' || record['kind'] === 'symlink') &&
    Number.isFinite(record['dev']) &&
    Number.isFinite(record['ino']) &&
    Number.isFinite(record['mtimeMs']) &&
    Number.isFinite(record['ctimeMs']) &&
    Number.isFinite(record['size']) &&
    Number.isFinite(record['fingerprintSize']) &&
    typeof record['hash'] === 'string' &&
    record['hash'] !== 'unreadable'
  );
}

function sameFingerprintStatIdentity(
  record: FingerprintStatRecord,
  kind: FingerprintStatKind,
  stats: FileStatIdentity,
): boolean {
  return (
    record.kind === kind &&
    record.dev === stats.dev &&
    record.ino === stats.ino &&
    record.mtimeMs === stats.mtimeMs &&
    record.ctimeMs === stats.ctimeMs &&
    record.size === stats.size
  );
}

function sameFingerprintStatRecord(left: FingerprintStatRecord, right: FingerprintStatRecord): boolean {
  return (
    sameFingerprintStatIdentity(left, right.kind, right) &&
    left.hash === right.hash &&
    left.fingerprintSize === right.fingerprintSize
  );
}

function writeFingerprintStatCacheFile(path: string, value: FingerprintStatCacheFile): void {
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    unlinkSync(tmpPath);
  } catch {
    // A leftover tmp from a crashed persist must not block the next write.
  }
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  const fd = openSync(tmpPath, 'wx', 0o600);
  try {
    writeFileCompletely(
      fd,
      bytes,
      {
        writeFile: (descriptor, data, offset, length) => writeSync(descriptor, data, offset, length),
      },
      'fingerprint stat cache',
    );
  } catch (error) {
    closeSync(fd);
    unlinkSync(tmpPath);
    throw error;
  }
  closeSync(fd);
  renameSync(tmpPath, path);
}

function canonicalProjectRoot(projectRoot: string): string {
  return realpathSync(projectRoot);
}
