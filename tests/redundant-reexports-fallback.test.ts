import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../src/storage/db.js';
import { redundantReexports } from '../src/queries/cleanup/redundant-reexports.js';
import type { ScipQueryConfig } from '../src/domain/types.js';
import { evidenceFixtureDb, writeFixtureFiles } from './evidence-fixture.js';

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
      'src/analysis_status_exports.rs': [
        'pub use crate::analysis_status_core::normalize_status_label;',
        '',
      ],
    });

    evidenceFixtureDb(join(tempDir, 'index.db'))
      .document(1, 'rust', 'src/analysis_status_core.rs')
      .document(2, 'rust', 'src/analysis_status_exports.rs')
      .symbol(
        1,
        'scip-rust cargo fixture crate/src/analysis_status_core.rs/normalize_status_label().',
        'normalize_status_label',
        12,
      )
      .definition(1, 1, 1, 0, 0, 2, 1)
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
    expect(redundantReexports(db)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        barrelFile: 'src/analysis_status_exports.rs',
        originalFile: 'src/analysis_status_core.rs',
        symbol: expect.stringContaining('normalize_status_label'),
      }),
    ]));
  });
});
