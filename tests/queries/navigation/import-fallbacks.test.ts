import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { importedBy, imports } from '../../../src/queries/navigation/imports.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('import fallbacks', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-import-fallbacks-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    mkdirSync(join(projectRoot, 'lib'), { recursive: true });

    writeFixtureFiles(projectRoot, {
      'src/CompanionAdapter.java': ['package fixture;', 'public interface CompanionAdapter {}', ''],
      'src/RunCoordinator.java': [
        'package fixture;',
        'import fixture.CompanionAdapter;',
        'public final class RunCoordinator {',
        '  private final CompanionAdapter adapter;',
        '  public RunCoordinator(CompanionAdapter adapter) { this.adapter = adapter; }',
        '}',
        '',
      ],
      'lib/companion_adapter.rb': ['module Fixture', '  class CompanionAdapter', '  end', 'end', ''],
      'lib/fixture.rb': ['require_relative "companion_adapter"', '', 'module Fixture', 'end', ''],
    });

    evidenceFixtureDb(join(tempDir, 'index.db'))
      .document(1, 'java', 'src/CompanionAdapter.java')
      .document(2, 'java', 'src/RunCoordinator.java')
      .document(3, 'ruby', 'lib/companion_adapter.rb')
      .document(4, 'ruby', 'lib/fixture.rb')
      .symbol(1, 'scip-java maven . . fixture/CompanionAdapter#', 'CompanionAdapter', 5)
      .symbol(2, 'scip-ruby gem fixture . lib/companion_adapter.rb/Fixture/CompanionAdapter#', 'CompanionAdapter', 5)
      .definition(1, 1, 1, 1, 0, 1, 35)
      .definition(2, 3, 2, 1, 0, 2, 5)
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

  it('recovers java import edges from source when role=2 is missing', () => {
    expect(imports(db, 'src/RunCoordinator.java')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          shortName: 'CompanionAdapter',
          fromFile: 'src/CompanionAdapter.java',
        }),
      ]),
    );

    expect(importedBy(db, 'CompanionAdapter')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromFile: 'src/RunCoordinator.java',
        }),
      ]),
    );
  });

  it('treats require_relative as an importer of the loaded ruby file', () => {
    expect(imports(db, 'lib/fixture.rb')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromFile: 'lib/companion_adapter.rb',
        }),
      ]),
    );

    expect(importedBy(db, 'scip-ruby gem fixture . lib/companion_adapter.rb/Fixture/CompanionAdapter#')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromFile: 'lib/fixture.rb',
        }),
      ]),
    );
  });
});
