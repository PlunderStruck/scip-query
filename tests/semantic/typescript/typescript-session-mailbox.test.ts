import Database from 'better-sqlite3';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureProfileEnvironment } from '../../../src/instrumentation/profile.js';
import type { ProjectInputSnapshot } from '../../../src/domain/project-input.js';
import { WATCH_SERVICE_PROTOCOL_VERSION } from '../../../src/platform/watch-service-state.js';
import { writeWatchServiceState } from '../../../src/runtime/watch-service.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { writeJsonAtomic } from '../../../src/storage/atomic-json.js';
import { initializeBoundedMailbox } from '../../../src/storage/bounded-mailbox.js';
import { publishedSqliteGenerationIdentity } from '../../../src/storage/sqlite-generation.js';
import type { SemanticProvider } from '../../../src/semantic/types.js';
import type { IndexedDefinition } from '../../../src/domain/types.js';
import { TypeScriptSemanticHost } from '../../../src/semantic/typescript/session-host.js';
import {
  processTypeScriptSemanticMailbox,
  TypeScriptSemanticServiceHost,
} from '../../../src/semantic/typescript/session-service.js';
import {
  TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
  TYPESCRIPT_SEMANTIC_LEGACY_PROTOCOL_VERSION,
  typeScriptSemanticMailboxPaths,
} from '../../../src/semantic/typescript/session-protocol.js';
import {
  createServiceBackedTypeScriptProvider,
  TypeScriptSemanticRequester,
} from '../../../src/semantic/typescript/remote-provider.js';
import { loadTsMorph } from '../../../src/semantic/typescript/ts-morph-runtime.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';
import { promoteReindexArtifacts } from '../../../src/reindex/sqlite-generation-store.js';
import type { ProcessIdentity } from '../../../src/platform/process-identity.js';

const NOW = Date.parse('2026-07-09T23:00:00.000Z');
const SERVICE_PROCESS_IDENTITY: ProcessIdentity = {
  version: 1,
  pid: 123,
  platform: 'linux',
  startToken: 'service-owner',
};
const tempDirs: string[] = [];
const inheritedSkipWatchService = process.env['SCIP_QUERY_SKIP_WATCH_SERVICE'];

beforeEach(() => {
  delete process.env['SCIP_QUERY_SKIP_WATCH_SERVICE'];
});

