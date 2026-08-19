import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProcessIdentity } from '../../src/platform/process-identity.js';
import { parseFastPathInvocation } from '../../src/runtime/query-service-fastpath.js';
import {
  QUERY_SERVICE_PROTOCOL_VERSION,
  isQueryServiceServerStateUsable,
  queryServiceSessionIdentity,
  readQueryServiceServerState,
} from '../../src/runtime/query-service.js';

describe('query service fast path', () => {
  it('parses the bounded machine-readable search form', () => {
    expect(
      parseFastPathInvocation(['call-graph', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact']),
    ).toEqual({
      kind: 'call-graph',
      symbolPattern: 'queryServiceSessionIdentity',
    });
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

  it('parses the complete machine-readable files and stats forms', () => {
    expect(parseFastPathInvocation(['files', '--json', '--result-only', '--compact', 'src/runtime'])).toEqual({
      kind: 'files',
      pattern: 'src/runtime',
    });
    expect(parseFastPathInvocation(['files', '--json', '--result-only', '--compact', '--', '--generated'])).toEqual({
      kind: 'files',
      pattern: '--generated',
    });
    expect(parseFastPathInvocation(['stats', '--json', '--result-only', '--compact'])).toEqual({ kind: 'stats' });
  });

  it('parses the complete machine-readable members and methods forms', () => {
    expect(parseFastPathInvocation(['members', '--json', '--result-only', '--compact', 'ScipDatabase'])).toEqual({
      kind: 'members',
      symbolPattern: 'ScipDatabase',
    });
    expect(parseFastPathInvocation(['methods', '--json', '--result-only', '--compact', 'ScipDatabase'])).toEqual({
      kind: 'methods',
      className: 'ScipDatabase',
    });
    expect(parseFastPathInvocation(['members', '--json', '--result-only', '--compact', '--', '--owner'])).toEqual({
      kind: 'members',
      symbolPattern: '--owner',
    });
  });

  it('parses the complete machine-readable dependency forms', () => {
    expect(
      parseFastPathInvocation(['deps', 'src/runtime/query-service.ts', '--json', '--result-only', '--compact']),
    ).toEqual({
      kind: 'file-dependencies',
      direction: 'outgoing',
      filePattern: 'src/runtime/query-service.ts',
    });
    expect(parseFastPathInvocation(['rdeps', '--json', '--result-only', '--compact', '--', '--generated.ts'])).toEqual({
      kind: 'file-dependencies',
      direction: 'incoming',
      filePattern: '--generated.ts',
    });
  });

  it('parses the complete machine-readable catalog forms', () => {
    expect(
      parseFastPathInvocation(['imported-by', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact']),
    ).toEqual({ kind: 'imported-by', symbolPattern: 'queryServiceSessionIdentity' });
    expect(
      parseFastPathInvocation(['hierarchy', '--json', '--result-only', '--compact', 'queryServiceSessionIdentity']),
    ).toEqual({ kind: 'hierarchy', symbolPattern: 'queryServiceSessionIdentity' });
    expect(parseFastPathInvocation(['by-kind', 'function', '--json', '--result-only', '--compact'])).toEqual({
      kind: 'by-kind',
      kindQuery: 'function',
    });
    expect(parseFastPathInvocation(['kind-counts', '--json', '--result-only', '--compact'])).toEqual({
      kind: 'kind-counts',
    });
    expect(
      parseFastPathInvocation(['refs', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact']),
    ).toEqual({
      kind: 'refs',
      symbolPattern: 'queryServiceSessionIdentity',
    });
    expect(
      parseFastPathInvocation(['trace', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact']),
    ).toEqual({
      kind: 'trace',
      symbolPattern: 'queryServiceSessionIdentity',
    });
    expect(
      parseFastPathInvocation(['value-flow', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact']),
    ).toEqual({
      kind: 'value-flow',
      symbolPattern: 'queryServiceSessionIdentity',
    });
    expect(
      parseFastPathInvocation(['dependence-slice', 'executeRequest', '--json', '--result-only', '--compact']),
    ).toEqual({
      kind: 'dependence-slice',
      criterion: 'executeRequest',
    });
    expect(
      parseFastPathInvocation([
        'reference-neighborhood',
        'queryServiceSessionIdentity',
        '--json',
        '--result-only',
        '--compact',
      ]),
    ).toEqual({
      kind: 'reference-neighborhood',
      symbolPattern: 'queryServiceSessionIdentity',
    });
    expect(
      parseFastPathInvocation(['dataflow', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact']),
    ).toEqual({
      kind: 'dataflow',
      symbolPattern: 'queryServiceSessionIdentity',
    });
    expect(
      parseFastPathInvocation([
        'reference-reachability',
        'queryServiceSessionIdentity',
        '--json',
        '--result-only',
        '--compact',
      ]),
    ).toEqual({
      kind: 'reference-reachability',
      symbolPattern: 'queryServiceSessionIdentity',
    });
    expect(
      parseFastPathInvocation(['slice', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact']),
    ).toEqual({
      kind: 'slice',
      symbolPattern: 'queryServiceSessionIdentity',
    });
    expect(parseFastPathInvocation(['imports', 'src/runtime/cli.ts', '--json', '--result-only', '--compact'])).toEqual({
      kind: 'imports',
      filePattern: 'src/runtime/cli.ts',
    });
    expect(
      parseFastPathInvocation(['unused-imports', 'src/runtime/cli.ts', '--json', '--result-only', '--compact']),
    ).toEqual({
      kind: 'unused-imports',
      filePattern: 'src/runtime/cli.ts',
    });
    expect(parseFastPathInvocation(['surface', 'src/runtime', '--json', '--result-only', '--compact'])).toEqual({
      kind: 'surface',
      modulePattern: 'src/runtime',
    });
    expect(parseFastPathInvocation(['system', 'src/runtime', '--json', '--result-only', '--compact'])).toEqual({
      kind: 'system',
      modulePattern: 'src/runtime',
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
    ['files', 'first', 'second', '--json', '--result-only', '--compact'],
    ['files', 'src', '--json', '--result-only'],
    ['stats', '--json', '--result-only'],
    ['stats', 'unexpected', '--json', '--result-only', '--compact'],
    ['members', 'first', 'second', '--json', '--result-only', '--compact'],
    ['members', 'ScipDatabase', '--json', '--result-only'],
    ['methods', 'ScipDatabase', '--json', '--result-only', '--compact', '--full'],
    ['methods', '--json', '--result-only', '--compact'],
    ['deps', 'first.ts', 'second.ts', '--json', '--result-only', '--compact'],
    ['deps', 'src/runtime/query-service.ts', '--json', '--result-only'],
    ['rdeps', 'src/runtime/query-service.ts', '--json', '--result-only', '--compact', '--full'],
    ['rdeps', '--json', '--result-only', '--compact'],
    ['imported-by', '--json', '--result-only', '--compact'],
    ['hierarchy', 'first', 'second', '--json', '--result-only', '--compact'],
    ['by-kind', 'function', '--scope', 'src', '--json', '--result-only', '--compact'],
    ['by-kind', 'function', '--limit', '10', '--json', '--result-only', '--compact'],
    ['kind-counts', '--scope', 'src', '--json', '--result-only', '--compact'],
    ['kind-counts', 'function', '--json', '--result-only', '--compact'],
    ['refs', 'queryServiceSessionIdentity', '--limit', '10', '--json', '--result-only', '--compact'],
    ['refs', 'queryServiceSessionIdentity', '--cursor', 'next', '--json', '--result-only', '--compact'],
    ['refs', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact', '--full'],
    ['trace', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact', '--full'],
    ['trace', '--json', '--result-only', '--compact'],
    ['value-flow', 'queryServiceSessionIdentity', '--depth', '3', '--json', '--result-only', '--compact'],
    ['value-flow', 'queryServiceSessionIdentity', '--max-edges', '12', '--json', '--result-only', '--compact'],
    ['value-flow', '--json', '--result-only', '--compact'],
    ['dependence-slice', 'executeRequest', '--forward', '--json', '--result-only', '--compact'],
    ['dependence-slice', 'executeRequest', '--depth', '2', '--json', '--result-only', '--compact'],
    ['dependence-slice', 'executeRequest', '--max-edges', '12', '--json', '--result-only', '--compact'],
    ['dependence-slice', '--json', '--result-only', '--compact'],
    ['call-graph', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact', '--full'],
    ['call-graph', '--json', '--result-only', '--compact'],
    ['reference-neighborhood', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact', '--full'],
    ['reference-neighborhood', '--json', '--result-only', '--compact'],
    ['dataflow', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact', '--full'],
    ['dataflow', '--json', '--result-only', '--compact'],
    ['reference-reachability', 'queryServiceSessionIdentity', '--forward', '--json', '--result-only', '--compact'],
    ['reference-reachability', 'queryServiceSessionIdentity', '--depth', '2', '--json', '--result-only', '--compact'],
    ['reference-reachability', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact', '--full'],
    ['reference-reachability', '--json', '--result-only', '--compact'],
    ['slice', 'queryServiceSessionIdentity', '--forward', '--json', '--result-only', '--compact'],
    ['slice', 'queryServiceSessionIdentity', '--depth', '2', '--json', '--result-only', '--compact'],
    ['slice', 'queryServiceSessionIdentity', '--json', '--result-only', '--compact', '--full'],
    ['slice', '--json', '--result-only', '--compact'],
    ['imports', 'src/runtime/cli.ts', '--json', '--result-only', '--compact', '--full'],
    ['imports', '--json', '--result-only', '--compact'],
    ['unused-imports', 'src/runtime/cli.ts', '--json', '--result-only', '--compact', '--full'],
    ['unused-imports', '--json', '--result-only', '--compact'],
    ['system', 'src/runtime', '--json', '--result-only', '--compact', '--full'],
    ['system', '--json', '--result-only', '--compact'],
    ['surface', 'src/runtime', '--json', '--result-only', '--compact', '--limit', '10'],
    ['surface', '--json', '--result-only', '--compact'],
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

  it('uses a fresh heartbeat before paying for exact process identity and rechecks stale state exactly', () => {
    const processIdentity = readProcessIdentity(process.pid);
    expect(processIdentity).not.toBeNull();
    const nowMs = Date.now();
    const state = {
      protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
      sessionIdentity: 'session-a',
      pid: process.pid,
      processIdentity: { ...processIdentity!, startToken: `${processIdentity!.startToken}-reused` },
      generation: 'generation-a',
      heartbeatAtMs: nowMs,
    };

    expect(isQueryServiceServerStateUsable(state, nowMs)).toBe(true);
    expect(isQueryServiceServerStateUsable({ ...state, heartbeatAtMs: nowMs - 2_001 }, nowMs)).toBe(false);
    expect(isQueryServiceServerStateUsable({ ...state, heartbeatAtMs: nowMs + 1 }, nowMs)).toBe(false);
  });
});
