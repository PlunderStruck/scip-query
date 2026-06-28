import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDefinitionExclusions } from '../../src/analysis/framework-patterns.js';
import { ScipDatabase } from '../../src/storage/db.js';

function withFrameworkFixture(files: Record<string, string>, run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-framework-patterns-'));
  const projectRoot = join(tempDir, 'project');
  const dbPath = join(tempDir, 'index.db');
  try {
    mkdirSync(projectRoot, { recursive: true });
    for (const [relativePath, source] of Object.entries(files)) {
      const fullPath = join(projectRoot, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, source);
    }
    new Database(dbPath).close();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(tempDir, 'index.scip') });
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('framework pattern exclusions', () => {
  it('skips TS/JS AST parsing when source has no exclusion marker', () => {
    withFrameworkFixture(
      {
        'src/plain.ts': ['export function plain() {', '  return 1;', '}', ''].join('\n'),
      },
      (db) => {
        expect(getDefinitionExclusions(db, 'src/plain.ts')).toEqual([]);
      },
    );
  });

  it('preserves TS/JS test framework file exclusions', () => {
    withFrameworkFixture(
      {
        'src/spec.ts': ['describe("suite", () => {', '  it("works", () => {});', '});', ''].join('\n'),
      },
      (db) => {
        expect(getDefinitionExclusions(db, 'src/spec.ts')).toEqual([
          expect.objectContaining({ reason: 'TS/JS test file (describe/it/test at top level)' }),
        ]);
      },
    );
  });

  it('preserves React custom hook exclusions', () => {
    withFrameworkFixture(
      {
        'src/hook.ts': ['export function useThing() {', '  return true;', '}', ''].join('\n'),
      },
      (db) => {
        expect(getDefinitionExclusions(db, 'src/hook.ts')).toEqual([
          expect.objectContaining({ reason: 'React custom hook (use*)' }),
        ]);
      },
    );
  });

  it('preserves scip-query suppression comment exclusions', () => {
    withFrameworkFixture(
      {
        'src/suppressed.ts': ['// scip-query: ignore-dead', 'export function suppressed() {', '  return true;', '}', ''].join(
          '\n',
        ),
      },
      (db) => {
        expect(getDefinitionExclusions(db, 'src/suppressed.ts')).toEqual([
          expect.objectContaining({ reason: 'scip-query suppression comment' }),
        ]);
      },
    );
  });
});
