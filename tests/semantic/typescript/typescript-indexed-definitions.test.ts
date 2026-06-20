import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { findIndexedDefinitionNear } from '../../../src/semantic/typescript/indexed-definitions.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';

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
    CREATE INDEX idx_defn_enclosing_ranges_symbol_id ON defn_enclosing_ranges(symbol_id);
  `);
}

function withDb(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-ts-defs-'));
  const projectRoot = join(tempDir, 'project');
  const dbPath = join(tempDir, 'index.db');

  try {
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'src', 'demo.ts'),
      [
        'export class ClassA {',
        '  run() { return 1; }',
        '}',
        '',
        'export class ClassB {',
        '  run() { return 2; }',
        '}',
        '',
        'export function fallbackSpecial() {',
        '  return 3;',
        '}',
        '',
      ].join('\n'),
    );

    const sqliteDb = new Database(dbPath);
    createSchema(sqliteDb);
    sqliteDb.exec(`
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'typescript', 'src/demo.ts');

      INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
        (1, 'scip-typescript npm fixture 1.0.0 src/\`demo.ts\`/ClassA#run().', 'run', 12, ''),
        (2, 'scip-typescript npm fixture 1.0.0 src/\`demo.ts\`/ClassB#run().', 'run', 12, ''),
        (3, 'scip-typescript npm fixture 1.0.0 src/\`demo.ts\`/fallbackSpecial().', 'fallbackSpecial', 12, '');

      INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
        (1, 1, 1, 1, 2, 1, 21),
        (2, 1, 2, 5, 2, 5, 21),
        (3, 1, 3, 8, 0, 10, 1);

      INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
        (1, 1, 0, 1, 1, X'00'),
        (2, 1, 1, 5, 5, X'00'),
        (3, 1, 2, 8, 10, X'00');
    `);
    sqliteDb.close();

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot,
    };
    const db = new ScipDatabase(config);
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('TypeScript indexed definition lookup', () => {
  it('uses cached leaf candidates and nearest start line for same-leaf methods', () => {
    withDb((db) => {
      const match = findIndexedDefinitionNear(db, 'src/demo.ts', 5, 'run');

      expect(match?.symbol).toBe('scip-typescript npm fixture 1.0.0 src/`demo.ts`/ClassB#run().');
    });
  });

  it('keeps substring fallback for non-exact symbol names', () => {
    withDb((db) => {
      const match = findIndexedDefinitionNear(db, 'src/demo.ts', 8, 'Special');

      expect(match?.symbol).toBe('scip-typescript npm fixture 1.0.0 src/`demo.ts`/fallbackSpecial().');
    });
  });
});
