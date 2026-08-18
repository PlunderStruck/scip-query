import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProcessIdentity } from '../../src/platform/process-identity.js';
import { parseFastPathInvocation } from '../../src/runtime/query-service-fastpath.js';
import {
  QUERY_SERVICE_PROTOCOL_VERSION,
  queryServiceSessionIdentity,
  readQueryServiceServerState,
} from '../../src/runtime/query-service.js';

describe('query service fast path', () => {
  it('parses the bounded machine-readable search form', () => {
    expect(
      parseFastPathInvocation([
        'search',
        '--json',
        '--result-only',
        '--compact',
        '--scope=src/runtime',
        '--context',
        '0',
        '-n',
        '12',
        '--regexp',
        '-i',
        'needle.*value',
      ]),
    ).toEqual({
      pattern: 'needle.*value',
      options: {
        scope: 'src/runtime',
        context: 0,
        limit: 12,
        regexp: true,
        ignoreCase: true,
        ranking: 'structural',
      },
    });
  });

  it('preserves a dash-prefixed exact text after the option terminator', () => {
    expect(parseFastPathInvocation(['search', '--json', '--result-only', '--compact', '--', '--config'])).toMatchObject(
      { pattern: '--config' },
    );
  });

  it.each([
    ['search', 'needle', '--json', '--result-only'],
    ['search', 'needle', '--json', '--result-only', '--compact', '--full'],
    ['search', 'needle', '--json', '--result-only', '--compact', '--context', '-1'],
    ['search', 'first', 'second', '--json', '--result-only', '--compact'],
    ['outline', 'src/runtime/cli.ts', '--json', '--result-only', '--compact'],
  ])('falls through for an ambiguous or unsupported invocation: %j', (...argv) => {
    expect(parseFastPathInvocation(argv)).toBeNull();
  });
});

describe('query service state identity', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('accepts a state whose process identity belongs to its declared pid', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'scip-query-service-state-'));
    temporaryDirectories.push(sessionDir);
    const processIdentity = readProcessIdentity(process.pid);
    expect(processIdentity).not.toBeNull();
    writeFileSync(
      join(sessionDir, 'server.json'),
      JSON.stringify({
        protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
        sessionIdentity: queryServiceSessionIdentity(sessionDir),
        pid: process.pid,
        processIdentity,
        generation: 'generation-a',
        heartbeatAtMs: Date.now(),
      }),
    );

    expect(readQueryServiceServerState(sessionDir)).toMatchObject({ pid: process.pid, generation: 'generation-a' });
  });

  it('rejects a process identity copied under a different pid', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'scip-query-service-state-'));
    temporaryDirectories.push(sessionDir);
    const processIdentity = readProcessIdentity(process.pid);
    expect(processIdentity).not.toBeNull();
    writeFileSync(
      join(sessionDir, 'server.json'),
      JSON.stringify({
        protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
        sessionIdentity: queryServiceSessionIdentity(sessionDir),
        pid: process.pid + 1,
        processIdentity,
        generation: 'generation-a',
        heartbeatAtMs: Date.now(),
      }),
    );

    expect(readQueryServiceServerState(sessionDir)).toBeNull();
  });
});
