import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { resolveIndexedPaths } from '../../../src/queries/internal/file-resolution.js';
import { findFirstSymbolMatch } from '../../../src/symbols/symbol-lookup.js';

function withPathFixture(run: (db: ScipDatabase, root: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-path-resolver-'));
  const dbPath = join(tempDir, 'index.db');
  const sqliteDb = new Database(dbPath);
  let sqliteClosed = false;

  try {
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
        INSERT INTO documents (id, language, relative_path) VALUES
          (1, 'typescript', 'backend/src/routes/horses.ts'),
          (2, 'typescript', 'backend/src/routes/onboarding/horses.ts'),
          (3, 'typescript', 'shared/src/contracts/horses.ts');
        INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
          (1, 'scip-typescript npm fixture 1.0.0 src/agents().', 'AGENTS.md', 12, 'AGENTS.md setup helper');
        INSERT INTO defn_enclosing_ranges
          (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
          (1, 1, 1, 0, 0, 0, 1);
      `);
    sqliteDb.close();
    sqliteClosed = true;

    const db = new ScipDatabase({
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    });
    try {
      run(db, tempDir);
    } finally {
      db.close();
    }
  } finally {
    if (!sqliteClosed) sqliteDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('path resolver', () => {
  it('expands an exact directory without treating it as an exact file or broad substring', () => {
    withPathFixture((db, root) => {
      mkdirSync(join(root, 'backend/src/routes'), { recursive: true });
      const expected = ['backend/src/routes/horses.ts', 'backend/src/routes/onboarding/horses.ts'];
      for (const path of ['backend/src/routes', './backend/src/routes/', join(root, 'backend/src/routes')]) {
        expect(resolveIndexedPaths(db, path)).toEqual(expected);
      }
      expect(resolveIndexedPaths(db, 'missing/src/routes')).toEqual([]);
      expect(resolveIndexedPaths(db, 'backend/src/routes/horses.ts')).toEqual([expected[0]]);
    });
  });
  it('keeps full path matches from broadening to same-basename files', () => {
    withPathFixture((db) => {
      expect(resolveIndexedPaths(db, 'shared/src/contracts/horses.ts')).toEqual(['shared/src/contracts/horses.ts']);
      expect(resolveIndexedPaths(db, 'backend/src/routes/horses.ts')).toEqual(['backend/src/routes/horses.ts']);
    });
  });

  it('still supports broad basename matches when the user only gives a basename', () => {
    withPathFixture((db) => {
      expect(resolveIndexedPaths(db, 'horses.ts')).toEqual([
        'backend/src/routes/horses.ts',
        'backend/src/routes/onboarding/horses.ts',
        'shared/src/contracts/horses.ts',
      ]);
    });
  });

  it('never treats a nonexistent path as a basename search', () => {
    withPathFixture((db) => {
      expect(resolveIndexedPaths(db, 'src/totally/made/up/horses.ts')).toEqual([]);
    });
  });

  it('does not reinterpret an exact unindexed disk path as a fuzzy symbol', () => {
    withPathFixture((db, root) => {
      writeFileSync(join(root, 'AGENTS.md'), '# Repository instructions\n');
      expect(findFirstSymbolMatch(db, 'AGENTS.md')?.relativePath).toBe('backend/src/routes/horses.ts');
      expect(resolveIndexedPaths(db, 'AGENTS.md')).toEqual([]);
    });
  });

  it('does not reinterpret an exact unindexed disk path as an indexed same-basename file', () => {
    withPathFixture((db, root) => {
      mkdirSync(join(root, 'frontend/src/routes'), { recursive: true });
      writeFileSync(join(root, 'frontend/src/routes/horses.ts'), 'export const frontendHorse = true;\n');

      expect(resolveIndexedPaths(db, 'frontend/src/routes/horses.ts')).toEqual([]);
    });
  });
});
