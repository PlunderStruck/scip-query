import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeFingerprint } from '../../src/runtime/index-freshness.js';
import {
  FINGERPRINT_STAT_CACHE_FILE,
  resetProjectFileFingerprintCacheForTest,
  projectFileFingerprintCacheStats,
  withProjectFileFingerprintCache,
} from '../../src/platform/fingerprint-stat-cache.js';
import { createHash } from 'node:crypto';
import { inspectWatchService } from '../../src/runtime/watch-service.js';
import { expect, test } from 'vitest';
import { IndexerHistoryFixture } from '../properties/indexer-history-fixture.js';
import { readRuntimeBoundaryGraph } from '../../src/analysis/runtime-boundaries/index.js';
import { collectRuntimeBoundaryGraph } from '../../src/analysis/runtime-boundaries/graph.js';

test('retains independent HTTP propagation and reunites interacting callable summaries', async () => {
  const fixture = new IndexerHistoryFixture();
  const independent = (body: string) => `export function independent(path: string): number { ${body} return 1; }\n`;
  const graphAfterIndex = async () => {
    await fixture.index({ allowExpensiveRebuild: false });
    const db = fixture.open();
    try {
      const graph = readRuntimeBoundaryGraph(db)!;
      expectIndexedPhaseSources(graph, fixture.sources);
      const fresh = await collectRuntimeBoundaryGraph(db);
      expect(graph.observations).toEqual(fresh.observations);
      expect(graph.links).toEqual(fresh.links);
      expect(graph.frontiers).toEqual(fresh.frontiers);
      expect(graph.relationGroups).toEqual(fresh.relationGroups);
      expect(graph.fileCoverage).toEqual(fresh.fileCoverage);
      expect(graph.coverage.extractors).toEqual(fresh.coverage.extractors);
      return graph;
    } finally {
      db.close();
    }
  };
  try {
    fixture.write('owner.ts', 'export function value(path: string) { return fetch(path); }\n');
    fixture.write('consumer.ts', "import { shared } from './bridge.js';\nexport const result = shared('/one');\n");
    fixture.write('independent.ts', independent(''));
    await fixture.index({ skipIfUnchanged: false, allowExpensiveRebuild: true });
    expect(existsSync(join(fixture.cache, FINGERPRINT_STAT_CACHE_FILE))).toBe(true);
    resetProjectFileFingerprintCacheForTest(fixture.root);
    runtimeFingerprint(fixture.root, ['typescript'], { dbPath: '.cache' });
    withProjectFileFingerprintCache(fixture.root, fixture.cache, () => {
      const stats = projectFileFingerprintCacheStats(fixture.root);
      expect(stats.hits).toBeGreaterThan(0);
      expect(stats.stores).toBe(0);
    });
    const baselineDb = fixture.open();
    try {
      expectIndexedPhaseSources(readRuntimeBoundaryGraph(baselineDb)!, fixture.sources);
    } finally {
      baselineDb.close();
    }
    fixture.startService();
    fixture.write('independent.ts', independent('void fetch(path);'));
    const separate = await graphAfterIndex();
    expect(separate.phaseRecords?.httpPartitions).toHaveLength(2);
    expect(separate.coverage.phases?.find((phase) => phase.id === 'http-summary')?.filesVisited).toBe(0);
    expect(separate.coverage.phases?.find((phase) => phase.id === 'body-summary')?.filesVisited).toBe(0);
    fixture.write(
      'independent.ts',
      "import { shared } from './bridge.js';\n" + independent('void shared(path); void fetch(path);'),
    );
    const merged = await graphAfterIndex();
    expect(merged.phaseRecords?.httpPartitions).toHaveLength(1);
    expect(
      merged.phaseRecords?.httpPartitions?.[0]?.record.result.summarySymbols.some((symbol) =>
        symbol.includes('independent'),
      ),
    ).toBe(true);
    fixture.write('independent.ts', independent(''));
    const removed = await graphAfterIndex();
    expect(removed.observations.some((observation) => observation.source.file === 'independent.ts')).toBe(false);
    fixture.assertCurrent();
  } finally {
    await fixture.dispose();
  }
}, 60_000);

