import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import {
  collectRuntimeBoundaryGraph,
  readRuntimeBoundaryGraph,
  writeRuntimeBoundaryGraph,
} from '../../../src/analysis/runtime-boundaries/index.js';
import { systemMap } from '../../../src/queries/graph/system-map.js';
import { dependenceSlice } from '../../../src/queries/graph/dependence-slice.js';
import { graphEvidence } from '../../../src/queries/graph/graph-evidence.js';
import { valueFlow } from '../../../src/queries/graph/value-flow.js';
import { connectedBehaviorPacket } from '../../../src/queries/internal/connected-behavior.js';
import { createExplorationTopology } from '../../../src/queries/internal/exploration-topology.js';
import { ProjectIndex } from '../../../src/queries/internal/project-index.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { importedMemberCallTargets } from '../../../src/symbols/graph/member-call-targets.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const symbols = {
  companionAppend: 'scip-typescript npm companion 1.0.0 src/`client.ts`/appendStreamEvents().',
  companionCommand: 'scip-typescript npm companion 1.0.0 src/`command.ts`/sessionStreamEvents().',
  companionEntry: 'scip-typescript npm companion 1.0.0 src/`entry.ts`/externalSessionPath().',
  dispatch: 'scip-typescript npm companion 1.0.0 src/`dispatch.ts`/dispatchCommand().',
  apiAppend: 'scip-typescript npm api 1.0.0 src/modules/sessions/`events.ts`/appendStreamEvents().',
  apiRoute: 'scip-typescript npm api 1.0.0 src/modules/sessions/`routes.ts`/dispatchStreamEvents().',
  listEvents: 'scip-typescript npm api 1.0.0 src/modules/sessions/`query.ts`/listEvents().',
  publish: 'scip-typescript npm api 1.0.0 src/modules/sessions/`realtime.ts`/publishUpdate().',
  eventTable: 'scip-typescript npm api 1.0.0 src/db/schema/`work-sessions.ts`/agentWorkSessionEvents.',
  realtimeTypes: 'scip-typescript npm shared 1.0.0 src/contracts/`sessions.ts`/sessionRealtimeEventTypes.',
  webRealtime: 'scip-typescript npm web 1.0.0 src/components/sessions/`realtime.ts`/handleRealtime().',
  refresh: 'scip-typescript npm web 1.0.0 src/components/sessions/`client.ts`/refreshEvents().',
  render: 'scip-typescript npm web 1.0.0 src/components/sessions/`view.ts`/renderEvent().',
  memberRegistry: 'scip-typescript npm api 1.0.0 src/modules/member-flow/`registry.ts`/memberRegistry.',
  capabilityInstruction: 'scip-typescript npm companion 1.0.0 src/`background.ts`/',
  capabilityHandler: 'scip-typescript npm companion 1.0.0 src/`kill-process.ts`/',
} as const;

