import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectRuntimeBoundaryGraph,
  readRuntimeBoundaryGraph,
  readRuntimeBoundaryObservations,
  readRuntimeBoundaryRelationGroups,
  writeRuntimeBoundaryGraph,
} from '../../src/analysis/runtime-boundaries/index.js';
import { buildRelationGroups, materializeBoundedLinks } from '../../src/analysis/runtime-boundaries/graph.js';
import { runtimeBoundarySourceScope } from '../../src/analysis/runtime-boundaries/source-scope.js';
import type { BoundaryObservation } from '../../src/analysis/runtime-boundaries/types.js';
import { runtimeBoundaryAugmentationStage } from '../../src/reindex/runtime-boundaries.js';
import { runPostIndexAugmentationAsync } from '../../src/reindex/augmentation/post-index-augmentation.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { getDefinitionsForFile } from '../../src/symbols/definition-catalog.js';
import {
  resolvedCallSitesForDefinition,
  resolvedCallSitesForDefinitions,
} from '../../src/symbols/graph/resolved-call-sites.js';
import { parameterValueFlowAtCall } from '../../src/symbols/graph/value-flow.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('runtime-boundary evidence', () => {
  let tempDir: string | null = null;

  it('distinguishes repository scripts from application modules named tools', async () => {
    expect(runtimeBoundarySourceScope('tools/release.ts')).toBe('script');
    expect(runtimeBoundarySourceScope('scripts/reindex.ts')).toBe('script');
    expect(runtimeBoundarySourceScope('src/agent/tools/bash.ts')).toBe('production');
    expect(runtimeBoundarySourceScope('packages/api/src/tools/dispatch.ts')).toBe('production');
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('extracts open observations and joins only evidence-backed runtime peers', async () => {
    const db = createBoundaryDb();
    try {
      const graph = await collectRuntimeBoundaryGraph(db);
      expect(graph.extractorVersion).toBe('runtime-boundaries-v19');

      expect(graph.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'http.request',
            strength: expect.stringMatching(/^(?:exact|derived)$/u),
            source: expect.objectContaining({ file: 'src/client.ts' }),
          }),
          expect.objectContaining({
            action: 'http.request',
            source: expect.objectContaining({ file: 'src/client.ts' }),
            keyParts: expect.arrayContaining([expect.objectContaining({ name: 'path', value: '/api/returned' })]),
          }),
          expect.objectContaining({
            action: 'http.handle',
            strength: expect.stringMatching(/^(?:exact|derived)$/u),
            source: expect.objectContaining({ file: 'src/server.ts' }),
          }),
          expect.objectContaining({ action: 'registry.dispatch', strength: 'exact' }),
          expect.objectContaining({ action: 'registry.handle', strength: 'exact' }),
          expect.objectContaining({ action: 'database.write', strength: 'exact' }),
          expect.objectContaining({ action: 'database.read', strength: 'exact' }),
          expect.objectContaining({
            action: 'database.read',
            source: expect.objectContaining({ file: 'src/persistence.ts' }),
            keyParts: expect.arrayContaining([expect.objectContaining({ name: 'resource', value: 'session_events' })]),
          }),
          expect.objectContaining({ action: 'queue.send', strength: 'exact' }),
          expect.objectContaining({ action: 'queue.consume', strength: 'exact' }),
          expect.objectContaining({
            action: 'queue.send',
            extractor: 'builtin.database-queue',
            keyParts: expect.arrayContaining([
              expect.objectContaining({ name: 'address', value: 'database:deliveryQueue' }),
            ]),
          }),
          expect.objectContaining({
            action: 'queue.consume',
            extractor: 'builtin.database-queue',
            keyParts: expect.arrayContaining([
              expect.objectContaining({ name: 'address', value: 'database:deliveryQueue' }),
            ]),
          }),
          expect.objectContaining({
            action: 'http.handle',
            strength: 'exact',
            evidence: 'framework-decorator',
            source: expect.objectContaining({ file: 'src/python_server.py' }),
          }),
          expect.objectContaining({
            action: 'http.handle',
            strength: 'exact',
            evidence: 'framework-adapter',
            source: expect.objectContaining({ file: 'src/rust_server.rs' }),
          }),
          expect.objectContaining({
            action: 'http.handle',
            strength: 'derived',
            source: expect.objectContaining({ file: 'src/imported-server.ts' }),
          }),
          expect.objectContaining({
            action: 'http.handle',
            strength: 'derived',
            source: expect.objectContaining({ file: 'src/mounted-routes.ts' }),
            keyParts: expect.arrayContaining([expect.objectContaining({ name: 'path', value: '/api/mounted' })]),
          }),
          expect.objectContaining({
            action: 'http.request',
            strength: 'derived',
            source: expect.objectContaining({ file: 'src/wrapper-client.ts' }),
            keyParts: expect.arrayContaining([
              expect.objectContaining({ name: 'method', value: 'POST' }),
              expect.objectContaining({ name: 'path', value: '/api/wrapped' }),
            ]),
          }),
          expect.objectContaining({
            action: 'carrier.publish',
            strength: 'derived',
            source: expect.objectContaining({ file: 'src/carrier-client.ts' }),
            keyParts: expect.arrayContaining([expect.objectContaining({ name: 'value', value: 'sync' })]),
          }),
          expect.objectContaining({
            action: 'carrier.consume',
            strength: 'derived',
            source: expect.objectContaining({ file: 'src/carrier-server.ts' }),
            keyParts: expect.arrayContaining([expect.objectContaining({ name: 'value', value: 'sync' })]),
          }),
        ]),
      );
      expect(graph.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            joinRule: 'http.method-path',
            strength: expect.stringMatching(/^(?:exact|derived)$/u),
          }),
          expect.objectContaining({ joinRule: 'registry.identity-key', strength: 'exact' }),
          expect.objectContaining({ joinRule: 'queue.address', strength: 'exact' }),
          expect.objectContaining({ joinRule: 'queue.address', strength: 'derived' }),
          expect.objectContaining({ joinRule: 'carrier.discriminator', strength: 'derived' }),
        ]),
      );
      const databaseQueueObservations = graph.observations.filter(
        (observation) => observation.extractor === 'builtin.database-queue',
      );
      expect(databaseQueueObservations).toHaveLength(2);
      expect(databaseQueueObservations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: expect.objectContaining({ file: 'src/persistence.ts' }) }),
          expect.objectContaining({ source: expect.objectContaining({ file: 'src/queue-consumer.ts' }) }),
        ]),
      );
      expect(
        databaseQueueObservations.every(
          (observation) =>
            observation.derivation?.inputFactIds.length === 2 && observation.derivation.sourceSpans.length === 2,
        ),
      ).toBe(true);
      expect(graph.links.some((link) => link.joinRule === 'database.resource' || link.strength === 'candidate')).toBe(
        false,
      );
      expect(graph.relationGroups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            joinRule: 'resource.identity',
            producerIds: expect.arrayContaining([expect.any(String)]),
            consumerIds: expect.arrayContaining([expect.any(String)]),
          }),
        ]),
      );
      expect(graph.coverage).toMatchObject({ filesScanned: 26, filesWithAst: 26, extractionErrors: [] });
      expect(graph.coverage.extractors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'builtin.wrapper', observations: 2, errors: 0 }),
          expect.objectContaining({ id: 'builtin.carrier', observations: 2, errors: 0 }),
        ]),
      );
      expect(graph.coverage.phases?.map((phase) => phase.id)).toEqual([
        'direct-extraction',
        'http-summary',
        'http-mount',
        'carrier',
        'relations',
        'links',
        'frontiers',
      ]);
      expect(graph.coverage.phases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'direct-extraction',
            durationMs: expect.any(Number),
            filesVisited: 26,
          }),
          expect.objectContaining({ id: 'http-mount', filesVisited: 26 }),
          expect.objectContaining({ id: 'carrier', filesVisited: 2 }),
        ]),
      );
      expect(graph.observations.some((observation) => observation.source.file === 'src/non-boundaries.ts')).toBe(false);
      expect(graph.observations.some((observation) => observation.source.file === 'src/custom.ts')).toBe(false);
      expect(graph.observations.some((observation) => observation.source.file.includes('__tests__'))).toBe(false);
      expect(graph.observations.some((observation) => observation.action.startsWith('event.'))).toBe(false);
      expect(
        graph.observations.some(
          (observation) => observation.source.file === 'src/mutated-client.ts' && observation.strength !== 'candidate',
        ),
      ).toBe(false);
      expect(
        graph.observations.some(
          (observation) =>
            observation.source.file === 'src/ambiguous-client.ts' &&
            (observation.extractor === 'builtin.http-summary' || observation.extractor === 'builtin.carrier'),
        ),
      ).toBe(false);
      expect(graph.frontiers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'call-resolution',
            action: 'http.request',
            strength: 'candidate',
            source: expect.objectContaining({ file: 'src/ambiguous-client.ts' }),
            reason: expect.stringContaining('ambiguous-call'),
          }),
        ]),
      );

      writeRuntimeBoundaryGraph(db.config.dbPath, graph);
    } finally {
      db.close();
    }
  });

  it('extracts exact Node child-process crossings from imported bindings only', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-runtime-process-boundaries-'));
    const files = {
      'src/process.ts': [
        "import { spawn as startChild, execFileSync } from 'node:child_process';",
        "import * as childProcess from 'child_process';",
        'export function run(command: string) {',
        "  const child = startChild('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });",
        "  execFileSync('/usr/bin/git', ['status']);",
        "  return childProcess.fork('./worker.js');",
        '}',
      ],
      'src/local.ts': ['function spawn(command: string) { return command; }', "spawn('not-a-runtime-boundary');"],
    };
    writeFixtureFiles(tempDir, files);
    const builder = evidenceFixtureDb(join(tempDir, 'index.db'));
    Object.keys(files).forEach((file, index) => builder.document(index + 1, 'typescript', file));
    builder.write();
    const db = new ScipDatabase({
      projectRoot: tempDir,
      dbPath: join(tempDir, 'index.db'),
      indexPath: join(tempDir, 'index.scip'),
    });

    try {
      const processObservations = (await collectRuntimeBoundaryGraph(db)).observations.filter(
        (observation) => observation.protocol === 'process',
      );
      expect(processObservations).toEqual([
        expect.objectContaining({
          action: 'process.spawn',
          role: 'producer',
          strength: 'exact',
          evidence: 'node-child-process-import',
          source: expect.objectContaining({ file: 'src/process.ts', startLine: 3 }),
          keyParts: expect.arrayContaining([
            expect.objectContaining({ name: 'operation', value: 'spawn', evidence: 'literal' }),
            expect.objectContaining({ name: 'executable', value: 'sh', evidence: 'literal' }),
          ]),
        }),
        expect.objectContaining({
          action: 'process.exec',
          source: expect.objectContaining({ file: 'src/process.ts', startLine: 4 }),
          keyParts: expect.arrayContaining([expect.objectContaining({ name: 'executable', value: '/usr/bin/git' })]),
        }),
        expect.objectContaining({
          action: 'process.spawn',
          source: expect.objectContaining({ file: 'src/process.ts', startLine: 5 }),
          keyParts: expect.arrayContaining([expect.objectContaining({ name: 'operation', value: 'fork' })]),
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it('links exact capability instructions to unique descriptor handlers', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-runtime-capability-boundaries-'));
    const files = {
      'src/bash.ts': [
        'export function backgroundInstructions(id: string) {',
        '  return [`started ${id}`, `Use kill_process({id: "${id}"}) to stop.`].join("\\n");',
        '}',
        'export const diagnostic = "Formatting issue() while JSON.stringify(value) remains visible.";',
      ],
      'src/kill-process.ts': [
        'export const killProcessTool = {',
        '  def: { name: "kill_process" },',
        '  async execute(input: Record<string, unknown>) {',
        '    return String(input.id ?? "");',
        '  },',
        '};',
      ],
      'src/irrelevant.ts': ['export function run() {', '  return "Formatting issue()";', '}'],
    };
    writeFixtureFiles(tempDir, files);
    const builder = evidenceFixtureDb(join(tempDir, 'index.db'));
    Object.keys(files).forEach((file, index) => builder.document(index + 1, 'typescript', file));
    builder.write();
    const db = new ScipDatabase({
      projectRoot: tempDir,
      dbPath: join(tempDir, 'index.db'),
      indexPath: join(tempDir, 'index.scip'),
    });

    try {
      const graph = await collectRuntimeBoundaryGraph(db);
      expect(graph.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'registry.reference',
            evidence: 'capability-instruction-reference',
            strength: 'exact',
            source: expect.objectContaining({ file: 'src/bash.ts' }),
            keyParts: [expect.objectContaining({ name: 'key', value: 'kill_process', evidence: 'literal' })],
          }),
          expect.objectContaining({
            action: 'registry.handle',
            evidence: 'capability-descriptor',
            strength: 'exact',
            source: expect.objectContaining({ file: 'src/kill-process.ts' }),
            keyParts: [expect.objectContaining({ name: 'key', value: 'kill_process', evidence: 'literal' })],
          }),
        ]),
      );
      expect(graph.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            joinRule: 'registry.capability-key',
            strength: 'exact',
          }),
        ]),
      );
      const capabilityReferences = graph.observations.filter(
        (item) => item.evidence === 'capability-instruction-reference',
      );
      expect(capabilityReferences).toHaveLength(1);
      expect(capabilityReferences[0]?.keyParts[0]?.value).toBe('kill_process');
      expect(
        graph.coverage.extractors.find((extractor) => extractor.id === 'builtin.capability-registry')?.applicableFiles,
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  it('does not resolve a capability reference when multiple handlers claim the same key', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-runtime-ambiguous-capability-'));
    const files = {
      'src/instructions.ts': ['export const instructions = "Use kill_process() to stop.";'],
      'src/first.ts': [
        'export const first = {',
        '  def: { name: "kill_process" },',
        '  execute() { return "first"; },',
        '};',
      ],
      'src/second.ts': [
        'export const second = {',
        '  def: { name: "kill_process" },',
        '  execute() { return "second"; },',
        '};',
      ],
    };
    writeFixtureFiles(tempDir, files);
    const builder = evidenceFixtureDb(join(tempDir, 'index.db'));
    Object.keys(files).forEach((file, index) => builder.document(index + 1, 'typescript', file));
    builder.write();
    const db = new ScipDatabase({
      projectRoot: tempDir,
      dbPath: join(tempDir, 'index.db'),
      indexPath: join(tempDir, 'index.scip'),
    });

    try {
      const graph = await collectRuntimeBoundaryGraph(db);
      expect(graph.links.filter((link) => link.joinRule === 'registry.capability-key')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('recovers call syntax from compiler identity and preserves same-line ambiguity', async () => {
    const db = createBoundaryDb();
    try {
      const postJson = getDefinitionsForFile(db, 'src/http-wrapper.ts').find(
        (definition) => definition.leaf === 'postJson',
      );
      const postEnvelope = getDefinitionsForFile(db, 'src/carrier-runtime.ts').find(
        (definition) => definition.leaf === 'postEnvelope',
      );
      expect(postJson).toBeDefined();
      expect(postEnvelope).toBeDefined();

      const wrappedCalls = resolvedCallSitesForDefinition(db, postJson!);
      expect(wrappedCalls.sites).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: 'src/wrapper-client.ts',
            targetText: 'postJson',
            caller: expect.objectContaining({ leaf: 'invokeWrapped' }),
            arguments: [expect.objectContaining({ text: "'/api/wrapped'" }), expect.objectContaining({ text: '{}' })],
          }),
        ]),
      );
      const forwardedCall = wrappedCalls.sites.find((site) => site.caller?.leaf === 'forwardWrapped');
      expect(forwardedCall).toBeDefined();
      expect(parameterValueFlowAtCall(db, forwardedCall!)).toEqual(
        expect.objectContaining({
          transfers: [expect.objectContaining({ calleePosition: 0, callerPosition: 0, argumentText: 'path' })],
          unknown: expect.arrayContaining([
            expect.objectContaining({ calleePosition: 1, reason: 'argument-not-direct-parameter' }),
          ]),
        }),
      );

      const carrierCalls = resolvedCallSitesForDefinition(db, postEnvelope!);
      expect(carrierCalls.sites.some((site) => site.file === 'src/ambiguous-client.ts')).toBe(false);
      expect(carrierCalls.unresolved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: 'src/ambiguous-client.ts',
            reason: 'ambiguous-call',
            candidates: 2,
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('uses SCIP reference rows for compiler-resolved call sites', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-runtime-compiler-references-'));
    writeFixtureFiles(tempDir, {
      'src/request.ts': ['export function sendRequest(path: string) { return fetch(path); }'],
      'src/caller.ts': ["import { sendRequest } from './request.js';", "sendRequest('/events');"],
    });
    const builder = evidenceFixtureDb(join(tempDir, 'index.db'));
    builder
      .document(1, 'typescript', 'src/request.ts')
      .document(2, 'typescript', 'src/caller.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`request.ts`/sendRequest().', 'sendRequest', 12)
      .definition(1, 1, 1, 0, 0, 0, 75)
      .chunk(1, 2, 1, 1)
      .mention(1, 1, 2)
      .write();
    const db = new ScipDatabase({
      projectRoot: tempDir,
      dbPath: join(tempDir, 'index.db'),
      indexPath: join(tempDir, 'index.scip'),
    });

    try {
      const sendRequest = getDefinitionsForFile(db, 'src/request.ts').find(
        (definition) => definition.leaf === 'sendRequest',
      );
      expect(sendRequest).toBeDefined();
      const calls = resolvedCallSitesForDefinition(db, sendRequest!);
      expect(calls.sites).toEqual([
        expect.objectContaining({
          file: 'src/caller.ts',
          targetText: 'sendRequest',
          referenceProvenance: 'scip-reference-chunk',
        }),
      ]);
      expect(resolvedCallSitesForDefinitions(db, [sendRequest!]).get(sendRequest!.symbolId)).toBe(calls);
    } finally {
      db.close();
    }
  });

  it('replaces affected-file facts while retaining exact coverage for unchanged files', async () => {
    const baselineDb = createBoundaryDb();
    const projectRoot = baselineDb.config.projectRoot;
    const dbPath = baselineDb.config.dbPath;
    const baseline = await collectRuntimeBoundaryGraph(baselineDb);
    baselineDb.close();
    writeFixtureFiles(projectRoot, {
      'src/client.ts': [
        "const EVENTS_PATH = '/api/renamed-events';",
        'export async function sendEvents(events: unknown[]) {',
        "  return fetch(EVENTS_PATH, { method: 'POST', body: JSON.stringify({ events }) });",
        '}',
      ],
    });
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(projectRoot, 'index.scip') });
    try {
      const refreshed = await collectRuntimeBoundaryGraph(db, {
        previousGraph: baseline,
        affectedFiles: ['src/client.ts'],
      });
      const clean = await collectRuntimeBoundaryGraph(db);

      expect(refreshed.observations).toEqual(clean.observations);
      expect(refreshed.relationGroups).toEqual(clean.relationGroups);
      expect(refreshed.links).toEqual(clean.links);
      expect(refreshed.frontiers).toEqual(clean.frontiers);
      expect(refreshed.coverage.extractors).toEqual(clean.coverage.extractors);
      expect(refreshed.coverage.extractionErrors).toEqual(clean.coverage.extractionErrors);
      expect(refreshed.fileCoverage).toEqual(clean.fileCoverage);
      expect(refreshed.coverage).toMatchObject({
        filesScanned: 26,
        filesWithAst: 26,
        filesReused: 25,
        extractionErrors: [],
      });
      expect(refreshed.fileCoverage).toHaveLength(26);
      expect(
        refreshed.observations.some((observation) =>
          observation.keyParts.some((part) => part.value === '/api/renamed-events'),
        ),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it('reuses derived phases when an affected file has no boundary facts or references into the prior graph', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-runtime-unrelated-change-'));
    writeFixtureFiles(tempDir, {
      'src/client.ts': ["fetch('/events', { method: 'POST' });"],
      'src/unrelated.ts': ['export const unrelated = 1;'],
    });
    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/client.ts')
      .document(2, 'typescript', 'src/unrelated.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`unrelated.ts`/unrelated.', 'unrelated', 13)
      .definition(1, 2, 1, 0, 0, 0, 35)
      .chunk(1, 2, 0, 0)
      .mention(1, 1, 2)
      .write();
    const baselineDb = new ScipDatabase({
      projectRoot: tempDir,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
    const baseline = await collectRuntimeBoundaryGraph(baselineDb);
    baselineDb.close();

    writeFixtureFiles(tempDir, { 'src/unrelated.ts': ['', 'export const unrelated = 1;'] });
    const db = new ScipDatabase({ projectRoot: tempDir, dbPath, indexPath: join(tempDir, 'index.scip') });
    try {
      const refreshed = await collectRuntimeBoundaryGraph(db, {
        previousGraph: baseline,
        affectedFiles: ['src/unrelated.ts'],
      });
      const forced = await collectRuntimeBoundaryGraph(db, {
        previousGraph: baseline,
        affectedFiles: ['src/unrelated.ts'],
        forceDerivedRebuild: true,
      });

      expect(refreshed.observations).toEqual(baseline.observations);
      expect(refreshed.relationGroups).toEqual(baseline.relationGroups);
      expect(refreshed.coverage.phases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'http-summary', durationMs: 0, filesVisited: 0 }),
          expect.objectContaining({ id: 'carrier', durationMs: 0, filesVisited: 0 }),
        ]),
      );
      expect(forced.observations).toEqual(baseline.observations);
      expect(forced.coverage.filesReused).toBe(1);
      expect(forced.coverage.phases?.find((phase) => phase.id === 'http-summary')?.durationMs).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('reuses derived phases when deleting a file with no boundary facts or references into the prior graph', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-runtime-unrelated-deletion-'));
    writeFixtureFiles(tempDir, {
      'src/client.ts': ["fetch('/events', { method: 'POST' });"],
      'src/unrelated.ts': ['export const unrelated = 1;'],
    });
    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/client.ts')
      .document(2, 'typescript', 'src/unrelated.ts')
      .write();
    const baselineDb = new ScipDatabase({
      projectRoot: tempDir,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
    const baseline = await collectRuntimeBoundaryGraph(baselineDb);
    baselineDb.close();

    rmSync(join(tempDir, 'src/unrelated.ts'));
    const sqlite = new Database(dbPath);
    sqlite.prepare('DELETE FROM documents WHERE relative_path = ?').run('src/unrelated.ts');
    sqlite.close();

    const db = new ScipDatabase({ projectRoot: tempDir, dbPath, indexPath: join(tempDir, 'index.scip') });
    try {
      const refreshed = await collectRuntimeBoundaryGraph(db, {
        previousGraph: baseline,
        affectedFiles: ['src/unrelated.ts'],
      });
      const clean = await collectRuntimeBoundaryGraph(db);

      expect(refreshed.observations).toEqual(clean.observations);
      expect(refreshed.relationGroups).toEqual(clean.relationGroups);
      expect(refreshed.links).toEqual(clean.links);
      expect(refreshed.frontiers).toEqual(clean.frontiers);
      expect(refreshed.fileCoverage).toEqual(clean.fileCoverage);
      expect(refreshed.coverage.phases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'http-summary', durationMs: 0, filesVisited: 0 }),
          expect.objectContaining({ id: 'carrier', durationMs: 0, filesVisited: 0 }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('reuses derived phases when an affected file references only a persistence boundary', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-runtime-persistence-only-change-'));
    writeFixtureFiles(tempDir, {
      'src/repository.ts': [
        'export function saveEvent(value: unknown) {',
        '  return db.insert(events).values(value);',
        '}',
      ],
      'src/caller.ts': ["import { saveEvent } from './repository.js';", "saveEvent('first');"],
    });
    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/repository.ts')
      .document(2, 'typescript', 'src/caller.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`repository.ts`/saveEvent().', 'saveEvent', 12)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .chunk(1, 2, 1, 1)
      .mention(1, 1, 2)
      .write();
    const baselineDb = new ScipDatabase({
      projectRoot: tempDir,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
    const baseline = await collectRuntimeBoundaryGraph(baselineDb);
    baselineDb.close();

    writeFixtureFiles(tempDir, {
      'src/caller.ts': ["import { saveEvent } from './repository.js';", "saveEvent('second');"],
    });
    const db = new ScipDatabase({ projectRoot: tempDir, dbPath, indexPath: join(tempDir, 'index.scip') });
    try {
      const refreshed = await collectRuntimeBoundaryGraph(db, {
        previousGraph: baseline,
        affectedFiles: ['src/caller.ts'],
      });

      expect(refreshed.observations).toEqual(baseline.observations);
      expect(refreshed.relationGroups).toEqual(baseline.relationGroups);
      expect(refreshed.coverage.phases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'http-summary', durationMs: 0, filesVisited: 0 }),
          expect.objectContaining({ id: 'carrier', durationMs: 0, filesVisited: 0 }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('reuses derived phases when an affected file references a non-boundary symbol beside an HTTP boundary', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-runtime-adjacent-http-change-'));
    writeFixtureFiles(tempDir, {
      'src/client.ts': [
        'export function getAccountId() {',
        "  return 'account';",
        '}',
        'export function sendRequest(path: string) {',
        '  return fetch(path);',
        '}',
      ],
      'src/caller.ts': ["import { getAccountId } from './client.js';", 'getAccountId();'],
    });
    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/client.ts')
      .document(2, 'typescript', 'src/caller.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`client.ts`/getAccountId().', 'getAccountId', 12)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`client.ts`/sendRequest().', 'sendRequest', 12)
      .definition(2, 1, 2, 3, 0, 5, 1)
      .chunk(1, 2, 1, 1)
      .mention(1, 1, 2)
      .write();
    const baselineDb = new ScipDatabase({
      projectRoot: tempDir,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
    const baseline = await collectRuntimeBoundaryGraph(baselineDb);
    baselineDb.close();

    writeFixtureFiles(tempDir, {
      'src/caller.ts': [
        "import { getAccountId } from './client.js';",
        'getAccountId();',
        "export const label = 'new';",
      ],
    });
    const db = new ScipDatabase({ projectRoot: tempDir, dbPath, indexPath: join(tempDir, 'index.scip') });
    try {
      const refreshed = await collectRuntimeBoundaryGraph(db, {
        previousGraph: baseline,
        affectedFiles: ['src/caller.ts'],
      });

      expect(refreshed.observations).toEqual(baseline.observations);
      expect(refreshed.coverage.phases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'http-summary', durationMs: 0, filesVisited: 0 }),
          expect.objectContaining({ id: 'carrier', durationMs: 0, filesVisited: 0 }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('reuses HTTP call topology when only a template endpoint literal changes', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-runtime-template-endpoint-'));
    const file = 'src/client.ts';
    const source = [
      'export function sendMessage(accountId: string) {',
      "  return fetch(`https://api.test/accounts/${accountId}/messages`, { method: 'POST' });",
      '}',
    ];
    writeFixtureFiles(tempDir, { [file]: source });
    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', file)
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`client.ts`/sendMessage().', 'sendMessage', 12)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .write();
    const baselineDb = new ScipDatabase({ projectRoot: tempDir, dbPath, indexPath: join(tempDir, 'index.scip') });
    const baseline = await collectRuntimeBoundaryGraph(baselineDb);
    baselineDb.close();

    writeFixtureFiles(tempDir, {
      [file]: source.map((line) => line.replace('/messages`', '/messages-v2`')),
    });
    const db = new ScipDatabase({ projectRoot: tempDir, dbPath, indexPath: join(tempDir, 'index.scip') });
    try {
      const refreshed = await collectRuntimeBoundaryGraph(db, { previousGraph: baseline, affectedFiles: [file] });
      const clean = await collectRuntimeBoundaryGraph(db);

      expect(refreshed.observations).toEqual(clean.observations);
      expect(refreshed.frontiers).toEqual(clean.frontiers);
      expect(refreshed.coverage.phases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'http-summary', filesVisited: 0, factsReused: expect.any(Number) }),
          expect.objectContaining({ id: 'carrier', filesVisited: 0, factsReused: expect.any(Number) }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it.each([
    {
      label: 'wrapper call',
      file: 'src/wrapper-client.ts',
      source: [
        "import { postJson } from './http-wrapper.js';",
        'export function invokeWrapped() {',
        "  return postJson('/api/wrapped-v2', {});",
        '}',
        'export function forwardWrapped(path: string) {',
        '  return postJson(path, {});',
        '}',
      ],
    },
    {
      label: 'HTTP mount',
      file: 'src/app.ts',
      source: [
        "import express from 'express';",
        "import { router as mountedRouter } from './mounted-routes.js';",
        'const app = express();',
        "app.use('/v2', mountedRouter);",
      ],
    },
    {
      label: 'carrier literal',
      file: 'src/carrier-client.ts',
      source: [
        "import { postEnvelope } from './carrier-runtime.js';",
        'export function publishCarrier(command: string) {',
        "  return postEnvelope('/carrier', { command });",
        '}',
        'export function invokeCarrier() {',
        "  return publishCarrier('async');",
        '}',
      ],
    },
    {
      label: 'registry key',
      file: 'src/registry.ts',
      source: [
        'const commandHandlers = {',
        '  async: async (input: unknown) => input,',
        '};',
        "commandHandlers['async'](payload);",
      ],
    },
    {
      label: 'same-line ambiguity removal',
      file: 'src/ambiguous-client.ts',
      source: [
        "import { postEnvelope } from './carrier-runtime.js';",
        "postEnvelope('/carrier', { command: 'first' });",
        "postEnvelope('/carrier', { command: 'second' });",
      ],
    },
    {
      label: 'terminal endpoint literal',
      file: 'src/client.ts',
      source: [
        "const EVENTS_PATH = '/api/events-v2';",
        'export async function sendEvents(events: unknown[]) {',
        "  return fetch(EVENTS_PATH, { method: 'POST', body: JSON.stringify({ events }) });",
        '}',
        "function returnedPath() { return '/api/returned'; }",
        "fetch(returnedPath(), { method: 'GET' });",
      ],
    },
    { label: 'terminal deletion', file: 'src/client.ts', source: [] },
  ])('matches a clean graph after incremental $label change', async ({ label, file, source }) => {
    const baselineDb = createBoundaryDb();
    const projectRoot = baselineDb.config.projectRoot;
    const dbPath = baselineDb.config.dbPath;
    const baseline = await collectRuntimeBoundaryGraph(baselineDb);
    baselineDb.close();
    writeFixtureFiles(projectRoot, { [file]: source });
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(projectRoot, 'index.scip') });
    try {
      const refreshed = await collectRuntimeBoundaryGraph(db, { previousGraph: baseline, affectedFiles: [file] });
      const clean = await collectRuntimeBoundaryGraph(db);

      expect(refreshed.observations).toEqual(clean.observations);
      expect(refreshed.relationGroups).toEqual(clean.relationGroups);
      expect(refreshed.links).toEqual(clean.links);
      expect(refreshed.frontiers).toEqual(clean.frontiers);
      expect(refreshed.coverage.extractors).toEqual(clean.coverage.extractors);
      expect(refreshed.coverage.extractionErrors).toEqual(clean.coverage.extractionErrors);
      expect(refreshed.fileCoverage).toEqual(clean.fileCoverage);
      if (label === 'terminal endpoint literal') {
        expect(refreshed.coverage.phases).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'http-summary', filesVisited: 0, factsReused: expect.any(Number) }),
            expect.objectContaining({ id: 'carrier', filesVisited: 0, factsReused: expect.any(Number) }),
          ]),
        );
      }
    } finally {
      db.close();
    }
  });

  it('persists extraction as part of post-index augmentation and reads it without repository configuration', async () => {
    const db = createBoundaryDb();
    const dbPath = db.config.dbPath;
    const projectRoot = db.config.projectRoot;
    db.close();

    const result = await runPostIndexAugmentationAsync(runtimeBoundaryAugmentationStage(), { projectRoot, dbPath });
    expect(result.result).toMatchObject({
      reused: false,
      observations: expect.any(Number),
      links: expect.any(Number),
      errors: 0,
    });

    const incrementalStatuses: string[] = [];
    const incremental = await runPostIndexAugmentationAsync(
      runtimeBoundaryAugmentationStage({ affectedFiles: ['src/client.ts'] }),
      {
        projectRoot,
        dbPath,
        onStatus: (message) => incrementalStatuses.push(message),
      },
    );
    expect(incremental.result).toMatchObject({ incrementallyUpdated: true, filesScanned: 26 });
    expect(incrementalStatuses).toEqual([
      expect.stringContaining('Incrementally refreshed runtime-boundary'),
      expect.stringContaining('Runtime-boundary phases:'),
    ]);

    const statuses: string[] = [];
    const reused = await runPostIndexAugmentationAsync(runtimeBoundaryAugmentationStage({ reuseExisting: true }), {
      projectRoot,
      dbPath,
      onStatus: (message) => statuses.push(message),
    });
    expect(reused.result).toMatchObject({ reused: true, observations: result.result.observations });
    expect(statuses).toEqual([expect.stringContaining('cached runtime-boundary')]);

    const reopened = new ScipDatabase({ projectRoot, dbPath, indexPath: join(projectRoot, 'index.scip') });
    try {
      const stored = readRuntimeBoundaryGraph(reopened);
      expect(stored?.observations.length).toBe(result.result.observations);
      expect(stored?.links).toEqual(expect.arrayContaining([expect.objectContaining({ strength: 'exact' })]));
      expect(
        readRuntimeBoundaryObservations(reopened, {
          protocols: ['carrier'],
          sourceScopes: ['production'],
        }),
      ).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'carrier.publish' })]));
      expect(readRuntimeBoundaryRelationGroups(reopened, { joinRules: ['carrier.discriminator'] })).toEqual(
        expect.arrayContaining([expect.objectContaining({ joinRule: 'carrier.discriminator' })]),
      );
    } finally {
      reopened.close();
    }
  });

  it('returns no stored graph for an older index instead of failing exploration', async () => {
    const db = createBoundaryDb();
    try {
      expect(readRuntimeBoundaryGraph(db)).toBeNull();
      const graph = await collectRuntimeBoundaryGraph(db);
      db.close();
      writeRuntimeBoundaryGraph(db.config.dbPath, graph);
    } finally {
      if (db.open) db.close();
    }
  });

  it('joins Effect HttpApi endpoint declarations to their uniquely registered handlers', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-effect-httpapi-boundaries-'));
    const files = {
      'src/groups.ts': [
        'import { HttpApi, HttpApiEndpoint as Endpoint, HttpApiGroup } from "effect/unstable/httpapi";',
        'const Paths = { prompt: "/session/:sessionID/message" } as const;',
        'export const SessionApi = HttpApi.make("api").add(',
        '  HttpApiGroup.make("session").add(Endpoint.post("prompt", Paths.prompt)),',
        ');',
      ],
      'src/handlers.ts': [
        'import { HttpApiBuilder as Builder } from "effect/unstable/httpapi";',
        'const prompt = (ctx: unknown) => ctx;',
        'export const handlers = Builder.group(SessionApi, "session", (handlers) =>',
        '  handlers.handle("prompt", prompt),',
        ');',
      ],
      'src/client.ts': ['fetch("/session/:sessionID/message", { method: "POST" });'],
    };
    writeFixtureFiles(tempDir, files);
    const builder = evidenceFixtureDb(join(tempDir, 'index.db'));
    Object.keys(files).forEach((file, index) => builder.document(index + 1, 'typescript', file));
    builder
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`groups.ts`/SessionApi.', 'SessionApi', 13)
      .definition(1, 1, 1, 2, 0, 4, 2)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`handlers.ts`/handlers.', 'handlers', 13)
      .definition(2, 2, 2, 2, 0, 4, 2)
      .write();
    const db = new ScipDatabase({
      projectRoot: tempDir,
      dbPath: join(tempDir, 'index.db'),
      indexPath: join(tempDir, 'index.scip'),
    });
    try {
      const graph = await collectRuntimeBoundaryGraph(db);
      expect(graph.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'http.handle',
            evidence: 'effect-httpapi-endpoint-declaration',
            keyParts: expect.arrayContaining([
              expect.objectContaining({ name: 'method', value: 'POST' }),
              expect.objectContaining({ name: 'path', value: '/session/:sessionID/message' }),
            ]),
          }),
          expect.objectContaining({
            action: 'framework.declare',
            strength: 'exact',
            keyParts: expect.arrayContaining([
              expect.objectContaining({ name: 'group', value: 'session' }),
              expect.objectContaining({ name: 'operation', value: 'prompt' }),
            ]),
          }),
          expect.objectContaining({
            action: 'framework.handle',
            strength: 'exact',
            owner: expect.objectContaining({
              file: 'src/handlers.ts',
              name: 'prompt',
              startLine: 1,
              symbol: expect.stringContaining('source-callable:'),
            }),
          }),
        ]),
      );
      expect(graph.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ joinRule: 'http.method-path' }),
          expect.objectContaining({ joinRule: 'framework.effect-httpapi-operation', strength: 'exact' }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('does not guess an Effect HttpApi handler when an operation registration is ambiguous', async () => {
    const declaration = syntheticFrameworkObservation('declaration', 'declaration');
    const first = syntheticFrameworkObservation('consumer', 'handler-a');
    const second = syntheticFrameworkObservation('consumer', 'handler-b');
    const observations = [declaration, first, second];
    const groups = buildRelationGroups(observations);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      joinRule: 'framework.effect-httpapi-operation',
      declarationIds: [declaration.id],
      consumerIds: [first.id, second.id],
    });
    expect(materializeBoundedLinks(observations, groups)).toEqual([]);
  });

  it('factorizes a 1,000 by 1,000 partial join without materializing a pairwise product', async () => {
    const observations: BoundaryObservation[] = [
      ...Array.from({ length: 1_000 }, (_, index) => syntheticHttpObservation('producer', index)),
      ...Array.from({ length: 1_000 }, (_, index) => syntheticHttpObservation('consumer', index)),
    ];
    const groups = buildRelationGroups(observations);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ joinRule: 'http.method-path' });
    expect(groups[0]?.producerIds).toHaveLength(1_000);
    expect(groups[0]?.consumerIds).toHaveLength(1_000);
    expect(materializeBoundedLinks(observations, groups)).toEqual([]);
  });

  function createBoundaryDb(): ScipDatabase {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-runtime-boundaries-'));
    const files = {
      'src/client.ts': [
        "const EVENTS_PATH = '/api/events';",
        'export async function sendEvents(events: unknown[]) {',
        "  return fetch(EVENTS_PATH, { method: 'POST', body: JSON.stringify({ events }) });",
        '}',
        "function returnedPath() { return '/api/returned'; }",
        "fetch(returnedPath(), { method: 'GET' });",
      ],
      'src/server.ts': [
        "import express from 'express';",
        'const router = express.Router();',
        "router.post('/api/events', handleEvents);",
        "router.post('/api/wrapped', handleWrapped);",
        'export async function handleEvents(request: unknown) { return request; }',
      ],
      'src/events.ts': ["bus.emit('events.appended', payload);", "bus.on('events.appended', handleAppended);"],
      'src/registry.ts': [
        'const commandHandlers = {',
        '  sync: async (input: unknown) => input,',
        '};',
        "commandHandlers['sync'](payload);",
      ],
      'src/persistence.ts': [
        'await prisma.sessionEvent.create({ data: event });',
        'await prisma.sessionEvent.findMany({ where: { sessionId } });',
        "db.get<{ id: string }>('select * from session_events');",
        "await db.insert(deliveryQueue).values({ status: 'pending' });",
      ],
      'src/custom.ts': ['internalApiRequest(resolveDispatchPath(input), payload);'],
      'src/queue-producer.ts': [
        "import amqp from 'amqplib';",
        "channel.sendToQueue('jobs.ready', Buffer.from(payload));",
      ],
      'src/queue-consumer.ts': [
        "import amqp from 'amqplib';",
        "channel.consume('jobs.ready', handleJob);",
        'await db.transaction(async (tx) => {',
        "  await tx.execute(sql`SELECT ${deliveryQueue.id} FROM ${deliveryQueue} WHERE ${deliveryQueue.status} = 'pending' FOR UPDATE SKIP LOCKED`);",
        '});',
      ],
      'src/http-wrapper.ts': [
        'export function postJson(path: string, body: unknown) {',
        "  return fetch(path, { method: 'POST', body: JSON.stringify(body) });",
        '}',
      ],
      'src/wrapper-client.ts': [
        "import { postJson } from './http-wrapper.js';",
        'export function invokeWrapped() {',
        "  return postJson('/api/wrapped', {});",
        '}',
        'export function forwardWrapped(path: string) {',
        '  return postJson(path, {});',
        '}',
      ],
      'src/non-boundaries.ts': [
        'const packageRegistry = { pack };',
        'export function requestUserInput() {',
        '  return directReasonsByFile.get("src/example.ts");',
        '}',
      ],
      'src/web-client.ts': ["fetch('/api/python', { method: 'GET' });", "fetch('/api/rust', { method: 'POST' });"],
      'src/python_server.py': [
        'from fastapi import FastAPI',
        'app = FastAPI()',
        "@app.get('/api/python')",
        'def read_python():',
        "    return {'ok': True}",
      ],
      'src/rust_server.rs': [
        'use axum::{routing::post, Router};',
        'fn routes() -> Router {',
        '    Router::new().route("/api/rust", post(handle_rust))',
        '}',
      ],
      'src/shared.ts': ["export const API_PATHS = { imported: '/api/imported' } as const;"],
      'src/imported-server.ts': [
        "import express from 'express';",
        "import { API_PATHS } from './shared.js';",
        'const router = express.Router();',
        'router.post(API_PATHS.imported, handleImported);',
      ],
      'src/imported-client.ts': ["fetch('/api/imported', { method: 'POST' });"],
      'src/__tests__/supertest.test.ts': ["import request from 'supertest';", "request(app).post('/api/events');"],
      'src/mounted-routes.ts': [
        "import express from 'express';",
        'export const router = express.Router();',
        "router.post('/mounted', handleMounted);",
      ],
      'src/app.ts': [
        "import express from 'express';",
        "import { router as mountedRouter } from './mounted-routes.js';",
        'const app = express();',
        "app.use('/api', mountedRouter);",
      ],
      'src/mounted-client.ts': ["fetch('/api/mounted', { method: 'POST' });"],
      'src/carrier-runtime.ts': [
        'export function postEnvelope(path: string, body: unknown) {',
        "  return fetch(path, { method: 'POST', body: JSON.stringify(body) });",
        '}',
      ],
      'src/carrier-client.ts': [
        "import { postEnvelope } from './carrier-runtime.js';",
        'export function publishCarrier(command: string) {',
        "  return postEnvelope('/carrier', { command });",
        '}',
        'export function invokeCarrier() {',
        "  return publishCarrier('sync');",
        '}',
      ],
      'src/carrier-server.ts': [
        "import express from 'express';",
        'function createRegistry<T>(value: T): T { return value; }',
        'const familyHandlers = {',
        '  sync: async (request: unknown) => request,',
        '} satisfies Record<string, (request: unknown) => Promise<unknown>>;',
        'function readEnvelope(request: any) {',
        '  const command = request.body?.command;',
        '  return { command };',
        '}',
        'const handlers = createRegistry(familyHandlers);',
        'export const controller = {',
        '  async dispatch(request: any) {',
        '    const { command } = readEnvelope(request);',
        '    return handlers[command](request);',
        '  },',
        '};',
        'const router = express.Router();',
        "router.post('/carrier', controller.dispatch);",
      ],
      'src/mutated-client.ts': [
        "let path = '/api/events';",
        "path = '/api/other';",
        "fetch(path, { method: 'POST' });",
      ],
      'src/ambiguous-client.ts': [
        "import { postEnvelope } from './carrier-runtime.js';",
        "postEnvelope('/carrier', { command: 'first' }); postEnvelope('/carrier', { command: 'second' });",
      ],
    };
    writeFixtureFiles(tempDir, files);
    const builder = evidenceFixtureDb(join(tempDir, 'index.db'));
    Object.keys(files).forEach((file, index) =>
      builder.document(index + 1, file.endsWith('.py') ? 'python' : file.endsWith('.rs') ? 'rust' : 'typescript', file),
    );
    builder
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`http-wrapper.ts`/postJson().', 'postJson', 12)
      .definition(1, 9, 1, 0, 0, 2, 1)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`wrapper-client.ts`/invokeWrapped().', 'invokeWrapped', 12)
      .definition(2, 10, 2, 1, 0, 3, 1)
      .symbol(3, 'scip-typescript npm fixture 1.0.0 src/`shared.ts`/API_PATHS.', 'API_PATHS', 13)
      .definition(3, 15, 3, 0, 0, 0, 67)
      .symbol(4, 'scip-typescript npm fixture 1.0.0 src/`mounted-routes.ts`/router.', 'router', 13)
      .definition(4, 19, 4, 1, 0, 1, 46)
      .symbol(5, 'scip-typescript npm fixture 1.0.0 src/`carrier-runtime.ts`/postEnvelope().', 'postEnvelope', 12)
      .definition(5, 22, 5, 0, 0, 2, 1)
      .symbol(6, 'scip-typescript npm fixture 1.0.0 src/`carrier-client.ts`/publishCarrier().', 'publishCarrier', 12)
      .definition(6, 23, 6, 1, 0, 3, 1)
      .symbol(7, 'scip-typescript npm fixture 1.0.0 src/`carrier-client.ts`/invokeCarrier().', 'invokeCarrier', 12)
      .definition(7, 23, 7, 4, 0, 6, 1)
      .symbol(8, 'scip-typescript npm fixture 1.0.0 src/`carrier-server.ts`/familyHandlers.', 'familyHandlers', 13)
      .definition(8, 24, 8, 2, 0, 4, 70)
      .symbol(9, 'scip-typescript npm fixture 1.0.0 src/`carrier-server.ts`/readEnvelope().', 'readEnvelope', 12)
      .definition(9, 24, 9, 5, 0, 8, 1)
      .symbol(10, 'scip-typescript npm fixture 1.0.0 src/`carrier-server.ts`/handlers.', 'handlers', 13)
      .definition(10, 24, 10, 9, 0, 9, 57)
      .symbol(11, 'scip-typescript npm fixture 1.0.0 src/`carrier-server.ts`/controller.', 'controller', 13)
      .definition(11, 24, 11, 10, 0, 15, 2)
      .symbol(12, 'scip-typescript npm fixture 1.0.0 src/`wrapper-client.ts`/forwardWrapped().', 'forwardWrapped', 12)
      .definition(12, 10, 12, 4, 0, 6, 1)
      .symbol(13, 'scip-typescript npm fixture 1.0.0 src/`client.ts`/returnedPath().', 'returnedPath', 12)
      .definition(13, 1, 13, 4, 0, 4, 51);
    builder.write();
    return new ScipDatabase({
      projectRoot: tempDir,
      dbPath: join(tempDir, 'index.db'),
      indexPath: join(tempDir, 'index.scip'),
    });
  }
});