test('publishes retained documents while advancing source freshness and runtime facts', async () => {
  const fixture = new IndexerHistoryFixture();
  const source = (path: string, amount: number) =>
    `export function value(input: number) { void fetch("${path}"); return input + ${amount}; }\n`;
  const requests = () => {
    const db = fixture.open();
    try {
      return readRuntimeBoundaryGraph(db)
        ?.observations.filter((observation) => observation.action === 'http.request')
        .map((observation) => observation.keyParts.find((part) => part.name === 'path')?.value);
    } finally {
      db.close();
    }
  };
  try {
    const quiet = (amount: number) =>
      `export const untouched = 17;\nexport function quiet(value: number): number { return value + ${amount}; }\n`;
    fixture.write('quiet.ts', quiet(1));
    fixture.write('owner.ts', source('/one', 1));
    await fixture.index({ skipIfUnchanged: false, allowExpensiveRebuild: true });
    fixture.startService();
    fixture.write('owner.ts', source('/one', 2));
    await fixture.index({ allowExpensiveRebuild: false });
    fixture.assertCurrent();
    fixture.write('quiet.ts', quiet(2));
    await fixture.index({ allowExpensiveRebuild: false });
    fixture.write('quiet.ts', quiet(3));
    await fixture.index({ allowExpensiveRebuild: false });
    expect(fixture.statuses.join('\n')).toContain('SQLite conversion is unnecessary');
    const reusedDb = fixture.open();
    try {
      const graph = readRuntimeBoundaryGraph(reusedDb)!;
      expect(graph.phaseRecords?.httpPartitions?.length).toBeGreaterThan(0);
      expect(graph.phaseRecords?.body).toBeDefined();
      expect(graph.phaseRecords?.carrier).toBeDefined();
      for (const id of ['http-summary', 'carrier']) {
        expect(graph.coverage.phases?.find((phase) => phase.id === id)).toMatchObject({
          filesVisited: 0,
          factsReused: expect.any(Number),
        });
      }
      const full = await collectRuntimeBoundaryGraph(reusedDb);
      expect(graph.observations).toEqual(full.observations);
      expect(graph.frontiers).toEqual(full.frontiers);
      expect(graph.links).toEqual(full.links);
      expect(graph.relationGroups).toEqual(full.relationGroups);
    } finally {
      reusedDb.close();
    }
    const before = fixture.publication();
    fixture.write('owner.ts', source('/two', 2));
    await fixture.index({ allowExpensiveRebuild: false });
    expect(fixture.statuses.join('\n')).toContain('SQLite conversion is unnecessary');
    expect(fixture.statuses.join('\n')).not.toContain('Converting bounded TypeScript');
    expect(fixture.publication()).not.toEqual(before);
    expect(requests()).toEqual(['/two']);
    fixture.assertCurrent();
    const unchanged = await fixture.index({ allowExpensiveRebuild: false });
    expect(unchanged.reused).toBe(true);
    fixture.write('owner.ts', '// moved source\n' + source('/two', 2));
    await fixture.index({ allowExpensiveRebuild: false });
    const movedDb = fixture.open();
    try {
      const graph = readRuntimeBoundaryGraph(movedDb)!;
      const request = graph.observations.find((observation) => observation.action === 'http.request')!;
      expect(request.source.startLine).toBe(1);
      expect(graph.observations).toEqual((await collectRuntimeBoundaryGraph(movedDb)).observations);
    } finally {
      movedDb.close();
    }
    fixture.write('owner.ts', 'export function value(input: number): string { return "changed"; }\n');
    await fixture.index({ allowExpensiveRebuild: false });
    expect(fixture.statuses.join('\n')).toContain('Converting bounded TypeScript');
    expect(requests()).toEqual([]);
    fixture.assertCurrent();
  } finally {
    await fixture.dispose();
  }
}, 60_000);

