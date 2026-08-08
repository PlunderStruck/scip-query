import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { cycleSummary, dependencyCycleSummary } from '../../../src/queries/graph/cycles.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('cycles', () => {
  it('reports every cyclic component once with a deterministic witness', () => {
    withCycleFixture((db) => {
      const full = cycleSummary(db, { maxDepth: 5 });

      expect(full.truncated).toBe(false);
      expect(full.cycles).toEqual([
        expect.objectContaining({
          kind: 'real',
          classification: 'dependency-cycle',
          component: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
          edgeBasis: 'symbol-references',
          witness: true,
          path: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/a.ts'],
        }),
      ]);

      const legacyDepth = cycleSummary(db, { maxDepth: 1 });
      expect(legacyDepth.truncated).toBe(false);
      expect(legacyDepth.maxDepth).toBe(1);
      expect(legacyDepth.cycles).toHaveLength(1);
    });
  });

  it('distinguishes symbol-reference cycles from the narrower import graph', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-ambient-cycle-'));
    try {
      const dbPath = join(root, 'index.db');
      writeFixtureFiles(root, {
        'src/a.ts': 'declare global { interface Window { fromA?: string } }\n',
        'src/b.ts': 'declare global { interface Window { fromB?: string } }\n',
      });
      evidenceFixtureDb(dbPath)
        .document(1, 'typescript', 'src/a.ts')
        .document(2, 'typescript', 'src/b.ts')
        .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`a.ts`/Window#', 'Window', 11)
        .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`b.ts`/Window#', 'Window', 11)
        .definition(1, 1, 1, 0, 0, 0, 1)
        .definition(2, 2, 2, 0, 0, 0, 1)
        .chunk(1, 1, 0, 0)
        .chunk(2, 2, 0, 0)
        .mention(1, 1, 1)
        .mention(2, 2, 1)
        .mention(1, 2, 0)
        .mention(2, 1, 0)
        .write();
      const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
      try {
        expect(cycleSummary(db).cycles).toEqual([
          expect.objectContaining({
            component: ['src/a.ts', 'src/b.ts'],
            edgeBasis: 'symbol-references',
          }),
        ]);
        expect(dependencyCycleSummary(db, { edgeBasis: 'imports' }).cycles).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function withCycleFixture(run: (db: ScipDatabase) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-cycles-'));
  try {
    const dbPath = join(root, 'index.db');
    writeFixtureFiles(root, {
      'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
      'src/b.ts': "import { c } from './c';\nexport const b = c;\n",
      'src/c.ts': "import { a } from './a';\nexport const c = a;\n",
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/a.ts')
      .document(2, 'typescript', 'src/b.ts')
      .document(3, 'typescript', 'src/c.ts')
      .write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
