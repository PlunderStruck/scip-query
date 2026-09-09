import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ScipDatabase } from '../../../src/storage/db.js';
import { programExecutionFrontiers } from '../../../src/queries/graph/program-execution-frontiers.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

it('reports an unresolved module initializer without claiming nested deferred calls belong to the file', () => {
  const root = mkdtempSync(join(tmpdir(), 'file-call-frontier-'));
  try {
    writeFixtureFiles(root, { 'entry.ts': ['externalStartup();', 'export function later() { deferredCall(); }'] });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'entry.ts').write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = programExecutionFrontiers(db, [
        {
          id: 'file:entry.ts',
          kind: 'file',
          label: 'entry.ts',
          disposition: 'emitted',
          anchorIds: [],
          location: { file: 'entry.ts', line: 0 },
        },
      ]);
      expect(result.frontiers).toHaveLength(1);
      expect(result.frontiers[0]!.reason).toContain('externalStartup');
      expect(result.frontiers[0]!.reason).not.toContain('deferredCall');
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
