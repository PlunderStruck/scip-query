import Database from 'better-sqlite3';
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
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../src/db.js';
import { importedBy, imports } from '../src/queries/imports.js';
import type { ScipQueryConfig } from '../src/types.js';

function createSchema(sqliteDb: Database.Database): void {
  sqliteDb.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      language TEXT,
      relative_path TEXT NOT NULL UNIQUE,
      position_encoding TEXT,
      text TEXT
    );
    CREATE TABLE global_symbols (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      display_name TEXT,
      kind INTEGER,
      documentation TEXT,
      signature BLOB,
      enclosing_symbol TEXT,
      relationships BLOB
    );
    CREATE TABLE defn_enclosing_ranges (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      start_char INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_char INTEGER NOT NULL
    );
    CREATE TABLE mentions (
      chunk_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      role INTEGER NOT NULL,
      PRIMARY KEY (chunk_id, symbol_id, role)
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      occurrences BLOB NOT NULL
    );
    CREATE INDEX idx_mentions_symbol_id_role ON mentions(symbol_id, role);
    CREATE INDEX idx_chunks_doc_id ON chunks(document_id);
    CREATE INDEX idx_global_symbols_symbol ON global_symbols(symbol);
  `);
}

describe('import fallbacks', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-import-fallbacks-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    mkdirSync(join(projectRoot, 'lib'), { recursive: true });

    writeFileSync(
      join(projectRoot, 'src', 'CompanionAdapter.java'),
      [
        'package fixture;',
        'public interface CompanionAdapter {}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'src', 'RunCoordinator.java'),
      [
        'package fixture;',
        'import fixture.CompanionAdapter;',
        'public final class RunCoordinator {',
        '  private final CompanionAdapter adapter;',
        '  public RunCoordinator(CompanionAdapter adapter) { this.adapter = adapter; }',
        '}',
        '',
      ].join('\n'),
    );

    writeFileSync(
      join(projectRoot, 'lib', 'companion_adapter.rb'),
      [
        'module Fixture',
        '  class CompanionAdapter',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'lib', 'fixture.rb'),
      [
        'require_relative "companion_adapter"',
        '',
        'module Fixture',
        'end',
        '',
      ].join('\n'),
    );

    const sqliteDb = new Database(join(tempDir, 'index.db'));
    createSchema(sqliteDb);
    sqliteDb.exec(`
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'java', 'src/CompanionAdapter.java'),
        (2, 'java', 'src/RunCoordinator.java'),
        (3, 'ruby', 'lib/companion_adapter.rb'),
        (4, 'ruby', 'lib/fixture.rb');
      INSERT INTO global_symbols (id, symbol, display_name, kind) VALUES
        (1, 'scip-java maven . . fixture/CompanionAdapter#', 'CompanionAdapter', 5),
        (2, 'scip-ruby gem fixture . lib/companion_adapter.rb/Fixture/CompanionAdapter#', 'CompanionAdapter', 5);
      INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
        (1, 1, 1, 1, 0, 1, 35),
        (2, 3, 2, 1, 0, 2, 5);
    `);
    sqliteDb.close();

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
    expect(imports(db, 'src/RunCoordinator.java')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        shortName: 'CompanionAdapter',
        fromFile: 'src/CompanionAdapter.java',
      }),
    ]));

    expect(importedBy(db, 'CompanionAdapter')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromFile: 'src/RunCoordinator.java',
      }),
    ]));
  });

  it('treats require_relative as an importer of the loaded ruby file', () => {
    expect(imports(db, 'lib/fixture.rb')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromFile: 'lib/companion_adapter.rb',
      }),
    ]));

    expect(importedBy(db, 'scip-ruby gem fixture . lib/companion_adapter.rb/Fixture/CompanionAdapter#')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromFile: 'lib/fixture.rb',
      }),
    ]));
  });
});
