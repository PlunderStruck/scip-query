import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { profileSpan } from '../instrumentation/profile.js';
import type { HealthReport } from '../queries/health/health-report.js';
import type { ScipDatabase } from '../storage/db.js';
import { projectEvidenceFingerprint, sha256Hex } from '../storage/evidence-cache.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';

// Q1: bumped 1 -> 2 for the twin-drift dimension (health.ts HEALTH_PHASES,
// health-report.ts findings/axes/actions/scoreBreakdown) — an old-shaped
// cached report would otherwise pass isHealthReport()'s shallow check and
// silently miss the new dimension until the next git-HEAD-driven miss.
//
// Q2: bumped 2 -> 3 so default health's phase-timeout policy is part of the
// cache identity. A partial 30s default report and an unbounded report are not
// interchangeable.
const HEALTH_REPORT_CACHE_VERSION = 3;
const HEALTH_REPORT_CACHE_FILE = 'health-report-cache.json';

export interface HealthReportCacheOptions {
  scope?: string;
  full?: boolean;
  phaseTimeoutMs?: number | null;
}

export interface HealthReportCacheKey {
  version: typeof HEALTH_REPORT_CACHE_VERSION;
  projectFingerprint: string;
  cliVersion: string;
  scope: string | null;
  full: boolean;
  phaseTimeoutMs: number | null;
  gitHead: string | null;
}

interface HealthReportCacheFile {
  version: typeof HEALTH_REPORT_CACHE_VERSION;
  keyHash: string;
  key: HealthReportCacheKey;
  writtenAt: string;
  report: HealthReport;
}

interface HealthReportCacheKeyDeps {
  gitHead(cwd: string): string | null;
}

interface HealthReportCacheFileDeps {
  existsSync(path: string): boolean;
  mkdirSync(path: string, opts: { recursive: true }): void;
  readFile(path: string): string;
  renameSync(oldPath: string, newPath: string): void;
  writeFileSync(path: string, data: string): void;
  nowIso(): string;
}

export function healthReportCacheKey(
  db: ScipDatabase,
  opts: HealthReportCacheOptions,
  cliVersion: string,
  deps: HealthReportCacheKeyDeps = defaultKeyDeps(),
): HealthReportCacheKey | null {
  const projectFingerprint = projectEvidenceFingerprint(db);
  if (!projectFingerprint) return null;
  return {
    version: HEALTH_REPORT_CACHE_VERSION,
    projectFingerprint,
    cliVersion,
    scope: opts.scope ?? null,
    full: opts.full === true,
    phaseTimeoutMs: opts.phaseTimeoutMs ?? null,
    gitHead: deps.gitHead(db.config.projectRoot),
  };
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function readHealthReportCache(
  db: ScipDatabase,
  key: HealthReportCacheKey,
  deps: HealthReportCacheFileDeps = defaultFileDeps(),
): HealthReport | null {
  const cachePath = healthReportCachePath(db);
  const expectedHash = healthReportCacheKeyHash(key);
  let hit = false;
  return profileSpan(
    'health.report-cache.read',
    () => {
      if (!deps.existsSync(cachePath)) return null;
      try {
        const parsed = JSON.parse(deps.readFile(cachePath)) as unknown;
        if (!isHealthReportCacheFile(parsed)) return null;
        if (parsed.keyHash !== expectedHash) return null;
        hit = true;
        return parsed.report;
      } catch {
        return null;
      }
    },
    () => ({ available: true, hit, keyHash: expectedHash }),
  );
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function writeHealthReportCache(
  db: ScipDatabase,
  key: HealthReportCacheKey,
  report: HealthReport,
  deps: HealthReportCacheFileDeps = defaultFileDeps(),
): void {
  const cachePath = healthReportCachePath(db);
  const payload: HealthReportCacheFile = {
    version: HEALTH_REPORT_CACHE_VERSION,
    keyHash: healthReportCacheKeyHash(key),
    key,
    writtenAt: deps.nowIso(),
    report,
  };
  deps.mkdirSync(dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  deps.writeFileSync(tempPath, JSON.stringify(payload));
  deps.renameSync(tempPath, cachePath);
}

export function healthReportCachePath(db: ScipDatabase): string {
  return join(dirname(db.config.dbPath), HEALTH_REPORT_CACHE_FILE);
}

export function healthReportCacheKeyHash(key: HealthReportCacheKey): string {
  return sha256Hex(JSON.stringify(key));
}

function isHealthReportCacheFile(value: unknown): value is HealthReportCacheFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<HealthReportCacheFile>;
  return (
    candidate.version === HEALTH_REPORT_CACHE_VERSION &&
    typeof candidate.keyHash === 'string' &&
    isHealthReportCacheKey(candidate.key) &&
    typeof candidate.writtenAt === 'string' &&
    isHealthReport(candidate.report)
  );
}

function isHealthReportCacheKey(value: unknown): value is HealthReportCacheKey {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<HealthReportCacheKey>;
  return (
    candidate.version === HEALTH_REPORT_CACHE_VERSION &&
    typeof candidate.projectFingerprint === 'string' &&
    typeof candidate.cliVersion === 'string' &&
    (candidate.scope === null || typeof candidate.scope === 'string') &&
    typeof candidate.full === 'boolean' &&
    (candidate.phaseTimeoutMs === null || typeof candidate.phaseTimeoutMs === 'number') &&
    (candidate.gitHead === null || typeof candidate.gitHead === 'string')
  );
}

function isHealthReport(value: unknown): value is HealthReport {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<HealthReport>;
  return (
    typeof candidate.score === 'number' &&
    typeof candidate.riskScore === 'number' &&
    typeof candidate.hygieneScore === 'number' &&
    typeof candidate.overview === 'object' &&
    typeof candidate.findings === 'object' &&
    Array.isArray(candidate.scoreBreakdown) &&
    Array.isArray(candidate.actions) &&
    Array.isArray(candidate.pressure) &&
    Array.isArray(candidate.topComplexity) &&
    Array.isArray(candidate.detectorPrecision)
  );
}

function defaultKeyDeps(): HealthReportCacheKeyDeps {
  return {
    gitHead(cwd) {
      const result = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      });
      return result.status === 0 ? result.stdout.trim() : null;
    },
  };
}

function defaultFileDeps(): HealthReportCacheFileDeps {
  return {
    existsSync,
    mkdirSync,
    readFile: (path) => readSmallArtifactText(path, 'health report cache'),
    renameSync,
    writeFileSync,
    nowIso: () => new Date().toISOString(),
  };
}