describe('explicit-anchor system maps', { timeout: 15_000 }, () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('projects several exact roots into one compact typed evidence packet', () => {
    const db = createSystemMapDb();
    try {
      const result = graphEvidence(
        db,
        { symbols: [symbols.companionCommand, symbols.apiAppend] },
        { view: 'complete', maxDepth: 2, maxEdges: 40 },
      );

      expect(result.targets).toEqual([
        expect.objectContaining({ query: symbols.companionCommand, status: 'matched' }),
        expect.objectContaining({ query: symbols.apiAppend, status: 'matched' }),
      ]);
      expect(result.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ family: 'execution', subtype: 'call' }),
          expect.objectContaining({ family: 'dataflow' }),
        ]),
      );
      const temporalInventory = result.inventory.find((row) => row.family === 'temporal');
      expect(temporalInventory?.both).toBeGreaterThan(0);
      if (!result.edges.some((edge) => edge.family === 'temporal')) {
        expect(result.folds).toEqual(expect.arrayContaining([expect.objectContaining({ family: 'temporal' })]));
      }
      expect(result.edges.some((edge) => edge.from.location || edge.to.location)).toBe(true);
      expect(result.coverage).toMatchObject({ maxDepth: 2, maxEdges: 40, returnedEdges: result.edges.length });
    } finally {
      db.close();
    }
  });

  it('keeps explicit edge selection and edge-budget omissions visible', () => {
    const db = createSystemMapDb();
    try {
      const result = graphEvidence(
        db,
        { symbols: [symbols.apiAppend] },
        { families: ['execution'], maxDepth: 2, maxEdges: 1 },
      );
      const expanded = graphEvidence(
        db,
        { symbols: [symbols.apiAppend] },
        { families: ['execution'], maxDepth: 2, maxEdges: 1_000 },
      );

      expect(result.view).toBe('custom');
      expect(result.families).toEqual(['execution']);
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]?.family).toBe('execution');
      expect(result.coverage.eligibleEdges).toBeGreaterThanOrEqual(1);
      expect(result.coverage.omittedEdges).toBe(result.coverage.eligibleEdges - 1);
      expect(result.coverage.status).toBe(result.coverage.omittedEdges > 0 ? 'bounded' : 'accounted');
      const emittedIds = new Set(result.edges.map((edge) => edge.id));
      const foldedIds = result.folds.flatMap((fold) => fold.edgeIds);
      expect(new Set([...emittedIds, ...foldedIds])).toEqual(new Set(expanded.edges.map((edge) => edge.id)));
      expect(foldedIds).toHaveLength(new Set(foldedIds).size);
      expect(result.folds.every((fold) => fold.minimumMaxEdges <= expanded.coverage.eligibleEdges)).toBe(true);
      expect(result.folds.every((fold) => ['linear', 'scc', 'topology'].includes(fold.mode))).toBe(true);
      const fold = result.folds[0];
      if (fold) {
        const materialized = graphEvidence(
          db,
          { symbols: [symbols.apiAppend] },
          { families: ['execution'], maxDepth: 2, maxEdges: 1, foldIds: [fold.id] },
        );
        expect(materialized.selection.foldIds).toEqual([fold.id]);
        expect(materialized.edges.map((edge) => edge.id).sort()).toEqual(fold.edgeIds);
        expect(materialized.folds).toEqual([]);
        expect(materialized.coverage).toMatchObject({ status: 'accounted', omittedEdges: 0 });
        expect(() =>
          graphEvidence(
            db,
            { symbols: [symbols.apiAppend] },
            { families: ['execution'], maxDepth: 2, maxEdges: 1, foldIds: ['fold:unknown'] },
          ),
        ).toThrow('Unknown evidence fold');
      }
    } finally {
      db.close();
    }
  });

  it('projects explicit directions and reports exact inventory without materializing edges', () => {
    const db = createSystemMapDb();
    try {
      const selectors = { symbols: [symbols.apiAppend] };
      const shared = { families: ['execution'] as const, maxDepth: 2, maxEdges: 1_000 };
      const incoming = graphEvidence(db, selectors, { ...shared, direction: 'incoming' });
      const outgoing = graphEvidence(db, selectors, { ...shared, direction: 'outgoing' });
      const both = graphEvidence(db, selectors, { ...shared, direction: 'both' });
      const inventory = graphEvidence(db, selectors, { ...shared, inventoryOnly: true });

      expect(incoming.selection.direction).toBe('incoming');
      expect(outgoing.selection.direction).toBe('outgoing');
      expect(both.selection.direction).toBe('both');
      expect(incoming.edges.length).toBeGreaterThan(0);
      expect(outgoing.edges.length).toBeGreaterThan(0);
      const bothIds = new Set(both.edges.map((edge) => edge.id));
      expect([...incoming.edges, ...outgoing.edges].every((edge) => bothIds.has(edge.id))).toBe(true);
      expect(inventory.edges).toEqual([]);
      expect(inventory.coverage).toMatchObject({
        matchedEdges: both.coverage.matchedEdges,
        eligibleEdges: 0,
        returnedEdges: 0,
        omittedEdges: 0,
      });
      expect(inventory.inventory.reduce((total, row) => total + row.incoming, 0)).toBe(incoming.coverage.matchedEdges);
      expect(inventory.inventory.reduce((total, row) => total + row.outgoing, 0)).toBe(outgoing.coverage.matchedEdges);
      expect(inventory.inventory.reduce((total, row) => total + row.both, 0)).toBe(both.coverage.matchedEdges);
    } finally {
      db.close();
    }
  });

  it('filters exact subtypes and returns deterministic connecting paths for several roots', () => {
    const db = createSystemMapDb();
    try {
      const selectors = { symbols: [symbols.companionCommand, symbols.apiAppend] };
      const complete = graphEvidence(db, selectors, { view: 'complete', maxDepth: 8, maxEdges: 1_000 });
      const subtype = complete.inventory.find((row) => row.both > 0)?.subtype;
      expect(subtype).toBeDefined();

      const filtered = graphEvidence(db, selectors, {
        view: 'complete',
        subtypes: [subtype!],
        maxDepth: 8,
        maxEdges: 1_000,
      });
      expect(filtered.selection.subtypes).toEqual([subtype]);
      expect(filtered.edges.every((edge) => edge.subtype === subtype)).toBe(true);

      const first = graphEvidence(db, selectors, {
        view: 'complete',
        direction: 'both',
        connecting: true,
        maxDepth: 8,
        maxEdges: 1_000,
      });
      const second = graphEvidence(db, selectors, {
        view: 'complete',
        direction: 'both',
        connecting: true,
        maxDepth: 8,
        maxEdges: 1_000,
      });
      expect(first.selection.connecting).toBe(true);
      expect(first.edges.length).toBeGreaterThan(0);
      expect(first.edges.map((edge) => edge.id)).toEqual(second.edges.map((edge) => edge.id));
      expect(first.edges.every((edge) => complete.edges.some((candidate) => candidate.id === edge.id))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('rejects connecting projections that do not resolve at least two roots', () => {
    const db = createSystemMapDb();
    try {
      expect(() => graphEvidence(db, { symbols: [symbols.apiAppend] }, { connecting: true })).toThrow(
        'Connecting evidence requires at least two resolved root nodes.',
      );
    } finally {
      db.close();
    }
  });

  it('preserves every literal hit and every ambiguous symbol candidate', () => {
    const db = createSystemMapDb();
    try {
      const result = systemMap(db, {
        searches: ['work_session_stream_events'],
        symbols: ['appendStreamEvents'],
        maxDepth: 0,
      });

      expect(result.anchors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'literal',
            query: 'work_session_stream_events',
            status: 'matched',
            matchingLines: 2,
          }),
          expect.objectContaining({
            kind: 'symbol',
            query: 'appendStreamEvents',
            status: 'ambiguous',
            totalSymbolCandidates: 2,
            omittedSymbolCandidates: 0,
            symbolCandidates: expect.arrayContaining([
              expect.objectContaining({ symbol: symbols.companionAppend }),
              expect.objectContaining({ symbol: symbols.apiAppend }),
            ]),
          }),
        ]),
      );
      expect(result.coverage.literalSearchesComplete).toBe(true);
      expect(result.coverage.symbolCandidateSetsComplete).toBe(true);
    } finally {
      db.close();
    }
  });

  it('keeps compatibility selection terms from changing graph or recovery membership', () => {
    const db = createSystemMapDb();
    try {
      const selectors = {
        symbols: [symbols.companionCommand, symbols.apiAppend],
        maxDepth: 3,
      };
      const baseline = systemMap(db, selectors);
      const relabeled = systemMap(db, {
        ...selectors,
        selectionTerms: ['persistence', 'authorization', 'unrelated-vocabulary'],
      });

      expect(relabeled.topology).toEqual(baseline.topology);
      expect(relabeled.nextAnchors).toEqual(baseline.nextAnchors);
    } finally {
      db.close();
    }
  });

  it('uses an exact wrapped-callable range as a source construct when SCIP has no local definition', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-source-construct-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/service.ts': [
        "const process = Effect.fn('Session.process')(function* (input: Input) {",
        '  if (!input.ready) return false;',
        '  yield* persist(input);',
        '  return true;',
        '});',
      ],
    });
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/service.ts').write();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = systemMap(db, { symbols: ['src/service.ts:1-5'], maxDepth: 1 });

      expect(result.anchors[0]).toMatchObject({
        kind: 'symbol',
        status: 'matched',
        totalSymbolCandidates: 1,
        symbolCandidates: [
          expect.objectContaining({ shortName: 'process', relativePath: 'src/service.ts', startLine: 0, endLine: 4 }),
        ],
      });
      expect(result.regions).toEqual(
        expect.arrayContaining([expect.objectContaining({ sourceFileCount: 1, symbolCount: 0 })]),
      );
      expect(result.behavior?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'process',
            location: expect.objectContaining({ file: 'src/service.ts', line: 0, endLine: 4 }),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('protects an exact process crossing inside a large anchored construct', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-process-crossing-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    const filler = Array.from(
      { length: 70 },
      (_, index) => `  const bookkeeping${index} = '${'x'.repeat(70)}-${index}';`,
    );
    const source = [
      "import { spawn } from 'node:child_process';",
      'export function run(command: string) {',
      ...filler.slice(0, 35),
      "  const child = spawn('sh', ['-c', command], { cwd: '/repo', stdio: ['ignore', 'pipe', 'pipe'] });",
      ...filler.slice(35),
      '  return child;',
      '}',
    ];
    writeFixtureFiles(projectRoot, { 'src/runner.ts': source });
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/runner.ts').write();
    const config = { projectRoot, dbPath, indexPath: join(root, 'index.scip') };
    const initial = new ScipDatabase(config);
    const graph = collectRuntimeBoundaryGraph(initial);
    initial.close();
    writeRuntimeBoundaryGraph(dbPath, graph);
    const db = new ScipDatabase(config);
    try {
      expect(
        readRuntimeBoundaryGraph(db)?.observations.some(
          (observation) => observation.action === 'process.spawn' && observation.source.startLine === 37,
        ),
      ).toBe(true);
      const result = systemMap(db, {
        symbols: [`src/runner.ts:2-${source.length}`],
        maxDepth: 1,
        relations: ['runtime-boundary'],
        behaviorFocusLocations: [{ file: 'src/runner.ts', line: 2 }],
      });

      const runner = result.behavior?.steps.find((step) => step.location?.file === 'src/runner.ts');
      expect(runner?.behavior?.kind).toBe('connector-slice');
      expect(runner?.behavior?.lines).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("spawn('sh'") })]),
      );
    } finally {
      db.close();
    }
  });

  it('materializes one source construct when several callsites share the same enclosing callable', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-source-construct-deduplication-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/service.ts': [
        'const processImpl = () => true;',
        'export const loop = Effect.fn("loop")(function* () {',
        '  yield* processImpl();',
        '  return yield* processImpl();',
        '});',
      ],
    });
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/service.ts').write();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = systemMap(db, {
        symbols: ['src/service.ts:1-1'],
        maxDepth: 2,
        relations: ['call'],
      });

      const loopNodes = result.topology?.nodes.filter((node) => node.label === 'loop') ?? [];
      expect(loopNodes).toHaveLength(1);
      expect(loopNodes[0]?.location).toEqual({ file: 'src/service.ts', line: 1, endLine: 4 });
      const callEdges = result.topology?.edges.filter((edge) => edge.kind === 'call') ?? [];
      expect(callEdges.length).toBeGreaterThan(0);
      expect(
        callEdges.every((edge) =>
          edge.semantics?.some(({ family, subtype }) => family === 'control' && subtype === 'call'),
        ),
      ).toBe(true);
      expect(result.topology?.coverage.programEdges?.unmappedKinds).toEqual([]);
      const loopStep = result.behavior?.steps.filter((step) => step.label === 'loop') ?? [];
      expect(loopStep).toHaveLength(1);
      expect(loopStep[0]?.behavior?.lines.map((line) => line.line)).toEqual(expect.arrayContaining([2, 3]));
    } finally {
      db.close();
    }
  });

  it('joins compiler-resolved argument and return flow to call edges in the first system map', () => {
    const db = createSystemMapDb();
    try {
      const result = systemMap(db, {
        symbols: [symbols.companionCommand, symbols.companionAppend, symbols.dispatch],
        maxDepth: 1,
        relations: ['call'],
      });

      const dataEdges = result.topology?.edges.filter((edge) => edge.kind === 'data-transfer') ?? [];
      expect(dataEdges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            disposition: 'folded',
            semantics: [
              expect.objectContaining({
                family: 'data',
                subtype: 'argument-to-parameter',
                attributes: expect.objectContaining({ argumentText: 'events', callerPosition: 0, calleePosition: 0 }),
              }),
            ],
          }),
          expect.objectContaining({
            disposition: 'folded',
            semantics: [
              expect.objectContaining({
                family: 'data',
                subtype: 'constant-to-parameter',
                attributes: expect.objectContaining({
                  value: 'work_session_stream_events',
                  precision: 'literal',
                  calleePosition: 0,
                }),
              }),
            ],
          }),
        ]),
      );
      expect(result.topology?.coverage.programEdges?.families.data).toMatchObject({
        sourceEdges: expect.any(Number),
        projectedEdges: expect.any(Number),
        subtypes: ['argument-to-parameter', 'constant-to-parameter', 'definition-to-use', 'return-to-call-result'],
      });
      expect(result.topology?.coverage.programEdges?.families.data.projectedEdges).toBeGreaterThan(0);
      const corridorDataSubtypes =
        result.topology?.edges
          .filter((edge) => result.topology?.corridor?.edgeIds.includes(edge.id))
          .flatMap((edge) => edge.semantics ?? [])
          .filter((semantic) => semantic.family === 'data')
          .map((semantic) => semantic.subtype) ?? [];
      expect(corridorDataSubtypes).toEqual(
        expect.arrayContaining(['argument-to-parameter', 'constant-to-parameter', 'return-to-call-result']),
      );
      expect(
        result.topology?.nodes.some(
          (node) => node.kind === 'call-result' && node.attributes['calleeSymbol'] === symbols.companionAppend,
        ),
      ).toBe(true);
      expect(
        result.topology?.nodes.some(
          (node) => node.kind === 'call-result' && node.attributes['calleeSymbol'] === symbols.publish,
        ),
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it('keeps proved value flow distinct from reference and call neighborhoods', () => {
    const db = createSystemMapDb();
    try {
      const flow = valueFlow(db, { symbols: [symbols.companionCommand, symbols.companionAppend] }, { maxDepth: 1 });

      expect(flow.kind).toBe('value-flow');
      expect(flow.edges).toEqual(
        expect.arrayContaining([expect.objectContaining({ family: 'dataflow', subtype: 'argument-to-parameter' })]),
      );
      expect(flow.edges.every((edge) => edge.family === 'dataflow')).toBe(true);
      expect(flow.edges).toEqual(
        expect.arrayContaining([expect.objectContaining({ family: 'dataflow', subtype: 'return-to-call-result' })]),
      );
      expect(flow.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            family: 'dataflow',
            subtype: 'definition-to-use',
            providerId: 'typescript-local-dependence',
          }),
        ]),
      );
      expect(flow.coverage).toMatchObject({
        basis: 'proved-bounded-static-value-flow',
        analysisBasis: 'partial-system-definition-use',
        providers: ['bounded-static-value-flow', 'typescript-local-dependence'],
      });
      expect(flow.coverage.unsupportedRelations).not.toContain('general local definition-use chains');
      expect(flow.coverage.unsupportedRelations).toContain(
        'general heap alias and cross-instance field points-to flow',
      );
    } finally {
      db.close();
    }
  });

  it('computes a directional dependence slice and labels call connectors as support', () => {
    const db = createSystemMapDb();
    try {
      const result = dependenceSlice(db, symbols.companionAppend, {
        direction: 'backward',
        maxDepth: 2,
        maxEdges: 200,
      });

      expect(result).toMatchObject({
        kind: 'dependence-slice',
        direction: 'backward',
        coverage: { basis: 'partial-system-dependence-graph', criterionKind: 'symbol-summary' },
      });
      expect(result.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ family: 'dataflow', subtype: 'argument-to-parameter', supporting: false }),
          expect.objectContaining({ family: 'execution', subtype: 'call', supporting: true }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('reverse-connects an imported service member call to its source-only implementation', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-source-service-member-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/service.ts': [
        'const processImpl = () => true;',
        'export const Service = Context.GenericTag("Service");',
        'const layer = Layer.effect(Service, Effect.gen(function* () {',
        '  return Service.of({ process: processImpl });',
        '}));',
      ],
      'src/caller.ts': [
        "import * as SessionCompaction from './service.js';",
        'export const loop = Effect.fn("loop")(function* () {',
        '  const compaction = yield* SessionCompaction.Service;',
        '  return yield* compaction.process();',
        '});',
        'export const prompt = Effect.fn("prompt")(function* () {',
        '  return yield* loop();',
        '});',
      ],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/service.ts')
      .document(2, 'typescript', 'src/caller.ts')
      .write();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(root, 'index.scip') });
    try {
      expect(importedMemberCallTargets(db, 'src/caller.ts', { excludeIndexedTargets: false })).toMatchObject({
        targets: [
          expect.objectContaining({
            sourceFile: 'src/caller.ts',
            targetFile: 'src/service.ts',
            targetStartLine: 0,
            targetEndLine: 0,
          }),
        ],
      });
      expect([...(new ProjectIndex(db).fileDependencyGraph().get('src/caller.ts') ?? [])]).toContain('src/service.ts');
      const result = systemMap(db, {
        symbols: ['src/service.ts:1-1'],
        maxDepth: 3,
        relations: ['call'],
      });

      expect(result.topology?.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'call',
            fromNodeId: expect.stringContaining('loop'),
            toNodeId: expect.stringContaining('processImpl'),
            evidence: expect.arrayContaining([
              expect.objectContaining({ method: 'ast-service-member-callsite', strength: 'derived' }),
            ]),
          }),
          expect.objectContaining({
            kind: 'call',
            fromNodeId: expect.stringContaining('prompt'),
            toNodeId: expect.stringContaining('loop'),
            evidence: expect.arrayContaining([
              expect.objectContaining({ method: 'ast-callsite', strength: 'derived' }),
            ]),
          }),
        ]),
      );
      expect(result.behavior?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'processImpl' }),
          expect.objectContaining({
            label: expect.stringContaining('loop'),
            location: expect.objectContaining({ file: 'src/caller.ts' }),
          }),
          expect.objectContaining({
            label: expect.stringContaining('prompt'),
            location: expect.objectContaining({ file: 'src/caller.ts' }),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('reverse-connects service callers through a separate declaration and provider file', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-split-service-provider-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/service.ts': ['export class Service {}'],
      'src/provider.ts': [
        "import { Service } from './service.js';",
        'const processImpl = () => true;',
        'export const layer = Layer.effect(Service, Effect.gen(function* () {',
        '  return Service.of({ process: processImpl });',
        '}));',
      ],
      'src/caller.ts': [
        "import * as Work from './service.js';",
        'export const loop = Effect.fn("loop")(function* () {',
        '  const service = yield* Work.Service;',
        '  return yield* service.process();',
        '});',
      ],
    });
    const serviceSymbol = 'scip-typescript npm fixture 1.0.0 src/`service.ts`/Service#';
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/service.ts')
      .document(2, 'typescript', 'src/provider.ts')
      .document(3, 'typescript', 'src/caller.ts')
      .symbol(1, serviceSymbol, 'Service', 7)
      .definition(1, 1, 1, 0, 0, 0, 1)
      .chunk(1, 1, 0, 0)
      .mention(1, 1, 1)
      .chunk(2, 2, 0, 4)
      .mention(2, 1, 2)
      .chunk(3, 3, 0, 4)
      .mention(3, 1, 2)
      .write();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = systemMap(db, {
        symbols: ['src/provider.ts:2-2'],
        maxDepth: 3,
        relations: ['call'],
      });

      expect(result.topology?.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'call',
            fromNodeId: expect.stringContaining('loop'),
            toNodeId: expect.stringContaining('processImpl'),
            evidence: expect.arrayContaining([
              expect.objectContaining({ method: 'ast-service-member-callsite', strength: 'derived' }),
            ]),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('attributes a reverse call inside an anonymous layer factory to its enclosing binding', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-source-layer-owner-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/compaction.ts': ['export const make = () => ({ compact: true });'],
      'src/runner.ts': [
        "import * as Compaction from './compaction.js';",
        'export const layer = Layer.effect(Service, Effect.gen(function* () {',
        '  const compaction = Compaction.make();',
        '  return Service.of({ run: () => compaction.compact });',
        '}));',
      ],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/compaction.ts')
      .document(2, 'typescript', 'src/runner.ts')
      .write();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = systemMap(db, {
        symbols: ['src/compaction.ts:1-1'],
        maxDepth: 2,
        relations: ['call'],
      });
      expect(result.topology?.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'call',
            fromNodeId: expect.stringContaining('layer'),
            toNodeId: expect.stringContaining('make'),
            evidence: expect.arrayContaining([
              expect.objectContaining({ method: 'ast-member-import-candidate', strength: 'candidate' }),
            ]),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('retains embedded and test-only literal matches without letting them seed default traversal', () => {
    const db = createSystemMapDb();
    try {
      const collapsed = systemMap(db, { searches: ['issue.created'], maxDepth: 0 });
      const anchor = collapsed.anchors.find((candidate) => candidate.kind === 'literal');

      expect(anchor).toMatchObject({
        matchingLines: 4,
        seedMatchingLines: 2,
        matchOnlyLines: 2,
        seedRegionIds: ['region:apps/api:modules/webhooks'],
        matchOnlyRegionIds: expect.arrayContaining([
          'region:apps/api:modules/reports',
          'region:apps/api:modules/webhooks',
        ]),
      });
      expect(collapsed.expansion?.regionIds).toContain('region:apps/api:modules/webhooks');
      expect(collapsed.expansion?.regionIds).not.toContain('region:apps/api:modules/reports');

      const expanded = systemMap(db, {
        searches: ['issue.created'],
        maxDepth: 0,
        expand: ['region:apps/api:modules/webhooks', 'region:apps/api:modules/reports'],
      });
      expect(expanded.regions.flatMap((region) => region.literalHits)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ matchKind: 'exact-value', traversalSeed: true }),
          expect.objectContaining({ matchKind: 'boundary', traversalSeed: true }),
          expect.objectContaining({ matchKind: 'exact-value', traversalSeed: false }),
          expect.objectContaining({ matchKind: 'embedded', traversalSeed: false }),
        ]),
      );
      expect(expanded.drilldown?.command).toContain("--at 'apps/api/src/modules/webhooks/event.ts:1'");
      expect(expanded.drilldown?.definitionCommand).toBeNull();
    } finally {
      db.close();
    }
  });

  it('connects command, API, persistence, shared contract, and web regions through typed evidence', () => {
    const db = createSystemMapDb();
    try {
      const result = systemMap(db, {
        searches: ['work_session_stream_events'],
        symbols: ['appendStreamEvents'],
        maxDepth: 3,
      });

      expect(result.regions.map((region) => region.label)).toEqual(
        expect.arrayContaining([
          'companion:root',
          'api:modules/sessions',
          'api:db/schema',
          'shared:contracts',
          'web:components/sessions',
        ]),
      );
      expect([...new Set(result.regions.flatMap((region) => region.relationKinds))]).toEqual(
        expect.arrayContaining(['call', 'import', 'reference', 'runtime-boundary']),
      );
      expect(result.regions.find((region) => region.label === 'api:db/schema')?.notableSymbols).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ shortName: expect.stringContaining('agentWorkSessionEvents') }),
        ]),
      );
      expect(result.regions.find((region) => region.label === 'web:components/sessions')?.notableSymbols).toEqual(
        expect.arrayContaining([expect.objectContaining({ shortName: expect.stringContaining('handleRealtime') })]),
      );
      expect(result.coverage.relationFamilies.reference.scope).toContain('explicit anchors');
      expect(result.coverage.referenceExpansionEligibleSymbols).toBeGreaterThan(0);
      expect(result.coverage.referenceExpansionSkippedSymbols).toBeGreaterThan(0);
      expect(result.coverage.dynamicDispatchRepresented).toBe(false);
      expect(result.coverage.runtimeBoundaryEvidenceAvailable).toBe(true);
      expect(result.coverage.runtimeBoundaryExactLinks).toBeGreaterThan(0);
      expect(result.coverage.runtimeBoundaryTraversedLinks).toBeGreaterThan(0);
      expect(result.behavior?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            location: expect.objectContaining({ file: 'apps/api/src/modules/sessions/routes.ts' }),
          }),
          expect.objectContaining({
            location: expect.objectContaining({ file: 'apps/api/src/modules/sessions/events.ts' }),
          }),
        ]),
      );
      const serviceBehavior = result.behavior?.steps.find(
        (step) => step.location?.file === 'apps/api/src/modules/sessions/events.ts',
      )?.behavior;
      expect(serviceBehavior?.coverage.omittedStatements).toBe(0);
      expect(serviceBehavior?.coverage.representedStatements).toBe(serviceBehavior?.coverage.sourceStatements);
      expect(result.coverage.regionBoundariesAreStructural).toBe(true);
      expect(result.closure).toMatchObject({
        status: 'accounted',
        emitted: { regions: result.regions.length, relations: expect.any(Number) },
        withheld: { symbols: expect.any(Number), files: expect.any(Number) },
        ambiguous: { anchors: 1, omittedSymbolCandidates: 0 },
        unresolved: expect.any(Number),
      });
      expect(result.closure.explanation).toContain('declared anchors, relations, depth');
    } finally {
      db.close();
    }
  });

  it('crosses an automatically extracted HTTP boundary from one symbol anchor', () => {
    const db = createSystemMapDb();
    try {
      const result = systemMap(db, { symbols: [symbols.dispatch], maxDepth: 1 });

      expect(result.regions.map((region) => region.label)).toEqual(
        expect.arrayContaining(['companion:root', 'api:modules/sessions']),
      );
      expect(result.regionRelations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kinds: expect.arrayContaining(['runtime-boundary']),
            evidence: expect.arrayContaining(['runtime-boundary:http.method-path']),
          }),
        ]),
      );
      expect(result.coverage.runtimeBoundaryTraversedLinks).toBe(1);
      expect(result.coverage.blindSpots).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Built-in runtime-boundary extractors traverse direct and replayably derived links'),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('retains an exact database state effect when its runtime peer is unresolved', () => {
    const seededDb = createSystemMapDb();
    const config = seededDb.config;
    const graph = readRuntimeBoundaryGraph(seededDb)!;
    const basis = graph.observations[0]!;
    seededDb.close();
    graph.observations.push({
      ...basis,
      id: 'fixture-database-write',
      extractor: 'persistence',
      action: 'database.write',
      owner: {
        file: 'apps/api/src/modules/sessions/events.ts',
        symbol: symbols.apiAppend,
        name: 'appendStreamEvents',
        startLine: 2,
        endLine: 4,
      },
      source: { file: 'apps/api/src/modules/sessions/events.ts', startLine: 3, endLine: 3 },
      keyParts: [{ name: 'resource', value: 'agent_work_session_events', evidence: 'literal' }],
      evidence: 'persistence-insert',
      strength: 'exact',
      protocol: 'database',
      role: 'producer',
      modality: 'must',
      resolution: 'unresolved',
      sourceScope: 'production',
    });
    graph.frontiers.push({
      observationId: 'fixture-database-write',
      reason: 'No exact database reader was linked.',
      missingKeyParts: [],
      sourceScope: 'production',
      kind: 'observation',
    });
    writeRuntimeBoundaryGraph(config.dbPath, graph);

    const db = new ScipDatabase(config);
    try {
      const result = systemMap(db, { symbols: [symbols.apiAppend], maxDepth: 1 });
      const stateSemantics =
        result.topology?.edges
          .flatMap((edge) => edge.semantics ?? [])
          .filter((semantic) => semantic.family === 'state') ?? [];

      expect(stateSemantics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subtype: 'writes-resource',
            context: expect.objectContaining({ crossesRuntimeBoundary: true, protocol: 'database' }),
            attributes: expect.objectContaining({
              operation: 'database.write',
              durabilityClass: 'external-durable-intent',
              resource: 'agent_work_session_events',
              recordIdentity: null,
              resolution: 'unresolved',
            }),
          }),
        ]),
      );
      expect(result.topology?.frontiers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'runtime-boundary',
            disposition: 'unsupported',
            reason: 'No exact database reader was linked.',
          }),
        ]),
      );
      const evidence = graphEvidence(
        db,
        { symbols: [symbols.apiAppend] },
        { families: ['state'], maxDepth: 1, maxEdges: 4 },
      );
      expect(evidence.edges).toEqual(
        expect.arrayContaining([expect.objectContaining({ family: 'state', subtype: 'writes-resource' })]),
      );
    } finally {
      db.close();
    }
  });

  it('materializes a source-backed runtime participant when the consumer has no compiler symbol', () => {
    const db = createSystemMapDb({ unindexedRuntimeParticipant: true });
    try {
      const result = systemMap(db, {
        symbols: [symbols.dispatch],
        maxDepth: 1,
        expand: ['region:packages/companion:root', 'region:apps/api:modules/sessions'],
      });
      const relation = result.regions
        .flatMap((region) => region.relations)
        .find((candidate) => candidate.toBoundaryParticipant?.observationId === 'fixture-unindexed-consumer');
      expect(relation?.toSymbol).toBeNull();
      expect(relation?.toBoundaryParticipant).toMatchObject({
        ownerName: 'work_session_stream_events',
        file: 'apps/api/src/modules/sessions/registry.ts',
        line: 1,
      });
      expect(result.topology?.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'source-construct',
            label: 'work_session_stream_events',
            disposition: 'emitted',
            location: expect.objectContaining({ file: 'apps/api/src/modules/sessions/registry.ts', line: 1 }),
          }),
        ]),
      );
      expect(result.behavior?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'source-construct',
            behavior: expect.objectContaining({
              lines: expect.arrayContaining([
                expect.objectContaining({ text: expect.stringContaining('work_session_stream_events') }),
              ]),
            }),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('catalogues a framework registration through its resolved source-callable owner', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-framework-owner-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/groups.ts': [
        'import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";',
        'export const api = HttpApi.make("api").add(',
        '  HttpApiGroup.make("session").add(HttpApiEndpoint.post("prompt", "/session/prompt")),',
        ');',
      ],
      'src/handlers.ts': [
        'import { HttpApiBuilder } from "effect/unstable/httpapi";',
        'const prompt = (input: unknown) => input;',
        'export const handlers = HttpApiBuilder.group(Api, "session", (handlers) =>',
        '  handlers.handle("prompt", prompt),',
        ');',
      ],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/groups.ts')
      .document(2, 'typescript', 'src/handlers.ts')
      .write();
    const config = { projectRoot, dbPath, indexPath: join(root, 'index.scip') };
    const initial = new ScipDatabase(config);
    const graph = collectRuntimeBoundaryGraph(initial);
    initial.close();
    writeRuntimeBoundaryGraph(dbPath, graph);
    const db = new ScipDatabase(config);
    try {
      const result = systemMap(db, {
        symbols: ['src/handlers.ts:2-2'],
        maxDepth: 1,
        relations: ['runtime-boundary'],
      });

      expect(result.coverage.runtimeBoundaryTraversedLinks).toBe(1);
      expect(result.topology?.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'runtime-boundary',
            evidence: expect.arrayContaining([
              expect.objectContaining({ method: 'runtime-boundary:framework.effect-httpapi-operation' }),
            ]),
          }),
        ]),
      );
      expect(result.topology?.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            disposition: 'emitted',
            location: expect.objectContaining({ file: 'src/groups.ts', line: 2 }),
          }),
        ]),
      );
      expect(result.topology?.routeCatalog?.routes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            endpointKind: 'runtime-boundary',
            endpointLocation: expect.objectContaining({ file: 'src/groups.ts', line: 2 }),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('preserves distinct runtime operations that share one declaration file and implementation', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-framework-operation-identity-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/groups.ts': [
        'import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";',
        'export const api = HttpApi.make("api").add(',
        '  HttpApiGroup.make("session")',
        '    .add(HttpApiEndpoint.post("prompt", "/session/prompt"))',
        '    .add(HttpApiEndpoint.post("prompt_async", "/session/prompt_async")),',
        ');',
      ],
      'src/handlers.ts': [
        'import { HttpApiBuilder } from "effect/unstable/httpapi";',
        'const processCompaction = () => true;',
        'const prompt = () => processCompaction();',
        'const promptAsync = () => processCompaction();',
        'export const handlers = HttpApiBuilder.group(Api, "session", (handlers) =>',
        '  handlers.handle("prompt", prompt).handle("prompt_async", promptAsync),',
        ');',
      ],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/groups.ts')
      .document(2, 'typescript', 'src/handlers.ts')
      .write();
    const config = { projectRoot, dbPath, indexPath: join(root, 'index.scip') };
    const initial = new ScipDatabase(config);
    const graph = collectRuntimeBoundaryGraph(initial);
    initial.close();
    writeRuntimeBoundaryGraph(dbPath, graph);
    const db = new ScipDatabase(config);
    try {
      const result = systemMap(db, {
        symbols: ['src/handlers.ts:2-2'],
        maxDepth: 3,
        relations: ['call', 'runtime-boundary'],
      });

      const selectedOperations = (result.topology?.nodes ?? [])
        .filter((node) => node.kind === 'runtime-boundary-participant')
        .map((node) => node.label);
      expect(selectedOperations).toEqual(
        expect.arrayContaining([
          expect.stringContaining('operation=prompt'),
          expect.stringContaining('operation=prompt_async'),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('does not traverse an unrelated runtime observation merely because its file was reached', () => {
    const seeded = createSystemMapDb();
    const config = seeded.config;
    const graph = readRuntimeBoundaryGraph(seeded)!;
    const templateLink = graph.links[0]!;
    const templateProducer = graph.observations.find((observation) => observation.id === templateLink.from)!;
    seeded.close();
    graph.observations.push(
      {
        ...templateProducer,
        id: 'fixture-reached-observation',
        owner: {
          file: 'packages/companion/src/command.ts',
          symbol: symbols.companionCommand,
          name: 'sessionStreamEvents',
          startLine: 2,
          endLine: 4,
        },
        source: { file: 'packages/companion/src/command.ts', startLine: 3, endLine: 3 },
      },
      {
        ...templateProducer,
        id: 'fixture-file-sibling-observation',
        owner: {
          file: 'packages/companion/src/command.ts',
          symbol: null,
          name: null,
          startLine: 0,
          endLine: 0,
        },
        source: { file: 'packages/companion/src/command.ts', startLine: 0, endLine: 0 },
      },
    );
    graph.links.push(
      { ...templateLink, id: 'fixture-reached-link', from: 'fixture-reached-observation' },
      { ...templateLink, id: 'fixture-file-sibling-link', from: 'fixture-file-sibling-observation' },
    );
    writeRuntimeBoundaryGraph(config.dbPath, graph);

    const db = new ScipDatabase(config);
    try {
      const result = systemMap(db, {
        symbols: [symbols.companionCommand],
        maxDepth: 1,
        relations: ['runtime-boundary'],
      });
      expect(result.coverage.runtimeBoundaryTraversedLinks).toBe(1);
      expect(
        result.topology?.edges.some((candidate) =>
          candidate.evidence.some((evidence) => evidence.identity === 'fixture-file-sibling-link'),
        ),
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it('anchors a registry literal to its anonymous handler instead of the containing module', () => {
    const db = createSystemMapDb({ unindexedRuntimeParticipant: true });
    try {
      const result = systemMap(db, {
        searches: ['work_session_stream_events'],
        maxDepth: 1,
        relations: ['call', 'runtime-boundary'],
      });
      const registryAnchor = result.topology?.nodes.find(
        (node) => node.anchorIds.length > 0 && node.location?.file === 'apps/api/src/modules/sessions/registry.ts',
      );
      expect(registryAnchor).toMatchObject({
        kind: 'source-construct',
        location: { line: 1, endLine: 4 },
      });
      expect(result.behavior?.steps.find((step) => step.nodeId === registryAnchor?.id)?.behavior?.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('appendStreamEvents(input.events)') }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('uses an unindexed source callable as a literal anchor and preserves its exact imported call as graph evidence', () => {
    const db = createSystemMapDb({ unindexedSourceAnchor: true });
    try {
      const result = systemMap(db, {
        searches: ['sourceOnlySessionStream'],
        maxDepth: 2,
        relations: ['call'],
      });
      expect(result.topology?.anchors[0]?.nodeIds).toHaveLength(1);
      expect(result.behavior?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'anchor',
            kind: 'source-construct',
            label: 'sourceOnlySessionStream',
            behavior: expect.objectContaining({
              lines: expect.arrayContaining([
                expect.objectContaining({ text: expect.stringContaining('deliverStreamEvents(events)') }),
              ]),
            }),
          }),
        ]),
      );
      const anchorNodeId = result.topology?.anchors[0]?.nodeIds[0];
      expect(result.topology?.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'call',
            fromNodeId: anchorNodeId,
            toNodeId: expect.stringContaining('appendStreamEvents'),
            evidence: expect.any(Array),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('attributes a reverse reference to its source callable when SCIP only identifies the module', () => {
    const db = createSystemMapDb({ moduleOwnedReference: true });
    try {
      const result = systemMap(db, {
        symbols: [symbols.companionAppend],
        maxDepth: 2,
        relations: ['call', 'reference'],
      });
      const caller = result.topology?.nodes.find(
        (node) =>
          node.kind === 'source-construct' &&
          node.location?.file === 'packages/companion/src/object-commands.ts' &&
          node.label === 'sessionStreamEvents',
      );

      expect(caller).toMatchObject({
        location: { line: 3, endLine: 5 },
      });
      expect(result.topology?.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromNodeId: caller?.id,
            toNodeId: expect.stringContaining('appendStreamEvents'),
            kind: 'call',
          }),
        ]),
      );
      const behavior = result.behavior?.steps.find((step) => step.nodeId === caller?.id)?.behavior;
      expect(behavior?.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('appendStreamEvents(events)') }),
        ]),
      );
      expect(behavior?.lines.some((line) => line.text.includes('unrelatedCommand'))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('recursively reverse-expands proven callers without propagating ordinary references', () => {
    const db = createSystemMapDb();
    try {
      const result = systemMap(db, {
        symbols: [symbols.companionAppend],
        maxDepth: 3,
        relations: ['call'],
      });

      expect(result.behavior?.steps.map((step) => step.label)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('appendStreamEvents'),
          expect.stringContaining('sessionStreamEvents'),
          expect.stringContaining('externalSessionPath'),
        ]),
      );
      expect(result.topology?.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromNodeId: expect.stringContaining('externalSessionPath'),
            toNodeId: expect.stringContaining('sessionStreamEvents'),
            kind: 'call',
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('catalogues a nested callback under its enclosing exported package doorway', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-public-owner-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(projectRoot, {
      'package.json': JSON.stringify({ exports: './src/public.ts' }),
      'src/public.ts': [
        'export const layer = make(() => {',
        '  const hidden = () => compact();',
        '  return { prompt: () => compact() };',
        '});',
        'function compact() { return true; }',
      ],
    });
    const layerSymbol = 'scip-typescript npm fixture 1.0.0 src/`public.ts`/layer.';
    const compactSymbol = 'scip-typescript npm fixture 1.0.0 src/`public.ts`/compact().';
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/public.ts')
      .symbol(1, layerSymbol, 'layer', 13)
      .symbol(2, compactSymbol, 'compact', 12)
      .definition(1, 1, 1, 0, 0, 3, 2)
      .definition(2, 1, 2, 4, 0, 4, 36)
      .chunk(1, 1, 0, 3)
      .mention(1, 1, 1)
      .mention(1, 2, 0)
      .chunk(2, 1, 4, 4, 1)
      .mention(2, 2, 1)
      .write();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = systemMap(db, {
        symbols: [compactSymbol],
        maxDepth: 1,
        relations: ['call'],
      });

      expect(result.topology?.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            location: expect.objectContaining({ file: 'src/public.ts' }),
            attributes: expect.objectContaining({
              publicEntry: true,
              publicEntryPriority: 2,
            }),
            disposition: 'folded',
          }),
        ]),
      );
      expect(result.topology?.nodes.find((node) => node.label === 'hidden')?.attributes['publicEntry']).not.toBe(true);
      expect(result.topology?.routeCatalog?.routes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            endpointKind: 'public-entry',
            endpointLocation: expect.objectContaining({ file: 'src/public.ts' }),
            anchorLabel: expect.stringContaining('compact'),
          }),
        ]),
      );
      const routeId = result.topology?.routeCatalog?.routes[0]?.id;
      expect(routeId).toBeDefined();
      const selected = systemMap(db, {
        symbols: [compactSymbol],
        maxDepth: 1,
        relations: ['call'],
        routeIds: [routeId!],
      });
      expect(selected.topology?.routeCatalog?.selectedRouteIds).toEqual([routeId]);
    } finally {
      db.close();
    }
  });

  it('populates the universal topology with typed compiler and runtime evidence', () => {
    const db = createSystemMapDb();
    try {
      const result = systemMap(db, {
        searches: ['work_session_stream_events'],
        symbols: ['appendStreamEvents'],
        maxDepth: 3,
      });

      expect(result.topology).toBeDefined();
      const topology = result.topology!;
      expect(topology.schemaVersion).toBe(1);
      expect(topology.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'call',
            evidence: expect.arrayContaining([
              expect.objectContaining({ method: 'ast-callsite', strength: 'derived' }),
            ]),
          }),
          expect.objectContaining({
            kind: 'runtime-boundary',
            evidence: expect.arrayContaining([
              expect.objectContaining({
                method: 'runtime-boundary:http.method-path',
                strength: 'exact',
                identity: expect.stringContaining('path=/api/agent-dispatch'),
              }),
            ]),
          }),
        ]),
      );
      expect(topology.coverage.status).toBe('accounted');
      expect(topology.nodes.every((node) => ['emitted', 'folded', 'unsupported'].includes(node.disposition))).toBe(
        true,
      );
      const structuralRegionNodeIds = new Set(
        topology.nodes.filter((node) => node.kind === 'structural-region').map((node) => node.id),
      );
      expect(
        topology.edges.some(
          (edge) => edge.fromNodeId === edge.toNodeId && structuralRegionNodeIds.has(edge.fromNodeId),
        ),
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it('returns connector-ordered behavior with evidence for every transition', () => {
    const db = createSystemMapDb();
    try {
      const result = systemMap(db, {
        symbols: [symbols.dispatch, symbols.apiRoute],
        maxDepth: 2,
      });

      expect(result.behavior).toBeDefined();
      expect(
        result.behavior?.status,
        JSON.stringify(
          {
            paths: result.topology?.paths,
            runtimeEdges: result.topology?.edges.filter((edge) => edge.kind === 'runtime-boundary'),
          },
          null,
          2,
        ),
      ).toBe('connected');
      expect(result.behavior).toMatchObject({
        coverage: { withheldStatements: expect.any(Number) },
        exactSourceCommand: expect.stringContaining('--view source'),
      });
      expect(result.behavior!.steps.some((step) => step.label.includes('dispatchCommand'))).toBe(true);
      expect(result.behavior!.steps.some((step) => step.label.includes('dispatchStreamEvents'))).toBe(true);
      expect(
        result
          .behavior!.steps.flatMap((step) => step.behavior?.lines ?? [])
          .some((line) => line.text.includes('appendStreamEvents(events)') && line.signals.includes('call')),
      ).toBe(true);
      expect(
        result.behavior!.steps.some(
          (step) =>
            step.location?.file === 'packages/companion/src/client.ts' && step.label.includes('appendStreamEvents'),
        ),
      ).toBe(true);
      const apiAnchor = result.behavior!.steps.find((step) => step.label.includes('dispatchStreamEvents'));
      expect(apiAnchor?.behavior?.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining('appendStreamEvents(events)'),
          }),
        ]),
      );
      expect(result.behavior!.transitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'runtime-boundary',
            directed: true,
            evidence: expect.arrayContaining([
              expect.objectContaining({ method: 'runtime-boundary:http.method-path', strength: 'exact' }),
            ]),
          }),
        ]),
      );
      expect(result.behavior!.paths).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'connected',
            stepIds: expect.arrayContaining([
              expect.stringContaining('dispatchCommand'),
              expect.stringContaining('dispatchStreamEvents'),
            ]),
          }),
        ]),
      );
      expect(result.nextAnchors).toBeDefined();
      expect(result.nextAnchors!.visibleCallsites).toBeGreaterThan(0);
      expect(result.nextAnchors!.anchors.length + result.nextAnchors!.withheldAnchors.length).toBe(
        result.nextAnchors!.candidateAnchors,
      );
      for (const command of [
        result.nextAnchors!.inspectCommand,
        ...result.nextAnchors!.remainingInspectCommands,
      ].filter((command): command is string => command !== null)) {
        expect(command).toContain('--at');
        expect(command).not.toContain('--symbol');
      }
    } finally {
      db.close();
    }
  });

  it('keeps a decisive branch predicate in the connected behavior representation', () => {
    const db = createSystemMapDb();
    try {
      const result = systemMap(db, {
        symbols: [symbols.webRealtime, symbols.render],
        maxDepth: 2,
      });
      const realtime = result.behavior?.steps.find((step) => step.label.includes('handleRealtime'));

      expect(realtime?.behavior?.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining('type === sessionRealtimeEventTypes.workSession'),
          }),
        ]),
      );
      expect(
        (realtime?.behavior?.coverage.representedStatements ?? 0) +
          (realtime?.behavior?.coverage.omittedStatements ?? 0),
      ).toBe(realtime?.behavior?.coverage.sourceStatements);
      expect(result.behavior?.exactSourceCommand).toContain('--view source');
    } finally {
      db.close();
    }
  });

  it('connects a predicate to both sibling outcomes and their distinct terminal behavior', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-control-dependence-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/control.ts': [
        'export function decide(ready: boolean) {',
        '  if (ready) {',
        '    return "accepted";',
        '  } else {',
        '    throw new Error("rejected");',
        '  }',
        '}',
      ],
      'src/selection.ts': [
        'export function select(kind: string) {',
        '  switch (kind) {',
        '    case "known": return true;',
        '    default: throw new Error("unknown");',
        '  }',
        '}',
      ],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/control.ts')
      .document(2, 'typescript', 'src/selection.ts')
      .write();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = systemMap(db, {
        symbols: ['src/control.ts:0-6', 'src/selection.ts:0-5'],
        maxDepth: 1,
        relations: ['call'],
      });
      const predicate = result.topology?.nodes.find(
        (node) => node.kind === 'control-predicate' && node.label.includes('ready'),
      );
      const governed =
        result.topology?.edges
          .filter((edge) => edge.fromNodeId === predicate?.id)
          .flatMap((edge) => edge.semantics ?? [])
          .filter((semantic) => semantic.family === 'control')
          .map((semantic) => semantic.subtype) ?? [];

      expect(predicate).toBeDefined();
      expect(governed).toEqual(
        expect.arrayContaining([
          'predicate-consequence',
          'predicate-alternative',
          'predicate-return',
          'predicate-throw',
        ]),
      );
      const allControlSubtypes =
        result.topology?.edges
          .flatMap((edge) => edge.semantics ?? [])
          .filter((semantic) => semantic.family === 'control')
          .map((semantic) => semantic.subtype) ?? [];
      expect(allControlSubtypes).toEqual(expect.arrayContaining(['predicate-case', 'predicate-default']));
      const corridorControlSubtypes =
        result.topology?.edges
          .filter((edge) => result.topology?.corridor?.edgeIds.includes(edge.id))
          .flatMap((edge) => edge.semantics ?? [])
          .filter((semantic) => semantic.family === 'control')
          .map((semantic) => semantic.subtype) ?? [];
      expect(result.topology?.corridor?.status).toBe('complete');
      expect(corridorControlSubtypes).toEqual(
        expect.arrayContaining([
          'predicate-consequence',
          'predicate-alternative',
          'predicate-return',
          'predicate-throw',
        ]),
      );
      const compilerDependence = graphEvidence(
        db,
        { symbols: ['src/control.ts:0-6'] },
        { families: ['execution'], subtypes: ['control-dependence'], maxDepth: 1, maxEdges: 100 },
      );
      expect(compilerDependence.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            family: 'execution',
            subtype: 'control-dependence',
            providerId: 'typescript-local-dependence',
            evidenceStrength: 'exact',
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('projects exact state mutations, assigned values, and await ordering from source constructs', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-state-temporal-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/state.ts': [
        'export async function update(state: State, id: string, payload: Payload) {',
        '  state.records[id] = payload;',
        '  await persist(state.records[id]);',
        '  state.version += 1;',
        '  notify(id);',
        '}',
      ],
    });
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/state.ts').write();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = systemMap(db, {
        symbols: ['src/state.ts:0-5'],
        maxDepth: 1,
        relations: ['call'],
      });
      const semantics = result.topology?.edges.flatMap((edge) => edge.semantics ?? []) ?? [];

      expect(semantics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            family: 'state',
            subtype: 'writes-resource',
            attributes: expect.objectContaining({
              operation: 'assign',
              durabilityClass: 'in-memory',
              resource: 'state.records[]',
              recordIdentity: 'id',
            }),
          }),
          expect.objectContaining({ family: 'data', subtype: 'value-to-state' }),
          expect.objectContaining({ family: 'temporal', subtype: 'lexical-successor' }),
          expect.objectContaining({ family: 'temporal', subtype: 'awaits-completion' }),
          expect.objectContaining({ family: 'temporal', subtype: 'await-completion-before' }),
        ]),
      );
      const corridorSemantics =
        result.topology?.edges
          .filter((edge) => result.topology?.corridor?.edgeIds.includes(edge.id))
          .flatMap((edge) => edge.semantics ?? []) ?? [];
      expect(result.topology?.corridor?.status).toBe('complete');
      expect(corridorSemantics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ family: 'state', subtype: 'writes-resource' }),
          expect.objectContaining({ family: 'data', subtype: 'value-to-state' }),
          expect.objectContaining({ family: 'temporal', subtype: 'await-completion-before' }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('distinguishes an exactly captured lexical value from a local assignment value', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-captured-state-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/captured.ts': [
        'export function makeWriter(prefix: string) {',
        '  return (state: State, id: string) => {',
        '    state.values[id] = prefix;',
        '  };',
        '}',
      ],
    });
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/captured.ts').write();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = systemMap(db, {
        symbols: ['src/captured.ts:0-4'],
        maxDepth: 1,
        relations: ['call'],
      });
      const semantics = result.topology?.edges.flatMap((edge) => edge.semantics ?? []) ?? [];

      expect(semantics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            family: 'data',
            subtype: 'captured-value-to-state',
            attributes: expect.objectContaining({ value: 'prefix', resource: 'state.values[]' }),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('projects syntax-proved lock membership without inferring a lock from a call name', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-lock-scope-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/StateStore.java': [
        'class StateStore {',
        '  void update() {',
        '    synchronized (guard) {',
        '      checkVersion();',
        '      state.value = 1;',
        '      persist();',
        '    }',
        '  }',
        '}',
      ],
    });
    evidenceFixtureDb(dbPath).document(1, 'java', 'src/StateStore.java').write();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = systemMap(db, {
        searches: ['synchronized'],
        maxDepth: 1,
        relations: ['call'],
      });
      const lockSemantics =
        result.topology?.edges
          .flatMap((edge) => edge.semantics ?? [])
          .filter((semantic) => semantic.family === 'temporal' && semantic.subtype === 'inside-lock-scope') ?? [];

      expect(lockSemantics.length).toBeGreaterThanOrEqual(3);
      expect(lockSemantics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ context: expect.objectContaining({ synchronizationScope: 'guard' }) }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('does not infer lock or transaction membership from call names', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-unproved-scopes-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/unproved.ts': [
        'export function update(state: State) {',
        '  lock(() => { state.value = 1; });',
        '  transaction(() => { state.value = 2; });',
        '}',
      ],
    });
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/unproved.ts').write();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = systemMap(db, {
        symbols: ['src/unproved.ts:0-3'],
        maxDepth: 1,
        relations: ['call'],
      });
      const semantics = result.topology?.edges.flatMap((edge) => edge.semantics ?? []) ?? [];

      expect(semantics).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ family: 'temporal', subtype: 'inside-lock-scope' })]),
      );
      expect(
        semantics.some(
          (semantic) => semantic.context?.transaction !== undefined || semantic.subtype.includes('transaction'),
        ),
      ).toBe(false);
      expect(semantics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            family: 'state',
            attributes: expect.objectContaining({ transactionMembership: 'unknown' }),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('compresses a multiline governing predicate as one complete connector line', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-multiline-connector-predicate-'));
    const projectRoot = join(root, 'project');
    const dbPath = join(root, 'index.db');
    const unrelatedCalls = Array.from({ length: 160 }, (_, index) => `  observeUnrelatedState${index}();`);
    writeFixtureFiles(projectRoot, {
      'src/flow.ts': [
        'export function entry() { return runLoop(); }',
        'export function runLoop() {',
        '  if (',
        '    completed &&',
        '    !summary &&',
        '    isOverflow(tokens)',
        '  ) {',
        '    compact();',
        '  }',
        ...unrelatedCalls,
        '}',
        'export function compact() { return true; }',
      ],
    });
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/flow.ts').write();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(root, 'index.scip') });
    const node = (id: string, line: number, endLine: number, anchorIds: string[]) => ({
      id,
      kind: 'symbol' as const,
      label: id,
      disposition: 'emitted' as const,
      location: { file: 'src/flow.ts', line, endLine },
      anchorIds,
      attributes: { leaf: id },
    });
    const edge = (fromNodeId: string, toNodeId: string, line: number) => ({
      id: `edge:${fromNodeId}:${toNodeId}`,
      kind: 'call' as const,
      fromNodeId,
      toNodeId,
      directed: true as const,
      disposition: 'emitted' as const,
      evidence: [
        {
          method: 'scip-occurrence-callsite',
          strength: 'exact' as const,
          location: { file: 'src/flow.ts', line },
        },
      ],
    });
    try {
      const topology = createExplorationTopology({
        anchors: [
          {
            id: 'anchor:entry',
            kind: 'symbol',
            query: 'entry',
            status: 'matched',
            nodeIds: ['entry'],
            candidateNodeIds: [],
            omittedCandidates: 0,
          },
          {
            id: 'anchor:compact',
            kind: 'symbol',
            query: 'compact',
            status: 'matched',
            nodeIds: ['compact'],
            candidateNodeIds: [],
            omittedCandidates: 0,
          },
        ],
        nodes: [
          node('entry', 0, 0, ['anchor:entry']),
          node('runLoop', 1, 9 + unrelatedCalls.length, []),
          node('compact', 10 + unrelatedCalls.length, 10 + unrelatedCalls.length, ['anchor:compact']),
        ],
        edges: [edge('entry', 'runLoop', 0), edge('runLoop', 'compact', 7)],
        paths: [
          {
            id: 'path:entry:compact',
            fromAnchorId: 'anchor:entry',
            toAnchorId: 'anchor:compact',
            status: 'connected',
            nodeIds: ['entry', 'runLoop', 'compact'],
            edgeIds: ['edge:entry:runLoop', 'edge:runLoop:compact'],
          },
        ],
        scope: 'multiline predicate fixture',
      });
      const packet = connectedBehaviorPacket(db, topology, {
        focusLocations: [{ file: 'src/flow.ts', line: 7 }],
      });
      const runLoop = packet.steps.find((step) => step.label === 'runLoop');
      const predicate = runLoop?.behavior?.lines.find((line) => line.signals.includes('branch'));

      expect(runLoop?.role).toBe('connector');
      expect(runLoop?.behavior?.kind).toBe('connector-slice');
      expect(predicate?.text).toContain('completed && !summary && isOverflow(tokens)');
      expect(predicate?.text).not.toBe('if (');
    } finally {
      db.close();
    }
  });

  it('keeps every answer-determinative sibling branch while compacting a source-large explicit anchor', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-complete-explicit-anchor-'));
    const padding = Array.from(
      { length: 80 },
      (_, index) => `  // padding-${String(index).padStart(4, '0')}-abcdefghijklmnopqrstuvwxyz0123456789`,
    );
    const source = [
      'export function execute(input: string, results: unknown[], block: { id: string }, r: { content: string; isError: boolean }) {',
      '  const command = input.trim();',
      '  if (!command) {',
      "    return { action: 'block', reason: 'empty command' };",
      '  }',
      ...padding,
      '  results.push({',
      "    type: 'tool_result',",
      '    tool_use_id: block.id,',
      '    content: r.content,',
      '    isError: r.isError,',
      '  });',
      "  if (command.endsWith('&')) {",
      '    return {',
      "      action: 'background',",
      '      command,',
      '      content: `started background process\\nlog: ${command}\\nuse process_output and kill_process`,',
      '    };',
      '  }',
      "  return { action: 'foreground', command };",
      '}',
    ];
    writeFixtureFiles(root, { 'src/bash.ts': source });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/bash.ts').write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const topology = createExplorationTopology({
        anchors: [
          {
            id: 'anchor:execute',
            kind: 'symbol',
            query: 'execute',
            status: 'matched',
            nodeIds: ['execute'],
            candidateNodeIds: [],
            omittedCandidates: 0,
          },
        ],
        nodes: [
          {
            id: 'execute',
            kind: 'symbol',
            label: 'execute',
            disposition: 'emitted',
            location: { file: 'src/bash.ts', line: 0, endLine: source.length - 1 },
            anchorIds: ['anchor:execute'],
            attributes: { leaf: 'execute' },
          },
        ],
        edges: [],
        paths: [],
        scope: 'complete explicit anchor fixture',
      });
      const packet = connectedBehaviorPacket(db, topology, {
        focusLocations: [{ file: 'src/bash.ts', line: source.length - 4 }],
      });
      const behavior = packet.steps.find((step) => step.label === 'execute')?.behavior;
      const rendered = behavior?.lines.map((line) => line.text).join('\n') ?? '';

      expect(behavior?.kind).not.toBe('source');
      expect(behavior?.renderedCharacters).toBeLessThan(behavior?.rawCharacters ?? 0);
      expect(rendered).toContain('const command = input.trim()');
      expect(rendered).toContain('if !command');
      expect(rendered).toContain("return { action: 'block', reason: 'empty command' }");
      expect(rendered).toContain(
        "results.push({ type: 'tool_result', tool_use_id: block.id, content: r.content, isError: r.isError, });",
      );
      const structuredCall = behavior?.lines.find((line) => line.text.startsWith('results.push'));
      expect(structuredCall?.signals).toEqual(expect.arrayContaining(['call', 'shape']));
      expect(structuredCall?.signals).not.toContain('mutation');
      expect(rendered).toContain("action: 'background'");
      expect(rendered).toContain('log: ${command}');
      expect(rendered).toContain('use process_output and kill_process');
      expect(rendered).toContain("return { action: 'foreground', command }");
      expect(rendered).not.toContain('padding-0001');
    } finally {
      db.close();
    }
  });

  it('falls back to complete source when an explicit anchor cannot be compressed losslessly', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-complete-explicit-source-'));
    const body = [`  performMaterialEffect('${'material-unknown-'.repeat(260)}');`];
    const source = [
      'export function execute(input: string) {',
      '  const command = input.trim();',
      '  if (!command) return false;',
      ...body,
      '  return command.length > 0;',
      '}',
    ];
    writeFixtureFiles(root, { 'src/bash.ts': source });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/bash.ts').write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const topology = createExplorationTopology({
        anchors: [
          {
            id: 'anchor:execute',
            kind: 'symbol',
            query: 'execute',
            status: 'matched',
            nodeIds: ['execute'],
            candidateNodeIds: [],
            omittedCandidates: 0,
          },
        ],
        nodes: [
          {
            id: 'execute',
            kind: 'symbol',
            label: 'execute',
            disposition: 'emitted',
            location: { file: 'src/bash.ts', line: 0, endLine: source.length - 1 },
            anchorIds: ['anchor:execute'],
            attributes: { leaf: 'execute' },
          },
        ],
        edges: [],
        paths: [],
        scope: 'complete explicit source fixture',
      });
      const packet = connectedBehaviorPacket(db, topology, {
        focusLocations: [{ file: 'src/bash.ts', line: source.length - 2 }],
      });
      const behavior = packet.steps.find((step) => step.label === 'execute')?.behavior;

      expect(behavior?.kind).toBe('source');
      expect(behavior?.coverage.omittedStatements).toBe(0);
      expect(behavior?.lines.map((line) => line.text)).toEqual(source);
    } finally {
      db.close();
    }
  });

  it('materializes every exact callee selected by explicit question focus', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-focused-callees-'));
    const source = [
      'export function execute() {',
      '  classify();',
      '  approve();',
      '  startBackground();',
      '  return finish();',
      '}',
      'function classify() { return true; }',
      'function approve() { return true; }',
      'function startBackground() { return true; }',
      'function finish() { return true; }',
    ];
    writeFixtureFiles(root, { 'src/flow.ts': source });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/flow.ts').write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    const node = (id: string, line: number, anchorIds: string[] = []) => ({
      id,
      kind: 'symbol' as const,
      label: id,
      disposition: anchorIds.length > 0 ? ('emitted' as const) : ('folded' as const),
      location: { file: 'src/flow.ts', line, endLine: line },
      anchorIds,
      attributes: { leaf: id },
    });
    const edge = (toNodeId: string, line: number) => ({
      id: `edge:execute:${toNodeId}`,
      kind: 'call' as const,
      fromNodeId: 'execute',
      toNodeId,
      directed: true as const,
      disposition: toNodeId === 'finish' ? ('emitted' as const) : ('folded' as const),
      evidence: [
        {
          method: 'scip-occurrence-callsite',
          strength: toNodeId === 'finish' ? ('exact' as const) : ('derived' as const),
          location: { file: 'src/flow.ts', line },
        },
      ],
    });
    try {
      const topology = createExplorationTopology({
        anchors: [
          {
            id: 'anchor:execute',
            kind: 'symbol',
            query: 'execute classification approval background',
            status: 'matched',
            nodeIds: ['execute'],
            candidateNodeIds: [],
            omittedCandidates: 0,
          },
          {
            id: 'anchor:finish',
            kind: 'symbol',
            query: 'finish result',
            status: 'matched',
            nodeIds: ['finish'],
            candidateNodeIds: [],
            omittedCandidates: 0,
          },
        ],
        nodes: [
          { ...node('execute', 0, ['anchor:execute']), location: { file: 'src/flow.ts', line: 0, endLine: 5 } },
          node('classify', 6),
          node('approve', 7),
          node('startBackground', 8),
          node('finish', 9, ['anchor:finish']),
        ],
        edges: [edge('classify', 1), edge('approve', 2), edge('startBackground', 3), edge('finish', 4)],
        paths: [
          {
            id: 'path:execute:finish',
            fromAnchorId: 'anchor:execute',
            toAnchorId: 'anchor:finish',
            status: 'connected',
            nodeIds: ['execute', 'finish'],
            edgeIds: ['edge:execute:finish'],
          },
        ],
        scope: 'focused direct callee fixture',
      });
      const packet = connectedBehaviorPacket(db, topology, {
        focusLocations: [1, 2, 3].map((line) => ({ file: 'src/flow.ts', line })),
      });

      expect(packet.steps.map((step) => step.label)).toEqual(
        expect.arrayContaining(['execute', 'classify', 'approve', 'startBackground', 'finish']),
      );
    } finally {
      db.close();
    }
  });

  it('includes a bounded recursive caller spine above a selected construct', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-caller-spine-'));
    const source = [
      'export function externalEntry() { return sessionOwner(); }',
      'export function sessionOwner() { return runAttempt(); }',
      'export function runAttempt() { return compact(); }',
      'export function compact() { return true; }',
    ];
    writeFixtureFiles(root, { 'src/flow.ts': source });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/flow.ts').write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    const node = (id: string, line: number) => ({
      id,
      kind: 'symbol' as const,
      label: id,
      disposition: 'emitted' as const,
      location: { file: 'src/flow.ts', line, endLine: line },
      anchorIds: id === 'compact' ? ['anchor:compact'] : [],
      attributes: { leaf: id },
    });
    const edge = (fromNodeId: string, toNodeId: string, line: number) => ({
      id: `edge:${fromNodeId}:${toNodeId}`,
      kind: 'call' as const,
      fromNodeId,
      toNodeId,
      directed: true as const,
      disposition: 'emitted' as const,
      evidence: [
        {
          method: 'ast-callsite',
          strength: 'derived' as const,
          location: { file: 'src/flow.ts', line },
        },
      ],
    });
    try {
      const topology = createExplorationTopology({
        anchors: [
          {
            id: 'anchor:compact',
            kind: 'symbol',
            query: 'compact',
            status: 'matched',
            nodeIds: ['compact'],
            candidateNodeIds: [],
            omittedCandidates: 0,
          },
        ],
        nodes: [node('externalEntry', 0), node('sessionOwner', 1), node('runAttempt', 2), node('compact', 3)],
        edges: [
          edge('externalEntry', 'sessionOwner', 0),
          edge('sessionOwner', 'runAttempt', 1),
          edge('runAttempt', 'compact', 2),
        ],
        scope: 'recursive caller fixture',
      });
      const packet = connectedBehaviorPacket(db, topology);

      expect(packet.steps.map((step) => step.label)).toEqual([
        'compact',
        'runAttempt',
        'sessionOwner',
        'externalEntry',
      ]);
    } finally {
      db.close();
    }
  });

  it('does not materialize owner source merely because the causal corridor protects an internal fact', () => {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-corridor-source-budget-'));
    writeFixtureFiles(root, {
      'src/flow.ts': [
        'export function selectedEntry() { return true; }',
        'export function unrelatedOwner(payload: string) { return payload.length; }',
      ],
    });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/flow.ts').write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const topology = createExplorationTopology({
        anchors: [
          {
            id: 'anchor:selected',
            kind: 'symbol',
            query: 'selectedEntry',
            status: 'matched',
            nodeIds: ['selected'],
            candidateNodeIds: [],
            omittedCandidates: 0,
          },
        ],
        nodes: [
          {
            id: 'selected',
            kind: 'symbol',
            label: 'selectedEntry',
            disposition: 'emitted',
            location: { file: 'src/flow.ts', line: 0, endLine: 0 },
            anchorIds: ['anchor:selected'],
            attributes: { leaf: 'selectedEntry' },
          },
          {
            id: 'unrelated',
            kind: 'symbol',
            label: 'unrelatedOwner',
            disposition: 'emitted',
            location: { file: 'src/flow.ts', line: 1, endLine: 1 },
            anchorIds: [],
            attributes: { leaf: 'unrelatedOwner' },
          },
          {
            id: 'parameter:payload',
            kind: 'parameter',
            label: 'payload',
            disposition: 'emitted',
            location: { file: 'src/flow.ts', line: 1, endLine: 1 },
            anchorIds: [],
            attributes: { ownerNodeId: 'unrelated', ownerSymbol: 'unrelatedOwner' },
          },
        ],
        edges: [],
        scope: 'corridor source budget fixture',
      });
      topology.corridor = {
        schemaVersion: 1,
        status: 'complete',
        startNodeIds: ['selected'],
        outcomeNodeIds: ['selected'],
        baseNodeIds: ['selected'],
        baseEdgeIds: [],
        nodeIds: ['selected', 'parameter:payload'],
        edgeIds: [],
        accountedFrontierIds: [],
        unresolvedFrontierIds: [],
        unresolvedEdgeIds: [],
        coverage: {
          protectedNodes: 2,
          protectedEdges: 0,
          baseNodes: 1,
          baseEdges: 0,
          accountedFrontiers: 0,
          unresolvedFrontiers: 0,
          unresolvedEdges: 0,
        },
        explanation: 'fixture',
      };

      const packet = connectedBehaviorPacket(db, topology);

      expect(packet.steps.map((step) => step.label)).toEqual(['selectedEntry']);
    } finally {
      db.close();
    }
  });

  it('traverses only the requested relation families', () => {
    const db = createSystemMapDb();
    try {
      const result = systemMap(db, {
        symbols: [symbols.dispatch],
        maxDepth: 1,
        relations: ['runtime-boundary'],
      });

      expect(result.coverage.requestedRelationKinds).toEqual(['runtime-boundary']);
      expect(result.regionRelations.length).toBeGreaterThan(0);
      expect(result.regionRelations.flatMap((relation) => relation.kinds)).toEqual(['runtime-boundary']);
      expect(result.regions.map((region) => region.label)).toEqual(
        expect.arrayContaining(['companion:root', 'api:modules/sessions']),
      );
    } finally {
      db.close();
    }
  });

  it('traverses exact named-capability references to their unique handlers', () => {
    const db = createSystemMapDb({ capabilityRegistry: true });
    try {
      const result = systemMap(db, {
        symbols: [symbols.capabilityInstruction, symbols.capabilityHandler],
        maxDepth: 1,
        relations: ['runtime-boundary'],
      });

      expect(result.coverage.runtimeBoundaryExactLinks).toBeGreaterThan(0);
      expect(result.coverage.runtimeBoundaryTraversedLinks).toBeGreaterThan(0);
      expect(
        result.behavior?.transitions,
        JSON.stringify(
          {
            runtimeEdges: result.topology?.edges.filter((edge) => edge.kind === 'runtime-boundary'),
            paths: result.topology?.paths,
            behavior: result.behavior,
          },
          null,
          2,
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'runtime-boundary',
            evidence: expect.arrayContaining([
              expect.objectContaining({ method: 'runtime-boundary:registry.capability-key' }),
            ]),
          }),
        ]),
      );
      expect(result.behavior?.steps.map((step) => step.location?.file)).toEqual(
        expect.arrayContaining(['packages/companion/src/background.ts', 'packages/companion/src/kill-process.ts']),
      );
    } finally {
      db.close();
    }
  });

  it('uses the evidence floor to exclude derived runtime crossings', () => {
    const seededDb = createSystemMapDb();
    const config = seededDb.config;
    const graph = readRuntimeBoundaryGraph(seededDb)!;
    seededDb.close();
    writeRuntimeBoundaryGraph(config.dbPath, {
      ...graph,
      links: graph.links.map((link) => ({ ...link, strength: 'derived' })),
    });

    const db = new ScipDatabase(config);
    try {
      const derived = systemMap(db, {
        symbols: [symbols.dispatch],
        maxDepth: 1,
        relations: ['runtime-boundary'],
        evidenceFloor: 'derived',
      });
      const exact = systemMap(db, {
        symbols: [symbols.dispatch],
        maxDepth: 1,
        relations: ['runtime-boundary'],
        evidenceFloor: 'exact',
      });

      expect(derived.coverage.runtimeBoundaryTraversedLinks).toBeGreaterThan(0);
      expect(exact.coverage.runtimeBoundaryTraversedLinks).toBe(0);
      expect(derived.regions.map((region) => region.label)).toContain('api:modules/sessions');
      expect(exact.regions.map((region) => region.label)).not.toContain('api:modules/sessions');
    } finally {
      db.close();
    }
  });

  it('makes source-scope inclusion explicit without losing excluded literal matches', () => {
    const db = createSystemMapDb();
    try {
      const production = systemMap(db, { searches: ['issue.created'], maxDepth: 0 });
      const withTests = systemMap(db, {
        searches: ['issue.created'],
        maxDepth: 0,
        sourceScopes: ['production', 'test'],
      });

      expect(production.anchors[0]).toMatchObject({ matchingLines: 4, seedMatchingLines: 2, matchOnlyLines: 2 });
      expect(withTests.anchors[0]).toMatchObject({ matchingLines: 4, seedMatchingLines: 3, matchOnlyLines: 1 });
      expect(withTests.coverage.includedSourceScopes).toEqual(['production', 'test']);
      expect(withTests.expansion?.command).toContain("--source-scope 'test'");
    } finally {
      db.close();
    }
  });

  it('keeps collapsed regions compact and expands several selected regions together', () => {
    const db = createSystemMapDb();
    try {
      const collapsed = systemMap(db, {
        searches: ['work_session_stream_events'],
        symbols: ['appendStreamEvents'],
        maxDepth: 3,
      });
      expect(collapsed.presentation.maxCharacters).toBe(9_000);
      expect(collapsed.regions.every((region) => region.files.length === 0 && region.symbols.length === 0)).toBe(true);
      expect(collapsed.regions.every((region) => region.notableSymbols.length > 0 || region.symbolCount === 0)).toBe(
        true,
      );
      expect(collapsed.expansion).toMatchObject({
        command: expect.stringContaining("--search 'work_session_stream_events'"),
        candidateRegionCount: expect.any(Number),
        regionCount: expect.any(Number),
      });
      expect(collapsed.expansion!.candidateRegionCount).toBeLessThan(collapsed.regions.length);
      expect(collapsed.expansion!.regionCount).toBe(collapsed.expansion!.candidateRegionCount);
      for (const anchor of collapsed.anchors) {
        for (const regionId of anchor.seedRegionIds ?? anchor.matchedRegionIds) {
          expect(collapsed.expansion?.regionIds).toContain(regionId);
        }
      }
      expect(collapsed.expansion?.omittedRegionIds).toEqual([]);
      expect(collapsed.topology?.frontiers.some((frontier) => frontier.disposition === 'folded')).toBe(true);
      expect(
        collapsed.topology?.nodes.every((node) =>
          ['emitted', 'folded', 'excluded', 'unsupported'].includes(node.disposition),
        ),
      ).toBe(true);
      expect(collapsed.drilldown).toMatchObject({
        command: null,
        definitionCommand: null,
        candidateAnchors: 0,
        omittedAnchors: 0,
      });

      const apiRegion = collapsed.regions.find((region) => region.label === 'api:modules/sessions')!.id;
      const webRegion = collapsed.regions.find((region) => region.label === 'web:components/sessions')!.id;
      const expanded = systemMap(db, {
        searches: ['work_session_stream_events'],
        symbols: ['appendStreamEvents'],
        maxDepth: 3,
        expand: [apiRegion, webRegion],
      });

      expect(expanded.unmatchedExpansions).toEqual([]);
      const details = expanded.regions.filter((region) => region.expanded);
      expect(details.map((region) => region.id)).toEqual(expect.arrayContaining([apiRegion, webRegion]));
      expect(details.every((region) => region.files.length > 0 && region.relations.length > 0)).toBe(true);
      expect(expanded.regions.filter((region) => !region.expanded).every((region) => region.files.length === 0)).toBe(
        true,
      );
      expect(expanded.drilldown).toMatchObject({
        command: expect.stringContaining('--view behavior'),
        candidateAnchors: expect.any(Number),
        selectedAnchors: expect.any(Number),
        omittedAnchors: 0,
        anchors: expect.arrayContaining([
          expect.objectContaining({ regionId: apiRegion, file: 'apps/api/src/modules/sessions/events.ts' }),
          expect.objectContaining({ regionId: webRegion, file: 'apps/web/src/components/sessions/realtime.ts' }),
        ]),
      });
      expect(expanded.drilldown.command).toContain("--at 'apps/api/src/modules/sessions/events.ts:5'");
      expect(expanded.drilldown.command).toContain("--at 'apps/web/src/components/sessions/realtime.ts:4'");
      expect(expanded.drilldown.definitionCommand).toBeNull();

      const foldedFrontierIds = collapsed
        .topology!.frontiers.filter((frontier) => frontier.disposition === 'folded')
        .map((frontier) => frontier.id);
      const reconstructed = systemMap(db, {
        searches: ['work_session_stream_events'],
        symbols: ['appendStreamEvents'],
        maxDepth: 3,
        topologyFrontiers: foldedFrontierIds,
      });
      expect(reconstructed.topology?.nodes.filter((node) => node.disposition === 'folded')).toEqual([]);
      expect(reconstructed.topology?.edges.filter((edge) => edge.disposition === 'folded')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('reports missing anchors and an untraversed frontier instead of implying completeness', () => {
    const db = createSystemMapDb();
    try {
      const result = systemMap(db, {
        symbols: ['doesNotExist'],
        searches: ['work_session_stream_events'],
        maxDepth: 0,
      });

      expect(result.anchors).toContainEqual(
        expect.objectContaining({ kind: 'symbol', query: 'doesNotExist', status: 'missing' }),
      );
      expect(result.coverage.frontierFiles + result.coverage.frontierSymbols).toBeGreaterThan(0);
      expect(result.coverage.blindSpots).toEqual(expect.arrayContaining([expect.stringContaining('Traversal stops')]));
    } finally {
      db.close();
    }
  });

  it('never emits more drill anchors than one inspect command accepts', () => {
    const db = createSystemMapDb();
    try {
      const collapsed = systemMap(db, {
        searches: ['bulk_drill_anchor'],
        maxDepth: 0,
        fullLiteralTraversal: true,
      });
      expect(collapsed.expansion).toMatchObject({
        candidateRegionCount: 30,
        regionCount: 12,
      });
      expect(collapsed.expansion?.omittedRegionIds).toHaveLength(18);
      const expanded = systemMap(db, {
        searches: ['bulk_drill_anchor'],
        maxDepth: 0,
        fullLiteralTraversal: true,
        expand: collapsed.regions.map((region) => region.id),
      });

      expect(expanded.drilldown).toMatchObject({
        candidateAnchors: 30,
        selectedAnchors: 12,
        omittedAnchors: 18,
      });
      expect(expanded.drilldown?.command?.match(/--at /gu)).toHaveLength(12);
      expect(expanded.drilldown?.definitionCommand).toBeNull();
    } finally {
      db.close();
    }
  });

  it('bounds the first topology view while retaining a recoverable withheld manifest', () => {
    const db = createSystemMapDb();
    try {
      const result = systemMap(db, {
        searches: ['bulk_drill_anchor'],
        maxDepth: 0,
        fullLiteralTraversal: true,
        maxTopologyCharacters: 500,
      });

      expect(result.regions).toHaveLength(30);
      expect(result.presentation).toMatchObject({
        maxCharacters: 500,
        complete: false,
        omittedRelations: 0,
        expansionCommand: expect.stringContaining('--topology-characters'),
      });
      expect(result.presentation.regionIds.length).toBeGreaterThan(0);
      expect(result.presentation.regionIds.length).toBeLessThan(result.regions.length);
      expect(result.presentation.omittedRegionIds).toHaveLength(
        result.regions.length - result.presentation.regionIds.length,
      );
      expect(result.presentation.totalEstimatedCharacters).toBeGreaterThan(result.presentation.estimatedCharacters);
    } finally {
      db.close();
    }
  });

  it('gives each expanded region a drill anchor before spending a second selector in one region', () => {
    const db = createSystemMapDb();
    try {
      const collapsed = systemMap(db, {
        searches: ['diverse_drill_anchor'],
        maxDepth: 0,
        fullLiteralTraversal: true,
      });
      const expanded = systemMap(db, {
        searches: ['diverse_drill_anchor'],
        maxDepth: 0,
        fullLiteralTraversal: true,
        expand: collapsed.regions.map((region) => region.id),
      });

      expect(expanded.drilldown).toMatchObject({
        candidateAnchors: 31,
        selectedAnchors: 12,
        omittedAnchors: 19,
      });
      expect(new Set(expanded.drilldown?.anchors.map((anchor) => anchor.regionId))).toEqual(
        new Set(collapsed.regions.map((region) => region.id)),
      );
      expect(expanded.drilldown?.command).toContain("--at 'apps/web/src/components/diverse-tail.ts:1'");
    } finally {
      db.close();
    }
  });

  it('keeps an explicit symbol anchor in a saturated behavior drill-down', () => {
    const db = createSystemMapDb();
    try {
      const collapsed = systemMap(db, {
        searches: ['bulk_drill_anchor'],
        symbols: [symbols.render],
        maxDepth: 0,
        fullLiteralTraversal: true,
      });
      const expanded = systemMap(db, {
        searches: ['bulk_drill_anchor'],
        symbols: [symbols.render],
        maxDepth: 0,
        fullLiteralTraversal: true,
        expand: collapsed.regions.map((region) => region.id),
      });

      expect(expanded.drilldown?.selectedAnchors).toBe(12);
      expect(expanded.drilldown?.anchors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: 'apps/web/src/components/sessions/view.ts',
            label: expect.stringContaining('renderEvent'),
          }),
        ]),
      );
      expect(expanded.drilldown?.command).toContain("--at 'apps/web/src/components/sessions/view.ts:1'");
    } finally {
      db.close();
    }
  });

  it('crosses to a directly imported object-member controller when the member has no indexed symbol', () => {
    const db = createSystemMapDb();
    try {
      const collapsed = systemMap(db, { symbols: [symbols.memberRegistry], maxDepth: 2 });
      const result = systemMap(db, {
        symbols: [symbols.memberRegistry],
        maxDepth: 2,
        expand: collapsed.regions.map((region) => region.id),
      });

      expect(result.regions.flatMap((region) => region.files)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: 'apps/api/src/controllers/member-controller.ts',
            origins: [
              'import:apps/api/src/modules/member-flow/registry.ts',
              'member-call:apps/api/src/modules/member-flow/registry.ts',
            ],
          }),
        ]),
      );
      expect(result.regionRelations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kinds: expect.arrayContaining(['call']),
            evidence: expect.arrayContaining(['ast-member-import-candidate']),
          }),
        ]),
      );
      expect(result.coverage.memberCallCandidateEdges).toBe(1);
      expect(result.coverage.unresolvedMemberCallsites).toBeGreaterThanOrEqual(0);
      expect(
        result.regions.some(
          (region) => region.memberCallCandidateRelationCount > 0 && region.relationKinds.includes('call'),
        ),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it('requires an explicit anchor', () => {
    const db = createSystemMapDb();
    try {
      expect(() => systemMap(db, {})).toThrow(/requires at least one --search or --symbol anchor/u);
    } finally {
      db.close();
    }
  });

  it('withholds a broad literal before graph traversal while preserving exact recovery', () => {
    const db = createSystemMapDb({ broadLiteral: 'common-runtime-term' });
    try {
      const result = systemMap(db, {
        searches: ['common-runtime-term'],
        symbols: ['appendStreamEvents'],
        maxDepth: 0,
      });
      const anchor = result.anchors.find((candidate) => candidate.kind === 'literal');

      expect(anchor).toMatchObject({
        status: 'matched',
        matchingLines: 12,
        eligibleSeedMatchingLines: 12,
        seedMatchingLines: 0,
        materializedMatchingLines: 0,
        withheldMatchingLines: 12,
        literalTraversal: 'withheld-broad',
      });
      expect(anchor?.representativeMatches).toHaveLength(8);
      expect(anchor?.narrowingCommands?.length).toBeGreaterThan(0);
      expect(anchor?.exhaustiveTraversalCommand).toBe(
        "scip-query system-map --search 'common-runtime-term' --full-literal-traversal",
      );
      expect(anchor?.narrowingCommands?.every((command) => command.includes("--scope 'apps/api/src/modules"))).toBe(
        true,
      );
      expect(result.regions.flatMap((region) => region.literalHits)).toEqual([]);
      expect(result.anchors.find((candidate) => candidate.kind === 'symbol')?.symbolCandidates).toHaveLength(2);
      expect(result.coverage).toMatchObject({ broadLiteralAnchors: 1, withheldLiteralMatches: 12 });
      expect(result.closure.withheld.literalMatches).toBe(12);

      const exhaustive = systemMap(db, {
        searches: ['common-runtime-term'],
        maxDepth: 0,
        fullLiteralTraversal: true,
      });
      expect(exhaustive.anchors[0]).toMatchObject({
        literalTraversal: 'materialized',
        seedMatchingLines: 12,
        withheldMatchingLines: 0,
      });
      expect(exhaustive.expansion?.command).toContain('--full-literal-traversal');
    } finally {
      db.close();
    }
  });

  it('limits active literal graph seeds while retaining every exact match and exhaustive recovery', () => {
    const db = createSystemMapDb({ boundedLiteral: 'bounded-runtime-term' });
    try {
      const result = systemMap(db, { searches: ['bounded-runtime-term'], maxDepth: 0 });
      const anchor = result.anchors[0];

      expect(anchor).toMatchObject({
        matchingLines: 6,
        eligibleSeedMatchingLines: 6,
        seedMatchingLines: 3,
        matchOnlyLines: 3,
        materializedMatchingLines: 6,
        withheldMatchingLines: 0,
        exhaustiveTraversalCommand: "scip-query system-map --search 'bounded-runtime-term' --full-literal-traversal",
      });
      expect(result.regions.reduce((total, region) => total + region.literalHitCount, 0)).toBe(6);

      const exhaustive = systemMap(db, {
        searches: ['bounded-runtime-term'],
        maxDepth: 0,
        fullLiteralTraversal: true,
      });
      expect(exhaustive.anchors[0]).toMatchObject({ seedMatchingLines: 6, matchOnlyLines: 0 });
    } finally {
      db.close();
    }
  });

  function createSystemMapDb(
    options: {
      broadLiteral?: string;
      boundedLiteral?: string;
      capabilityRegistry?: boolean;
      moduleOwnedReference?: boolean;
      unindexedRuntimeParticipant?: boolean;
      unindexedSourceAnchor?: boolean;
    } = {},
  ): ScipDatabase {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-'));
    const source = fixtureSource();
    if (options.broadLiteral) {
      for (const [file, lines] of Object.entries(source)) {
        if (!file.includes('/empty-')) continue;
        source[file] = [`${lines[0]} // ${options.broadLiteral}`];
      }
    }
    if (options.boundedLiteral) {
      let remaining = 6;
      for (const [file, lines] of Object.entries(source)) {
        if (!file.includes('/empty-') || remaining === 0) continue;
        source[file] = [`${lines[0]} // '${options.boundedLiteral}'`];
        remaining -= 1;
      }
    }
    if (options.capabilityRegistry) {
      source['packages/companion/src/background.ts'] = [
        'export function backgroundInstructions(id: string) {',
        '  return `Use kill_process({ id: "${id}" }) to stop.`;',
        '}',
      ];
      source['packages/companion/src/kill-process.ts'] = [
        'export const killProcessTool = {',
        '  def: { name: "kill_process" },',
        '  async execute(input: { id: string }) {',
        '    return input.id;',
        '  },',
        '};',
      ];
    }
    if (options.moduleOwnedReference) {
      source['packages/companion/src/object-commands.ts'] = [
        "import { appendStreamEvents } from './client.js';",
        '',
        'export const commands = {',
        '  sessionStreamEvents(events: unknown[]) {',
        '    return appendStreamEvents(events);',
        '  },',
        "  unrelatedCommand() { return 'unrelated'; },",
        '};',
      ];
    }
    if (options.unindexedRuntimeParticipant) {
      source['apps/api/src/modules/sessions/registry.ts'] = [
        "import { appendStreamEvents } from './events.js';",
        'export const dispatchHandlers = {',
        '  work_session_stream_events: (_request: unknown, input: { events: unknown[] }) =>',
        '    appendStreamEvents(input.events),',
        '};',
      ];
    }
    if (options.unindexedSourceAnchor) {
      source['packages/companion/src/source-owned-command.ts'] = [
        "import { appendStreamEvents as deliverStreamEvents } from './public-client.js';",
        'export const sourceOwnedCommands = {',
        '  async sourceOnlySessionStream(events: unknown[]) {',
        '    return deliverStreamEvents(events);',
        '  },',
        '};',
      ];
      source['packages/companion/src/public-client.ts'] = ["export * from './client.js';"];
    }
    writeFixtureFiles(root, {
      'package.json': JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }),
      'apps/api/package.json': JSON.stringify({ name: 'api' }),
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
      'packages/companion/package.json': JSON.stringify({ name: 'companion' }),
      'packages/shared/package.json': JSON.stringify({ name: 'shared' }),
      ...source,
    });

    const paths = Object.keys(source);
    const definitions = [
      { symbol: symbols.companionAppend, displayName: 'appendStreamEvents', file: paths[0]!, start: 2 },
      { symbol: symbols.companionCommand, displayName: 'sessionStreamEvents', file: paths[1]!, start: 2 },
      { symbol: symbols.dispatch, displayName: 'dispatchCommand', file: paths[2]!, start: 0 },
      { symbol: symbols.apiAppend, displayName: 'appendStreamEvents', file: paths[3]!, start: 4 },
      { symbol: symbols.apiRoute, displayName: 'dispatchStreamEvents', file: paths[4]!, start: 2 },
      { symbol: symbols.listEvents, displayName: 'listEvents', file: paths[5]!, start: 2 },
      { symbol: symbols.publish, displayName: 'publishUpdate', file: paths[6]!, start: 0 },
      { symbol: symbols.eventTable, displayName: 'agentWorkSessionEvents', file: paths[7]!, start: 0, kind: 13 },
      { symbol: symbols.realtimeTypes, displayName: 'sessionRealtimeEventTypes', file: paths[8]!, start: 0, kind: 13 },
      { symbol: symbols.webRealtime, displayName: 'handleRealtime', file: paths[9]!, start: 3 },
      { symbol: symbols.refresh, displayName: 'refreshEvents', file: paths[10]!, start: 2 },
      { symbol: symbols.render, displayName: 'renderEvent', file: paths[11]!, start: 0 },
      { symbol: symbols.memberRegistry, displayName: 'memberRegistry', file: paths[12]!, start: 2, kind: 13 },
      ...Array.from({ length: 12 }, (_, index) => ({
        symbol: `scip-typescript npm api 1.0.0 src/modules/empty-${String(index).padStart(2, '0')}/\`support.ts\`/support${index}.`,
        displayName: `support${index}`,
        file: paths[13 + index]!,
        start: 0,
        kind: 13,
      })),
      {
        symbol: symbols.companionEntry,
        displayName: 'externalSessionPath',
        file: 'packages/companion/src/entry.ts',
        start: 2,
      },
      ...(options.capabilityRegistry
        ? [
            {
              symbol: symbols.capabilityInstruction,
              displayName: 'background.ts',
              file: 'packages/companion/src/background.ts',
              start: 0,
              kind: 1,
            },
            {
              symbol: symbols.capabilityHandler,
              displayName: 'kill-process.ts',
              file: 'packages/companion/src/kill-process.ts',
              start: 0,
              kind: 1,
            },
          ]
        : []),
    ];

    const builder = evidenceFixtureDb(join(root, 'index.db'));
    definitions.forEach((definition, index) => {
      const id = index + 1;
      const lines = source[definition.file] as readonly string[];
      builder
        .document(id, 'typescript', definition.file)
        .symbol(id, definition.symbol, definition.displayName, definition.kind ?? 12)
        .definition(id, id, id, definition.start, 0, lines.length - 1, 1)
        .chunk(id, id, 0, lines.length - 1)
        .mention(id, id, 1);
    });
    const definedFiles = new Set(definitions.map((definition) => definition.file));
    paths
      .filter((file) => !definedFiles.has(file))
      .forEach((file, index) => {
        builder.document(definitions.length + index + 1, 'typescript', file);
      });

    const mention = (documentId: number, symbolId: number, role: number): void => {
      builder.mention(documentId, symbolId, role);
    };
    for (const [documentId, symbolId] of [
      [1, 3],
      [2, 1],
      [4, 7],
      [4, 8],
      [4, 9],
      [5, 4],
      [6, 8],
      [10, 9],
      [10, 11],
      [11, 12],
      ...Array.from({ length: 12 }, (_, index) => [4, 14 + index] as const),
      [26, 2],
    ] as const) {
      mention(documentId, symbolId, 2);
      mention(documentId, symbolId, 0);
    }
    if (options.moduleOwnedReference) {
      const objectCommandsDocumentId = paths.indexOf('packages/companion/src/object-commands.ts') + 1;
      mention(objectCommandsDocumentId, 1, 2);
      mention(objectCommandsDocumentId, 1, 0);
    }
    builder.write();

    const config: ScipQueryConfig = {
      dbPath: join(root, 'index.db'),
      indexPath: join(root, 'index.scip'),
      projectRoot: root,
    };
    const extractionDb = new ScipDatabase(config);
    const runtimeBoundaries = collectRuntimeBoundaryGraph(extractionDb);
    extractionDb.close();
    if (options.unindexedRuntimeParticipant) {
      const linked = runtimeBoundaries.links[0];
      const originalConsumer = linked
        ? runtimeBoundaries.observations.find((observation) => observation.id === linked.to)
        : undefined;
      if (!linked || !originalConsumer) throw new Error('fixture runtime boundary was not extracted');
      runtimeBoundaries.observations.push({
        ...originalConsumer,
        id: 'fixture-unindexed-consumer',
        owner: {
          file: 'apps/api/src/modules/sessions/registry.ts',
          symbol: null,
          name: 'work_session_stream_events',
          startLine: 1,
          endLine: 4,
        },
        source: {
          file: 'apps/api/src/modules/sessions/registry.ts',
          startLine: 1,
          endLine: 4,
        },
      });
      runtimeBoundaries.links.push({
        ...linked,
        id: 'fixture-unindexed-link',
        to: 'fixture-unindexed-consumer',
      });
    }
    writeRuntimeBoundaryGraph(config.dbPath, runtimeBoundaries);
    return new ScipDatabase(config);
  }
});

