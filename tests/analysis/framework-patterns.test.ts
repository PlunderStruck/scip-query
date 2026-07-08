import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDefinitionExclusions } from '../../src/analysis/framework-patterns.js';
import { buildFileExclusionPredicate } from '../../src/queries/cleanup/dead-exclusions.js';
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

  it('preserves React custom hook variable exclusions', () => {
    withFrameworkFixture(
      {
        'src/hook.ts': ['const useThing = () => {', '  return true;', '};', ''].join('\n'),
      },
      (db) => {
        expect(getDefinitionExclusions(db, 'src/hook.ts')).toEqual([
          expect.objectContaining({ reason: 'React custom hook (use*)' }),
        ]);
      },
    );
  });

  it('does not treat ordinary React hook calls as custom hook exclusions', () => {
    withFrameworkFixture(
      {
        'src/component.tsx': [
          "import { useState } from 'react';",
          'export function Panel() {',
          '  const [count] = useState(0);',
          '  return count;',
          '}',
          '',
        ].join('\n'),
      },
      (db) => {
        expect(getDefinitionExclusions(db, 'src/component.tsx')).toEqual([]);
      },
    );
  });

  it('preserves scip-query suppression comment exclusions', () => {
    withFrameworkFixture(
      {
        'src/suppressed.ts': [
          '// scip-query: ignore-dead',
          'export function suppressed() {',
          '  return true;',
          '}',
          '',
        ].join('\n'),
      },
      (db) => {
        expect(getDefinitionExclusions(db, 'src/suppressed.ts')).toEqual([
          expect.objectContaining({ reason: 'scip-query suppression comment' }),
        ]);
      },
    );
  });

  it('marks generated Rust files as hard exclusions', () => {
    withFrameworkFixture(
      {
        'src/generated.rs': ['// @generated', 'pub fn generated_entry() {', '}', ''].join('\n'),
      },
      (db) => {
        expect(getDefinitionExclusions(db, 'src/generated.rs')).toEqual([
          expect.objectContaining({
            reason: 'generated file (@generated header)',
            disposition: 'exclude',
          }),
        ]);
        expect(
          buildFileExclusionPredicate(db)(
            'src/generated.rs',
            1,
            'rust crate src/generated.rs/generated_entry().',
            null,
          ),
        ).toBe(true);
      },
    );
  });

  it('keeps Rust test functions as hard exclusions', () => {
    withFrameworkFixture(
      {
        'src/lib.rs': ['#[test]', 'fn parses_input() {', '}', ''].join('\n'),
      },
      (db) => {
        expect(getDefinitionExclusions(db, 'src/lib.rs')).toEqual([
          expect.objectContaining({
            reason: '#[test]',
            disposition: 'exclude',
          }),
        ]);
        expect(buildFileExclusionPredicate(db)('src/lib.rs', 1, 'rust crate src/lib.rs/parses_input().', null)).toBe(
          true,
        );
      },
    );
  });

  it('classifies Rust framework attributes as implicit usage instead of hard exclusions', () => {
    withFrameworkFixture(
      {
        'src/lib.rs': ['#[tauri::command]', 'pub fn launch() {', '}', ''].join('\n'),
      },
      (db) => {
        expect(getDefinitionExclusions(db, 'src/lib.rs')).toEqual([
          expect.objectContaining({
            reason: 'Rust attribute macro #[tauri::command]',
            disposition: 'implicit-usage',
          }),
        ]);
        expect(buildFileExclusionPredicate(db)('src/lib.rs', 1, 'rust crate src/lib.rs/launch().', null)).toBe(false);
      },
    );
  });

  it('classifies Rust reflective derives as implicit usage instead of hard exclusions', () => {
    withFrameworkFixture(
      {
        'src/model.rs': ['#[derive(Serialize, Deserialize)]', 'pub struct Payload {', '  value: String,', '}', ''].join(
          '\n',
        ),
      },
      (db) => {
        expect(getDefinitionExclusions(db, 'src/model.rs')).toEqual([
          expect.objectContaining({
            reason: '#[derive(...)] - generated impl may access fields',
            disposition: 'implicit-usage',
            containerName: 'Payload',
          }),
        ]);
        expect(
          buildFileExclusionPredicate(db)('src/model.rs', 2, 'rust crate src/model.rs/Payload#value.', 'Payload'),
        ).toBe(false);
      },
    );
  });
});
