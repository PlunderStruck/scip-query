import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

type ProfileMetadata = Record<string, unknown>;

const PROFILE_ENV = 'SCIP_QUERY_PROFILE';
const PROFILE_OUT_ENV = 'SCIP_QUERY_PROFILE_OUT';
const PROFILE_COMMAND_ENV = 'SCIP_QUERY_PROFILE_COMMAND';
const ensuredDirs = new Set<string>();
let warnedProfileWriteFailure = false;

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

export function writeProfileEvent(event: ProfileMetadata, outputPath = profileOutputPath()): void {
  const record = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    command: profileCommand(),
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

function profileMetadata(metadata: ProfileMetadata | (() => ProfileMetadata) | undefined): ProfileMetadata | undefined {
  return typeof metadata === 'function' ? metadata() : metadata;
}
