import {
  existsSync,
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
import { afterEach, describe, expect, test } from 'vitest';
import {
  createTypeScriptDocumentEmitter,
  loadTypeScriptDocumentRuntime,
} from '../../src/reindex/typescript-document-emitter.js';
import {
  TypeScriptIndexMemoryPressureError,
  TypeScriptIndexRequester,
  type RequestedTypeScriptDocuments,
  type TypeScriptIndexRequesterRuntime,
} from '../../src/reindex/typescript-index-requester.js';
import {
  TypeScriptIndexServiceHost,
  initializeTypeScriptIndexMailbox,
  processTypeScriptIndexMailbox,
} from '../../src/reindex/typescript-index-service.js';
import {
  TYPESCRIPT_INDEX_PROTOCOL_VERSION,
  TYPESCRIPT_INDEX_LEGACY_PROTOCOL_VERSION,
  TYPESCRIPT_INDEX_PREVIOUS_PROTOCOL_VERSION,
  parseTypeScriptIndexEnvelope,
  typeScriptIndexMailboxPaths,
  type TypeScriptIndexDocumentRequest,
} from '../../src/reindex/typescript-index-protocol.js';
import {
  WATCH_SERVICE_PROTOCOL_VERSION,
  watchServicePaths,
  type WatchServiceState,
} from '../../src/platform/watch-service-state.js';
import { writeWatchServiceState } from '../../src/runtime/watch-service.js';
import { writeJsonAtomic } from '../../src/storage/atomic-json.js';
import type { ProcessIdentity } from '../../src/platform/process-identity.js';
import {
  BOUNDED_MAILBOX_VERSION,
  boundedMailboxOperationKey,
  boundedMailboxRequestId,
} from '../../src/storage/bounded-mailbox.js';
import { createTypeScriptIndexMailboxLane } from '../../src/runtime/typescript-mailbox-lanes.js';
import type { RequestWorkerLike, WorkerLaneResponse } from '../../src/runtime/worker-request-lane.js';

const NOW = Date.parse('2026-07-10T08:00:00.000Z');
const SERVICE_PROCESS_IDENTITY: ProcessIdentity = {
  version: 1,
  pid: 123,
  platform: 'linux',
  startToken: 'service-owner',
};
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('TypeScript index service mailbox', () => {
  test('rejects a reused service PID when the recorded process instance changed', () => {
    const fixture = serviceFixture();
    const host = new TypeScriptIndexServiceHost({
      projectRoot: fixture.projectRoot,
      currentGeneration: () => 'base',
      now: () => NOW,
    });
    writeLiveState(fixture.cacheDir, fixture.projectRoot, host.status(), SERVICE_PROCESS_IDENTITY);
    let localCalls = 0;
    const requester = new TypeScriptIndexRequester(
      { projectRoot: fixture.projectRoot, cacheDir: fixture.cacheDir, baseGeneration: 'base' },
      {
        timeoutMs: 1_000,
        emitLocally: (request) => {
          localCalls += 1;
          return {
            producerIdentity: request.producerIdentity,
            cold: true,
            durationMs: 1,
            fragments: [
              {
                relativePath: 'src/a.ts',
                bytes: new Uint8Array([1]),
                occurrences: 1,
                symbols: 1,
                referenceFragments: [],
              },
            ],
          };
        },
        runtime: {
          now: () => NOW + 365 * 86_400_000,
          randomId: () => 'reused-pid',
          isProcessAlive: () => true,
          readProcessIdentity: () => ({ ...SERVICE_PROCESS_IDENTITY, startToken: 'successor' }),
          sleep: () => {
            throw new Error('request should not be admitted');
          },
        },
      },
    );

    expect(requester.request(indexRequest('producer'))).toEqual(
      expect.objectContaining({
        producerIdentity: 'producer',
        cold: true,
        fragments: [expect.objectContaining({ relativePath: 'src/a.ts' })],
      }),
    );
    expect(localCalls).toBe(1);
  });

  test('emits locally when the watch service heartbeat is stale', () => {
    const fixture = serviceFixture();
    const host = new TypeScriptIndexServiceHost({
      projectRoot: fixture.projectRoot,
      currentGeneration: () => 'base',
      now: () => NOW,
    });
    writeLiveState(fixture.cacheDir, fixture.projectRoot, host.status());
    let localCalls = 0;
    const requester = new TypeScriptIndexRequester(
      { projectRoot: fixture.projectRoot, cacheDir: fixture.cacheDir, baseGeneration: 'base' },
      {
        timeoutMs: 1_000,
        emitLocally: (request) => {
          localCalls += 1;
          return {
            producerIdentity: request.producerIdentity,
            cold: true,
            durationMs: 1,
            fragments: [
              {
                relativePath: 'src/a.ts',
                bytes: new Uint8Array([1]),
                occurrences: 1,
                symbols: 1,
                referenceFragments: [],
              },
            ],
          };
        },
        runtime: {
          now: () => NOW + 30_000,
          randomId: () => 'stale-heartbeat',
          isProcessAlive: () => true,
          sleep: () => {
            throw new Error('stale watch service should not be polled');
          },
        },
      },
    );

    expect(requester.request(indexRequest('producer')).cold).toBe(true);
    expect(localCalls).toBe(1);
  });

  test('does not load the compiler into a caller that requires the isolated service', () => {
    const fixture = serviceFixture();
    let localCalls = 0;
    const requester = new TypeScriptIndexRequester(
      { projectRoot: fixture.projectRoot, cacheDir: fixture.cacheDir, baseGeneration: 'base' },
      {
        requireService: true,
        emitLocally: (request) => {
          localCalls += 1;
          return localEmit(request);
        },
      },
    );

    expect(() => requester.request(indexRequest('producer'))).toThrow(
      'refusing to load the whole compiler graph inside the reindex process',
    );
    expect(localCalls).toBe(0);
  });

  test('processes a cold request and a warm requester update with exact identities', () => {
    const availability = loadTypeScriptDocumentRuntime();
    expect(availability.available).toBe(true);
    if (!availability.available) return;
    const fixture = serviceFixture();
    const projectAlias = symbolicLinkTo(fixture.projectRoot, 'scip-query-index-mailbox-alias-');
    let generation = 'base-generation-1';
    const host = new TypeScriptIndexServiceHost({
      projectRoot: fixture.projectRoot,
      currentGeneration: () => generation,
      now: () => NOW,
    });
    const paths = typeScriptIndexMailboxPaths(fixture.cacheDir);
    initializeTypeScriptIndexMailbox(paths);

    writeRequest(paths.requestDir, 'cold', generation, indexRequest(availability.producerIdentity));
    expect(processTypeScriptIndexMailbox(paths, host, { nowMs: NOW })).toBe(1);
    const cold = readResponse(paths.responseDir, 'cold');
    expect(cold).toEqual(
      expect.objectContaining({
        ok: true,
        id: 'cold',
        baseGeneration: generation,
        response: expect.objectContaining({ cold: true, producerIdentity: availability.producerIdentity }),
      }),
    );
    expect((cold.response as { fragments: unknown[] }).fragments).toHaveLength(1);

    writeFileSync(join(fixture.projectRoot, 'src/a.ts'), 'export const value = 2;\n');
    writeLiveState(fixture.cacheDir, fixture.projectRoot, host.status());
    let processed = false;
    const requester = new TypeScriptIndexRequester(
      { projectRoot: projectAlias, cacheDir: fixture.cacheDir, baseGeneration: generation },
      {
        timeoutMs: 1_000,
        runtime: {
          now: () => NOW,
          randomId: () => 'warm',
          isProcessAlive: () => true,
          sleep: () => {
            if (processed) return;
            processed = true;
            processTypeScriptIndexMailbox(paths, host, { nowMs: NOW });
            writeLiveState(fixture.cacheDir, fixture.projectRoot, host.status());
          },
        },
      },
    );
    const warm = requester.request(indexRequest(availability.producerIdentity));
    expect(warm.cold).toBe(false);
    expect(warm.fragments).toEqual([
      expect.objectContaining({ relativePath: 'src/a.ts', bytes: expect.any(Uint8Array) }),
    ]);
    expect(host.status()).toEqual(
      expect.objectContaining({ requests: 2, sessionsCreated: 1, initializations: 1, programUpdates: 1 }),
    );

    mkdirSync(join(fixture.projectRoot, 'apps/web/src'), { recursive: true });
    mkdirSync(join(fixture.projectRoot, 'packages/shared'), { recursive: true });
    writeFileSync(join(fixture.projectRoot, 'packages/shared/value.ts'), 'export const shared = 1;\n');
    writeFileSync(
      join(fixture.projectRoot, 'apps/web/src/b.ts'),
      "import { shared } from '../../../packages/shared/value.js';\nexport const result = shared;\n",
    );
    writeFileSync(
      join(fixture.projectRoot, 'apps/web/tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
        include: ['src/**/*.ts'],
      }),
    );
    const crossProject = host.handle(generation, {
      kind: 'emit-documents',
      tsconfigPath: 'apps/web/tsconfig.json',
      projectArgument: 'apps/web',
      projectIdentity: 'fixture-project-v1',
      producerIdentity: availability.producerIdentity,
      modifiedFiles: ['packages/shared/value.ts'],
      affectedFiles: ['apps/web/src/b.ts'],
    });
    expect(crossProject).toEqual(
      expect.objectContaining({
        cold: true,
        fragments: [expect.objectContaining({ relativePath: 'apps/web/src/b.ts' })],
      }),
    );

    writeFileSync(join(fixture.projectRoot, 'src/a.ts'), 'export const value = 3;\n');
    const rootAgain = host.handle(generation, indexRequest(availability.producerIdentity));
    expect(rootAgain.cold).toBe(false);
    expect(host.status()).toEqual(
      expect.objectContaining({ requests: 4, sessionsCreated: 2, initializations: 2, programUpdates: 2 }),
    );

    generation = 'base-generation-2';
    writeRequest(paths.requestDir, 'stale', 'base-generation-1', indexRequest(availability.producerIdentity));
    expect(processTypeScriptIndexMailbox(paths, host, { nowMs: NOW })).toBe(1);
    expect(readResponse(paths.responseDir, 'stale')).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('currently published generation') }),
    );
    expect(host.status().requests).toBe(4);
  });

  test('keeps recently used compiler sessions warm within a fixed memory budget', () => {
    const availability = loadTypeScriptDocumentRuntime();
    expect(availability.available).toBe(true);
    if (!availability.available) return;
    const fixture = serviceFixture();
    const activeSessionsAtCreation: number[] = [];
    const hostRef: { current: TypeScriptIndexServiceHost | null } = { current: null };
    const host = new TypeScriptIndexServiceHost({
      projectRoot: fixture.projectRoot,
      currentGeneration: () => 'base',
      maxActiveSessions: 2,
      createEmitter: (options) => {
        activeSessionsAtCreation.push(hostRef.current?.status().activeSessions ?? -1);
        return createTypeScriptDocumentEmitter(options);
      },
    });
    hostRef.current = host;
    const requestFor = (project: string): TypeScriptIndexDocumentRequest => {
      const sourcePath = `${project}/src/value.ts`;
      mkdirSync(join(fixture.projectRoot, project, 'src'), { recursive: true });
      writeFileSync(join(fixture.projectRoot, sourcePath), `export const value = '${project}';\n`);
      writeFileSync(
        join(fixture.projectRoot, project, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext' }, include: ['src/**/*.ts'] }),
      );
      return {
        kind: 'emit-documents',
        tsconfigPath: `${project}/tsconfig.json`,
        projectArgument: project,
        projectIdentity: 'fixture-project-v1',
        producerIdentity: availability.producerIdentity,
        modifiedFiles: [sourcePath],
        affectedFiles: [sourcePath],
      };
    };

    const first = requestFor('packages/first');
    const second = requestFor('packages/second');
    const third = requestFor('packages/third');
    expect(host.handle('base', first).cold).toBe(true);
    expect(host.handle('base', second).cold).toBe(true);
    expect(host.handle('base', first).cold).toBe(false);
    expect(host.handle('base', third).cold).toBe(true);
    expect(host.handle('base', second).cold).toBe(true);
    expect(host.status()).toEqual(
      expect.objectContaining({
        sessionsCreated: 4,
        sessionsEvicted: 2,
        activeSessions: 2,
        maxActiveSessions: 2,
      }),
    );
    expect(activeSessionsAtCreation).toEqual([0, 1, 1, 1]);
  });

  test('reports heap high-water pressure so the parent can retire the Worker after its response', () => {
    const fixture = serviceFixture();
    const mebibyte = 1024 * 1024;
    const host = new TypeScriptIndexServiceHost({
      projectRoot: fixture.projectRoot,
      currentGeneration: () => 'base',
      softMemoryLimitMb: 600,
      memoryUsage: () => ({ heapUsedBytes: 700 * mebibyte, heapLimitBytes: 1024 * mebibyte }),
    });

    expect(host.status()).toEqual(
      expect.objectContaining({
        heapUsedBytes: 700 * mebibyte,
        heapLimitBytes: 1024 * mebibyte,
        softMemoryLimitBytes: 600 * mebibyte,
        retireRequested: true,
      }),
    );
  });

  test('classifies terminal Worker OOM responses as memory pressure', () => {
    const fixture = serviceFixture();
    const paths = typeScriptIndexMailboxPaths(fixture.cacheDir);
    initializeTypeScriptIndexMailbox(paths);
    const host = new TypeScriptIndexServiceHost({
      projectRoot: fixture.projectRoot,
      currentGeneration: () => 'base',
    });
    writeLiveState(fixture.cacheDir, fixture.projectRoot, host.status());
    const requester = requesterWithRuntime(fixture, {
      now: () => NOW,
      randomId: () => 'oom',
      isProcessAlive: () => true,
      sleep: () => {
        const envelope = onlyPendingEnvelope(paths.pendingDir);
        writeJsonAtomic(join(paths.responseDir, `${envelope.id}.json`), {
          ok: false,
          protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
          id: envelope.id,
          operationKey: envelope.operationKey,
          error: 'TypeScript index worker failed: Worker terminated due to reaching memory limit',
        });
        rmSync(envelope.requestPath, { force: true });
      },
    });

    expect(() => requester.request(indexRequest('producer-oom'))).toThrow(TypeScriptIndexMemoryPressureError);
  });

  test('rejects malformed/expired work and bounds requester crash and timeout paths', () => {
    const fixture = serviceFixture();
    const paths = typeScriptIndexMailboxPaths(fixture.cacheDir);
    const host = new TypeScriptIndexServiceHost({
      projectRoot: fixture.projectRoot,
      currentGeneration: () => 'base',
      now: () => NOW,
    });
    initializeTypeScriptIndexMailbox(paths);
    writeFileSync(join(paths.requestDir, 'malformed.json'), '{');
    writeJsonAtomic(join(paths.requestDir, 'expired.json'), {
      protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
      id: 'expired',
      baseGeneration: 'base',
      deadlineAtMs: NOW - 1,
      request: indexRequest('producer'),
    });
    expect(processTypeScriptIndexMailbox(paths, host, { nowMs: NOW })).toBe(2);
    expect(readResponse(paths.responseDir, 'malformed')).toEqual(expect.objectContaining({ ok: false }));
    expect(readResponse(paths.responseDir, 'expired')).toEqual(expect.objectContaining({ ok: false }));
    writeFileSync(join(paths.requestDir, 'oversized.json'), 'x'.repeat(2_000));
    expect(
      processTypeScriptIndexMailbox(paths, host, {
        nowMs: NOW,
        limits: { maxItemBytes: 512 },
      }),
    ).toBe(1);
    expect(readResponse(paths.responseDir, 'oversized')).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('per-item limit') }),
    );

    writeLiveState(fixture.cacheDir, fixture.projectRoot, host.status());
    const omitted = requesterWithRuntime(fixture, {
      now: () => NOW,
      randomId: () => 'omitted',
      isProcessAlive: () => true,
      sleep: () => {
        const envelope = onlyPendingEnvelope(paths.pendingDir);
        writeJsonAtomic(join(paths.responseDir, `${envelope.id}.json`), {
          ok: true,
          protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
          id: envelope.id,
          operationKey: envelope.operationKey,
          baseGeneration: 'base',
          response: { producerIdentity: 'producer-omitted', cold: false, durationMs: 1, fragments: [] },
        });
        rmSync(envelope.requestPath, { force: true });
      },
    });
    expect(() => omitted.request(indexRequest('producer-omitted'))).toThrow('omitted or added an affected document');

    const missingReferences = requesterWithRuntime(fixture, {
      now: () => NOW,
      randomId: () => 'missing-references',
      isProcessAlive: () => true,
      sleep: () => {
        const envelope = onlyPendingEnvelope(paths.pendingDir);
        writeJsonAtomic(join(paths.responseDir, `${envelope.id}.json`), {
          ok: true,
          protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
          id: envelope.id,
          operationKey: envelope.operationKey,
          baseGeneration: 'base',
          response: {
            producerIdentity: 'producer-missing',
            cold: false,
            durationMs: 1,
            fragments: [{ relativePath: 'src/a.ts', bytesBase64: null, occurrences: 0, symbols: 0 }],
          },
        });
        rmSync(envelope.requestPath, { force: true });
      },
    });
    expect(() => missingReferences.request(indexRequest('producer-missing'))).toThrow('invalid fragment');

    const statePath = watchServicePaths(fixture.cacheDir).statePath;
    const crashed = new TypeScriptIndexRequester(
      { projectRoot: fixture.projectRoot, cacheDir: fixture.cacheDir, baseGeneration: 'base' },
      {
        timeoutMs: 1_000,
        emitLocally: localEmit,
        runtime: {
          now: () => NOW,
          randomId: () => 'crash',
          isProcessAlive: () => true,
          sleep: () => rmSync(statePath, { force: true }),
        },
      },
    );
    expect(crashed.request(indexRequest('producer-crash'))).toEqual(
      expect.objectContaining({ producerIdentity: 'producer-crash', cold: true }),
    );
    expect(readdirSync(paths.pendingDir).filter((entry) => entry.endsWith('.json'))).toHaveLength(1);

    writeLiveState(fixture.cacheDir, fixture.projectRoot, host.status());
    let monotonicNowMs = 0;
    const timedOut = new TypeScriptIndexRequester(
      { projectRoot: fixture.projectRoot, cacheDir: fixture.cacheDir, baseGeneration: 'base' },
      {
        timeoutMs: 20,
        emitLocally: localEmit,
        runtime: {
          now: () => NOW,
          monotonicNow: () => monotonicNowMs,
          randomId: () => 'timeout',
          isProcessAlive: () => true,
          sleep: (durationMs) => {
            monotonicNowMs += durationMs;
          },
        },
      },
    );
    expect(timedOut.request(indexRequest('producer-timeout'))).toEqual(
      expect.objectContaining({ producerIdentity: 'producer-timeout', cold: true }),
    );
    expect(monotonicNowMs).toBeGreaterThanOrEqual(20);
    expect(readdirSync(paths.pendingDir).filter((entry) => entry.endsWith('.json'))).toHaveLength(2);
  });

  test('rechecks each deadline so later batch work cannot execute after earlier work advances time', () => {
    const availability = loadTypeScriptDocumentRuntime();
    expect(availability.available).toBe(true);
    if (!availability.available) return;
    const fixture = serviceFixture();
    const paths = typeScriptIndexMailboxPaths(fixture.cacheDir);
    const host = new TypeScriptIndexServiceHost({
      projectRoot: fixture.projectRoot,
      currentGeneration: () => 'base',
      now: () => NOW,
    });
    initializeTypeScriptIndexMailbox(paths);
    writeRequest(paths.requestDir, 'first', 'base', indexRequest(availability.producerIdentity));
    writeRequest(paths.requestDir, 'second', 'base', indexRequest(availability.producerIdentity));
    let currentTime = NOW;
    let started = 0;

    expect(
      processTypeScriptIndexMailbox(paths, host, {
        now: () => currentTime,
        beforeRequest: () => {
          started += 1;
          currentTime = NOW + 2_000;
        },
      }),
    ).toBe(2);

    expect(started).toBe(1);
    expect(host.status().requests).toBe(1);
    expect(readResponse(paths.responseDir, 'first')).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('expired while') }),
    );
    expect(readResponse(paths.responseDir, 'second')).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('expired before') }),
    );
  });

  test('parses only complete versioned requests', () => {
    const request = indexRequest('producer');
    const operationKey = boundedMailboxOperationKey('typescript-index-v4', {
      baseGeneration: 'generation',
      request,
    });
    const valid = {
      mailboxVersion: BOUNDED_MAILBOX_VERSION,
      protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
      id: boundedMailboxRequestId(operationKey),
      operationKey,
      clientId: 'client',
      enqueuedAtMs: NOW - 1,
      baseGeneration: 'generation',
      deadlineAtMs: NOW,
      request,
    };
    expect(parseTypeScriptIndexEnvelope(JSON.stringify(valid))).toEqual(valid);
    const previousOperationKey = boundedMailboxOperationKey('typescript-index-v3', {
      baseGeneration: 'generation',
      request,
    });
    expect(
      parseTypeScriptIndexEnvelope(
        JSON.stringify({
          ...valid,
          protocolVersion: TYPESCRIPT_INDEX_PREVIOUS_PROTOCOL_VERSION,
          id: boundedMailboxRequestId(previousOperationKey),
          operationKey: previousOperationKey,
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
        id: boundedMailboxRequestId(previousOperationKey),
      }),
    );
    expect(() =>
      parseTypeScriptIndexEnvelope(JSON.stringify({ ...valid, request: { ...valid.request, affectedFiles: [] } })),
    ).toThrow('invalid mailbox request');
    const dependencyRequest = { ...valid.request, affectedFiles: ['src/other.ts'] };
    const dependencyOperationKey = boundedMailboxOperationKey('typescript-index-v4', {
      baseGeneration: 'generation',
      request: dependencyRequest,
    });
    expect(
      parseTypeScriptIndexEnvelope(
        JSON.stringify({
          ...valid,
          id: boundedMailboxRequestId(dependencyOperationKey),
          operationKey: dependencyOperationKey,
          request: dependencyRequest,
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        request: expect.objectContaining({ modifiedFiles: ['src/a.ts'], affectedFiles: ['src/other.ts'] }),
      }),
    );
  });

  test('lets the parent claim and commit an isolated Worker result exactly once', async () => {
    const fixture = serviceFixture();
    const paths = typeScriptIndexMailboxPaths(fixture.cacheDir);
    initializeTypeScriptIndexMailbox(paths);
    writeRequest(paths.requestDir, 'isolated', 'base', indexRequest('producer'));
    const worker = new FakeIndexWorker();
    let workerData: unknown;
    const lane = createTypeScriptIndexMailboxLane({
      paths,
      projectRoot: fixture.projectRoot,
      dbPath: join(fixture.cacheDir, 'index.db'),
      maxActiveSessions: 2,
      workerSoftMemoryMb: 6144,
      now: () => NOW,
      createWorker: (data) => {
        workerData = data;
        return worker;
      },
      onFatal: (error) => {
        throw error;
      },
    });

    expect(lane.poll()).toBe(1);
    expect(workerData).toEqual(
      expect.objectContaining({ kind: 'index', maxActiveSessions: 2, softMemoryLimitMb: 6144 }),
    );
    expect(worker.posts).toHaveLength(1);
    expect(existsSync(join(paths.responseDir, 'isolated.json'))).toBe(false);
    const status = new TypeScriptIndexServiceHost({
      projectRoot: fixture.projectRoot,
      currentGeneration: () => 'base',
    }).status();
    const response: WorkerLaneResponse<
      { producerIdentity: string; cold: boolean; durationMs: number; fragments: [] },
      typeof status
    > = {
      kind: 'response',
      requestId: 'isolated',
      ok: true,
      result: { producerIdentity: 'producer', cold: true, durationMs: 1, fragments: [] },
      status,
    };
    worker.emitMessage(response);
    worker.emitMessage(response);

    expect(readResponse(paths.responseDir, 'isolated')).toEqual(
      expect.objectContaining({
        ok: true,
        id: 'isolated',
        baseGeneration: 'base',
        response: expect.objectContaining({ producerIdentity: 'producer' }),
      }),
    );
    expect(readdirSync(paths.responseDir).filter((entry) => entry === 'isolated.json')).toHaveLength(1);
    await lane.close();
  });

  test('rejects an oversized Worker result without closing the mailbox lane', async () => {
    const fixture = serviceFixture();
    const paths = typeScriptIndexMailboxPaths(fixture.cacheDir);
    initializeTypeScriptIndexMailbox(paths);
    writeRequest(paths.requestDir, 'oversized', 'base', indexRequest('producer'));
    const worker = new FakeIndexWorker();
    const fatal: string[] = [];
    const lane = createTypeScriptIndexMailboxLane({
      paths,
      projectRoot: fixture.projectRoot,
      dbPath: join(fixture.cacheDir, 'index.db'),
      limits: { maxItemBytes: 2_048 },
      now: () => NOW,
      createWorker: () => worker,
      onFatal: (error) => fatal.push(error.message),
    });

    expect(lane.poll()).toBe(1);
    const status = new TypeScriptIndexServiceHost({
      projectRoot: fixture.projectRoot,
      currentGeneration: () => 'base',
    }).status();
    worker.emitMessage({
      kind: 'response',
      requestId: 'oversized',
      ok: true,
      result: {
        producerIdentity: 'producer',
        cold: true,
        durationMs: 1,
        fragments: [
          {
            relativePath: 'src/a.ts',
            bytesBase64: 'A'.repeat(4_096),
            occurrences: 0,
            symbols: 0,
            referenceFragments: [],
          },
        ],
      },
      status,
    });

    expect(fatal).toEqual([]);
    expect(readResponse(paths.responseDir, 'oversized')).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('per-item limit'),
      }),
    );
    expect(lane.status().mailbox).toEqual(expect.objectContaining({ inflight: 0, responses: 1 }));
    writeRequest(paths.requestDir, 'replacement', 'base', indexRequest('replacement-producer'));
    expect(lane.poll()).toBe(1);
    await lane.close();
  });

  test('retains an inflight claim and closes admission when durable completion fails', async () => {
    const fixture = serviceFixture();
    const paths = typeScriptIndexMailboxPaths(fixture.cacheDir);
    initializeTypeScriptIndexMailbox(paths);
    writeRequest(paths.requestDir, 'settlement-failure', 'base', indexRequest('producer'));
    const worker = new FakeIndexWorker();
    const fatal: string[] = [];
    const lane = createTypeScriptIndexMailboxLane({
      paths,
      projectRoot: fixture.projectRoot,
      dbPath: join(fixture.cacheDir, 'index.db'),
      now: () => NOW,
      createWorker: () => worker,
      onFatal: (error) => fatal.push(error.message),
    });

    expect(lane.poll()).toBe(1);
    expect(lane.status().mailbox).toEqual(expect.objectContaining({ inflight: 1, responses: 0 }));
    rmSync(paths.responseDir, { recursive: true, force: true });
    writeFileSync(paths.responseDir, 'blocks response directory creation');

    const status = new TypeScriptIndexServiceHost({
      projectRoot: fixture.projectRoot,
      currentGeneration: () => 'base',
    }).status();
    worker.emitMessage({
      kind: 'response',
      requestId: 'settlement-failure',
      ok: true,
      result: { producerIdentity: 'producer', cold: true, durationMs: 1, fragments: [] },
      status,
    } satisfies WorkerLaneResponse<
      { producerIdentity: string; cold: boolean; durationMs: number; fragments: [] },
      typeof status
    >);

    expect(fatal).toEqual([expect.any(String)]);
    rmSync(paths.responseDir, { force: true });
    mkdirSync(paths.responseDir, { recursive: true });
    expect(lane.status().mailbox).toEqual(expect.objectContaining({ inflight: 1, responses: 0 }));
    writeRequest(paths.requestDir, 'replacement', 'base', indexRequest('replacement-producer'));
    expect(lane.poll()).toBe(0);

    await lane.close('completion settlement failed');

    expect(readResponse(paths.responseDir, 'settlement-failure')).toEqual(
      expect.objectContaining({ ok: false, error: 'completion settlement failed' }),
    );
    expect(lane.status().mailbox).toEqual(expect.objectContaining({ inflight: 0, responses: 1 }));
  });
});