afterEach(() => {
  if (inheritedSkipWatchService === undefined) delete process.env['SCIP_QUERY_SKIP_WATCH_SERVICE'];
  else process.env['SCIP_QUERY_SKIP_WATCH_SERVICE'] = inheritedSkipWatchService;
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('TypeScript semantic service mailbox', () => {
  it('rejects a reused service PID even when civil heartbeat time appears current', () => {
    const fixture = serviceFixture(true);
    const db = fixture.openDb(fixture.projectRoot);
    const statePath = join(fixture.projectRoot, 'watch-state.json');
    writeLiveState(statePath, fixture.projectRoot, SERVICE_PROCESS_IDENTITY);
    const requester = new TypeScriptSemanticRequester(db, {
      timeoutMs: 20,
      runtime: {
        now: () => NOW - 365 * 86_400_000,
        randomId: () => 'reused-pid',
        isProcessAlive: () => true,
        readProcessIdentity: () => ({ ...SERVICE_PROCESS_IDENTITY, startToken: 'successor' }),
        sleep: () => {
          throw new Error('request should not be admitted');
        },
      },
    });

    expect(() => requester.request({ kind: 'availability' })).toThrow('not running');
    db.close();
  });

  it('processes atomic requests and refreshes its host when the publication changes', () => {
    const fixture = serviceFixture();
    let generation = 'generation-1';
    let snapshot = projectSnapshot('consumer-v1');
    const service = new TypeScriptSemanticServiceHost({
      openDb: fixture.openDb,
      generationIdentity: () => generation,
      readSnapshot: () => snapshot,
      createHost: fakeSemanticHost,
      now: () => NOW,
    });
    const paths = typeScriptSemanticMailboxPaths(fixture.projectRoot);
    initializeBoundedMailbox(paths);

    writeRequest(paths.requestDir, 'first', generation, { kind: 'availability' });
    expect(processTypeScriptSemanticMailbox(paths, service, { nowMs: NOW })).toBe(1);
    expect(readResponse(paths.responseDir, 'first')).toEqual(
      expect.objectContaining({
        ok: true,
        id: 'first',
        generation,
        response: { available: true, tsconfigPaths: ['tsconfig.json'] },
      }),
    );

    generation = 'generation-2';
    snapshot = projectSnapshot('consumer-v2');
    writeRequest(paths.requestDir, 'second', generation, { kind: 'import-usage', file: 'src/consumer.ts' });
    expect(processTypeScriptSemanticMailbox(paths, service, { nowMs: NOW })).toBe(1);
    expect(readResponse(paths.responseDir, 'second')).toEqual(
      expect.objectContaining({ ok: true, generation, response: [] }),
    );
    expect(service.status()).toEqual(
      expect.objectContaining({
        state: 'ready',
        requests: 2,
        sessionsRefreshed: 1,
      }),
    );
    service.closeTypeScriptService();
  });

  it('rejects expired, malformed, and wrong-generation work without accepting a response', () => {
    const fixture = serviceFixture();
    const service = new TypeScriptSemanticServiceHost({
      openDb: fixture.openDb,
      generationIdentity: () => 'current',
      readSnapshot: () => projectSnapshot('current'),
      createHost: fakeSemanticHost,
      now: () => NOW,
    });
    const paths = typeScriptSemanticMailboxPaths(fixture.projectRoot);
    initializeBoundedMailbox(paths);
    writeRequest(paths.requestDir, 'expired', 'current', { kind: 'availability' }, NOW - 1);
    writeFileSync(join(paths.requestDir, 'malformed.json'), '{');
    writeRequest(paths.requestDir, 'wrong', 'old', { kind: 'availability' });

    expect(processTypeScriptSemanticMailbox(paths, service, { nowMs: NOW })).toBe(3);
    for (const id of ['expired', 'malformed', 'wrong']) {
      expect(readResponse(paths.responseDir, id)).toEqual(expect.objectContaining({ ok: false, id }));
    }
    writeFileSync(join(paths.requestDir, 'oversized.json'), 'x'.repeat(2_000));
    expect(
      processTypeScriptSemanticMailbox(paths, service, {
        nowMs: NOW,
        limits: { maxItemBytes: 512 },
      }),
    ).toBe(1);
    expect(readResponse(paths.responseDir, 'oversized')).toEqual(
      expect.objectContaining({ ok: false, id: 'oversized', error: expect.stringContaining('per-item limit') }),
    );
    expect(service.status().requests).toBe(0);
    service.closeTypeScriptService();
  });

  it('rechecks each deadline so a later request cannot execute after an earlier handler advances time', () => {
    const fixture = serviceFixture();
    const service = new TypeScriptSemanticServiceHost({
      openDb: fixture.openDb,
      generationIdentity: () => 'current',
      readSnapshot: () => projectSnapshot('current'),
      createHost: fakeSemanticHost,
      now: () => NOW,
    });
    const paths = typeScriptSemanticMailboxPaths(fixture.projectRoot);
    initializeBoundedMailbox(paths);
    writeRequest(paths.requestDir, 'first', 'current', { kind: 'availability' }, NOW + 1_000);
    writeRequest(paths.requestDir, 'second', 'current', { kind: 'availability' }, NOW + 1_000);
    let currentTime = NOW;
    let started = 0;

    expect(
      processTypeScriptSemanticMailbox(paths, service, {
        now: () => currentTime,
        beforeRequest: () => {
          started += 1;
          currentTime = NOW + 2_000;
        },
      }),
    ).toBe(2);

    expect(started).toBe(1);
    expect(service.status().requests).toBe(1);
    expect(readResponse(paths.responseDir, 'first')).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('expired while') }),
    );
    expect(readResponse(paths.responseDir, 'second')).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('expired before') }),
    );
    service.closeTypeScriptService();
  });

  it('lets a synchronous requester receive a response and rejects a mismatched response identity', () => {
    const fixture = serviceFixture(true);
    const projectAlias = symbolicLinkTo(fixture.projectRoot, 'scip-query-ts-mailbox-alias-');
    const db = fixture.openDb(projectAlias);
    const paths = typeScriptSemanticMailboxPaths(fixture.projectRoot);
    const statePath = join(fixture.projectRoot, 'watch-state.json');
    const generation = publishedSqliteGenerationIdentity(db.config.dbPath)!;
    const service = new TypeScriptSemanticServiceHost({
      openDb: fixture.openDb,
      createHost: fakeSemanticHost,
      now: () => NOW,
    });
    writeLiveState(statePath, fixture.projectRoot);
    let processed = false;
    const requester = new TypeScriptSemanticRequester(db, {
      timeoutMs: 1_000,
      runtime: {
        now: () => NOW,
        randomId: () => 'request-ok',
        isProcessAlive: () => true,
        sleep: () => {
          if (!processed) {
            processed = true;
            processTypeScriptSemanticMailbox(paths, service, { nowMs: NOW });
          }
        },
      },
    });
    expect(requester.request({ kind: 'availability' })).toEqual({
      available: true,
      tsconfigPaths: ['tsconfig.json'],
    });

    const mismatched = new TypeScriptSemanticRequester(db, {
      timeoutMs: 1_000,
      runtime: {
        now: () => NOW,
        randomId: () => 'request-bad',
        isProcessAlive: () => true,
        sleep: () => {
          const envelope = onlyPendingEnvelope(paths.pendingDir);
          writeJsonAtomic(join(paths.responseDir, `${envelope.id}.json`), {
            ok: true,
            protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
            id: 'some-other-request',
            operationKey: envelope.operationKey,
            generation,
            response: { available: true },
          });
        },
      },
    });
    expect(() => mismatched.request({ kind: 'import-usage', file: 'src/mismatch.ts' })).toThrow(
      'incompatible response',
    );
    service.closeTypeScriptService();
    db.close();
  });

  it('rejects old numeric symbol identifiers after publication moves to a conflicting generation', () => {
    const fixture = serviceFixture(true);
    const oldDb = fixture.openDb();
    const candidateDir = join(fixture.projectRoot, 'candidate');
    mkdirSync(candidateDir);
    const candidateDbPath = join(candidateDir, 'index.db');
    const candidateScipPath = join(candidateDir, 'index.scip');
    const candidateMetaPath = join(candidateDir, 'meta.json');
    copyFileSync(join(fixture.projectRoot, 'index.db'), candidateDbPath);
    const candidate = new Database(candidateDbPath);
    candidate
      .prepare('UPDATE global_symbols SET symbol = ?, display_name = ? WHERE id = 7')
      .run('scip-query npm new/New#', 'New');
    candidate.close();
    writeFileSync(candidateScipPath, 'new-generation-scip');
    writeFileSync(
      candidateMetaPath,
      JSON.stringify({
        version: 3,
        status: 'complete',
        updatedAt: '2026-07-09T23:01:00.000Z',
        fingerprint: projectSnapshot('consumer-v2'),
        indexedLanguages: ['typescript'],
      }),
    );

    const publication = promoteReindexArtifacts({
      tempOutputScip: candidateScipPath,
      tempOutputDb: candidateDbPath,
      tempMetaPath: candidateMetaPath,
      outputScip: join(fixture.projectRoot, 'index.scip'),
      outputDb: join(fixture.projectRoot, 'index.db'),
      metaPath: join(fixture.projectRoot, 'meta.json'),
    });
    const currentDb = fixture.openDb();
    const service = new TypeScriptSemanticServiceHost({
      openDb: fixture.openDb,
      createHost: fakeSemanticHost,
    });
    try {
      expect(oldDb.get<{ symbol: string }>('SELECT symbol FROM global_symbols WHERE id = 7')?.symbol).toContain(
        'old/Old#',
      );
      expect(currentDb.get<{ symbol: string }>('SELECT symbol FROM global_symbols WHERE id = 7')?.symbol).toContain(
        'new/New#',
      );
      expect(currentDb.generation.identity).toBe(publication.currentGeneration);
      expect(() => service.handle(oldDb.generation.identity, { kind: 'availability' })).toThrow(
        'does not match the currently published index generation',
      );
      expect(service.handle(currentDb.generation.identity, { kind: 'availability' })).toEqual(
        expect.objectContaining({ available: true }),
      );
    } finally {
      service.closeTypeScriptService();
      oldDb.close();
      currentDb.close();
    }
  });

  it('abandons a request promptly when the service dies and bounds a live-service timeout', () => {
    const fixture = serviceFixture(true);
    const db = fixture.openDb();
    const paths = typeScriptSemanticMailboxPaths(fixture.projectRoot);
    const statePath = join(fixture.projectRoot, 'watch-state.json');
    writeLiveState(statePath, fixture.projectRoot);
    const crashed = new TypeScriptSemanticRequester(db, {
      timeoutMs: 1_000,
      runtime: {
        now: () => NOW,
        randomId: () => 'request-crash',
        isProcessAlive: () => true,
        sleep: () => rmSync(statePath, { force: true }),
      },
    });
    expect(() => crashed.request({ kind: 'availability' })).toThrow('stopped while processing');
    expect(readdirSync(paths.pendingDir).filter((entry) => entry.endsWith('.json'))).toHaveLength(1);

    writeLiveState(statePath, fixture.projectRoot);
    let nowMs = NOW;
    let monotonicNowMs = 0;
    const timedOut = new TypeScriptSemanticRequester(db, {
      timeoutMs: 20,
      runtime: {
        now: () => nowMs,
        monotonicNow: () => monotonicNowMs,
        randomId: () => 'request-timeout',
        isProcessAlive: () => true,
        sleep: (durationMs) => {
          monotonicNowMs += durationMs;
          nowMs = nowMs === NOW ? NOW - 86_400_000 : NOW + 86_400_000;
        },
      },
    });
    expect(() => timedOut.request({ kind: 'import-usage', file: 'src/timeout.ts' })).toThrow('timed out');
    expect(monotonicNowMs).toBeGreaterThanOrEqual(20);
    expect(readdirSync(paths.pendingDir).filter((entry) => entry.endsWith('.json'))).toHaveLength(2);
    db.close();
  });

  it('caches remote availability for the command-scoped provider', () => {
    const fixture = serviceFixture(true);
    const db = fixture.openDb();
    const paths = typeScriptSemanticMailboxPaths(fixture.projectRoot);
    const statePath = join(fixture.projectRoot, 'watch-state.json');
    const service = new TypeScriptSemanticServiceHost({ openDb: fixture.openDb, createHost: fakeSemanticHost });
    writeLiveState(statePath, fixture.projectRoot);
    let requestNumber = 0;
    const provider = createServiceBackedTypeScriptProvider(db, undefined, {
      timeoutMs: 1_000,
      runtime: {
        now: () => NOW,
        randomId: () => `availability-${++requestNumber}`,
        isProcessAlive: () => true,
        sleep: () => {
          processTypeScriptSemanticMailbox(paths, service, { nowMs: NOW });
        },
      },
    });

    expect(provider.availability()).toEqual({ available: true, tsconfigPaths: ['tsconfig.json'] });
    expect(provider.availability()).toEqual({ available: true, tsconfigPaths: ['tsconfig.json'] });
    expect(service.status().requests).toBe(1);
    service.closeTypeScriptService();
    db.close();
  });

  it('forwards exact reference batches through one mailbox request', () => {
    const fixture = serviceFixture(true);
    const db = fixture.openDb();
    const paths = typeScriptSemanticMailboxPaths(fixture.projectRoot);
    const statePath = join(fixture.projectRoot, 'watch-state.json');
    const service = new TypeScriptSemanticServiceHost({ openDb: fixture.openDb, createHost: fakeSemanticHost });
    writeLiveState(statePath, fixture.projectRoot);
    let requestNumber = 0;
    const provider = createServiceBackedTypeScriptProvider(db, undefined, {
      timeoutMs: 1_000,
      runtime: {
        now: () => NOW,
        randomId: () => `references-${++requestNumber}`,
        isProcessAlive: () => true,
        sleep: () => {
          processTypeScriptSemanticMailbox(paths, service, { nowMs: NOW });
        },
      },
    });
    const definition: IndexedDefinition = {
      symbolId: 1,
      documentId: 1,
      symbol: 'fixture/exact().',
      relativePath: 'src/consumer.ts',
      leaf: 'exact',
      startLine: 0,
      endLine: 0,
      parentTypeName: null,
      isFunctionLike: true,
      isTypeLike: false,
      kind: 12,
      documentation: null,
      enclosingSymbol: null,
    };

    expect(provider.referencesForDefinitions?.([definition], { exact: true }).get(1)).toEqual([
      { file: 'src/exact-consumer.ts', line: 1, column: 0 },
    ]);
    expect(service.status().requests).toBe(1);
    service.closeTypeScriptService();
    db.close();
  });

  it('applies each request profile identity inside the persistent service and restores its own environment', () => {
    const fixture = serviceFixture();
    const paths = typeScriptSemanticMailboxPaths(fixture.projectRoot);
    const observed: Array<Record<string, string | undefined>> = [];
    const previous = captureProfileEnvironment();
    const service = new TypeScriptSemanticServiceHost({
      openDb: fixture.openDb,
      generationIdentity: () => 'current',
      readSnapshot: () => projectSnapshot('current'),
      createHost: (db) =>
        new TypeScriptSemanticHost(db, {
          loadModule: () => loadTsMorph(),
          discoverTsconfigs: () => ['tsconfig.json'],
          createProjects: () => [],
          createProvider: () => ({
            ...fakeProvider(),
            availability: () => {
              observed.push({
                runId: process.env['SCIP_QUERY_PROFILE_RUN_ID'],
                workloadIdentity: process.env['SCIP_QUERY_PROFILE_WORKLOAD_IDENTITY'],
              });
              return { available: true, tsconfigPaths: ['tsconfig.json'] };
            },
          }),
        }),
    });

    try {
      writeRequest(paths.requestDir, 'profiled', 'current', { kind: 'availability' }, NOW + 1_000, {
        SCIP_QUERY_PROFILE: '1',
        SCIP_QUERY_PROFILE_RUN_ID: 'request-run',
        SCIP_QUERY_PROFILE_WORKLOAD_IDENTITY: 'request-workload',
        SCIP_QUERY_PROFILE_WORKLOAD_IDENTITY_KIND: 'published-project',
      });
      expect(processTypeScriptSemanticMailbox(paths, service, { nowMs: NOW })).toBe(1);
      expect(observed).toEqual([
        { runId: 'request-run', workloadIdentity: 'request-workload' },
        { runId: 'request-run', workloadIdentity: 'request-workload' },
      ]);
      expect(captureProfileEnvironment()).toEqual(previous);
    } finally {
      service.closeTypeScriptService();
    }
  });
});

