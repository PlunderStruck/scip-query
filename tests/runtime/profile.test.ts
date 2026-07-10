import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { profileRunId, profileSpan, writeProfileEvent } from '../../src/instrumentation/profile.js';

const PROFILE_ENV_KEYS = [
  'SCIP_QUERY_PROFILE',
  'SCIP_QUERY_PROFILE_OUT',
  'SCIP_QUERY_PROFILE_COMMAND',
  'SCIP_QUERY_PROFILE_CACHE_STATE',
  'SCIP_QUERY_PROFILE_RUN_ID',
] as const;

function restoreProfileEnv(snapshot: Record<(typeof PROFILE_ENV_KEYS)[number], string | undefined>): void {
  for (const key of PROFILE_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('runtime profiling', () => {
  let tempDir: string | undefined;
  const envSnapshot = Object.fromEntries(PROFILE_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof PROFILE_ENV_KEYS)[number],
    string | undefined
  >;

  afterEach(() => {
    restoreProfileEnv(envSnapshot);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('writes span events as JSONL when profiling is enabled', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-profile-'));
    const profilePath = join(tempDir, 'profile.jsonl');
    process.env.SCIP_QUERY_PROFILE = '1';
    process.env.SCIP_QUERY_PROFILE_OUT = profilePath;
    process.env.SCIP_QUERY_PROFILE_COMMAND = 'scip-query similar --json --full';
    process.env.SCIP_QUERY_PROFILE_CACHE_STATE = 'evidence-cold';
    process.env.SCIP_QUERY_PROFILE_RUN_ID = 'run-123';

    const value = profileSpan('similar.test-phase', () => 42, { rows: 3 });

    expect(value).toBe(42);
    const event = JSON.parse(readFileSync(profilePath, 'utf8').trim()) as Record<string, unknown>;
    expect(event).toMatchObject({
      command: 'scip-query similar --json --full',
      cacheState: 'evidence-cold',
      runId: 'run-123',
      type: 'span',
      name: 'similar.test-phase',
      ok: true,
      rows: 3,
    });
    expect(typeof event.durationMs).toBe('number');
    expect(typeof event.timestamp).toBe('string');
  });

  it('generates one run identity that later profile events reuse', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-profile-'));
    const profilePath = join(tempDir, 'profile.jsonl');
    process.env.SCIP_QUERY_PROFILE = '1';
    process.env.SCIP_QUERY_PROFILE_OUT = profilePath;
    delete process.env.SCIP_QUERY_PROFILE_RUN_ID;

    const generated = profileRunId();
    writeProfileEvent({ type: 'first' });
    writeProfileEvent({ type: 'second' });

    const events = readFileSync(profilePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(generated).toEqual(expect.any(String));
    expect(events.map((event) => event.runId)).toEqual([generated, generated]);
  });

  it('allows callers to write benchmark events to an explicit output path', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-profile-'));
    const profilePath = join(tempDir, 'bench.jsonl');

    writeProfileEvent({ type: 'bench-command-start', command: 'scip-query stats' }, profilePath);

    const event = JSON.parse(readFileSync(profilePath, 'utf8').trim()) as Record<string, unknown>;
    expect(event).toMatchObject({
      type: 'bench-command-start',
      command: 'scip-query stats',
    });
  });
});