function serviceFixture(): { projectRoot: string; cacheDir: string } {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'scip-query-index-mailbox-')));
  tempDirs.push(projectRoot);
  const cacheDir = join(projectRoot, '.cache');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'mailbox-fixture', version: '1.0.0' }));
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['src/**/*.ts'],
    }),
  );
  writeFileSync(join(projectRoot, 'src/a.ts'), 'export const value = 1;\n');
  return { projectRoot, cacheDir };
}

function symbolicLinkTo(target: string, prefix: string): string {
  const alias = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(alias);
  rmSync(alias, { recursive: true, force: true });
  symlinkSync(target, alias, 'dir');
  return alias;
}

function indexRequest(producerIdentity: string): TypeScriptIndexDocumentRequest {
  return {
    kind: 'emit-documents',
    tsconfigPath: 'tsconfig.json',
    projectArgument: '.',
    projectIdentity: 'fixture-project-v1',
    producerIdentity,
    modifiedFiles: ['src/a.ts'],
    affectedFiles: ['src/a.ts'],
  };
}

function writeRequest(
  requestDir: string,
  id: string,
  baseGeneration: string,
  request: TypeScriptIndexDocumentRequest,
): void {
  writeJsonAtomic(join(requestDir, `${id}.json`), {
    protocolVersion: TYPESCRIPT_INDEX_LEGACY_PROTOCOL_VERSION,
    id,
    baseGeneration,
    deadlineAtMs: NOW + 1_000,
    request,
  });
}

