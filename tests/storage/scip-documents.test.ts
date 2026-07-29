import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import { indexedDocumentPaths } from '../../src/storage/scip-documents.js';

function withDocumentFixture(run: (db: ScipDatabase) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-documents-'));
  const dbPath = join(root, 'index.db');
  const sqlite = new Database(dbPath);
  try {
    sqlite.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        language TEXT,
        relative_path TEXT NOT NULL UNIQUE,
        position_encoding TEXT,
        text TEXT
      );
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'typescript', 'src/a.ts'),
        (2, 'typescript', 'src/b.ts'),
        (3, 'python', 'src/c.py');
    `);
  } finally {
    sqlite.close();
  }

  const db = new ScipDatabase({
    projectRoot: root,
    dbPath,
    indexPath: join(root, 'index.scip'),
  });
  try {
    run(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('indexed document paths', () => {
  it('queries each immutable option set once and returns mutation-safe copies', () => {
    withDocumentFixture((db) => {
      const all = vi.spyOn(db, 'all');

      const first = indexedDocumentPaths(db, { extensions: ['.TS'], includeIgnored: false });
      first.reverse();
      const second = indexedDocumentPaths(db, { extensions: ['.ts'], includeIgnored: false });

      expect(second).toEqual(['src/a.ts', 'src/b.ts']);
      expect(first).not.toEqual(second);
      expect(
        all.mock.calls.filter(
          ([sql]) => String(sql).includes('SELECT relative_path') && String(sql).includes('documents'),
        ),
      ).toHaveLength(1);

      expect(indexedDocumentPaths(db, { extensions: ['.py'], includeIgnored: false })).toEqual(['src/c.py']);
      expect(all.mock.calls.filter(([sql]) => String(sql).includes('SELECT relative_path'))).toHaveLength(2);
    });
  });
});
