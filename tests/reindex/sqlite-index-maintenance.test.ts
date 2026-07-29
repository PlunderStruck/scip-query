import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { optimizeSqliteQueryLayout } from '../../src/reindex/sqlite-index-maintenance.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('SQLite query-layout maintenance', () => {
  it('adds the definition-only covering index, records statistics, and removes provably redundant indexes', () => {
    const path = fixture(true);
    const before = definitionRows(path);

    expect(optimizeSqliteQueryLayout(path)).toEqual({
      added: ['idx_mentions_definitions'],
      removed: ['idx_global_symbols_symbol', 'idx_chunks_doc_id'],
      retained: [],
      analyzed: true,
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
      expect(names).toContain('idx_mentions_definitions');
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
      expect(
        queryPlan(
          db,
          `SELECT m.symbol_id, c.document_id
           FROM mentions m
           JOIN chunks c ON c.id = m.chunk_id
           WHERE m.role = 1
           GROUP BY m.symbol_id`,
        ).some((detail) => detail.includes('idx_mentions_definitions')),
      ).toBe(true);
      expect(
        queryPlan(db, 'SELECT chunk_id FROM mentions WHERE symbol_id = ? AND role = 1', 1).some((detail) =>
          detail.includes('idx_mentions_definitions'),
        ),
      ).toBe(true);
      expect(
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_mentions_definitions'")
          .pluck()
          .get(),
      ).toMatch(/ON mentions\(symbol_id, chunk_id\) WHERE role = 1/u);
      expect(db.prepare('SELECT COUNT(*) FROM sqlite_stat1').pluck().get()).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    expect(definitionRows(path)).toEqual(before);

    expect(optimizeSqliteQueryLayout(path)).toEqual({
      added: [],
      removed: [],
      retained: [],
      analyzed: true,
    });
  });

  it('retains a chunk prefix when no wider document index can serve it', () => {
    const path = fixture(false);
    expect(optimizeSqliteQueryLayout(path)).toEqual({
      added: ['idx_mentions_definitions'],
      removed: ['idx_global_symbols_symbol'],
      retained: ['idx_chunks_doc_id'],
      analyzed: true,
    });
  });

  it('rejects a same-named definition index with an incompatible contract', () => {
    const path = fixture(true);
    const db = new Database(path);
    db.exec('CREATE INDEX idx_mentions_definitions ON mentions(role, symbol_id)');
    db.close();

    expect(() => optimizeSqliteQueryLayout(path)).toThrow(
      'idx_mentions_definitions exists with an incompatible definition',
    );
  });

  it('leaves converter test doubles and legacy non-SQLite artifacts to the existing validation boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-index-maintenance-non-sqlite-'));
    roots.push(root);
    const path = join(root, 'index.db');
    writeFileSync(path, 'converter test double');

    expect(optimizeSqliteQueryLayout(path)).toEqual({
      added: [],
      removed: [],
      retained: [],
      analyzed: false,
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
    CREATE TABLE mentions (
      chunk_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      role INTEGER NOT NULL,
      PRIMARY KEY (chunk_id, symbol_id, role)
    );
    CREATE INDEX idx_global_symbols_symbol ON global_symbols(symbol);
    CREATE INDEX idx_chunks_doc_id ON chunks(document_id);
    CREATE INDEX idx_mentions_symbol_id_role ON mentions(symbol_id, role);
    ${withWiderChunkIndex ? 'CREATE INDEX idx_chunks_line_range ON chunks(document_id, start_line, end_line);' : ''}
    INSERT INTO global_symbols(id, symbol) VALUES (1, 'symbol/one'), (2, 'symbol/two');
    INSERT INTO chunks(id, document_id, start_line, end_line)
      VALUES (1, 1, 0, 2), (2, 2, 0, 2), (3, 3, 0, 2);
    INSERT INTO mentions(chunk_id, symbol_id, role)
      VALUES (1, 1, 1), (2, 1, 0), (3, 2, 1);
  `);
  db.close();
  return path;
}

function definitionRows(path: string): unknown[] {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT m.symbol_id, c.document_id
         FROM mentions m
         JOIN chunks c ON c.id = m.chunk_id
         WHERE m.role = 1
         GROUP BY m.symbol_id
         ORDER BY m.symbol_id`,
      )
      .all();
  } finally {
    db.close();
  }
}

function queryPlan(db: Database.Database, sql: string, ...values: unknown[]): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ detail: string }>).map((row) => row.detail);
}
