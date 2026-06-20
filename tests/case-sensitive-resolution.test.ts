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
import { ScipDatabase } from '../src/storage/db.js';
import { findFirstSymbolMatch } from '../src/symbols/symbol-lookup.js';
import { refs } from '../src/queries/navigation/refs.js';
import type { ScipQueryConfig } from '../src/domain/types.js';

function createCaseFixtureProject(projectRoot: string): void {
  mkdirSync(join(projectRoot, 'lib', 'src'), { recursive: true });

  writeFileSync(
    join(projectRoot, 'lib', 'src', 'run_store.dart'),
    [
      'abstract class RunStore {',
      '  List<String> openRecords();',
      '}',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(projectRoot, 'lib', 'src', 'proof.dart'),
    [
      'class ProofCollector {',
      '  String collect() => "proof";',
      '}',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(projectRoot, 'lib', 'src', 'coordinator.dart'),
    [
      'class RunCoordinator {',
      '  final RunStore runStore;',
      '  final ProofCollector proofCollector;',
      '',
      '  RunCoordinator(this.runStore, this.proofCollector);',
      '}',
      '',
    ].join('\n'),
  );
}

function createCaseFixtureDb(dbPath: string): void {
  const sqliteDb = new Database(dbPath);
  const run = (sql: string) => sqliteDb.exec(sql);

  run(`
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

  run(`
    INSERT INTO documents (id, language, relative_path) VALUES
      (1, 'dart', 'lib/src/run_store.dart'),
      (2, 'dart', 'lib/src/proof.dart'),
      (3, 'dart', 'lib/src/coordinator.dart');
  `);

  const insertSymbol = sqliteDb.prepare(
    `INSERT INTO global_symbols (id, symbol, display_name, kind)
     VALUES (?, ?, ?, ?)`,
  );

  insertSymbol.run(1, 'scip-dart pub fixture . lib/src/`run_store.dart`/RunStore#', 'RunStore', 5);
  insertSymbol.run(2, 'scip-dart pub fixture . lib/src/`proof.dart`/ProofCollector#', 'ProofCollector', 5);
  insertSymbol.run(3, 'scip-dart pub fixture . lib/src/`coordinator.dart`/RunCoordinator#', 'RunCoordinator', 5);
  insertSymbol.run(4, 'scip-dart pub fixture . lib/src/`coordinator.dart`/RunCoordinator#runStore.', 'runStore', 8);
  insertSymbol.run(5, 'scip-dart pub fixture . lib/src/`coordinator.dart`/RunCoordinator#proofCollector.', 'proofCollector', 8);

  run(`
    INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
      (1, 1, 1, 0, 0, 2, 1),
      (2, 2, 2, 0, 0, 2, 1),
      (3, 3, 3, 0, 0, 5, 1),
      (4, 3, 4, 1, 2, 1, 26),
      (5, 3, 5, 2, 2, 2, 38);
  `);

  run(`
    INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
      (1, 1, 0, 0, 2, X'00'),
      (2, 2, 0, 0, 2, X'00'),
      (3, 3, 0, 0, 0, X'00'),
      (4, 3, 1, 1, 1, X'00'),
      (5, 3, 2, 2, 2, X'00'),
      (6, 3, 3, 4, 4, X'00');
  `);

  run(`
    INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
      (1, 1, 1),
      (2, 2, 1),
      (3, 3, 1),
      (4, 1, 0),
      (4, 4, 1),
      (5, 2, 0),
      (5, 5, 1),
      (6, 4, 0),
      (6, 5, 0);
  `);

  sqliteDb.close();
}

describe('case-sensitive symbol resolution', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-case-resolution-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    createCaseFixtureProject(projectRoot);

    const dbPath = join(tempDir, 'index.db');
    createCaseFixtureDb(dbPath);

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot,
    };
    db = new ScipDatabase(config);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('prefers exact-case type symbols over similarly named members', () => {
    expect(findFirstSymbolMatch(db, 'RunStore')?.symbol).toBe('scip-dart pub fixture . lib/src/`run_store.dart`/RunStore#');
    expect(findFirstSymbolMatch(db, 'ProofCollector')?.symbol).toBe('scip-dart pub fixture . lib/src/`proof.dart`/ProofCollector#');
    expect(findFirstSymbolMatch(db, 'runStore')?.symbol).toBe('scip-dart pub fixture . lib/src/`coordinator.dart`/RunCoordinator#runStore.');
    expect(findFirstSymbolMatch(db, 'proofCollector')?.symbol).toBe('scip-dart pub fixture . lib/src/`coordinator.dart`/RunCoordinator#proofCollector.');
  });

  it('keeps refs aligned with the resolved symbol intent', () => {
    expect(refs(db, 'RunStore')).toEqual(expect.arrayContaining([
      { relativePath: 'lib/src/run_store.dart', line: 0 },
      { relativePath: 'lib/src/coordinator.dart', line: 1 },
    ]));

    expect(refs(db, 'ProofCollector')).toEqual(expect.arrayContaining([
      { relativePath: 'lib/src/proof.dart', line: 0 },
      { relativePath: 'lib/src/coordinator.dart', line: 2 },
    ]));
  });
});