function syntheticHttpObservation(role: 'producer' | 'consumer', index: number): BoundaryObservation {
  const action = role === 'producer' ? 'http.request' : 'http.handle';
  const file = `src/${role}-${index}.ts`;
  return {
    id: `${role}-${index}`,
    extractor: 'fixture',
    action,
    owner: { file, symbol: null, name: null, startLine: 0, endLine: 0 },
    source: { file, startLine: 0, endLine: 0 },
    keyParts: [
      { name: 'method', value: 'POST', evidence: 'literal' },
      { name: 'path', value: '/shared', evidence: 'literal' },
    ],
    evidence: 'fixture',
    strength: 'exact',
    protocol: 'http',
    role,
    executionDomain: null,
    derivation: {
      kind: 'direct',
      rule: 'fixture',
      ruleVersion: '1',
      inputFactIds: [],
      sourceSpans: [{ file, startLine: 0, endLine: 0 }],
    },
    valuePrecision: 'literal',
    modality: 'may',
    resolution: 'unresolved',
    sourceScope: 'production',
  };
}

function syntheticFrameworkObservation(role: 'declaration' | 'consumer', id: string): BoundaryObservation {
  return {
    id,
    extractor: 'fixture',
    action: role === 'declaration' ? 'framework.declare' : 'framework.handle',
    owner: { file: `src/${id}.ts`, symbol: null, name: id, startLine: 0, endLine: 0 },
    source: { file: `src/${id}.ts`, startLine: 0, endLine: 0 },
    keyParts: [
      { name: 'adapter', value: 'effect-httpapi', evidence: 'literal' },
      { name: 'group', value: 'session', evidence: 'literal' },
      { name: 'operation', value: 'prompt', evidence: 'literal' },
    ],
    evidence: 'fixture',
    strength: 'exact',
    protocol: 'framework',
    role,
    executionDomain: null,
    derivation: { kind: 'direct', rule: 'fixture', ruleVersion: '1', inputFactIds: [], sourceSpans: [] },
    valuePrecision: 'literal',
    modality: 'must',
    resolution: 'unresolved',
    sourceScope: 'production',
  };
}
