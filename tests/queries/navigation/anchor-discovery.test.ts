import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeRuntimeBoundaryGraph } from '../../../src/analysis/runtime-boundaries/index.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { discoverAnchors, normalizeAnchorQuery } from '../../../src/queries/navigation/anchor-discovery.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('anchor discovery', () => {
  let fixtureRoot: string | null = null;

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  });

  it('normalizes phrasing and compound identifiers without inventing semantic synonyms', () => {
    expect(
      normalizeAnchorQuery(
        'How does downloadPaper protect fetched papers from duplicates, concurrent writers, and interrupted updates?',
      ),
    ).toEqual(['download', 'paper', 'protect', 'fetch', 'duplicate', 'concurrent', 'writer', 'interrupt', 'update']);
  });

  it('groups repository-owned vocabulary through a bounded two-hop call path', () => {
    const db = createAnchorFixture();
    try {
      const result = discoverAnchors(
        db,
        'How does a fetched paper become durable local state, and what protects it from duplicates and interrupted updates?',
        { limit: 2, semantic: false },
      );

      expect(result.normalizedTerms).toEqual(
        expect.arrayContaining(['fetch', 'paper', 'durable', 'local', 'state', 'duplicate', 'interrupt', 'update']),
      );
      expect(result.unmatchedTerms).toContain('durable');
      expect(result.candidateRootCount).toBeGreaterThan(2);
      expect(result.analyzedRootCount + result.omittedRootCount).toBe(result.candidateRootCount);

      const flow = result.groups.find(
        (group) =>
          group.roots.some((root) => root.leaf === 'executeDownload') &&
          group.roots.some((root) => root.leaf === 'addPdf'),
      );
      expect(flow).toBeDefined();
      expect(flow?.matchedTerms).toEqual(
        expect.arrayContaining(['fetch', 'paper', 'duplicate', 'interrupt', 'update']),
      );
      expect(flow?.relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromLabel: expect.stringContaining('executeDownload'),
            toLabel: expect.stringContaining('addPdf'),
          }),
          expect.objectContaining({ toLabel: expect.stringContaining('withSqliteMutex') }),
          expect.objectContaining({ toLabel: expect.stringContaining('reconcileLocked') }),
        ]),
      );
      expect(flow?.keyAnchors[0]?.leaf).toBe('addPdf');
      expect(flow?.keyAnchors.map((anchor) => anchor.leaf)).toContain('executeDownload');
      expect(flow?.keyAnchors.map((anchor) => anchor.leaf)).toContain('reconcileLocked');
      expect(flow?.systemMapCommand).toContain("--symbol 'src/store.ts:3-7'");
      expect(flow?.systemMapCommand).toContain("--symbol 'src/download.ts:3-5'");
      expect(flow?.systemMapCommand).toContain("--symbol 'src/store.ts:9-12'");
      expect(flow?.systemMapCommand).not.toContain("--symbol 'src/mutex.ts:1-3'");
      expect(flow?.systemMapCommand).not.toContain('scip-typescript npm');

      const sharedCalleeSurface = result.groups.find((group) => group.kind === 'shared-callee-owners');
      expect(sharedCalleeSurface).toBeDefined();
      expect(sharedCalleeSurface?.keyAnchors.map((anchor) => anchor.leaf)).toEqual(
        expect.arrayContaining(['addPdf', 'refreshMetadata', 'remove', 'restore', 'repair']),
      );
      expect(sharedCalleeSurface?.relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ fromLabel: expect.stringContaining('refreshMetadata') }),
          expect.objectContaining({ fromLabel: expect.stringContaining('remove') }),
          expect.objectContaining({ fromLabel: expect.stringContaining('restore') }),
          expect.objectContaining({ fromLabel: expect.stringContaining('repair') }),
        ]),
      );
      expect(sharedCalleeSurface?.systemMapCommand).toContain("--symbol 'src/store.ts:14-16'");
      expect(sharedCalleeSurface?.systemMapCommand).toContain("--symbol 'src/store.ts:18-20'");
      expect(sharedCalleeSurface?.systemMapCommand).toContain("--symbol 'src/store.ts:22-24'");
      expect(sharedCalleeSurface?.systemMapCommand).toContain("--symbol 'src/store.ts:26-28'");

      const full = discoverAnchors(db, 'fetched paper duplicate interrupted update', {
        full: true,
        semantic: false,
      });
      expect(full.analyzedRootCount).toBe(full.candidateRootCount);
      expect(full.omittedRootCount).toBe(0);
      expect(full.omittedGroupCount).toBe(0);
      expect(full.recoveryCommand).toBeNull();
    } finally {
      db.close();
    }
  });

  it('composes separate call groups through a proven runtime crossing and downstream calls', () => {
    const db = createCrossBoundaryFixture();
    try {
      const result = discoverAnchors(
        db,
        'How does sendStreamEvents cross the API and persist stream events for realtime consumers?',
        { limit: 3, semantic: false },
      );

      const flow = result.groups[0];
      expect(flow?.kind).toBe('cross-boundary-flow');
      expect(flow?.roots.map((root) => root.leaf)).toEqual(
        expect.arrayContaining(['sendStreamEvents', 'handleStreamEvents', 'persistStreamEvents']),
      );
      expect(flow?.relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'runtime-boundary',
            runtimeBoundaryKey: 'command=stream_events',
          }),
          expect.objectContaining({
            fromLabel: expect.stringContaining('handleStreamEvents'),
            toLabel: expect.stringContaining('persistStreamEvents'),
          }),
        ]),
      );
      expect(flow?.systemMapCommand).toContain("--symbol 'src/client.ts:1-3'");
      expect(flow?.systemMapCommand).toContain("--symbol 'src/server.ts:1-3'");
      expect(flow?.systemMapCommand).toContain("--symbol 'src/server.ts:5-8'");
      expect(flow?.upstreamEntries).toEqual([
        {
          name: 'sessionStreamEvents',
          file: 'src/commands.ts',
          line: 2,
          endLine: 4,
          callsiteLine: 3,
        },
      ]);
    } finally {
      db.close();
    }
  });

  function createAnchorFixture(): ScipDatabase {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'scip-anchor-discovery-'));
    writeFixtureFiles(fixtureRoot, {
      'src/download.ts': [
        "import { addPdf } from './store.js';",
        '',
        'export async function executeDownload(fetchedPaper: Buffer) {',
        '  return await addPdf(fetchedPaper);',
        '}',
      ],
      'src/store.ts': [
        "import { withSqliteMutex } from './mutex.js';",
        '',
        'export async function addPdf(paper: Buffer) {',
        "  const localState = 'active';",
        "  if (localState === 'duplicate') return paper;",
        '  return await withSqliteMutex(() => reconcileLocked(paper));',
        '}',
        '',
        'export async function reconcileLocked(paper: Buffer) {',
        "  const interruptedUpdate = 'repair';",
        '  return { paper, interruptedUpdate };',
        '}',
        '',
        'export async function refreshMetadata(paper: Buffer) {',
        '  return await withSqliteMutex(() => reconcileLocked(paper));',
        '}',
        '',
        'export async function remove(paper: Buffer) {',
        '  return await withSqliteMutex(() => reconcileLocked(paper));',
        '}',
        '',
        'export async function restore(paper: Buffer) {',
        '  return await withSqliteMutex(() => reconcileLocked(paper));',
        '}',
        '',
        'export async function repair(paper: Buffer) {',
        '  return await withSqliteMutex(() => reconcileLocked(paper));',
        '}',
      ],
      'src/mutex.ts': [
        'export async function withSqliteMutex<T>(work: () => Promise<T>) {',
        '  return await work();',
        '}',
      ],
    });

    const execute = 'scip-typescript npm fixture 1.0.0 src/`download.ts`/executeDownload().';
    const add = 'scip-typescript npm fixture 1.0.0 src/`store.ts`/addPdf().';
    const reconcile = 'scip-typescript npm fixture 1.0.0 src/`store.ts`/reconcileLocked().';
    const refresh = 'scip-typescript npm fixture 1.0.0 src/`store.ts`/refreshMetadata().';
    const remove = 'scip-typescript npm fixture 1.0.0 src/`store.ts`/remove().';
    const restore = 'scip-typescript npm fixture 1.0.0 src/`store.ts`/restore().';
    const repair = 'scip-typescript npm fixture 1.0.0 src/`store.ts`/repair().';
    const mutex = 'scip-typescript npm fixture 1.0.0 src/`mutex.ts`/withSqliteMutex().';
    evidenceFixtureDb(join(fixtureRoot, 'index.db'))
      .document(1, 'typescript', 'src/download.ts')
      .document(2, 'typescript', 'src/store.ts')
      .document(3, 'typescript', 'src/mutex.ts')
      .symbol(1, execute, 'executeDownload', 12)
      .symbol(2, add, 'addPdf', 12)
      .symbol(3, reconcile, 'reconcileLocked', 12)
      .symbol(4, mutex, 'withSqliteMutex', 12)
      .symbol(5, refresh, 'refreshMetadata', 12)
      .symbol(6, remove, 'remove', 12)
      .symbol(7, restore, 'restore', 12)
      .symbol(8, repair, 'repair', 12)
      .definition(1, 1, 1, 2, 0, 4, 1)
      .definition(2, 2, 2, 2, 0, 6, 1)
      .definition(3, 2, 3, 8, 0, 11, 1)
      .definition(4, 3, 4, 0, 0, 2, 1)
      .definition(5, 2, 5, 13, 0, 15, 1)
      .definition(6, 2, 6, 17, 0, 19, 1)
      .definition(7, 2, 7, 21, 0, 23, 1)
      .definition(8, 2, 8, 25, 0, 27, 1)
      .write();

    const config: ScipQueryConfig = {
      dbPath: join(fixtureRoot, 'index.db'),
      indexPath: join(fixtureRoot, 'index.scip'),
      projectRoot: fixtureRoot,
    };
    return new ScipDatabase(config);
  }

  function createCrossBoundaryFixture(): ScipDatabase {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'scip-anchor-cross-boundary-'));
    writeFixtureFiles(fixtureRoot, {
      'src/client.ts': [
        'export function sendStreamEvents(events: unknown[]) {',
        "  return { command: 'stream_events', events };",
        '}',
      ],
      'src/commands.ts': [
        "import { sendStreamEvents } from './client.js';",
        '',
        'export function sessionStreamEvents(events: unknown[]) {',
        '  return sendStreamEvents(events);',
        '}',
      ],
      'src/server.ts': [
        'export function handleStreamEvents(events: unknown[]) {',
        '  return persistStreamEvents(events);',
        '}',
        '',
        'export function persistStreamEvents(events: unknown[]) {',
        "  const realtimeConsumers = 'notified';",
        '  return { inserted: events.length, realtimeConsumers };',
        '}',
      ],
    });

    const send = 'scip-typescript npm fixture 1.0.0 src/`client.ts`/sendStreamEvents().';
    const command = 'scip-typescript npm fixture 1.0.0 src/`commands.ts`/sessionStreamEvents().';
    const handle = 'scip-typescript npm fixture 1.0.0 src/`server.ts`/handleStreamEvents().';
    const persist = 'scip-typescript npm fixture 1.0.0 src/`server.ts`/persistStreamEvents().';
    evidenceFixtureDb(join(fixtureRoot, 'index.db'))
      .document(1, 'typescript', 'src/client.ts')
      .document(2, 'typescript', 'src/server.ts')
      .document(3, 'typescript', 'src/commands.ts')
      .symbol(1, send, 'sendStreamEvents', 12)
      .symbol(2, handle, 'handleStreamEvents', 12)
      .symbol(3, persist, 'persistStreamEvents', 12)
      .symbol(4, command, 'sessionStreamEvents', 12)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 2, 1)
      .definition(3, 2, 3, 4, 0, 7, 1)
      .definition(4, 3, 4, 2, 0, 4, 1)
      .write();
    const config: ScipQueryConfig = {
      dbPath: join(fixtureRoot, 'index.db'),
      indexPath: join(fixtureRoot, 'index.scip'),
      projectRoot: fixtureRoot,
    };
    writeRuntimeBoundaryGraph(config.dbPath, {
      schemaVersion: 2,
      extractorVersion: 'fixture',
      observations: [
        {
          id: 'producer',
          extractor: 'fixture',
          action: 'carrier.publish',
          owner: { file: 'src/client.ts', symbol: send, name: 'sendStreamEvents', startLine: 0, endLine: 2 },
          source: { file: 'src/client.ts', startLine: 1, endLine: 1 },
          keyParts: [{ name: 'command', value: 'stream_events', evidence: 'literal' }],
          evidence: 'fixture',
          strength: 'exact',
          protocol: 'carrier',
          role: 'producer',
          executionDomain: null,
          derivation: {
            kind: 'direct',
            rule: 'fixture',
            ruleVersion: '1',
            inputFactIds: [],
            sourceSpans: [{ file: 'src/client.ts', startLine: 1, endLine: 1 }],
          },
          valuePrecision: 'literal',
          modality: 'may',
          resolution: 'locally-linked',
          sourceScope: 'production',
        },
        {
          id: 'consumer',
          extractor: 'fixture',
          action: 'carrier.consume',
          owner: { file: 'src/server.ts', symbol: handle, name: 'handleStreamEvents', startLine: 0, endLine: 2 },
          source: { file: 'src/server.ts', startLine: 0, endLine: 0 },
          keyParts: [{ name: 'command', value: 'stream_events', evidence: 'literal' }],
          evidence: 'fixture',
          strength: 'exact',
          protocol: 'carrier',
          role: 'consumer',
          executionDomain: null,
          derivation: {
            kind: 'direct',
            rule: 'fixture',
            ruleVersion: '1',
            inputFactIds: [],
            sourceSpans: [{ file: 'src/server.ts', startLine: 0, endLine: 0 }],
          },
          valuePrecision: 'literal',
          modality: 'may',
          resolution: 'locally-linked',
          sourceScope: 'production',
        },
      ],
      relationGroups: [],
      links: [
        {
          id: 'link',
          from: 'producer',
          to: 'consumer',
          joinRule: 'fixture.command',
          matchedKeyParts: [{ name: 'command', value: 'stream_events', evidence: 'literal' }],
          strength: 'exact',
          derivation: {
            kind: 'direct',
            rule: 'fixture',
            ruleVersion: '1',
            inputFactIds: ['producer', 'consumer'],
            sourceSpans: [
              { file: 'src/client.ts', startLine: 1, endLine: 1 },
              { file: 'src/server.ts', startLine: 0, endLine: 0 },
            ],
          },
        },
      ],
      frontiers: [],
      coverage: {
        filesScanned: 3,
        filesWithAst: 3,
        filesWithoutAst: 0,
        extractors: [],
        extractionErrors: [],
      },
    });
    return new ScipDatabase(config);
  }
});
