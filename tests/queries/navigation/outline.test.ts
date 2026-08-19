import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { outline } from '../../../src/queries/navigation/outline.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('outline file resolution', () => {
  let projectRoot: string | null = null;

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  });

  it('refuses an ambiguous basename instead of merging unrelated file trees', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-outline-resolution-'));
    writeFixtureFiles(projectRoot, {
      'src/one/identity.ts': 'export function firstIdentity() { return 1; }\n',
      'src/two/identity.ts': 'export function secondIdentity() { return 2; }\n',
      'src/only/unique.ts': 'export function uniqueIdentity() { return 3; }\n',
      'src/range.ts': 'export const first = 1;\nexport const second = 2;\n',
    });
    const dbPath = join(projectRoot, 'index.db');
    const firstModule = 'scip-typescript npm fixture 1.0.0 src/one/`identity.ts`/';
    const secondModule = 'scip-typescript npm fixture 1.0.0 src/two/`identity.ts`/';
    const uniqueModule = 'scip-typescript npm fixture 1.0.0 src/only/`unique.ts`/';
    const rangeModule = 'scip-typescript npm fixture 1.0.0 src/`range.ts`/';
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/one/identity.ts')
      .document(2, 'typescript', 'src/two/identity.ts')
      .document(3, 'typescript', 'src/only/unique.ts')
      .document(4, 'typescript', 'src/range.ts')
      .symbol(1, firstModule, 'identity.ts', 2)
      .symbol(2, `${firstModule}firstIdentity().`, 'firstIdentity', 12)
      .symbol(3, secondModule, 'identity.ts', 2)
      .symbol(4, `${secondModule}secondIdentity().`, 'secondIdentity', 12)
      .symbol(5, uniqueModule, 'unique.ts', 2)
      .symbol(6, `${uniqueModule}uniqueIdentity().`, 'uniqueIdentity', 12)
      .symbol(7, rangeModule, 'range.ts', 2)
      .definition(1, 1, 1, 0, 0, 0, 48)
      .definition(2, 1, 2, 0, 0, 0, 48)
      .definition(3, 2, 3, 0, 0, 0, 49)
      .definition(4, 2, 4, 0, 0, 0, 49)
      .definition(5, 3, 5, 0, 0, 0, 49)
      .definition(6, 3, 6, 0, 0, 0, 49)
      .definition(7, 4, 7, 0, 0, 2, 0)
      .write();
    const db = new ScipDatabase({ dbPath, indexPath: join(projectRoot, 'index.scip'), projectRoot });

    try {
      expect(outline(db, 'identity.ts')).toEqual([]);
      expect(outline(db, 'src/totally/made/up/identity.ts')).toEqual([]);
      expect(outline(db, 'src/totally/made/up/unique.ts')).toEqual([]);
      expect(outline(db, 'src/two/identity.ts').map((node) => node.symbol)).toEqual([secondModule]);
      expect(outline(db, 'src/range.ts')).toEqual([
        expect.objectContaining({ symbol: rangeModule, startLine: 0, endLine: 1 }),
      ]);
    } finally {
      db.close();
    }
  });
});
