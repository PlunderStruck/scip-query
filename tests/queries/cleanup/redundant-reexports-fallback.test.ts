import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { redundantReexports } from '../../../src/queries/cleanup/redundant-reexports.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('redundant re-export fallbacks', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-reexport-fallbacks-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });

    writeFixtureFiles(projectRoot, {
      'src/analysis_status_core.rs': [
        'pub fn normalize_status_label(raw_status: &str) -> String {',
        '    raw_status.trim().to_lowercase()',
        '}',
        '',
      ],
      'src/analysis_status_exports.rs': ['pub use crate::analysis_status_core::normalize_status_label;', ''],
      'src/public-api.ts': ["export { publicUtility } from './public-utility.ts';", ''],
      'src/public-utility.ts': ['export function publicUtility(): string {', "  return 'ok';", '}', ''],
      'src/public-consumer.ts': ["import { publicUtility } from './public-utility.js';", 'publicUtility();', ''],
      'src/named-api.ts': ["export { secondUtility } from './multi.ts';", ''],
      'src/multi.ts': [
        "export function firstUtility(): string { return 'first'; }",
        "export function secondUtility(): string { return 'second'; }",
        '',
      ],
      'src/index.ts': ["import { boot } from './boot.js';", '', 'boot();', ''],
      'src/boot.ts': ['export function boot(): void {', '  // startup work', '}', ''],
      'src/unused/index.ts': ["export { orphaned } from './source.js';", ''],
      'src/unused/source.ts': ['export function orphaned(): void {', '  // intentionally unused', '}', ''],
    });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        exports: {
          './public-api': './src/public-api.ts',
        },
      }),
    );

    evidenceFixtureDb(join(tempDir, 'index.db'))
      .document(1, 'rust', 'src/analysis_status_core.rs')
      .document(2, 'rust', 'src/analysis_status_exports.rs')
      .document(3, 'typescript', 'src/index.ts')
      .document(4, 'typescript', 'src/boot.ts')
      .document(5, 'typescript', 'src/public-api.ts')
      .document(6, 'typescript', 'src/public-utility.ts')
      .document(7, 'typescript', 'src/named-api.ts')
      .document(8, 'typescript', 'src/multi.ts')
      .document(9, 'typescript', 'src/public-consumer.ts')
      .document(10, 'typescript', 'src/unused/index.ts')
      .document(11, 'typescript', 'src/unused/source.ts')
      .symbol(
        1,
        'scip-rust cargo fixture crate/src/analysis_status_core.rs/normalize_status_label().',
        'normalize_status_label',
        12,
      )
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`boot.ts`/boot().', 'boot', 12)
      .symbol(3, 'scip-typescript npm fixture 1.0.0 src/`public-utility.ts`/publicUtility().', 'publicUtility', 12)
      .symbol(4, 'scip-typescript npm fixture 1.0.0 src/`multi.ts`/firstUtility().', 'firstUtility', 12)
      .symbol(5, 'scip-typescript npm fixture 1.0.0 src/`multi.ts`/secondUtility().', 'secondUtility', 12)
      .symbol(6, 'scip-typescript npm fixture 1.0.0 src/unused/`source.ts`/orphaned().', 'orphaned', 12)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 4, 2, 0, 0, 2, 1)
      .definition(3, 6, 3, 0, 0, 2, 1)
      .definition(4, 8, 4, 0, 0, 0, 1)
      .definition(5, 8, 5, 1, 0, 1, 1)
      .definition(6, 11, 6, 0, 0, 2, 1)
      .chunk(1, 3, 0, 3)
      .mention(1, 2, 8)
      .chunk(2, 10, 0, 0)
      .mention(2, 6, 8)
      .chunk(3, 11, 0, 2)
      .mention(3, 6, 1)
      .write();

    const config: ScipQueryConfig = {
      dbPath: join(tempDir, 'index.db'),
      indexPath: join(tempDir, 'index.scip'),
      projectRoot,
    };
    db = new ScipDatabase(config);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports unused Rust pub use barrels from source exports', () => {
    expect(redundantReexports(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          barrelFile: 'src/analysis_status_exports.rs',
          originalFile: 'src/analysis_status_core.rs',
          symbol: expect.stringContaining('normalize_status_label'),
          actionTier: 'direct',
          surfaceEvidence: [],
        }),
      ]),
    );
  });

  it('downgrades package-public barrels to signal rows', () => {
    expect(redundantReexports(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          barrelFile: 'src/public-api.ts',
          originalFile: 'src/public-utility.ts',
          shortName: 'src:public-utility:publicUtility()',
          directConsumers: 1,
          actionTier: 'signal',
          surfaceEvidence: expect.arrayContaining([
            expect.stringContaining('barrel file is declared on the package public surface'),
          ]),
          recommendation: expect.stringContaining('Review the package API before removing this re-export'),
        }),
      ]),
    );
  });

  it('does not treat an executable index file as a redundant re-export barrel', () => {
    expect(redundantReexports(db)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          barrelFile: 'src/index.ts',
          originalFile: 'src/boot.ts',
        }),
      ]),
    );
  });

  it('attributes named source re-exports to the exported binding instead of an arbitrary module member', () => {
    const rows = redundantReexports(db).filter((row) => row.barrelFile === 'src/named-api.ts');
    expect(rows).toEqual([
      expect.objectContaining({
        shortName: 'src:multi:secondUtility()',
        originalFile: 'src/multi.ts',
      }),
    ]);
  });

  it('starts SCIP re-export discovery from the scoped barrel references', () => {
    expect(redundantReexports(db, { scope: 'src/unused' })).toEqual([
      expect.objectContaining({
        barrelFile: 'src/unused/index.ts',
        originalFile: 'src/unused/source.ts',
        shortName: 'src:unused:source:orphaned()',
        barrelConsumers: 0,
        directConsumers: 0,
      }),
    ]);
  });
});
