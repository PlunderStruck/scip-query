import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productionCallableDefinitions } from '../../../src/core/production-callables.js';
import { unusedParams } from '../../../src/queries/cleanup/unused-params.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('unused params', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-unused-params-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'src/changed.ts': ['export function changed(used: string, unused: string) {', '  return used;', '}'],
      'src/other.ts': ['export function other(used: string, unused: string) {', '  return used;', '}'],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/changed.ts')
      .document(2, 'typescript', 'src/other.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`changed.ts`/changed().', 'changed', 12)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`other.ts`/other().', 'other', 12)
      .symbol(3, 'scip-typescript npm fixture 1.0.0 src/`changed.ts`/ChangedType#', 'ChangedType', 5)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 2, 1)
      .definition(3, 1, 3, 0, 0, 0, 1)
      .chunk(1, 1, 0, 2)
      .chunk(2, 2, 0, 2)
      .mention(1, 1, 1)
      .mention(2, 2, 1)
      .mention(1, 3, 1)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads production callables from requested files only', () => {
    const callables = productionCallableDefinitions(db, {
      files: ['src/changed.ts'],
      minLoc: 2,
      requireFunctionLikeSymbol: true,
    });

    expect(callables.map((row) => row.relativePath)).toEqual(['src/changed.ts']);
  });

  it('loads callable-mode production candidates without type definitions', () => {
    const callables = productionCallableDefinitions(db, {
      requireCallableSymbol: true,
      includeSuppressed: true,
    });

    expect(callables.map((row) => row.symbol)).toEqual([
      'scip-typescript npm fixture 1.0.0 src/`changed.ts`/changed().',
      'scip-typescript npm fixture 1.0.0 src/`other.ts`/other().',
    ]);
  });

  it('honors file-scoped unused parameter checks', () => {
    const findings = unusedParams(db, { files: ['src/changed.ts'], limit: 50 });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      shortName: 'src:changed:changed()',
      file: 'src/changed.ts',
      unusedTrailing: ['unused'],
    });
  });
});
