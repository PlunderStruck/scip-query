import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSuppressionInventory } from '../../src/analysis/suppressions.js';
import type { ScipQueryConfig } from '../../src/domain/types.js';
import { ScipDatabase } from '../../src/storage/db.js';

function createSuppressionFixtureDb(dbPath: string): void {
  const sqliteDb = new Database(dbPath);
  sqliteDb.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      language TEXT,
      relative_path TEXT NOT NULL UNIQUE,
      position_encoding TEXT,
      text TEXT
    );

    INSERT INTO documents (id, language, relative_path) VALUES
      (1, 'typescript', 'src/suppressions.ts');
  `);
  sqliteDb.close();
}

describe('suppression inventory', () => {
  it('counts directive comments without counting strings or prose examples', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-suppressions-'));
    let db: ScipDatabase | null = null;

    try {
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(
        join(srcDir, 'suppressions.ts'),
        [
          'const generatedHint = "scip-query: ignore-wrapper";',
          '/**',
          ' * Every `scip-query: ignore-stale` example here is documentation.',
          ' */',
          '// scip-query: ignore-wrapper - accepted facade.',
          'export function wrapper(): string { return generatedHint; }',
          '// scip-query-ignore: dead-code - accepted legacy spelling.',
          'export function dead(): string { return wrapper(); }',
          '/* scip-query: ignore-passthrough */',
          'export function passthrough(): string { return dead(); }',
          '// scip-query: ignore-twin - reviewed same-name group.',
          'export function twin(): string { return passthrough(); }',
        ].join('\n'),
      );

      const dbPath = join(tempDir, 'index.db');
      createSuppressionFixtureDb(dbPath);
      const config: ScipQueryConfig = {
        dbPath,
        indexPath: join(tempDir, 'index.scip'),
        projectRoot: tempDir,
        suppressions: [
          {
            id: 'SQ-ACTIVE',
            check: 'recent-duplicates',
            file: 'src/suppressions.ts',
            reason: 'Reviewed intentional overlap.',
            expiresAt: '2999-01-01T00:00:00.000Z',
          },
          {
            id: 'SQ-EXPIRED',
            check: 'twin-drift',
            file: 'src/suppressions.ts',
            reason: 'Expired review.',
            expiresAt: '2000-01-01T00:00:00.000Z',
          },
        ],
      };
      db = new ScipDatabase(config);

      const inventory = getSuppressionInventory(db);

      expect(inventory.total).toBe(5);
      expect(inventory.byFile.get('src/suppressions.ts')).toBe(5);
      expect(inventory.byCategory.wrapper).toBe(1);
      expect(inventory.byCategory.dead).toBe(1);
      expect(inventory.byCategory.passthrough).toBe(1);
      expect(inventory.byCategory.stale).toBe(0);
      expect(inventory.byCategory.twin).toBe(1);
      expect(inventory.byCategory.similar).toBe(1);
    } finally {
      db?.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
