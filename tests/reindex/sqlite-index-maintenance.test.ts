import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeRedundantSqliteIndexes } from '../../src/reindex/sqlite-index-maintenance.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('redundant SQLite index maintenance', () => {
  it('drops duplicate symbol and chunk-prefix indexes while retaining their covering access paths', () => {
    const path = fixture(true);

    expect(removeRedundantSqliteIndexes(path)).toEqual({
      removed: ['idx_global_symbols_symbol', 'idx_chunks_doc_id'],
      retained: [],
    });

    const db = new Database(path, { readonly: true });
    try {
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .pluck()
        .all() as string[];
      expect(names).not.toContain('idx_global_symbols_symbol');
      expect(names).not.toContain('idx_chunks_doc_id');
      expect(names).toContain('idx_chunks_line_range');
      expect(
        queryPlan(db, 'SELECT * FROM global_symbols WHERE symbol = ?', 'symbol').some((detail) =>
          detail.includes('sqlite_autoindex_global_symbols_1'),
        ),
      ).toBe(true);
      expect(
        queryPlan(db, 'SELECT * FROM chunks WHERE document_id = ?', 1).some((detail) =>
          detail.includes('idx_chunks_line_range'),
        ),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it('retains a chunk prefix when no wider document index can serve it', () => {
    const path = fixture(false);
    expect(removeRedundantSqliteIndexes(path)).toEqual({
      removed: ['idx_global_symbols_symbol'],
      retained: ['idx_chunks_doc_id'],
    });
  });

  it('leaves converter test doubles and legacy non-SQLite artifacts to the existing validation boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-index-maintenance-non-sqlite-'));
    roots.push(root);
    const path = join(root, 'index.db');
    writeFileSync(path, 'converter test double');

    expect(removeRedundantSqliteIndexes(path)).toEqual({
      removed: [],
      retained: [],
      skippedReason: 'not-a-sqlite-database',
    });
  });
});

function fixture(withWiderChunkIndex: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-index-maintenance-'));
  roots.push(root);
  const path = join(root, 'index.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE global_symbols (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL
    );
    CREATE INDEX idx_global_symbols_symbol ON global_symbols(symbol);
    CREATE INDEX idx_chunks_doc_id ON chunks(document_id);
    ${withWiderChunkIndex ? 'CREATE INDEX idx_chunks_line_range ON chunks(document_id, start_line, end_line);' : ''}
  `);
  db.close();
  return path;
}

function queryPlan(db: Database.Database, sql: string, value: unknown): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(value) as Array<{ detail: string }>).map((row) => row.detail);
}