function onlyPendingEnvelope(pendingDir: string): { id: string; operationKey: string; requestPath: string } {
  const files = readdirSync(pendingDir).filter((entry) => entry.endsWith('.json'));
  expect(files).toHaveLength(1);
  const requestPath = join(pendingDir, files[0]!);
  const envelope = JSON.parse(readFileSync(requestPath, 'utf8')) as {
    id: string;
    operationKey: string;
  };
  return { ...envelope, requestPath };
}

function readResponse(responseDir: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(responseDir, `${id}.json`), 'utf8')) as Record<string, unknown>;
}

class FakeIndexWorker implements RequestWorkerLike {
  readonly posts: unknown[] = [];
  private readonly messageListeners: Array<(value: unknown) => void> = [];

  postMessage(value: unknown): void {
    this.posts.push(value);
  }

  on(event: 'message' | 'error' | 'exit', listener: (value: never) => void): this {
    if (event === 'message') this.messageListeners.push(listener as (value: unknown) => void);
    return this;
  }

  terminate(): Promise<number> {
    return Promise.resolve(0);
  }

  emitMessage(value: unknown): void {
    for (const listener of this.messageListeners) listener(value);
  }
}

function writeLiveState(
  cacheDir: string,
  projectRoot: string,
  typescriptIndex: ReturnType<TypeScriptIndexServiceHost['status']>,
  processIdentity?: ProcessIdentity,
): void {
  const state: WatchServiceState = {
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
    typescriptIndex,
  };
  writeWatchServiceState(watchServicePaths(cacheDir).statePath, state);
}

function localEmit(request: TypeScriptIndexDocumentRequest): RequestedTypeScriptDocuments {
  return {
    producerIdentity: request.producerIdentity,
    cold: true,
    durationMs: 1,
    fragments: [
      {
        relativePath: 'src/a.ts',
        bytes: new Uint8Array([1]),
        occurrences: 1,
        symbols: 1,
        referenceFragments: [],
      },
    ],
  };
}

function requesterWithRuntime(
  fixture: { projectRoot: string; cacheDir: string },
  runtime: TypeScriptIndexRequesterRuntime,
  timeoutMs = 1_000,
): TypeScriptIndexRequester {
  return new TypeScriptIndexRequester(
    { projectRoot: fixture.projectRoot, cacheDir: fixture.cacheDir, baseGeneration: 'base' },
    { runtime, timeoutMs },
  );
}
