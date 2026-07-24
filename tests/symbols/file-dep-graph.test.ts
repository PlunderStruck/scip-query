import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import { buildFileDepGraph } from '../../src/symbols/graph/file-dep-graph.js';
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

  function withFixture(run: (openDb: () => ScipDatabase, profilePath: string) => void): void {
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

    run(openDb, profilePath);
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

      const db2 = openDb();
      let secondShape: Array<[string, string[]]>;
      try {
        secondShape = graphShape(buildFileDepGraph(db2));
      } finally {
        db2.close();
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

      expect(productEvents).toHaveLength(2);
      expect(productEvents[0]).toMatchObject({ hit: false, available: true, graphFiles: 2 });
      expect(productEvents[1]).toMatchObject({ hit: true, available: true, graphFiles: 2 });
      expect(events.filter((event) => event.name === 'file-dep-graph.source-imports')).toHaveLength(1);
      expect(events.filter((event) => event.name === 'file-dep-graph.scip-edges')).toHaveLength(1);
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
});
