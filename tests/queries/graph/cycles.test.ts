import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { cycleSummary } from '../../../src/queries/graph/cycles.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('cycles', () => {
  it('reports simple source-import cycles and exposes search truncation', () => {
    withCycleFixture((db) => {
      const full = cycleSummary(db, { maxDepth: 5 });

      expect(full.truncated).toBe(false);
      expect(full.cycles).toEqual([
        expect.objectContaining({
          kind: 'real',
          path: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/a.ts'],
        }),
      ]);

      const truncated = cycleSummary(db, { maxDepth: 1 });
      expect(truncated.truncated).toBe(true);
      expect(truncated.maxDepth).toBe(1);
    });
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
