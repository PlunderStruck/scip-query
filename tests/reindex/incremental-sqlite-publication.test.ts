import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { readDocumentFactDigests } from '../../src/reindex/affected-shadow.js';
import { patchIncrementalSqliteGeneration } from '../../src/reindex/incremental-sqlite-publication.js';

describe('incremental SQLite publication', () => {
  test('replaces affected rows while preserving rich metadata owned by unaffected documents', () => {
    const paths = fixturePaths();
    createDatabase(paths.previous, populatePrevious);
    createDatabase(paths.mini, populateMini);
    createDatabase(paths.expected, populateExpected);

    const result = patchIncrementalSqliteGeneration({
      previousDbPath: paths.previous,
      miniDbPath: paths.mini,
      candidateDbPath: paths.candidate,
      affectedFiles: ['src/a.ts'],
    });

    expect(result.affectedDocumentCount).toBe(1);
    expect(result.changedDocumentPaths).toEqual(['src/a.ts']);
    expect(existsSync(paths.candidate)).toBe(true);
    expect(readFacts(paths.candidate)).toEqual(readFacts(paths.expected));

    const candidate = new Database(paths.candidate, { readonly: true });
    const symbols = candidate
      .prepare('SELECT symbol, display_name, documentation FROM global_symbols ORDER BY symbol')
      .all();
    candidate.close();
    expect(symbols).toEqual([
      { symbol: 'symbol/B', display_name: 'B', documentation: 'unaffected B documentation' },
      { symbol: 'symbol/C', display_name: 'C', documentation: 'new C documentation' },
    ]);
  });

  test('rolls back an injected mid-transaction failure and never changes the accepted database', () => {
    const paths = fixturePaths();
    createDatabase(paths.previous, populatePrevious);
    createDatabase(paths.mini, populateMini);
    const before = readFileSync(paths.previous);

    expect(() =>
      patchIncrementalSqliteGeneration({
        previousDbPath: paths.previous,
        miniDbPath: paths.mini,
        candidateDbPath: paths.candidate,
        affectedFiles: ['src/a.ts'],
        onStage: (stage) => {
          if (stage === 'after-delete') throw new Error('injected failure');
        },
      }),
    ).toThrow('injected failure');

    expect(existsSync(paths.candidate)).toBe(false);
    expect(readFileSync(paths.previous)).toEqual(before);
    expect(readFacts(paths.previous).get('src/a.ts')).toBeDefined();
  });

  test('inserts a newly affected document that was absent from the previous generation', () => {
    const paths = fixturePaths();
    createDatabase(paths.previous, populatePrevious);
    createDatabase(paths.mini, (db) => {
      insertDocument(db, 1, 'src/c.ts', 'new c', 'new-c');
      insertSymbol(db, 1, 'symbol/C', 'C', 'new C documentation');
      insertDefinition(db, 1, 1, 1);
    });

    const result = patchIncrementalSqliteGeneration({
      previousDbPath: paths.previous,
      miniDbPath: paths.mini,
      candidateDbPath: paths.candidate,
      affectedFiles: ['src/c.ts'],
    });

    expect(result.affectedDocumentCount).toBe(1);
    expect(result.changedDocumentPaths).toEqual(['src/c.ts']);
    const candidate = new Database(paths.candidate, { readonly: true });
    const pathsInDb = candidate.prepare('SELECT relative_path FROM documents ORDER BY relative_path').all();
    const symbols = candidate.prepare('SELECT symbol FROM global_symbols ORDER BY symbol').all();
    candidate.close();
    expect(pathsInDb).toEqual([{ relative_path: 'src/a.ts' }, { relative_path: 'src/b.ts' }, { relative_path: 'src/c.ts' }]);
    expect(symbols).toEqual([{ symbol: 'symbol/A' }, { symbol: 'symbol/B' }, { symbol: 'symbol/C' }]);
  });

  test('rejects omitted affected documents, schema drift, corrupt input, and shared definitions', () => {
    const omitted = fixturePaths();
    createDatabase(omitted.previous, populatePrevious);
    createDatabase(omitted.mini, populateMini);
    expect(() =>
      patchIncrementalSqliteGeneration({
        previousDbPath: omitted.previous,
        miniDbPath: omitted.mini,
        candidateDbPath: omitted.candidate,
        affectedFiles: ['src/a.ts', 'src/missing.ts'],
      }),
    ).toThrow('does not exactly match');
    expect(existsSync(omitted.candidate)).toBe(false);

    const drift = fixturePaths();
    createDatabase(drift.previous, populatePrevious);
    createDatabase(drift.mini, populateMini);
    const driftDb = new Database(drift.mini);
    driftDb.exec('DROP INDEX idx_chunks_line_range');
    driftDb.close();
    expect(() =>
      patchIncrementalSqliteGeneration({
        previousDbPath: drift.previous,
        miniDbPath: drift.mini,
        candidateDbPath: drift.candidate,
        affectedFiles: ['src/a.ts'],
      }),
    ).toThrow('schema changed for index idx_chunks_line_range');
    expect(existsSync(drift.candidate)).toBe(false);

    const corrupt = fixturePaths();
    createDatabase(corrupt.previous, populatePrevious);
    writeFileSync(corrupt.mini, 'not a SQLite database');
    expect(() =>
      patchIncrementalSqliteGeneration({
        previousDbPath: corrupt.previous,
        miniDbPath: corrupt.mini,
        candidateDbPath: corrupt.candidate,
        affectedFiles: ['src/a.ts'],
      }),
    ).toThrow();
    expect(existsSync(corrupt.candidate)).toBe(false);

    const shared = fixturePaths();
    createDatabase(shared.previous, (db) => populatePrevious(db, true));
    createDatabase(shared.mini, populateMini);
    expect(() =>
      patchIncrementalSqliteGeneration({
        previousDbPath: shared.previous,
        miniDbPath: shared.mini,
        candidateDbPath: shared.candidate,
        affectedFiles: ['src/a.ts'],
      }),
    ).toThrow('shared by affected and unaffected documents');
    expect(existsSync(shared.candidate)).toBe(false);
  });
});

