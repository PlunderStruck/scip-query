import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { findFirstSymbolMatch } from '../../../src/symbols/symbol-lookup.js';
import { callGraph } from '../../../src/queries/navigation/call-graph.js';
import { code } from '../../../src/queries/navigation/code.js';
import { methods } from '../../../src/queries/navigation/methods.js';
import { symbols } from '../../../src/queries/navigation/symbols.js';
import { trace } from '../../../src/queries/navigation/trace.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';

function createFallbackFixtureProject(projectRoot: string): void {
  mkdirSync(join(projectRoot, 'src'), { recursive: true });

  writeFileSync(
    join(projectRoot, 'src', 'RunCoordinator.scala'),
    [
      'class RunCoordinator(adapter: CompanionAdapter, selector: CandidateSelector) {',
      '  def scanBoard(): Unit = selector.select(adapter.fetchBoardSnapshot(), adapter.fetchActiveSessions())',
      '',
      '  def recoverStaleRuns(): Unit = adapter.fetchActiveSessions()',
      '}',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(projectRoot, 'src', 'Adapter.scala'),
    [
      'trait CompanionAdapter {',
      '  def fetchBoardSnapshot(): String',
      '  def fetchActiveSessions(): List[String]',
      '}',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(projectRoot, 'src', 'Selector.scala'),
    ['class CandidateSelector {', '  def select(snapshot: String, sessions: List[String]): Unit = ()', '}', ''].join(
      '\n',
    ),
  );
}

function createFallbackFixtureDb(dbPath: string): void {
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
      (1, 'scala', 'src/RunCoordinator.scala'),
      (2, 'scala', 'src/Adapter.scala'),
      (3, 'scala', 'src/Selector.scala');
  `);

  const insertSymbol = sqliteDb.prepare(
    `INSERT INTO global_symbols (id, symbol, display_name, kind, documentation)
     VALUES (?, ?, ?, ?, ?)`,
  );

  insertSymbol.run(
    1,
    'semanticdb maven . . example/RunCoordinator#',
    'RunCoordinator',
    5,
    'class RunCoordinator|class RunCoordinator',
  );
  insertSymbol.run(
    2,
    'semanticdb maven . . example/RunCoordinator#scanBoard().',
    'scanBoard',
    12,
    'def scanBoard|def scanBoard(): Unit',
  );
  insertSymbol.run(
    3,
    'semanticdb maven . . example/RunCoordinator#recoverStaleRuns().',
    'recoverStaleRuns',
    12,
    'def recoverStaleRuns|def recoverStaleRuns(): Unit',
  );
  insertSymbol.run(
    4,
    'semanticdb maven . . example/CompanionAdapter#',
    'CompanionAdapter',
    5,
    'trait CompanionAdapter|trait CompanionAdapter',
  );
  insertSymbol.run(
    5,
    'semanticdb maven . . example/CompanionAdapter#fetchBoardSnapshot().',
    'fetchBoardSnapshot',
    12,
    'def fetchBoardSnapshot|def fetchBoardSnapshot(): String',
  );
  insertSymbol.run(
    6,
    'semanticdb maven . . example/CompanionAdapter#fetchActiveSessions().',
    'fetchActiveSessions',
    12,
    'def fetchActiveSessions|def fetchActiveSessions(): List[String]',
  );
  insertSymbol.run(
    7,
    'semanticdb maven . . example/CandidateSelector#',
    'CandidateSelector',
    5,
    'class CandidateSelector|class CandidateSelector',
  );
  insertSymbol.run(
    8,
    'semanticdb maven . . example/CandidateSelector#select().',
    'select',
    12,
    'def select|def select(snapshot: String, sessions: List[String]): Unit',
  );

  run(`
    INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
      (1, 1, 0, 0, 4, X'00'),
      (2, 1, 1, 1, 1, X'00'),
      (3, 1, 2, 3, 3, X'00'),
      (4, 2, 0, 0, 2, X'00'),
      (5, 2, 1, 1, 1, X'00'),
      (6, 2, 2, 2, 2, X'00'),
      (7, 3, 0, 0, 1, X'00'),
      (8, 3, 1, 1, 1, X'00');
  `);

  run(`
    INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
      (1, 1, 1),
      (2, 2, 1),
      (2, 5, 0),
      (2, 6, 0),
      (2, 8, 0),
      (3, 3, 1),
      (3, 6, 0),
      (4, 4, 1),
      (5, 5, 1),
      (6, 6, 1),
      (7, 7, 1),
      (8, 8, 1);
  `);

  sqliteDb.close();
}

describe('definition fallback', () => {
  let tempDir: string;
  let projectRoot: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-fallback-'));
    projectRoot = join(tempDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    createFallbackFixtureProject(projectRoot);
    const dbPath = join(tempDir, 'index.db');
    createFallbackFixtureDb(dbPath);
    const config: ScipQueryConfig = { projectRoot, dbPath };
    db = new ScipDatabase(config);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves symbols and code when definition ranges are missing', () => {
    const match = findFirstSymbolMatch(db, 'scanBoard');
    expect(match?.relativePath).toBe('src/RunCoordinator.scala');
    expect(match?.startLine).toBe(1);
    expect(match?.endLine).toBe(1);

    const symbolRows = symbols(db, 'src/RunCoordinator.scala');
    expect(symbolRows.map((row) => row.shortName)).toEqual(
      expect.arrayContaining([
        'example:RunCoordinator',
        'example:RunCoordinator:scanBoard()',
        'example:RunCoordinator:recoverStaleRuns()',
      ]),
    );

    const snippet = code(db, 'scanBoard');
    expect(snippet?.source).toContain('selector.select');
    expect(snippet?.source).toContain('fetchBoardSnapshot');
  });

  it('recovers methods, trace, and call graph from definition mentions', () => {
    const methodRows = methods(db, 'RunCoordinator');
    expect(methodRows.map((row) => row.name)).toEqual(expect.arrayContaining(['scanBoard', 'recoverStaleRuns']));

    const traced = trace(db, 'scanBoard');
    expect(traced.definitions).toHaveLength(1);
    expect(traced.definitions[0]?.relativePath).toBe('src/RunCoordinator.scala');

    const graph = callGraph(db, 'scanBoard');
    expect(graph).not.toBeNull();
    expect(graph?.callees.map((row) => row.shortName)).toEqual(
      expect.arrayContaining([
        'example:CompanionAdapter:fetchBoardSnapshot()',
        'example:CompanionAdapter:fetchActiveSessions()',
        'example:CandidateSelector:select()',
      ]),
    );
  });
});
