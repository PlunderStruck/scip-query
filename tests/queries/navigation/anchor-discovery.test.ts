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
      expect(flow?.systemMapCommand).toContain("--selection-term 'interrupt'");
      expect(flow?.systemMapCommand).not.toContain("--selection-term 'durable'");

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

  it('promotes connected wrapped source callables over isolated matching constants', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'scip-anchor-wrapped-callable-'));
    writeFixtureFiles(fixtureRoot, {
      'src/compaction.ts': [
        'const TOOL_OUTPUT_MAX_CHARS = 2_000;',
        "const select = Effect.fn('Compaction.select')(function* () {",
        "  return 'retained history';",
        '});',
        "const processCompaction = Effect.fn('Compaction.process')(function* () {",
        '  const summary = yield* select();',
        '  return summary;',
        '});',
      ],
      'src/mock-open-code.ts': ['export function mockOpenCodeServer() {', "  return 'session path';", '}'],
    });
    const constant = 'scip-typescript npm fixture 1.0.0 src/`compaction.ts`/TOOL_OUTPUT_MAX_CHARS.';
    const distractor = 'scip-typescript npm fixture 1.0.0 src/`mock-open-code.ts`/mockOpenCodeServer().';
    evidenceFixtureDb(join(fixtureRoot, 'index.db'))
      .document(1, 'typescript', 'src/compaction.ts')
      .symbol(1, constant, 'TOOL_OUTPUT_MAX_CHARS', 13)
      .definition(1, 1, 1, 0, 0, 0, 32)
      .document(2, 'typescript', 'src/mock-open-code.ts')
      .symbol(2, distractor, 'mockOpenCodeServer', 12)
      .definition(2, 2, 2, 0, 0, 2, 1)
      .write();
    const db = new ScipDatabase({
      dbPath: join(fixtureRoot, 'index.db'),
      indexPath: join(fixtureRoot, 'index.scip'),
      projectRoot: fixtureRoot,
    });
    try {
      const result = discoverAnchors(
        db,
        'Open Code has compaction packages. How does it retain history and produce summary tool output?',
        {
          limit: 2,
          semantic: false,
        },
      );

      expect(result.groups[0]?.relationCount).toBeGreaterThan(0);
      expect(result.groups[0]?.roots.map((root) => root.leaf)).toEqual(
        expect.arrayContaining(['processCompaction', 'select']),
      );
      expect(result.groups[0]?.systemMapCommand).toContain("--symbol 'src/compaction.ts:2-4'");
      expect(result.groups[0]?.systemMapCommand).toContain("--symbol 'src/compaction.ts:5-8'");
    } finally {
      db.close();
    }
  });

  it('connects a wrapped caller to an imported service object implementation', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'scip-anchor-service-member-'));
    writeFixtureFiles(fixtureRoot, {
      'package.json': JSON.stringify({ private: true, type: 'module' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }),
      'src/runner.ts': [
        "import { SessionCompaction } from './compaction.js';",
        'const SESSION_LOOP_MARKER = true;',
        "const runLoop = Effect.fn('SessionPrompt.runLoop')(function* () {",
        '  const compaction = yield* SessionCompaction.Service;',
        '  return yield* compaction.process();',
        '});',
      ],
      'src/compaction.ts': [
        'const COMPACTION_MARKER = true;',
        "const processCompaction = Effect.fn('SessionCompaction.process')(function* () {",
        "  return 'retained history summary';",
        '});',
        'export const layer = Service.of({ process: processCompaction });',
      ],
    });
    const runnerMarker = 'scip-typescript npm fixture 1.0.0 src/`runner.ts`/SESSION_LOOP_MARKER.';
    const compactionMarker = 'scip-typescript npm fixture 1.0.0 src/`compaction.ts`/COMPACTION_MARKER.';
    evidenceFixtureDb(join(fixtureRoot, 'index.db'))
      .document(1, 'typescript', 'src/runner.ts')
      .document(2, 'typescript', 'src/compaction.ts')
      .symbol(1, runnerMarker, 'SESSION_LOOP_MARKER', 13)
      .symbol(2, compactionMarker, 'COMPACTION_MARKER', 13)
      .definition(1, 1, 1, 1, 0, 1, 20)
      .definition(2, 2, 2, 0, 0, 0, 24)
      .write();
    const db = new ScipDatabase({
      dbPath: join(fixtureRoot, 'index.db'),
      indexPath: join(fixtureRoot, 'index.scip'),
      projectRoot: fixtureRoot,
    });
    try {
      const result = discoverAnchors(db, 'How does the session run loop process compaction and retained history?', {
        semantic: false,
      });
      const flow = result.groups.find((group) =>
        group.relations.some(
          (relation) => relation.fromLabel === 'runLoop' && relation.toLabel === 'processCompaction',
        ),
      );
      expect(flow).toBeDefined();
      expect(flow?.systemMapCommand).toContain("--symbol 'src/runner.ts:3-6'");
      expect(flow?.systemMapCommand).toContain("--symbol 'src/compaction.ts:2-4'");
    } finally {
      db.close();
    }
  });

  it('batches explicitly named parallel repository paths without claiming they are connected', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'scip-anchor-parallel-paths-'));
    writeFixtureFiles(fixtureRoot, {
      'packages/alpha/src/compaction.ts': ['export function compactAlpha() {', "  return 'alpha';", '}'],
      'packages/beta/src/compaction.ts': ['export function compactBeta() {', "  return 'beta';", '}'],
    });
    const alpha = 'scip-typescript npm fixture 1.0.0 packages/alpha/src/`compaction.ts`/compactAlpha().';
    const beta = 'scip-typescript npm fixture 1.0.0 packages/beta/src/`compaction.ts`/compactBeta().';
    evidenceFixtureDb(join(fixtureRoot, 'index.db'))
      .document(1, 'typescript', 'packages/alpha/src/compaction.ts')
      .document(2, 'typescript', 'packages/beta/src/compaction.ts')
      .symbol(1, alpha, 'compactAlpha', 12)
      .symbol(2, beta, 'compactBeta', 12)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 2, 1)
      .write();
    const db = new ScipDatabase({
      dbPath: join(fixtureRoot, 'index.db'),
      indexPath: join(fixtureRoot, 'index.scip'),
      projectRoot: fixtureRoot,
    });
    try {
      const result = discoverAnchors(db, 'How do packages alpha and beta compaction paths differ?', {
        semantic: false,
      });
      const parallel = result.groups.find((group) => group.kind === 'parallel-paths');
      expect(parallel).toBeDefined();
      expect(parallel?.relations).toEqual([]);
      expect(parallel?.systemMapCommand).toContain("--symbol 'packages/alpha/src/compaction.ts:1-3'");
      expect(parallel?.systemMapCommand).toContain("--symbol 'packages/beta/src/compaction.ts:1-3'");
    } finally {
      db.close();
    }
  });

  it('prefers causally evidenced implementations on both sides of a parallel-path comparison', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'scip-anchor-parallel-connected-'));
    writeFixtureFiles(fixtureRoot, {
      'packages/alpha/src/compaction.ts': [
        'function buildPrompt() {',
        "  return 'prompt';",
        '}',
        '',
        'function selectAlpha() {',
        '  return [];',
        '}',
        '',
        'export function compactIfNeeded() {',
        '  return selectAlpha();',
        '}',
      ],
      'packages/beta/src/compaction.ts': [
        'function selectBeta() {',
        '  return [];',
        '}',
        '',
        'export function processCompaction() {',
        '  return selectBeta();',
        '}',
      ],
    });
    evidenceFixtureDb(join(fixtureRoot, 'index.db'))
      .document(1, 'typescript', 'packages/alpha/src/compaction.ts')
      .document(2, 'typescript', 'packages/beta/src/compaction.ts')
      .symbol(
        1,
        'scip-typescript npm fixture 1.0.0 packages/alpha/src/`compaction.ts`/buildPrompt().',
        'buildPrompt',
        12,
      )
      .symbol(
        2,
        'scip-typescript npm fixture 1.0.0 packages/alpha/src/`compaction.ts`/selectAlpha().',
        'selectAlpha',
        12,
      )
      .symbol(
        3,
        'scip-typescript npm fixture 1.0.0 packages/alpha/src/`compaction.ts`/compactIfNeeded().',
        'compactIfNeeded',
        12,
      )
      .symbol(4, 'scip-typescript npm fixture 1.0.0 packages/beta/src/`compaction.ts`/selectBeta().', 'selectBeta', 12)
      .symbol(
        5,
        'scip-typescript npm fixture 1.0.0 packages/beta/src/`compaction.ts`/processCompaction().',
        'processCompaction',
        12,
      )
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 1, 2, 4, 0, 6, 1)
      .definition(3, 1, 3, 8, 0, 10, 1)
      .definition(4, 2, 4, 0, 0, 2, 1)
      .definition(5, 2, 5, 4, 0, 6, 1)
      .write();
    const db = new ScipDatabase({
      dbPath: join(fixtureRoot, 'index.db'),
      indexPath: join(fixtureRoot, 'index.scip'),
      projectRoot: fixtureRoot,
    });
    try {
      const result = discoverAnchors(db, 'How do packages alpha and beta compaction implementations differ?', {
        semantic: false,
      });
      const parallel = result.groups.find((group) => group.kind === 'parallel-paths');
      expect(parallel?.parallelConnectedSides).toBe(2);
      expect(parallel?.parallelOrchestrationSides).toBe(2);
      expect(parallel?.parallelSharedPathTerms).toContain('compaction');
      expect(parallel?.keyAnchors.map((anchor) => anchor.leaf)).toEqual(
        expect.arrayContaining(['compactIfNeeded', 'processCompaction']),
      );
      expect(parallel?.keyAnchors.map((anchor) => anchor.leaf)).not.toContain('buildPrompt');
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
      'src/catalog.ts': ['export interface FetchedPaperDuplicateInterruptedUpdate {}'],
    });

    const execute = 'scip-typescript npm fixture 1.0.0 src/`download.ts`/executeDownload().';
    const add = 'scip-typescript npm fixture 1.0.0 src/`store.ts`/addPdf().';
    const reconcile = 'scip-typescript npm fixture 1.0.0 src/`store.ts`/reconcileLocked().';
    const refresh = 'scip-typescript npm fixture 1.0.0 src/`store.ts`/refreshMetadata().';
    const remove = 'scip-typescript npm fixture 1.0.0 src/`store.ts`/remove().';
    const restore = 'scip-typescript npm fixture 1.0.0 src/`store.ts`/restore().';
    const repair = 'scip-typescript npm fixture 1.0.0 src/`store.ts`/repair().';
    const mutex = 'scip-typescript npm fixture 1.0.0 src/`mutex.ts`/withSqliteMutex().';
    const catalog = 'scip-typescript npm fixture 1.0.0 src/`catalog.ts`/FetchedPaperDuplicateInterruptedUpdate#';
    evidenceFixtureDb(join(fixtureRoot, 'index.db'))
      .document(1, 'typescript', 'src/download.ts')
      .document(2, 'typescript', 'src/store.ts')
      .document(3, 'typescript', 'src/mutex.ts')
      .document(4, 'typescript', 'src/catalog.ts')
      .symbol(1, execute, 'executeDownload', 12)
      .symbol(2, add, 'addPdf', 12)
      .symbol(3, reconcile, 'reconcileLocked', 12)
      .symbol(4, mutex, 'withSqliteMutex', 12)
      .symbol(5, refresh, 'refreshMetadata', 12)
      .symbol(6, remove, 'remove', 12)
      .symbol(7, restore, 'restore', 12)
      .symbol(8, repair, 'repair', 12)
      .symbol(9, catalog, 'FetchedPaperDuplicateInterruptedUpdate', 5)
      .definition(1, 1, 1, 2, 0, 4, 1)
      .definition(2, 2, 2, 2, 0, 6, 1)
      .definition(3, 2, 3, 8, 0, 11, 1)
      .definition(4, 3, 4, 0, 0, 2, 1)
      .definition(5, 2, 5, 13, 0, 15, 1)
      .definition(6, 2, 6, 17, 0, 19, 1)
      .definition(7, 2, 7, 21, 0, 23, 1)
      .definition(8, 2, 8, 25, 0, 27, 1)
      .definition(9, 4, 9, 0, 0, 0, 65)
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
