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
import type { BoundaryObservation } from '../../src/analysis/runtime-boundaries/types.js';
import { runtimeBoundaryAugmentationStage } from '../../src/reindex/runtime-boundaries.js';
import { runPostIndexAugmentation } from '../../src/reindex/augmentation/post-index-augmentation.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('runtime-boundary evidence', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('extracts open observations and joins only evidence-backed runtime peers', () => {
    const db = createBoundaryDb();
    try {
      const graph = collectRuntimeBoundaryGraph(db);

      expect(graph.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'http.request',
            strength: expect.stringMatching(/^(?:exact|derived)$/u),
            source: expect.objectContaining({ file: 'src/client.ts' }),
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
          expect.objectContaining({ action: 'queue.send', strength: 'exact' }),
          expect.objectContaining({ action: 'queue.consume', strength: 'exact' }),
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
          expect.objectContaining({ joinRule: 'carrier.discriminator', strength: 'derived' }),
        ]),
      );
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

      writeRuntimeBoundaryGraph(db.config.dbPath, graph);
    } finally {
      db.close();
    }
  });

  it('persists extraction as part of post-index augmentation and reads it without repository configuration', () => {
    const db = createBoundaryDb();
    const dbPath = db.config.dbPath;
    const projectRoot = db.config.projectRoot;
    db.close();

    const result = runPostIndexAugmentation(runtimeBoundaryAugmentationStage(), { projectRoot, dbPath });
    expect(result.result).toMatchObject({
      reused: false,
      observations: expect.any(Number),
      links: expect.any(Number),
      errors: 0,
    });

    const statuses: string[] = [];
    const reused = runPostIndexAugmentation(runtimeBoundaryAugmentationStage({ reuseExisting: true }), {
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

  it('returns no stored graph for an older index instead of failing exploration', () => {
    const db = createBoundaryDb();
    try {
      expect(readRuntimeBoundaryGraph(db)).toBeNull();
      const graph = collectRuntimeBoundaryGraph(db);
      db.close();
      writeRuntimeBoundaryGraph(db.config.dbPath, graph);
    } finally {
      if (db.open) db.close();
    }
  });

  it('factorizes a 1,000 by 1,000 partial join without materializing a pairwise product', () => {
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
      ],
      'src/custom.ts': ['internalApiRequest(resolveDispatchPath(input), payload);'],
      'src/queue-producer.ts': [
        "import amqp from 'amqplib';",
        "channel.sendToQueue('jobs.ready', Buffer.from(payload));",
      ],
      'src/queue-consumer.ts': ["import amqp from 'amqplib';", "channel.consume('jobs.ready', handleJob);"],
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
      .definition(11, 24, 11, 10, 0, 15, 2);
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
