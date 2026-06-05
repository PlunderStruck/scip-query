import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../src/storage/db.js';
import { callGraph } from '../src/queries/call-graph.js';
import { code } from '../src/queries/code.js';
import { symbols } from '../src/queries/symbols.js';
import { trace } from '../src/queries/trace.js';
import type { ScipQueryConfig } from '../src/domain/types.js';

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
    CREATE INDEX idx_chunks_doc_id ON chunks(document_id);
    CREATE INDEX idx_global_symbols_symbol ON global_symbols(symbol);
  `);
}

function withFixture(
  name: string,
  files: Record<string, string>,
  populateDb: (sqliteDb: Database.Database) => void,
  run: (db: ScipDatabase) => void,
): void {
  const tempDir = mkdtempSync(join(tmpdir(), `scip-query-${name}-`));
  const projectRoot = join(tempDir, 'project');
  const dbPath = join(tempDir, 'index.db');

  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const fullPath = join(projectRoot, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, source);
    }

    const sqliteDb = new Database(dbPath);
    createSchema(sqliteDb);
    populateDb(sqliteDb);
    sqliteDb.close();

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot,
    };
    const db = new ScipDatabase(config);
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('source-backed accuracy regressions', () => {
  it('repairs callable definition ranges before rendering code and symbols', () => {
    withFixture(
      'definition-range',
      {
        'src/helpers.ts': [
          'export function firstHelper() {',
          "  return 'first';",
          '}',
          '',
          'export function targetHelper() {',
          '  return firstHelper();',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/helpers.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`helpers.ts\`/firstHelper().', 'firstHelper', 12, 'function firstHelper|function firstHelper(): string'),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`helpers.ts\`/targetHelper().', 'targetHelper', 12, 'function targetHelper|function targetHelper(): string');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 2, 1),
            (2, 1, 2, 0, 0, 2, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 2, X'00'),
            (2, 1, 1, 4, 6, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1),
            (2, 1, 0);
        `);
      },
      (db) => {
        const targetRow = symbols(db, 'helpers.ts')
          .find((row) => row.shortName === 'src:helpers:targetHelper()');
        expect(targetRow).toBeDefined();
        expect(targetRow!.endLine).toBeGreaterThan(targetRow!.startLine);

        const snippet = code(db, 'src:helpers:targetHelper()');
        expect(snippet?.source).toContain('export function targetHelper()');
        expect(snippet?.source).toContain('return firstHelper();');
        expect(snippet?.source).not.toContain('return \'first\';');

        const traced = trace(db, 'src:helpers:targetHelper()');
        expect(traced.definitions[0]?.source).toContain('targetHelper');
        expect(traced.definitions[0]?.source).toContain('firstHelper()');
      },
    );
  });

  it('prefers source-backed caller recovery over stale semantic caller lines in the same file', () => {
    withFixture(
      'caller-merge',
      {
        'src/api.ts': [
          'export function renderReport() {',
          "  return 'ready';",
          '}',
          '',
        ].join('\n'),
        'src/consumer.ts': [
          "import { renderReport } from './api.js';",
          '',
          'export function unrelatedHelper() {',
          "  return 'helper';",
          '}',
          '',
          'export function realCaller() {',
          '  return renderReport();',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/api.ts'),
            (2, 'typescript', 'src/consumer.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`api.ts\`/renderReport().', 'renderReport', 12, 'function renderReport|function renderReport(): string'),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`consumer.ts\`/unrelatedHelper().', 'unrelatedHelper', 12, 'function unrelatedHelper|function unrelatedHelper(): string'),
            (3, 'scip-typescript npm fixture 1.0.0 src/\`consumer.ts\`/realCaller().', 'realCaller', 12, 'function realCaller|function realCaller(): string');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 2, 1),
            (2, 2, 2, 2, 0, 4, 1),
            (3, 2, 3, 6, 0, 8, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 2, X'00'),
            (2, 2, 0, 2, 4, X'00'),
            (3, 2, 1, 6, 8, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1),
            (3, 3, 1),
            (2, 1, 0);
        `);
      },
      (db) => {
        const graph = callGraph(db, 'renderReport');
        expect(graph?.callers.map((row) => row.shortName)).toEqual([
          'src:consumer:realCaller()',
        ]);
      },
    );
  });

  it('uses parsed call sites instead of structural mentions when source call recovery is available', () => {
    withFixture(
      'callee-filter',
      {
        'src/summary.ts': [
          'export type Summary = {',
          '  label: string;',
          '};',
          '',
          'export function formatLabel() {',
          "  return 'ready';",
          '}',
          '',
          'export function buildSummary() {',
          '  const summary: Summary = { label: formatLabel() };',
          '  return summary.label;',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/summary.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`summary.ts\`/Summary#', 'Summary', 11, 'type Summary|type Summary = { label: string }'),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`summary.ts\`/Summary#label.', 'label', 8, 'property label|string'),
            (3, 'scip-typescript npm fixture 1.0.0 src/\`summary.ts\`/formatLabel().', 'formatLabel', 12, 'function formatLabel|function formatLabel(): string'),
            (4, 'scip-typescript npm fixture 1.0.0 src/\`summary.ts\`/buildSummary().', 'buildSummary', 12, 'function buildSummary|function buildSummary(): Summary');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 2, 1),
            (2, 1, 2, 1, 2, 1, 14),
            (3, 1, 3, 4, 0, 6, 1),
            (4, 1, 4, 8, 0, 11, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 4, 6, X'00'),
            (2, 1, 1, 8, 11, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 3, 1),
            (2, 4, 1),
            (2, 1, 0),
            (2, 2, 0),
            (2, 3, 0);
        `);
      },
      (db) => {
        const graph = callGraph(db, 'buildSummary');
        expect(graph?.callees.map((row) => row.shortName)).toEqual([
          'src:summary:formatLabel()',
        ]);
      },
    );
  });
});
