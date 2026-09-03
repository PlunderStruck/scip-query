import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { health } from '../../../src/queries/health/health.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('health cycle axis basis', () => {
  it('counts import cycles and discloses components that cycle only through symbol references', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-health-cycle-basis-'));
    try {
      const dbPath = join(root, 'index.db');
      writeFixtureFiles(root, {
        // `a` and `b` reference each other's declarations without importing:
        // a symbol-reference cycle that is not a runtime dependency.
        'src/a.ts': 'declare global { interface Window { fromA?: string } }\n',
        'src/b.ts': 'declare global { interface Window { fromB?: string } }\n',
        // `c` and `d` import each other: a real import cycle.
        'src/c.ts': "import { d } from './d';\nexport const c = d;\n",
        'src/d.ts': "import { c } from './c';\nexport const d = c;\n",
      });
      evidenceFixtureDb(dbPath)
        .document(1, 'typescript', 'src/a.ts')
        .document(2, 'typescript', 'src/b.ts')
        .document(3, 'typescript', 'src/c.ts')
        .document(4, 'typescript', 'src/d.ts')
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
        const report = health(db);
        expect(report.findings.cycles).toBe(1);
        expect(report.policyExclusions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ detector: 'cycles', reason: 'symbol-reference-only-cycles', count: 1 }),
          ]),
        );
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
