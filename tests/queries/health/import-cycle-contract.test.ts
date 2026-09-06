import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';
import { healthPhase } from '../../../src/queries/health/health.js';
import { collectBaselineFindings } from '../../../src/queries/health/health-baseline.js';
import { dependencyCycles } from '../../../src/queries/graph/cycles.js';

describe('indexed health import-cycle contract', () => {
  it.each([true, false])('agrees with the import graph and baseline for a barrel cycle: %s', (cyclic) => {
    const root = mkdtempSync(join(tmpdir(), 'scip-health-cycle-contract-'));
    try {
      writeFixtureFiles(root, {
        'src/index.ts': "export { worker } from './worker';\nexport const token = 1;",
        'src/worker.ts': cyclic
          ? "import { token } from './index';\nexport function worker() { return token; }"
          : 'export function worker() { return 1; }',
      });
      const dbPath = join(root, 'index.db');
      evidenceFixtureDb(dbPath)
        .document(1, 'typescript', 'src/index.ts')
        .document(2, 'typescript', 'src/worker.ts')
        .write();
      const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
      try {
        const cycles = dependencyCycles(db, { edgeBasis: 'imports' });
        expect(cycles).toHaveLength(cyclic ? 1 : 0);
        const phase = healthPhase(db, 'cycles');
        expect(phase).toMatchObject({ phase: 'cycles', realCycleCount: cyclic ? 1 : 0 });
        expect(collectBaselineFindings(db).filter((id) => id.startsWith('cycle:'))).toHaveLength(cyclic ? 1 : 0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
