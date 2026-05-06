import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../src/db.js';
import { augmentAuxiliaryDocuments } from '../src/reindex/augment.js';
import * as queries from '../src/queries/index.js';

function createDocumentsOnlyDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
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
    CREATE TABLE mentions (
      chunk_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      role INTEGER NOT NULL
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      occurrences BLOB NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO documents (language, relative_path) VALUES (?, ?)`,
  ).run('typescript', 'src/main.ts');
  db.close();
}

describe('auxiliary source augmentation', () => {
  it('adds Vue SFCs to documents so DB-backed file queries can see them', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-augment-'));
    const dbPath = join(projectRoot, 'index.db');
    mkdirSync(join(projectRoot, 'src/components'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/main.ts'), 'export const main = 1;\n');
    writeFileSync(
      join(projectRoot, 'src/components/UserList.vue'),
      '<script setup lang="ts">const count = 1</script>\n<template>{{ count }}</template>\n',
    );
    createDocumentsOnlyDb(dbPath);

    const result = augmentAuxiliaryDocuments({ projectRoot, dbPath });
    expect(result).toEqual({ scanned: 1, inserted: 1, existing: 0 });

    const db = new ScipDatabase({
      projectRoot,
      dbPath,
      indexPath: join(projectRoot, 'index.scip'),
    });
    try {
      expect(queries.stats(db).documents).toBe(2);
      expect(queries.files(db, '*.vue').map((file) => file.relativePath))
        .toEqual(['src/components/UserList.vue']);
    } finally {
      db.close();
    }
  });
});
