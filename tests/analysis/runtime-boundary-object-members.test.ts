import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCallableExpression } from '../../src/analysis/runtime-boundaries/object-members.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('runtime-boundary object-member resolution', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('resolves an unindexed object method through imports, re-exports, and object spreads', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-runtime-member-'));
    const files = {
      'src/leaf.ts': [
        'export const baseController = {',
        '  async dispatch(request: unknown) { return request; },',
        '};',
      ],
      'src/composed.ts': [
        "import { baseController } from './leaf.js';",
        'export const controller = { ...baseController };',
      ],
      'src/barrel.ts': ["export * from './composed.js';"],
      'src/route.ts': ["import { controller } from './barrel.js';", "router.post('/dispatch', controller.dispatch);"],
    };
    writeFixtureFiles(tempDir, files);
    const builder = evidenceFixtureDb(join(tempDir, 'index.db'));
    Object.keys(files).forEach((file, index) => builder.document(index + 1, 'typescript', file));
    builder
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`leaf.ts`/baseController.', 'baseController', 13)
      .definition(1, 1, 1, 0, 0, 2, 2)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`composed.ts`/controller.', 'controller', 13)
      .definition(2, 2, 2, 1, 0, 1, 48)
      .write();
    const db = new ScipDatabase({
      projectRoot: tempDir,
      dbPath: join(tempDir, 'index.db'),
      indexPath: join(tempDir, 'index.scip'),
    });
    try {
      expect(resolveCallableExpression(db, 'src/route.ts', 'controller.dispatch')).toEqual([
        expect.objectContaining({
          leaf: 'dispatch',
          relativePath: 'src/leaf.ts',
          startLine: 1,
          symbol: expect.stringContaining('source-callable:'),
        }),
      ]);
    } finally {
      db.close();
    }
  });
});