function fixtureSource(): Record<string, readonly string[]> {
  return {
    'packages/companion/src/client.ts': [
      "import { dispatchCommand } from './dispatch.js';",
      '',
      'export function appendStreamEvents(events: unknown[]) {',
      "  return dispatchCommand('work_session_stream_events', events);",
      '}',
    ],
    'packages/companion/src/command.ts': [
      "import { appendStreamEvents } from './client.js';",
      '',
      'export function sessionStreamEvents(events: unknown[]) {',
      '  return appendStreamEvents(events);',
      '}',
    ],
    'packages/companion/src/dispatch.ts': [
      'export function dispatchCommand(command: string, events: unknown[]) {',
      "  return fetch('/api/agent-dispatch', { method: 'POST', body: JSON.stringify({ command, events }) });",
      '}',
    ],
    'apps/api/src/modules/sessions/events.ts': [
      "import { agentWorkSessionEvents } from '../../db/schema/work-sessions.js';",
      "import { sessionRealtimeEventTypes } from 'shared/contracts';",
      "import { publishUpdate } from './realtime.js';",
      '',
      'export function appendStreamEvents(events: unknown[]) {',
      '  const table = agentWorkSessionEvents;',
      '  publishUpdate(sessionRealtimeEventTypes.workSession);',
      '  return { table, inserted: events.length };',
      '}',
      ...Array.from(
        { length: 12 },
        (_, index) => `import { support${index} } from '../empty-${String(index).padStart(2, '0')}/support.js';`,
      ),
    ],
    'apps/api/src/modules/sessions/routes.ts': [
      "import { appendStreamEvents } from './events.js';",
      '',
      'export function dispatchStreamEvents(events: unknown[]) {',
      "  const command = 'work_session_stream_events';",
      '  return { command, result: appendStreamEvents(events) };',
      '}',
      "const express = require('express');",
      'const router = express.Router();',
      "router.post('/api/agent-dispatch', dispatchStreamEvents);",
    ],
    'apps/api/src/modules/sessions/query.ts': [
      "import { agentWorkSessionEvents } from '../../db/schema/work-sessions.js';",
      '',
      'export function listEvents() {',
      '  return agentWorkSessionEvents;',
      '}',
    ],
    'apps/api/src/modules/sessions/realtime.ts': [
      'export function publishUpdate(type: string) {',
      '  return type;',
      '}',
    ],
    'apps/api/src/db/schema/work-sessions.ts': ['export const agentWorkSessionEvents = { table: true };'],
    'packages/shared/src/contracts/sessions.ts': [
      "export const sessionRealtimeEventTypes = { workSession: 'agent:work_session' };",
    ],
    'apps/web/src/components/sessions/realtime.ts': [
      "import { sessionRealtimeEventTypes } from 'shared/contracts';",
      "import { refreshEvents } from './client.js';",
      '',
      'export function handleRealtime(type: string) {',
      '  if (type === sessionRealtimeEventTypes.workSession) return refreshEvents();',
      '}',
    ],
    'apps/web/src/components/sessions/client.ts': [
      "import { renderEvent } from './view.js';",
      '',
      'export function refreshEvents() {',
      "  return renderEvent('latest');",
      '}',
    ],
    'apps/web/src/components/sessions/view.ts': [
      'export function renderEvent(value: string) {',
      '  return value;',
      '}',
    ],
    'apps/api/src/modules/member-flow/registry.ts': [
      "import { memberController } from '../../controllers/member-controller.js';",
      '',
      'export const memberRegistry = {',
      '  run: () => memberController.handleSession(),',
      '};',
    ],
    ...Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `apps/api/src/modules/empty-${String(index).padStart(2, '0')}/support.ts`,
        [`export const support${index} = true;`],
      ]),
    ),
    'packages/companion/src/entry.ts': [
      "import { sessionStreamEvents } from './command.js';",
      '',
      'export function externalSessionPath(events: unknown[]) {',
      '  return sessionStreamEvents(events);',
      '}',
    ],
    'apps/api/src/controllers/member-controller.ts': [
      'export const memberController = {',
      '  async handleSession() {',
      "    return 'handled';",
      '  },',
      '};',
    ],
    ...Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `packages/bulk-${String(index).padStart(2, '0')}/src/flow.ts`,
        [`export const marker${index} = 'bulk_drill_anchor';`],
      ]),
    ),
    ...Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `apps/api/src/modules/diverse/file-${String(index).padStart(2, '0')}.ts`,
        [`export const diverseMarker${index} = 'diverse_drill_anchor';`],
      ]),
    ),
    'apps/web/src/components/diverse-tail.ts': ["export const diverseTail = 'diverse_drill_anchor';"],
    'apps/api/src/modules/webhooks/event.ts': ["export const event = 'issue.created';"],
    'apps/api/src/modules/webhooks/consumer.ts': [
      'export function consumes(event: any) { return event === issue.created; }',
    ],
    'apps/api/src/modules/webhooks/__tests__/event.test.ts': ["expect('issue.created').toBeTruthy();"],
    'apps/api/src/modules/reports/aging.ts': ['export function age(issue: any) { return issue.createdAt; }'],
  };
}
