import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../src/domain/types.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { nearestSymbolNames, resolveSymbol } from '../../src/symbols/symbol-lookup.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('symbol resolution metadata', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('reports ambiguous same-leaf definitions and supports path qualification', () => {
    const db = createResolutionDb();
    try {
      const ambiguous = resolveSymbol(db, 'duplicateHelper');

      expect(ambiguous.match?.relativePath).toBe('src/a.ts');
      expect(ambiguous.total).toBe(2);
      expect(ambiguous.candidates).toEqual([
        expect.objectContaining({
          shortName: 'src:nested:b:duplicateHelper()',
          relativePath: 'src/nested/b.ts',
          startLine: 0,
        }),
      ]);
      expect(resolveSymbol(db, 'duplicateHelper')).toBe(ambiguous);

      const qualified = resolveSymbol(db, 'nested/duplicateHelper');

      expect(qualified).not.toBe(ambiguous);
      expect(qualified.match?.relativePath).toBe('src/nested/b.ts');
      expect(qualified.total).toBe(1);
      expect(qualified.candidates).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('suggests nearby symbol names for no-match lookups', () => {
    const db = createResolutionDb();
    try {
      expect(nearestSymbolNames(db, 'duplcateHelper', 3)).toContain('src:a:duplicateHelper()');
    } finally {
      db.close();
    }
  });

  it('prefers an exact callable leaf over same-prefix type declarations', () => {
    const db = createResolutionDb();
    try {
      const resolution = resolveSymbol(db, 'systemMap');

      expect(resolution.total).toBe(1);
      expect(resolution.match).toMatchObject({
        symbol: 'scip-typescript npm pkg 1.0.0 src/`a.ts`/systemMap().',
        relativePath: 'src/a.ts',
      });
      expect(resolveSymbol(db, 'SystemMapAnchorKind').match?.symbol).toContain('SystemMapAnchorKind#');
    } finally {
      db.close();
    }
  });

  function createResolutionDb(): ScipDatabase {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-symbol-resolution-'));
    mkdirSync(tempDir, { recursive: true });
    writeFixtureFiles(tempDir, {
      'src/a.ts': [
        'export function duplicateHelper() { return 1; }',
        'export function systemMap() { return true; }',
        "export type SystemMapAnchorKind = 'symbol';",
      ],
      'src/nested/b.ts': 'export function duplicateHelper() { return 2; }\n',
    });
    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/a.ts')
      .document(2, 'typescript', 'src/nested/b.ts')
      .symbol(1, 'scip-typescript npm pkg 1.0.0 src/`a.ts`/duplicateHelper().', 'duplicateHelper', 3)
      .symbol(2, 'scip-typescript npm pkg 1.0.0 src/nested/`b.ts`/duplicateHelper().', 'duplicateHelper', 3)
      .symbol(3, 'scip-typescript npm pkg 1.0.0 src/`a.ts`/systemMap().', null, 3)
      .symbol(4, 'scip-typescript npm pkg 1.0.0 src/`a.ts`/SystemMapAnchorKind#', 'SystemMapAnchorKind', 5)
      .definition(1, 1, 1, 0, 0, 0, 45)
      .definition(2, 2, 2, 0, 0, 0, 45)
      .definition(3, 1, 3, 1, 0, 1, 44)
      .definition(4, 1, 4, 2, 0, 2, 44)
      .chunk(1, 1, 0, 0)
      .chunk(2, 2, 0, 0)
      .chunk(3, 1, 1, 1)
      .chunk(4, 1, 2, 2)
      .mention(1, 1, 1)
      .mention(2, 2, 1)
      .mention(3, 3, 1)
      .mention(4, 4, 1)
      .write();
    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    };
    return new ScipDatabase(config);
  }
});