function serviceFixture(withMetadata = false): {
  projectRoot: string;
  openDb: (projectRootOverride?: string) => ScipDatabase;
} {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'scip-query-ts-mailbox-')));
  tempDirs.push(projectRoot);
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, 'src/consumer.ts'), 'export const value = 1;\n');
  writeFileSync(join(projectRoot, 'tsconfig.json'), '{}');
  const dbPath = join(projectRoot, 'index.db');
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/consumer.ts')
    .symbol(7, 'scip-query npm old/Old#', 'Old')
    .chunk(1, 1, 0, 0)
    .write();
  if (withMetadata) {
    writeFileSync(
      join(projectRoot, 'meta.json'),
      JSON.stringify({
        version: 3,
        status: 'complete',
        updatedAt: '2026-07-09T23:00:00.000Z',
        fingerprint: projectSnapshot('consumer-v1'),
        indexedLanguages: ['typescript'],
      }),
    );
  }
  return {
    projectRoot,
    openDb: (projectRootOverride = projectRoot) =>
      new ScipDatabase({ projectRoot: projectRootOverride, dbPath, indexPath: join(projectRoot, 'index.scip') }),
  };
}

function symbolicLinkTo(target: string, prefix: string): string {
  const alias = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(alias);
  rmSync(alias, { recursive: true, force: true });
  symlinkSync(target, alias, 'dir');
  return alias;
}

