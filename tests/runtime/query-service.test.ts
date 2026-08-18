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
      kind: 'source-search',
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

  it('parses the bounded machine-readable outline form', () => {
    expect(
      parseFastPathInvocation([
        'outline',
        '--json',
        '--result-only',
        '--compact',
        '--signatures',
        'src/runtime/cli.ts',
      ]),
    ).toEqual({ kind: 'outline', filePattern: 'src/runtime/cli.ts' });
  });

  it('parses the bounded machine-readable code form with local session policy', () => {
    expect(
      parseFastPathInvocation([
        'code',
        'firstSymbol',
        'src/runtime/cli.ts',
        '--context=3',
        '--members',
        'all',
        '--json',
        '--result-only',
        '--compact',
        '--no-session',
      ]),
    ).toEqual({
      kind: 'code',
      selectors: ['firstSymbol', 'src/runtime/cli.ts'],
      options: { context: 3, members: 'all' },
      session: false,
    });
  });

  it('parses the complete machine-readable entrypoints form', () => {
    expect(
      parseFastPathInvocation([
        'entrypoints',
        '--scope=src/runtime',
        '--json',
        '--result-only',
        '--compact',
        'queryServiceSessionIdentity',
      ]),
    ).toEqual({
      kind: 'entrypoints',
      options: { search: 'queryServiceSessionIdentity', scope: 'src/runtime' },
    });
    expect(parseFastPathInvocation(['entrypoints', '--json', '--result-only', '--compact'])).toEqual({
      kind: 'entrypoints',
      options: {},
    });
  });

  it.each([
    ['search', 'needle', '--json', '--result-only'],
    ['search', 'needle', '--json', '--result-only', '--compact', '--full'],
    ['search', 'needle', '--json', '--result-only', '--compact', '--context', '-1'],
    ['search', 'first', 'second', '--json', '--result-only', '--compact'],
    ['outline', 'src/runtime/cli.ts', '--json', '--result-only'],
    ['outline', 'first.ts', 'second.ts', '--json', '--result-only', '--compact'],
    ['outline', 'src/runtime/cli.ts', '--json', '--result-only', '--compact', '--full'],
    ['code', 'symbol', '--json', '--result-only'],
    ['code', 'symbol', '--json', '--result-only', '--compact', '-m', 'all'],
    ['code', 'symbol', '--json', '--result-only', '--compact', '--members', 'private'],
    ['code', 'symbol', '--json', '--result-only', '--compact', '--context', '-1'],
    ['code', '--json', '--result-only', '--compact'],
    ['entrypoints', 'first', 'second', '--json', '--result-only', '--compact'],
    ['entrypoints', '--json', '--result-only', '--compact', '--full'],
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
