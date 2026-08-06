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
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const symbols = {
  companionAppend: 'scip-typescript npm companion 1.0.0 src/`client.ts`/appendStreamEvents().',
  companionCommand: 'scip-typescript npm companion 1.0.0 src/`command.ts`/sessionStreamEvents().',
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
} as const;

describe('explicit-anchor system maps', { timeout: 15_000 }, () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
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
              expect.objectContaining({ method: 'runtime-boundary:http.method-path', strength: 'exact' }),
            ]),
          }),
        ]),
      );
      expect(topology.coverage.status).toBe('accounted');
      expect(topology.nodes.every((node) => ['emitted', 'folded', 'unsupported'].includes(node.disposition))).toBe(
        true,
      );
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
      expect(collapsed.regions.every((region) => region.files.length === 0 && region.symbols.length === 0)).toBe(true);
      expect(collapsed.regions.every((region) => region.notableSymbols.length > 0 || region.symbolCount === 0)).toBe(
        true,
      );
      expect(collapsed.expansion).toMatchObject({
        command: expect.stringContaining("--search 'work_session_stream_events'"),
        candidateRegionCount: collapsed.regions.length,
        regionCount: 12,
      });
      const evidenceBearingRegions = collapsed.regions.filter(
        (region) => region.symbolCount + region.literalHitCount > 0,
      );
      for (const region of evidenceBearingRegions) {
        expect(collapsed.expansion?.regionIds).toContain(region.id);
        expect(collapsed.expansion?.command).toContain(`--expand '${region.id}'`);
      }
      expect(collapsed.expansion?.omittedRegionIds).toHaveLength(collapsed.regions.length - 12);
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
      const collapsed = systemMap(db, { searches: ['bulk_drill_anchor'], maxDepth: 0 });
      expect(collapsed.expansion).toMatchObject({
        candidateRegionCount: 30,
        regionCount: 12,
      });
      expect(collapsed.expansion?.omittedRegionIds).toHaveLength(18);
      const expanded = systemMap(db, {
        searches: ['bulk_drill_anchor'],
        maxDepth: 0,
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
      const collapsed = systemMap(db, { searches: ['diverse_drill_anchor'], maxDepth: 0 });
      const expanded = systemMap(db, {
        searches: ['diverse_drill_anchor'],
        maxDepth: 0,
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
      });
      const expanded = systemMap(db, {
        searches: ['bulk_drill_anchor'],
        symbols: [symbols.render],
        maxDepth: 0,
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

  function createSystemMapDb(): ScipDatabase {
    root = mkdtempSync(join(tmpdir(), 'scip-system-map-'));
    const source = fixtureSource();
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
    paths.slice(definitions.length).forEach((file, index) => {
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
    ] as const) {
      mention(documentId, symbolId, 2);
      mention(documentId, symbolId, 0);
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
