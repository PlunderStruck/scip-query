import {
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
import { loadTypeScriptDocumentRuntime } from '../../src/reindex/typescript-document-emitter.js';
import {
  TypeScriptIndexRequester,
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
    const requester = requesterWithRuntime(fixture, {
      now: () => NOW + 365 * 86_400_000,
      randomId: () => 'reused-pid',
      isProcessAlive: () => true,
      readProcessIdentity: () => ({ ...SERVICE_PROCESS_IDENTITY, startToken: 'successor' }),
      sleep: () => {
        throw new Error('request should not be admitted');
      },
    });

    expect(() => requester.request(indexRequest('producer'))).toThrow('Compatible TypeScript index service');
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

    generation = 'base-generation-2';
    writeRequest(paths.requestDir, 'stale', 'base-generation-1', indexRequest(availability.producerIdentity));
    expect(processTypeScriptIndexMailbox(paths, host, { nowMs: NOW })).toBe(1);
    expect(readResponse(paths.responseDir, 'stale')).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('currently published generation') }),
    );
    expect(host.status().requests).toBe(2);
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
    const crashed = requesterWithRuntime(fixture, {
      now: () => NOW,
      randomId: () => 'crash',
      isProcessAlive: () => true,
      sleep: () => rmSync(statePath, { force: true }),
    });
    expect(() => crashed.request(indexRequest('producer-crash'))).toThrow('stopped while processing');
    expect(readdirSync(paths.pendingDir).filter((entry) => entry.endsWith('.json'))).toHaveLength(1);

    writeLiveState(fixture.cacheDir, fixture.projectRoot, host.status());
    let nowMs = NOW;
    let monotonicNowMs = 0;
    const timedOut = requesterWithRuntime(
      fixture,
      {
        now: () => nowMs,
        monotonicNow: () => monotonicNowMs,
        randomId: () => 'timeout',
        isProcessAlive: () => true,
        sleep: (durationMs) => {
          monotonicNowMs += durationMs;
          nowMs = nowMs === NOW ? NOW - 86_400_000 : NOW + 86_400_000;
        },
      },
      20,
    );
    expect(() => timedOut.request(indexRequest('producer-timeout'))).toThrow('timed out');
    expect(monotonicNowMs).toBeGreaterThanOrEqual(20);
    expect(readdirSync(paths.pendingDir).filter((entry) => entry.endsWith('.json'))).toHaveLength(2);
  });

  test('parses only complete versioned requests', () => {
    const request = indexRequest('producer');
    const operationKey = boundedMailboxOperationKey('typescript-index-v3', {
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
    expect(() =>
      parseTypeScriptIndexEnvelope(JSON.stringify({ ...valid, request: { ...valid.request, affectedFiles: [] } })),
    ).toThrow('invalid mailbox request');
    expect(() =>
      parseTypeScriptIndexEnvelope(
        JSON.stringify({ ...valid, request: { ...valid.request, affectedFiles: ['src/other.ts'] } }),
      ),
    ).toThrow('invalid mailbox request');
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