function fixturePaths(): {
  previous: string;
  mini: string;
  candidate: string;
  expected: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-sqlite-publication-'));
  return {
    previous: join(root, 'previous.db'),
    mini: join(root, 'mini.db'),
    candidate: join(root, 'candidate.db'),
    expected: join(root, 'expected.db'),
  };
}

function createDatabase(path: string, populate: (db: Database.Database) => void): void {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      language TEXT,
      relative_path TEXT NOT NULL UNIQUE,
      position_encoding TEXT,
      text TEXT
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      occurrences BLOB NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id)
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
    CREATE TABLE mentions (
      chunk_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      role INTEGER NOT NULL,
      PRIMARY KEY (chunk_id, symbol_id, role),
      FOREIGN KEY (chunk_id) REFERENCES chunks(id),
      FOREIGN KEY (symbol_id) REFERENCES global_symbols(id)
    );
    CREATE TABLE defn_enclosing_ranges (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      start_char INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_char INTEGER NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id),
      FOREIGN KEY (symbol_id) REFERENCES global_symbols(id)
    );
    CREATE INDEX idx_chunks_doc_id ON chunks(document_id);
    CREATE INDEX idx_chunks_line_range ON chunks(document_id, start_line, end_line);
    CREATE INDEX idx_defn_enclosing_ranges_document
      ON defn_enclosing_ranges(document_id, start_line, end_line);
    CREATE INDEX idx_defn_enclosing_ranges_symbol_id ON defn_enclosing_ranges(symbol_id);
    CREATE INDEX idx_global_symbols_symbol ON global_symbols(symbol);
    CREATE INDEX idx_mentions_symbol_id_role ON mentions(symbol_id, role);
  `);
  populate(db);
  db.close();
}

function populatePrevious(db: Database.Database, sharedDefinition = false): void {
  insertDocument(db, 1, 'src/a.ts', 'old a', 'old-a');
  insertDocument(db, 2, 'src/b.ts', 'stable b', 'stable-b');
  insertSymbol(db, 1, 'symbol/A', 'A', 'old A documentation');
  insertSymbol(db, 2, 'symbol/B', 'B', 'unaffected B documentation');
  insertSymbol(db, 3, 'symbol/stale-orphan', null, null);
  insertDefinition(db, 1, 1, 1);
  insertDefinition(db, 2, 2, 2);
  if (sharedDefinition) insertDefinition(db, 3, 2, 1);
}

function populateMini(db: Database.Database): void {
  insertDocument(db, 1, 'src/a.ts', 'new a', 'new-a');
  insertSymbol(db, 1, 'symbol/B', null, null);
  insertSymbol(db, 2, 'symbol/C', 'C', 'new C documentation');
  db.prepare('INSERT INTO mentions(chunk_id, symbol_id, role) VALUES (1, 1, 0)').run();
  insertDefinition(db, 1, 1, 2);
}

function populateExpected(db: Database.Database): void {
  insertDocument(db, 1, 'src/a.ts', 'new a', 'new-a');
  insertDocument(db, 2, 'src/b.ts', 'stable b', 'stable-b');
  insertSymbol(db, 1, 'symbol/B', 'B', 'unaffected B documentation');
  insertSymbol(db, 2, 'symbol/C', 'C', 'new C documentation');
  db.prepare('INSERT INTO mentions(chunk_id, symbol_id, role) VALUES (1, 1, 0)').run();
  insertDefinition(db, 1, 1, 2);
  insertDefinition(db, 2, 2, 1);
}

function insertDocument(
  db: Database.Database,
  id: number,
  relativePath: string,
  text: string,
  occurrences: string,
): void {
  db.prepare(
    `INSERT INTO documents(id, language, relative_path, position_encoding, text)
     VALUES (?, 'typescript', ?, 'UTF8', ?)`,
  ).run(id, relativePath, text);
  db.prepare(
    `INSERT INTO chunks(id, document_id, chunk_index, start_line, end_line, occurrences)
     VALUES (?, ?, 0, 0, 1, ?)`,
  ).run(id, id, Buffer.from(occurrences));
}

function insertSymbol(
  db: Database.Database,
  id: number,
  symbol: string,
  displayName: string | null,
  documentation: string | null,
): void {
  db.prepare(
    `INSERT INTO global_symbols(
       id, symbol, display_name, kind, documentation, signature, enclosing_symbol, relationships
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    symbol,
    displayName,
    displayName === null ? null : 13,
    documentation,
    displayName === null ? null : Buffer.from(`signature:${symbol}`),
    displayName === null ? null : 'enclosing',
    displayName === null ? null : Buffer.from(`relationships:${symbol}`),
  );
}

function insertDefinition(db: Database.Database, id: number, documentId: number, symbolId: number): void {
  db.prepare('INSERT INTO mentions(chunk_id, symbol_id, role) VALUES (?, ?, 1)').run(documentId, symbolId);
  db.prepare(
    `INSERT INTO defn_enclosing_ranges(
       id, document_id, symbol_id, start_line, start_char, end_line, end_char
     ) VALUES (?, ?, ?, 0, 0, 0, 1)`,
  ).run(id, documentId, symbolId);
}

function readFacts(path: string): Map<string, string> {
  const db = new Database(path, { readonly: true });
  try {
    return readDocumentFactDigests({
      all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[],
    });
  } finally {
    db.close();
  }
}
