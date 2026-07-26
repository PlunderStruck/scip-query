import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { IndexedDefinition, ScipQueryConfig } from '../../../src/domain/types.js';
import { attributeResidue, diffImpact, diffImpactPartial } from '../../../src/queries/impact/diff-impact.js';
import { ScipDatabase } from '../../../src/storage/db.js';

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
    CREATE INDEX idx_defn_enclosing_ranges_document ON defn_enclosing_ranges(document_id, start_line, end_line);
    CREATE INDEX idx_chunks_doc_id ON chunks(document_id);
    CREATE INDEX idx_global_symbols_symbol ON global_symbols(symbol);
  `);
}

function createFixtureDb(dbPath: string): void {
  const sqliteDb = new Database(dbPath);
  createSchema(sqliteDb);

  sqliteDb.exec(`
    INSERT INTO documents (id, language, relative_path) VALUES
      (1, 'typescript', 'src/model.ts'),
      (2, 'typescript', 'src/consumer.ts');

    INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
      (1, 'scip-typescript npm pkg 1.0.0 src/\`model.ts\`/', '', 1, 'module'),
      (2, 'scip-typescript npm pkg 1.0.0 src/\`model.ts\`/User#', 'User', 11, 'interface User'),
      (3, 'scip-typescript npm pkg 1.0.0 src/\`model.ts\`/User#name.', 'name', 8, 'property name'),
      (4, 'scip-typescript npm pkg 1.0.0 src/\`model.ts\`/updateUser().', 'updateUser', 3, 'function updateUser'),
      (5, 'scip-typescript npm pkg 1.0.0 src/\`model.ts\`/DEFAULT_STATUS.', 'DEFAULT_STATUS', 8, 'const DEFAULT_STATUS');

    INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
      (1, 1, 1, 0, 0, 7, 0),
      (2, 1, 2, 0, 0, 2, 0),
      (3, 1, 3, 1, 2, 1, 14),
      (4, 1, 4, 4, 0, 4, 40),
      (5, 1, 5, 6, 0, 6, 34);

    INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
      (1, 1, 0, 0, 7, X'00'),
      (2, 2, 0, 0, 4, X'00');

    INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
      (1, 1, 1),
      (1, 2, 1),
      (1, 3, 1),
      (1, 4, 1),
      (1, 5, 1),
      (2, 2, 0),
      (2, 3, 0),
      (2, 4, 0),
      (2, 5, 0);
  `);

  sqliteDb.close();
}

describe('diff-impact accuracy', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('does not let an option-like base create a Git output file', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-diff-base-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'model.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tempDir, stdio: 'ignore' });

    const dbPath = join(tempDir, 'index.db');
    createFixtureDb(dbPath);
    const db = new ScipDatabase({
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    });
    const outputPath = join(tempDir, 'git-option-output');

    try {
      const result = diffImpact(db, { base: `--output=${outputPath}` });
      expect(result.summary.note).toBe('Unable to compute git diff.');
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('reports only definitions touched by changed hunks without sibling definition noise', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-diff-impact-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(
      join(tempDir, 'src', 'model.ts'),
      [
        'export interface User {',
        '  name: string;',
        '}',
        '',
        'export function updateUser(user: User) { return user; }',
        '',
        "export const DEFAULT_STATUS = 'open';",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(tempDir, 'src', 'consumer.ts'),
      [
        "import { DEFAULT_STATUS, type User, updateUser } from './model';",
        '',
        'const user: User = { name: DEFAULT_STATUS };',
        'updateUser(user);',
        '',
      ].join('\n'),
    );

    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tempDir, stdio: 'ignore' });
    writeFileSync(
      join(tempDir, 'src', 'model.ts'),
      [
        'export interface User {',
        '  name: string;',
        '}',
        '',
        'export function updateUser(user: User) { return { ...user }; }',
        '',
        "export const DEFAULT_STATUS = 'open';",
        '',
      ].join('\n'),
    );

    const dbPath = join(tempDir, 'index.db');
    createFixtureDb(dbPath);
    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    };
    const db = new ScipDatabase(config);

    try {
      const result = diffImpact(db, { base: 'HEAD' });
      const shortNames = result.changedSymbols.map((symbol) => symbol.shortName);

      expect(result.changedFiles).toEqual(['src/model.ts']);
      expect(shortNames).toEqual(['src:model:updateUser()']);
      expect(shortNames).not.toContain('src:model:User:name');
      expect(result.changedSymbols.some((symbol) => symbol.symbol.endsWith('`model.ts`/'))).toBe(false);
      expect(result.changedSymbols[0]?.startLine).toBe(4);
      expect(result.changedSymbols[0]?.endLine).toBe(4);
      expect(result.affectedConsumers).toEqual([{ file: 'src/consumer.ts', consumedSymbols: 1 }]);
    } finally {
      db.close();
    }
  });

  it('preserves per-symbol fan-in and consumers when multiple changed definitions are batched', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-diff-impact-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(
      join(tempDir, 'src', 'model.ts'),
      [
        'export interface User {',
        '  name: string;',
        '}',
        '',
        'export function updateUser(user: User) { return user; }',
        '',
        "export const DEFAULT_STATUS = 'open';",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(tempDir, 'src', 'consumer.ts'),
      [
        "import { DEFAULT_STATUS, type User, updateUser } from './model';",
        '',
        'const user: User = { name: DEFAULT_STATUS };',
        'updateUser(user);',
        '',
      ].join('\n'),
    );

    const dbPath = join(tempDir, 'index.db');
    createFixtureDb(dbPath);
    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    };
    const db = new ScipDatabase(config);

    try {
      const result = diffImpactPartial(
        db,
        ['src/model.ts'],
        ['src/model.ts'],
        [
          { file: 'src/model.ts', startLine: 4, endLine: 4 },
          { file: 'src/model.ts', startLine: 6, endLine: 6 },
        ],
      );

      expect(result.changedSymbols.map((symbol) => symbol.shortName)).toEqual([
        'src:model:updateUser()',
        'src:model:DEFAULT_STATUS',
      ]);
      expect(result.changedSymbols.map((symbol) => symbol.fanIn)).toEqual([1, 1]);
      expect(result.consumerEntries).toEqual([
        {
          file: 'src/consumer.ts',
          symbols: ['src:model:DEFAULT_STATUS', 'src:model:updateUser()'],
        },
      ]);
    } finally {
      db.close();
    }
  });

  // Reproduces docs/plans/2026-07-02-followups.md item 2 / the 2026-07-01
  // Vega calibration's `new-dead` false positives (`AISettingsAuthType` and
  // siblings): a type newly added to a pnpm workspace package, consumed
  // only through a workspace-package specifier (`@fixture/shared/contracts`)
  // from another app in the same monorepo. scip-typescript emits zero
  // mention rows for the consumer on this shape (confirmed live against the
  // real Vega repo — see the accompanying commit message); before this fix
  // `diffImpactPartial` had no fallback tier at all wired for the
  // changed-symbol fan-in computation, so `new-dead` reported it as
  // "changed but has zero indexed consumers" even though a real consumer
  // exists on disk.
  it('does not report zero fan-in for a new type consumed only through a workspace-package specifier', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-diff-impact-workspace-'));
    mkdirSync(join(tempDir, 'packages/shared/src'), { recursive: true });
    mkdirSync(join(tempDir, 'apps/web/src'), { recursive: true });

    writeFileSync(
      join(tempDir, 'pnpm-workspace.yaml'),
      ['packages:', '  - "apps/*"', '  - "packages/*"', ''].join('\n'),
    );
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true }));
    writeFileSync(
      join(tempDir, 'packages/shared/package.json'),
      JSON.stringify({
        name: '@fixture/shared',
        exports: { './contracts': { types: './dist/contracts.d.ts', import: './dist/contracts.js' } },
      }),
    );
    // No dist/ exists — mirrors an unbuilt, freshly cloned monorepo.
    writeFileSync(
      join(tempDir, 'packages/shared/src/contracts.ts'),
      ['export interface NewType {', '  id: string;', '}', ''].join('\n'),
    );
    writeFileSync(
      join(tempDir, 'apps/web/src/consumer.ts'),
      [
        "import type { NewType } from '@fixture/shared/contracts';",
        'export function describe(value: NewType): string {',
        '  return value.id;',
        '}',
        '',
      ].join('\n'),
    );

    const dbPath = join(tempDir, 'index.db');
    const sqliteDb = new Database(dbPath);
    createSchema(sqliteDb);
    sqliteDb.exec(`
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'typescript', 'packages/shared/src/contracts.ts'),
        (2, 'typescript', 'apps/web/src/consumer.ts');

      INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
        (1, 'scip-typescript npm @fixture/shared 1.0.0 src/\`contracts.ts\`/NewType#', 'NewType', 11, 'interface NewType');

      INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
        (1, 1, 1, 0, 0, 2, 1);

      INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
        (1, 1, 0, 0, 3, X'00');

      -- Definition-site row only. Zero mention rows anywhere for
      -- apps/web/src/consumer.ts referencing NewType — the real
      -- scip-typescript gap this fixture reproduces.
      INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
        (1, 1, 1);
    `);
    sqliteDb.close();

    const config: ScipQueryConfig = { dbPath, indexPath: join(tempDir, 'index.scip'), projectRoot: tempDir };
    const db = new ScipDatabase(config);
    try {
      const result = diffImpactPartial(
        db,
        ['packages/shared/src/contracts.ts'],
        ['packages/shared/src/contracts.ts'],
        [{ file: 'packages/shared/src/contracts.ts', startLine: 0, endLine: 2 }],
      );

      const newType = result.changedSymbols.find((symbol) => symbol.shortName.endsWith('NewType'));
      expect(newType).toBeDefined();
      expect(newType!.fanIn).toBeGreaterThan(0);
      expect(result.consumerEntries).toEqual([
        { file: 'apps/web/src/consumer.ts', symbols: ['src:contracts:NewType'] },
      ]);
    } finally {
      db.close();
    }
  });

  it('attributes changed initializer residue to the enclosing declaration span', () => {
    const definition = indexedDefinition({
      symbolId: 10,
      symbol: 'scip-typescript npm pkg 1.0.0 src/`config.ts`/BUILTIN_SKILLS.',
      startLine: 0,
      endLine: 0,
    });

    const result = attributeResidue(
      [definition],
      [{ file: 'src/config.ts', startLine: 4, endLine: 4 }],
      [{ file: 'src/config.ts', startLine: 0, endLine: 8 }],
    );

    expect(result.definitions).toEqual([definition]);
    expect(result.notes).toEqual([{ file: 'src/config.ts', startLine: 4, endLine: 4, method: 'ast-widened' }]);
  });

  it('keeps edits between AST declaration spans unattributed', () => {
    const result = attributeResidue(
      [
        indexedDefinition({
          symbolId: 1,
          symbol: 'scip-typescript npm pkg 1.0.0 src/`a.ts`/first().',
          relativePath: 'src/a.ts',
          startLine: 0,
        }),
        indexedDefinition({
          symbolId: 2,
          symbol: 'scip-typescript npm pkg 1.0.0 src/`a.ts`/second().',
          relativePath: 'src/a.ts',
          startLine: 6,
        }),
      ],
      [{ file: 'src/a.ts', startLine: 3, endLine: 3 }],
      [
        { file: 'src/a.ts', startLine: 0, endLine: 1 },
        { file: 'src/a.ts', startLine: 6, endLine: 7 },
      ],
    );

    expect(result.definitions).toEqual([]);
    expect(result.notes).toEqual([{ file: 'src/a.ts', startLine: 3, endLine: 3, method: 'unattributed' }]);
  });
});

function indexedDefinition(
  overrides: Partial<IndexedDefinition> & Pick<IndexedDefinition, 'symbolId' | 'symbol' | 'startLine'>,
): IndexedDefinition {
  return {
    documentId: 1,
    endLine: overrides.endLine ?? overrides.startLine,
    relativePath: overrides.relativePath ?? 'src/config.ts',
    leaf: 'leaf',
    parentTypeName: null,
    isFunctionLike: true,
    isTypeLike: false,
    kind: 3,
    documentation: null,
    enclosingSymbol: null,
    ...overrides,
  };
}