function fakeSemanticHost(db: ScipDatabase): TypeScriptSemanticHost {
  return new TypeScriptSemanticHost(db, {
    loadModule: () => loadTsMorph(),
    discoverTsconfigs: () => ['tsconfig.json'],
    createProjects: () => [],
    createProvider: () => fakeProvider(),
  });
}

function fakeProvider(): SemanticProvider {
  return {
    language: 'typescript',
    availability: () => ({ available: true, tsconfigPaths: ['tsconfig.json'] }),
    importUsage: () => [],
    referencesFor: () => [],
    referencesForDefinitions: (definitions, opts) =>
      new Map(
        definitions.map((definition) => [
          definition.symbolId,
          opts?.exact ? [{ file: 'src/exact-consumer.ts', line: 1, column: 0 }] : [],
        ]),
      ),
    referenceFragmentsForFiles: (files) => new Map(files.map((file) => [file, []])),
    calleesFor: () => [],
    calleesForDefinitions: (definitions) => new Map(definitions.map((definition) => [definition.symbolId, []])),
    signatureFor: () => null,
  };
}

function projectSnapshot(sourceHash: string): ProjectInputSnapshot {
  return {
    version: 2,
    languages: ['typescript'],
    pnpmWorkspaces: false,
    typescriptProjectMode: 'single',
    typescriptProjects: [],
    files: [
      { path: 'src/consumer.ts', size: 10, hash: sourceHash },
      { path: 'tsconfig.json', size: 2, hash: 'config-v1' },
    ],
  };
}

