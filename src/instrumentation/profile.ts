import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

type ProfileMetadata = Record<string, unknown>;

const PROFILE_ENV = 'SCIP_QUERY_PROFILE';
const PROFILE_OUT_ENV = 'SCIP_QUERY_PROFILE_OUT';
const PROFILE_COMMAND_ENV = 'SCIP_QUERY_PROFILE_COMMAND';
const PROFILE_CACHE_STATE_ENV = 'SCIP_QUERY_PROFILE_CACHE_STATE';
const PROFILE_RUN_ID_ENV = 'SCIP_QUERY_PROFILE_RUN_ID';
const PROFILE_WORKLOAD_ID_ENV = 'SCIP_QUERY_PROFILE_WORKLOAD_IDENTITY';
const PROFILE_WORKLOAD_KIND_ENV = 'SCIP_QUERY_PROFILE_WORKLOAD_IDENTITY_KIND';
const PROFILE_ENVIRONMENT_KEYS = [
  PROFILE_ENV,
  PROFILE_OUT_ENV,
  PROFILE_COMMAND_ENV,
  PROFILE_CACHE_STATE_ENV,
  PROFILE_RUN_ID_ENV,
  PROFILE_WORKLOAD_ID_ENV,
  PROFILE_WORKLOAD_KIND_ENV,
] as const;
const PROFILE_ENVIRONMENT_KEY_SET = new Set<string>(PROFILE_ENVIRONMENT_KEYS);
const ensuredDirs = new Set<string>();
const subsystemIdentityCache = new Map<string, string>();
let warnedProfileWriteFailure = false;

export type ProfileWorkloadIdentityKind = 'published-project' | 'run-only';
export type ProfileEnvironment = Record<string, string | null>;

export interface ProfileWorkloadIdentityInput {
  command: string;
  toolVersion: string;
  projectFingerprint: string | null;
}

export function profileEnabled(): boolean {
  const value = process.env[PROFILE_ENV];
  return value === '1' || value === 'true';
}

export function profileOutputPath(): string | undefined {
  return process.env[PROFILE_OUT_ENV];
}

export function profileCommand(): string | undefined {
  return process.env[PROFILE_COMMAND_ENV];
}

export function profileCacheState(): string | undefined {
  return process.env[PROFILE_CACHE_STATE_ENV];
}

export function profileRunId(): string | undefined {
  const existing = process.env[PROFILE_RUN_ID_ENV];
  if (existing) return existing;
  if (!profileEnabled()) return undefined;
  const generated = randomUUID();
  process.env[PROFILE_RUN_ID_ENV] = generated;
  return generated;
}

export function profileWorkloadIdentity(): string | undefined {
  return process.env[PROFILE_WORKLOAD_ID_ENV];
}

export function initializeProfileWorkloadIdentity(input: ProfileWorkloadIdentityInput): string | undefined {
  const existing = profileWorkloadIdentity();
  if (existing) return existing;
  if (!profileEnabled()) return undefined;
  const runId = profileRunId();
  if (!runId) return undefined;
  const kind: ProfileWorkloadIdentityKind = input.projectFingerprint ? 'published-project' : 'run-only';
  const identity = profileWorkIdentity([
    'profile-workload-v1',
    input.toolVersion,
    input.command,
    input.projectFingerprint ?? runId,
  ]);
  process.env[PROFILE_WORKLOAD_ID_ENV] = identity;
  process.env[PROFILE_WORKLOAD_KIND_ENV] = kind;
  return identity;
}

// scip-query: ignore-wrapper — canonical work-identity encoding shared by the
// workload, subsystem, and evidence-product instrumentation boundaries.
export function profileWorkIdentity(parts: readonly (string | number | boolean | null)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

export function captureProfileEnvironment(): ProfileEnvironment {
  return Object.fromEntries(
    PROFILE_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

export function applyProfileEnvironment(environment: ProfileEnvironment): void {
  for (const key of PROFILE_ENVIRONMENT_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(environment)) {
    if (PROFILE_ENVIRONMENT_KEY_SET.has(key) && value !== null) process.env[key] = value;
  }
}

export function profileSpan<T>(name: string, run: () => T, metadata?: ProfileMetadata | (() => ProfileMetadata)): T {
  if (!profileEnabled()) return run();
  const started = performance.now();
  try {
    const value = run();
    writeProfileEvent({
      type: 'span',
      name,
      durationMs: Math.round(performance.now() - started),
      ok: true,
      ...(profileMetadata(metadata) ?? {}),
    });
    return value;
  } catch (error) {
    writeProfileEvent({
      type: 'span',
      name,
      durationMs: Math.round(performance.now() - started),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(profileMetadata(metadata) ?? {}),
    });
    throw error;
  }
}

export async function profileAsyncSpan<T>(
  name: string,
  run: () => Promise<T>,
  metadata?: ProfileMetadata | (() => ProfileMetadata),
): Promise<T> {
  if (!profileEnabled()) return run();
  const started = performance.now();
  try {
    const value = await run();
    writeProfileEvent({
      type: 'span',
      name,
      durationMs: Math.round(performance.now() - started),
      ok: true,
      ...(profileMetadata(metadata) ?? {}),
    });
    return value;
  } catch (error) {
    writeProfileEvent({
      type: 'span',
      name,
      durationMs: Math.round(performance.now() - started),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(profileMetadata(metadata) ?? {}),
    });
    throw error;
  }
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function writeProfileEvent(event: ProfileMetadata, outputPath = profileOutputPath()): void {
  const identityContext = profileEventIdentityContext(event);
  const record = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    runId: profileRunId(),
    command: profileCommand(),
    cacheState: profileCacheState(),
    ...identityContext,
    ...event,
  };
  const line = `${JSON.stringify(record)}\n`;
  if (outputPath) {
    try {
      const dir = dirname(outputPath);
      if (!ensuredDirs.has(dir)) {
        mkdirSync(dir, { recursive: true });
        ensuredDirs.add(dir);
      }
      appendFileSync(outputPath, line);
      return;
    } catch (error) {
      if (!warnedProfileWriteFailure) {
        warnedProfileWriteFailure = true;
        process.stderr.write(
          `[profile] failed to write ${outputPath}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      return;
    }
  }
  if (profileEnabled()) process.stderr.write(line);
}

function profileEventIdentityContext(event: ProfileMetadata): ProfileMetadata {
  const workloadIdentity =
    profileWorkloadIdentity() ??
    initializeProfileWorkloadIdentity({
      command: profileCommand() ?? 'unknown',
      toolVersion: 'unknown',
      projectFingerprint: null,
    });
  if (!workloadIdentity) return {};
  const workloadIdentityKind = process.env[PROFILE_WORKLOAD_KIND_ENV];
  const name = typeof event['name'] === 'string' ? event['name'] : undefined;
  if (!name) return { workloadIdentity, workloadIdentityKind };
  const subsystem = name.split(/[.:]/, 1)[0] ?? name;
  const cacheKey = `${workloadIdentity}\0${name}`;
  let subsystemWorkIdentity = subsystemIdentityCache.get(cacheKey);
  if (!subsystemWorkIdentity) {
    subsystemWorkIdentity = profileWorkIdentity(['profile-subsystem-v1', workloadIdentity, name]);
    subsystemIdentityCache.set(cacheKey, subsystemWorkIdentity);
  }
  return {
    workloadIdentity,
    workloadIdentityKind,
    subsystem,
    subsystemWorkIdentity,
  };
}

function profileMetadata(metadata: ProfileMetadata | (() => ProfileMetadata) | undefined): ProfileMetadata | undefined {
  return typeof metadata === 'function' ? metadata() : metadata;
}