test('reuses runtime query evidence after an unrelated compiler-reference edit and invalidates new callers', async () => {
  const fixture = new IndexerHistoryFixture();
  const quiet = (method: string) =>
    `const operations = { high(input: number): number { return input + 1; }, loww(input: number): number { return input - 1; } };\nexport const untouched = 17;\nexport function quiet(value: number): number { return operations.${method}(value); }\n`;
  const graphAfterIndex = async () => {
    await fixture.index({ allowExpensiveRebuild: false });
    const db = fixture.open();
    try {
      const graph = readRuntimeBoundaryGraph(db)!;
      const fresh = await collectRuntimeBoundaryGraph(db);
      expect(graph.observations).toEqual(fresh.observations);
      expect(graph.links).toEqual(fresh.links);
      expect(graph.frontiers).toEqual(fresh.frontiers);
      expect(graph.relationGroups).toEqual(fresh.relationGroups);
      return graph;
    } finally {
      db.close();
    }
  };
  try {
    fixture.write('owner.ts', 'export function value(path: string) { return fetch(path); }\n');
    fixture.write('consumer.ts', "import { shared } from './bridge.js';\nexport const result = shared('/one');\n");
    fixture.write('quiet.ts', quiet('high'));
    await fixture.index({ skipIfUnchanged: false, allowExpensiveRebuild: true });
    fixture.startService();
    fixture.write('quiet.ts', quiet('loww'));
    await graphAfterIndex();
    fixture.write('quiet.ts', quiet('high'));
    const unrelated = await graphAfterIndex();
    expect(fixture.statuses.join('\n')).toContain('Converting bounded TypeScript');
    expect(unrelated.phaseRecords?.httpPartitions?.[0]?.record.database?.reads.length).toBeGreaterThan(0);
    expect(unrelated.coverage.phases?.find((phase) => phase.id === 'http-summary')?.filesVisited).toBe(0);
    const paths = (graph: typeof unrelated) =>
      graph.observations.flatMap((observation) =>
        observation.action === 'http.request'
          ? observation.keyParts.filter((part) => part.name === 'path').map((part) => part.value)
          : [],
      );
    expect(paths(unrelated)).toContain('/one');
    expect(paths(unrelated)).not.toContain('/new-caller');
    fixture.write('quiet.ts', quiet('high') + "import { shared } from './bridge.js';\nshared('/new-caller');\n");
    const called = await graphAfterIndex();
    expect(paths(called)).toContain('/new-caller');
    expect(called.coverage.phases?.find((phase) => phase.id === 'http-summary')?.filesVisited).toBeGreaterThan(0);
    fixture.write('quiet.ts', quiet('high'));
    expect(paths(await graphAfterIndex())).not.toContain('/new-caller');
    fixture.assertCurrent();
  } finally {
    await fixture.dispose();
  }
}, 60_000);

test('recovers accepted documents after worker restart and still propagates changed types', async () => {
  const fixture = new IndexerHistoryFixture();
  const source = (amount: number) => `export function value(input: number): number { return input + ${amount}; }\n`;
  const emitted = () => {
    const status = inspectWatchService({ projectRoot: fixture.root, cacheDir: fixture.cache, cliVersion: '0.25.0' });
    if (status.classification.kind !== 'live') throw new Error('Expected live fixture watcher');
    return status.classification.state.typescriptIndex?.documentsEmitted;
  };
  try {
    fixture.write('owner.ts', source(1));
    await fixture.index({ skipIfUnchanged: false, allowExpensiveRebuild: true });
    fixture.startService();
    fixture.write('owner.ts', source(2));
    await fixture.index({ allowExpensiveRebuild: false });
    expect(emitted()).toBe(1);
    await fixture.restartService();
    fixture.write('owner.ts', source(3));
    await fixture.index({ allowExpensiveRebuild: false });
    fixture.assertCurrent();
    expect(emitted()).toBe(1);
    await fixture.restartService();
    fixture.write('owner.ts', 'export function value(input: number): string { return String(input); }\n');
    await fixture.index({ allowExpensiveRebuild: false });
    fixture.assertCurrent();
    expect(emitted()).toBeGreaterThan(1);
  } finally {
    await fixture.dispose();
  }
}, 60_000);

function expectIndexedPhaseSources(
  graph: NonNullable<ReturnType<typeof readRuntimeBoundaryGraph>>,
  sources: ReadonlyMap<string, string>,
): void {
  const records = [
    ...(graph.phaseRecords?.httpPartitions?.map((partition) => partition.record) ?? []),
    graph.phaseRecords?.body,
    graph.phaseRecords?.carrier,
  ];
  let checked = 0;
  for (const record of records) {
    for (const source of record?.sources ?? []) {
      const text = sources.get(source.file);
      if (text === undefined) continue;
      expect(source.indexedHash).toBe(createHash('sha256').update(text).digest('hex'));
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(0);
}
