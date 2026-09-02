import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import {
  buildFileDepGraph,
  captureFileDependencyGraph,
  captureTypeScriptPlanningDependencyGraph,
  carryFileDependencyGraph,
  materializeCarriedFileDependencyGraph,
  readPersistedFileDependencyGraph,
  warmSourceDependencyProducts,
} from '../../src/symbols/graph/file-dep-graph.js';
import { getAst, getAstForSource } from '../../src/source/ast.js';
import { collectScopedDefinitionsInBatches, getScopedDefinitions } from '../../src/symbols/definition-catalog.js';
import { warmSourceFactsProducts } from '../../src/source/facts/source-facts-warm.js';
import { warmFileProducts } from '../../src/runtime/file-product-warm.js';
import {
  crossFileCallerEvidenceMap,
  sourceFallbackCallerEvidenceMap,
} from '../../src/symbols/references/caller-evidence.js';
import { clearRegisteredCaches } from '../../src/storage/cache-registry.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

const PROFILE_ENV_KEYS = ['SCIP_QUERY_PROFILE', 'SCIP_QUERY_PROFILE_OUT', 'SCIP_QUERY_PROFILE_COMMAND'] as const;

const sym = (path: string, name: string) => `scip-typescript npm fixture 1.0.0 src/\`${path}\`/${name}().`;

