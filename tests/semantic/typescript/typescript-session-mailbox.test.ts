import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectInputSnapshot } from '../../../src/reindex/affected-set.js';
import { writeWatchServiceState, WATCH_SERVICE_PROTOCOL_VERSION } from '../../../src/runtime/watch-service.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { writeJsonAtomic } from '../../../src/storage/atomic-json.js';
import type { SemanticProvider } from '../../../src/semantic/types.js';
import { TypeScriptSemanticHost } from '../../../src/semantic/typescript/session-host.js';
import {
  initializeTypeScriptSemanticMailbox,
  processTypeScriptSemanticMailbox,
  TypeScriptSemanticServiceHost,
} from '../../../src/semantic/typescript/session-service.js';
import {
  TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
  publishedGenerationIdentity,
  typeScriptSemanticMailboxPaths,
} from '../../../src/semantic/typescript/session-protocol.js';
import { TypeScriptSemanticRequester } from '../../../src/semantic/typescript/remote-provider.js';
import { loadTsMorph } from '../../../src/semantic/typescript/ts-morph-runtime.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

const NOW = Date.parse('2026-07-09T23:00:00.000Z');
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('TypeScript semantic service mailbox', () => {
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
    initializeTypeScriptSemanticMailbox(paths);

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
    initializeTypeScriptSemanticMailbox(paths);
    writeRequest(paths.requestDir, 'expired', 'current', { kind: 'availability' }, NOW - 1);
    writeFileSync(join(paths.requestDir, 'malformed.json'), '{');
    writeRequest(paths.requestDir, 'wrong', 'old', { kind: 'availability' });

    expect(processTypeScriptSemanticMailbox(paths, service, { nowMs: NOW })).toBe(3);
    for (const id of ['expired', 'malformed', 'wrong']) {
      expect(readResponse(paths.responseDir, id)).toEqual(expect.objectContaining({ ok: false, id }));
    }
    expect(service.status().requests).toBe(0);
    service.closeTypeScriptService();
  });

  it('lets a synchronous requester receive a response and rejects a mismatched response identity', () => {
    const fixture = serviceFixture(true);
    const db = fixture.openDb();
    const paths = typeScriptSemanticMailboxPaths(fixture.projectRoot);
    const statePath = join(fixture.projectRoot, 'watch-state.json');
    const generation = publishedGenerationIdentity(db.config.dbPath)!;
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
          writeJsonAtomic(join(paths.responseDir, 'request-bad.json'), {
            ok: true,
            protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
            id: 'some-other-request',
            generation,
            response: { available: true },
          });
        },
      },
    });
    expect(() => mismatched.request({ kind: 'availability' })).toThrow('incompatible response');
    service.closeTypeScriptService();
    db.close();
  });

  it('abandons a request promptly when the service dies and bounds a live-service timeout', () => {
    const fixture = serviceFixture(true);
    const db = fixture.openDb();
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

    writeLiveState(statePath, fixture.projectRoot);
    let nowMs = NOW;
    const timedOut = new TypeScriptSemanticRequester(db, {
      timeoutMs: 20,
      runtime: {
        now: () => nowMs,
        randomId: () => 'request-timeout',
        isProcessAlive: () => true,
        sleep: (durationMs) => {
          nowMs += durationMs;
        },
      },
    });
    expect(() => timedOut.request({ kind: 'availability' })).toThrow('timed out');
    db.close();
  });
});

function serviceFixture(withMetadata = false): { projectRoot: string; openDb: () => ScipDatabase } {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-ts-mailbox-'));
  tempDirs.push(projectRoot);
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, 'src/consumer.ts'), 'export const value = 1;\n');
  writeFileSync(join(projectRoot, 'tsconfig.json'), '{}');
  const dbPath = join(projectRoot, 'index.db');
  evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/consumer.ts').chunk(1, 1, 0, 0).write();
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
    openDb: () => new ScipDatabase({ projectRoot, dbPath, indexPath: join(projectRoot, 'index.scip') }),
  };
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
    referencesForDefinitions: (definitions) => new Map(definitions.map((definition) => [definition.symbolId, []])),
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
): void {
  writeJsonAtomic(join(requestDir, `${id}.json`), {
    protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
    id,
    generation,
    deadlineAtMs,
    request,
  });
}

function readResponse(responseDir: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(responseDir, `${id}.json`), 'utf8')) as Record<string, unknown>;
}

function writeLiveState(statePath: string, projectRoot: string): void {
  writeWatchServiceState(statePath, {
    version: 1,
    protocolVersion: WATCH_SERVICE_PROTOCOL_VERSION,
    pid: 123,
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
