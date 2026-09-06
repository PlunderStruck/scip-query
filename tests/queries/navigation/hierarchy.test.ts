import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { hierarchy } from '../../../src/queries/navigation/hierarchy.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

describe('hierarchy', () => {
  it('uses enclosing_symbol when present and falls back to the SCIP descriptor chain', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-hierarchy-'));
    try {
      const dbPath = join(root, 'index.db');
      const method = 'scip-typescript npm fixture 1.0.0 src/`widget.ts`/Widget#render().';
      const cls = 'scip-typescript npm fixture 1.0.0 src/`widget.ts`/Widget#';
      const fallbackMethod = 'scip-typescript npm fixture 1.0.0 src/`fallback.ts`/Fallback#run().';
      const fallbackClass = 'scip-typescript npm fixture 1.0.0 src/`fallback.ts`/Fallback#';
      const fallbackModule = 'scip-typescript npm fixture 1.0.0 src/`fallback.ts`/';
      evidenceFixtureDb(dbPath)
        .document(1, 'typescript', 'src/widget.ts')
        .document(2, 'typescript', 'src/fallback.ts')
        .symbol(1, method, 'render', 6)
        .symbol(2, cls, 'Widget', 5)
        .symbol(3, fallbackMethod, 'run', 6)
        .symbol(4, fallbackClass, 'Fallback', 5)
        .symbol(5, fallbackModule, 'fallback', 1)
        .definition(1, 1, 1, 4, 2, 6, 3)
        .definition(2, 1, 2, 0, 0, 8, 1)
        .definition(3, 2, 3, 1, 2, 2, 3)
        .definition(4, 2, 4, 0, 0, 3, 1)
        .definition(5, 2, 5, 0, 0, 3, 1)
        .write();
      const sqliteDb = new Database(dbPath);
      try {
        sqliteDb.prepare('UPDATE global_symbols SET enclosing_symbol = ? WHERE id = ?').run(cls, 1);
      } finally {
        sqliteDb.close();
      }
      const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
      try {
        expect(hierarchy(db, 'render').map((node) => node.shortName)).toEqual([
          'src:widget:Widget:render()',
          'src:widget:Widget',
        ]);
        expect(hierarchy(db, 'Fallback#run').map((node) => node.shortName)).toEqual([
          'src:fallback:Fallback:run()',
          'src:fallback:Fallback',
          'src:fallback',
        ]);
        expect(hierarchy(db, 'Fallback#run').map((node) => node.symbol)).toEqual([
          fallbackMethod,
          fallbackClass,
          fallbackModule,
        ]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