function restoreProfileEnv(snapshot: Record<(typeof PROFILE_ENV_KEYS)[number], string | undefined>): void {
  for (const key of PROFILE_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function graphShape(graph: Map<string, Set<string>>): Array<[string, string[]]> {
  return [...graph].map(([file, deps]) => [file, [...deps]]);
}

describe('file dependency graph evidence', () => {
  let tempDir: string | undefined;
  const envSnapshot = Object.fromEntries(PROFILE_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof PROFILE_ENV_KEYS)[number],
    string | undefined
  >;

  afterEach(() => {
    restoreProfileEnv(envSnapshot);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function withFixture<T>(run: (openDb: () => ScipDatabase, profilePath: string) => T): T {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-file-deps-'));
    const projectRoot = join(tempDir, 'project');
    const dbPath = join(tempDir, 'index.db');
    const profilePath = join(tempDir, 'profile.jsonl');

    writeFixtureFiles(projectRoot, {
      'src/a.ts': "import { b } from './b';\nexport function a(): string { return b(); }\n",
      'src/b.ts': "export function b(): string { return 'b'; }\n",
      'src/barrel.ts': "export { b } from './b';\n",
      'src/c.ts': "import { b } from './b';\nexport function c(): string { return b(); }\n",
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/a.ts')
      .document(2, 'typescript', 'src/b.ts')
      .document(3, 'typescript', 'src/c.ts')
      .document(4, 'typescript', 'src/barrel.ts')
      .symbol(1, sym('a.ts', 'a'), 'a', 6)
      .symbol(2, sym('b.ts', 'b'), 'b', 6)
      .symbol(3, sym('c.ts', 'c'), 'c', 6)
      .definition(1, 1, 1, 1, 0, 1, 45)
      .definition(2, 2, 2, 0, 0, 0, 45)
      .definition(3, 3, 3, 1, 0, 1, 45)
      .chunk(1, 1, 0, 1)
      .chunk(2, 2, 0, 0)
      .chunk(3, 3, 0, 1)
      .mention(1, 1, 1)
      .mention(1, 2, 0)
      .mention(2, 2, 1)
      .mention(3, 3, 1)
      .mention(3, 2, 0)
      .write();
    writeFileSync(
      join(tempDir, 'meta.json'),
      JSON.stringify({
        version: 3,
        status: 'complete',
        fingerprint: {
          version: 1,
          languages: ['typescript'],
          files: [
            { path: 'src/a.ts', size: 61, hash: 'a' },
            { path: 'src/b.ts', size: 43, hash: 'b' },
            { path: 'src/barrel.ts', size: 28, hash: 'barrel' },
            { path: 'src/c.ts', size: 61, hash: 'c' },
          ],
        },
        indexedLanguages: ['typescript'],
      }),
    );

    process.env.SCIP_QUERY_PROFILE = '1';
    process.env.SCIP_QUERY_PROFILE_OUT = profilePath;
    process.env.SCIP_QUERY_PROFILE_COMMAND = 'scip-query cycles --json';

    const openDb = (): ScipDatabase =>
      new ScipDatabase({
        projectRoot,
        dbPath,
        indexPath: join(tempDir!, 'index.scip'),
      });

    return run(openDb, profilePath);
  }

  it('persists graph evidence and reuses it from a fresh database connection', () => {
    withFixture((openDb, profilePath) => {
      const db1 = openDb();
      let firstShape: Array<[string, string[]]>;
      try {
        firstShape = graphShape(buildFileDepGraph(db1));
      } finally {
        db1.close();
      }

      const persistedDb = openDb();
      try {
        expect(graphShape(readPersistedFileDependencyGraph(persistedDb)?.graph ?? new Map())).toEqual(firstShape!);
      } finally {
        persistedDb.close();
      }

      const db2 = openDb();
      let secondShape: Array<[string, string[]]>;
      try {
        secondShape = graphShape(buildFileDepGraph(db2));
      } finally {
        db2.close();
      }

      const planningDb = openDb();
      try {
        expect(graphShape(captureTypeScriptPlanningDependencyGraph(planningDb).graph)).toEqual(firstShape!);
      } finally {
        planningDb.close();
      }

      expect(secondShape).toEqual(firstShape!);
      expect(secondShape).toEqual([
        ['src/a.ts', ['src/b.ts']],
        ['src/c.ts', ['src/b.ts']],
      ]);

      const events = readFileSync(profilePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const productEvents = events.filter((event) => event.name === 'file-dep-graph.product');

      expect(productEvents).toHaveLength(3);
      expect(productEvents[0]).toMatchObject({ hit: false, available: true, graphFiles: 2 });
      expect(productEvents[1]).toMatchObject({ hit: true, available: true, graphFiles: 2 });
      expect(productEvents[2]).toMatchObject({ hit: false, sourceEdgeMode: 'none', graphFiles: 2 });
      expect(events.filter((event) => event.name === 'file-dep-graph.source-imports')).toHaveLength(1);
      expect(events.filter((event) => event.name === 'file-dep-graph.scip-edges')).toHaveLength(2);
    });
  });

  it('includes re-exports only in the opt-in source edge mode and isolates both cache identities', () => {
    withFixture((openDb) => {
      const db1 = openDb();
      try {
        expect(graphShape(buildFileDepGraph(db1))).toEqual([
          ['src/a.ts', ['src/b.ts']],
          ['src/c.ts', ['src/b.ts']],
        ]);
        expect(graphShape(buildFileDepGraph(db1, undefined, { sourceEdges: 'imports-and-reexports' }))).toEqual([
          ['src/a.ts', ['src/b.ts']],
          ['src/c.ts', ['src/b.ts']],
          ['src/barrel.ts', ['src/b.ts']],
        ]);
      } finally {
        db1.close();
      }

      const db2 = openDb();
      try {
        expect(graphShape(buildFileDepGraph(db2, undefined, { sourceEdges: 'imports-and-reexports' }))).toContainEqual([
          'src/barrel.ts',
          ['src/b.ts'],
        ]);
        expect(graphShape(buildFileDepGraph(db2))).not.toContainEqual(['src/barrel.ts', ['src/b.ts']]);
      } finally {
        db2.close();
      }
    });
  });

  it('carries an exact graph forward by replacing only affected outgoing edges', () => {
    withFixture((openDb, profilePath) => {
      const db1 = openDb();
      const snapshot = captureFileDependencyGraph(db1);
      db1.close();

      writeFileSync(
        join(tempDir!, 'project/src/c.ts'),
        "import { a } from './a';\nexport function c(): string { return a(); }\n",
      );
      const sqlite = new Database(join(tempDir!, 'index.db'));
      sqlite.prepare('UPDATE mentions SET symbol_id = ? WHERE chunk_id = ? AND role = ?').run(1, 3, 0);
      sqlite.close();

      const metadataPath = join(tempDir!, 'meta.json');
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
        fingerprint: { files: Array<{ path: string; size: number; hash: string }> };
      };
      const changed = metadata.fingerprint.files.find((file) => file.path === 'src/c.ts');
      if (!changed) throw new Error('fixture metadata is missing src/c.ts');
      changed.hash = 'c-next';
      writeFileSync(metadataPath, JSON.stringify(metadata));

      const db2 = openDb();
      try {
        const materialized = materializeCarriedFileDependencyGraph(db2, snapshot, ['src/c.ts']);
        expect(materialized).not.toBeNull();
        expect(materialized!.get('src/a.ts')).toBe(snapshot.graph.get('src/a.ts'));
        expect(carryFileDependencyGraph(db2, snapshot, ['src/c.ts'], materialized!)).toBe(true);
      } finally {
        db2.close();
      }

      const db3 = openDb();
      try {
        expect(graphShape(buildFileDepGraph(db3))).toEqual([
          ['src/a.ts', ['src/b.ts']],
          ['src/c.ts', ['src/a.ts']],
        ]);
      } finally {
        db3.close();
      }

      const productEvents = readFileSync(profilePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.name === 'file-dep-graph.product');
      expect(productEvents.at(-1)).toMatchObject({ hit: true, construction: 'carried', graphFiles: 2 });
    });
  });

  it('warms import and re-export products in yielding batches so the synchronous build parses nothing new', async () => {
    await withFixture(async (openDb) => {
      const db = openDb();
      const events: string[] = [];
      const progress: Array<{ files: number; total: number }> = [];
      const warmed = await warmSourceDependencyProducts(db, {
        batchSize: 3,
        collectGarbage: () => {
          events.push('collect');
          return true;
        },
        yieldToEventLoop: async () => {
          events.push('yield');
        },
        onBatch: (batch) => {
          progress.push(batch);
          events.push(`batch:${batch.files}`);
        },
      });

      expect(warmed).toEqual({ files: 4 });
      expect(progress).toEqual([
        { files: 3, total: 4 },
        { files: 4, total: 4 },
      ]);
      // Every batch ends with a full collection, which queues the finalizers
      // of the batch's dead trees, and then one event-loop turn, which runs
      // them. The last batch is not exempt: its trees are otherwise held
      // until whatever the caller does next yields.
      expect(events).toEqual(['batch:3', 'collect', 'yield', 'batch:4', 'collect', 'yield']);
      // The synchronous build reads the persisted products it just wrote.
      expect(graphShape(buildFileDepGraph(db))).toEqual(
        expect.arrayContaining([
          ['src/a.ts', ['src/b.ts']],
          ['src/c.ts', ['src/b.ts']],
        ]),
      );
    });
  });

  it('shares one tree between the import sweep and getAst for identical bytes', () => {
    withFixture((openDb) => {
      const db = openDb();
      const source = readFileSync(join(db.config.projectRoot, 'src/a.ts'), 'utf8');
      const tree = getAstForSource(db, 'src/a.ts', source);
      expect(tree).not.toBeNull();
      // The re-export pass reads the same bytes through getAst; it must not
      // parse the file a second time.
      expect(getAst(db, 'src/a.ts')).toBe(tree);
    });
  });

  it('reads scoped definitions in collecting, yielding batches with the same result as the synchronous form', async () => {
    await withFixture(async (openDb) => {
      const db = openDb();
      const events: string[] = [];
      const batched = await collectScopedDefinitionsInBatches(db, undefined, {
        batchSize: 3,
        collectGarbage: () => {
          events.push('collect');
          return true;
        },
        yieldToEventLoop: async () => {
          events.push('yield');
        },
        onBatch: (batch) => events.push(`batch:${batch.files}/${batch.total}`),
      });

      expect(events).toEqual(['batch:3/4', 'collect', 'yield', 'batch:4/4', 'collect', 'yield']);
      expect(batched.map((row) => row.symbol)).toEqual(getScopedDefinitions(db).map((row) => row.symbol));
      expect(batched.length).toBeGreaterThan(0);
    });
  });

  it('persists source facts in collecting, yielding batches', async () => {
    await withFixture(async (openDb) => {
      const db = openDb();
      const events: string[] = [];
      const warmed = await warmSourceFactsProducts(db, {
        batchSize: 3,
        collectGarbage: () => {
          events.push('collect');
          return true;
        },
        yieldToEventLoop: async () => {
          events.push('yield');
        },
        onBatch: (batch) => events.push(`batch:${batch.files}/${batch.total}`),
      });

      expect(warmed).toEqual({ files: 4, withFacts: 4 });
      expect(events).toEqual(['batch:3/4', 'collect', 'yield', 'batch:4/4', 'collect', 'yield']);
    });
  });

  it('memoizes caller files per symbol across calls and forgets them with the source-file group', () => {
    withFixture((openDb) => {
      const db = openDb();
      const definitions = getScopedDefinitions(db);
      const b = definitions.find((definition) => definition.relativePath === 'src/b.ts');
      const a = definitions.find((definition) => definition.relativePath === 'src/a.ts');
      expect(b && a).toBeTruthy();
      const shape = (map: Map<number, Set<string>>): Array<[number, string[]]> =>
        [...map].map(([id, files]) => [id, [...files].sort()]);

      const first = crossFileCallerEvidenceMap(db, [b!], { semantic: false });
      expect(first.get(b!.symbolId)).toEqual(new Set(['src/a.ts', 'src/c.ts']));
      // A later call over a superset reuses b's answer and computes only a's.
      const second = crossFileCallerEvidenceMap(db, [a!, b!], { semantic: false });
      expect(second.get(b!.symbolId)).toEqual(first.get(b!.symbolId));
      expect(shape(sourceFallbackCallerEvidenceMap(db, [b!]))).toEqual(
        shape(sourceFallbackCallerEvidenceMap(db, [a!, b!])).filter(([id]) => id === b!.symbolId),
      );
      // Returned sets are copies: mutating one must not poison later answers.
      second.get(b!.symbolId)!.add('src/poison.ts');
      expect(crossFileCallerEvidenceMap(db, [b!], { semantic: false }).get(b!.symbolId)).toEqual(
        first.get(b!.symbolId),
      );

      clearRegisteredCaches(db, { groups: ['source-file'] });
      expect(crossFileCallerEvidenceMap(db, [b!], { semantic: false }).get(b!.symbolId)).toEqual(
        first.get(b!.symbolId),
      );
    });
  });

  it("warms every per-file product in one collecting sweep and returns the files' definitions", async () => {
    await withFixture(async (openDb) => {
      const db = openDb();
      const events: string[] = [];
      const warmed = await warmFileProducts(db, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/barrel.ts'], {
        batchSize: 3,
        collectGarbage: () => {
          events.push('collect');
          return true;
        },
        yieldToEventLoop: async () => {
          events.push('yield');
        },
        onBatch: (batch) => events.push(`batch:${batch.files}/${batch.total}`),
      });

      expect(warmed.files).toBe(4);
      expect(warmed.definitions.map((row) => row.symbol)).toEqual(getScopedDefinitions(db).map((row) => row.symbol));
      expect(events).toEqual(['batch:3/4', 'collect', 'yield', 'batch:4/4', 'collect', 'yield']);
      // The sweep persisted the import products too: the synchronous graph
      // build reads them back without parsing.
      expect(graphShape(buildFileDepGraph(db))).toEqual(
        expect.arrayContaining([
          ['src/a.ts', ['src/b.ts']],
          ['src/c.ts', ['src/b.ts']],
        ]),
      );
    });
  });
});