function writeRequest(
  requestDir: string,
  id: string,
  generation: string,
  request: { kind: 'availability' } | { kind: 'import-usage'; file: string },
  deadlineAtMs = NOW + 1_000,
  profileEnvironment?: Record<string, string | null>,
): void {
  writeJsonAtomic(join(requestDir, `${id}.json`), {
    protocolVersion: TYPESCRIPT_SEMANTIC_LEGACY_PROTOCOL_VERSION,
    id,
    generation,
    deadlineAtMs,
    ...(profileEnvironment ? { profileEnvironment } : {}),
    request,
  });
}

function onlyPendingEnvelope(pendingDir: string): {
  id: string;
  operationKey: string;
} {
  const files = readdirJson(pendingDir);
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(pendingDir, files[0]!), 'utf8')) as {
    id: string;
    operationKey: string;
  };
}

function readdirJson(directory: string): string[] {
  return readdirSync(directory).filter((entry) => entry.endsWith('.json'));
}

function readResponse(responseDir: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(responseDir, `${id}.json`), 'utf8')) as Record<string, unknown>;
}

function writeLiveState(statePath: string, projectRoot: string, processIdentity?: ProcessIdentity): void {
  writeWatchServiceState(statePath, {
    version: 1,
    protocolVersion: WATCH_SERVICE_PROTOCOL_VERSION,
    pid: 123,
    ...(processIdentity ? { processIdentity } : {}),
    projectRoot,
    cliVersion: '0.15.0',
    startedAt: new Date(NOW - 1_000).toISOString(),
    heartbeatAt: new Date(NOW).toISOString(),
    lastActivityAt: new Date(NOW).toISOString(),
    watcher: { state: 'idle' },
    typescriptSemantic: {
      protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
      state: 'idle',
      requests: 0,
      sessionsCreated: 0,
      sessionsReused: 0,
      sessionsRefreshed: 0,
      sessionsReplaced: 0,
      projectsCreated: 0,
    },
  });
}
