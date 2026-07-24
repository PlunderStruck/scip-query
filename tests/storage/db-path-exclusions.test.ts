import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../src/storage/db.js';

describe('ScipDatabase path exclusions', () => {
  it('accepts the minimal path-exclusion capability owned by storage', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-db-policy-'));
    const dbPath = join(tempDir, 'index.db');
    const sqliteDb = new Database(dbPath);
    sqliteDb.exec('CREATE TABLE documents (id INTEGER PRIMARY KEY, language TEXT, relative_path TEXT NOT NULL UNIQUE)');
    sqliteDb.close();

    const db = new ScipDatabase(
      { dbPath, indexPath: join(tempDir, 'index.scip'), projectRoot: tempDir },
      { isIgnored: (relativePath) => relativePath === 'generated.ts' },
    );
    try {
      expect(db.isIgnored('generated.ts')).toBe(true);
      expect(db.isIgnored('src/index.ts')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('filters nested build artifacts from SQL-level document scans', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-db-exclusions-'));
    const dbPath = join(tempDir, 'index.db');
    const sqliteDb = new Database(dbPath);
    sqliteDb.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        language TEXT,
        relative_path TEXT NOT NULL UNIQUE
      );
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'typescript', 'src/index.ts'),
        (2, 'javascript', 'packages/app/dist/assets/index.js'),
        (3, 'typescript', 'packages/web/build/main.ts'),
        (4, 'typescript', 'packages/web/.next/server/page.ts'),
        (5, 'typescript', 'node_modules/pkg/index.ts');
    `);
    sqliteDb.close();

    const db = new ScipDatabase({
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    });
    try {
      const rows = db.all<{ relative_path: string }>(
        `SELECT relative_path FROM documents WHERE 1 = 1 ${db.pathExclusionsFor('documents')}`,
      );
      expect(rows.map((row) => row.relative_path)).toEqual(['src/index.ts']);
    } finally {
      db.close();
    }
  });
});
