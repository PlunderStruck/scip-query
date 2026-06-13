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
import { dataflow } from '../src/queries/dataflow.js';
import { symbols } from '../src/queries/symbols.js';
import { trace } from '../src/queries/trace.js';
import { buildAstCalleeMap, buildChunkCalleeMap } from '../src/symbols/call-graph-evidence.js';
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
  it('attributes AST callsites to the innermost containing definition', () => {
    withFixture(
      'ast-line-owner',
      {
        'src/nested.ts': [
          'export function outer() {',
          '  function inner() {',
          '    return helper();',
          '  }',
          '  return inner();',
          '}',
          '',
          'export function helper() {',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/nested.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`nested.ts\`/outer().', 'outer', 12, 'function outer|function outer(): number'),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`nested.ts\`/outer().inner().', 'inner', 12, 'function inner|function inner(): number'),
            (3, 'scip-typescript npm fixture 1.0.0 src/\`nested.ts\`/helper().', 'helper', 12, 'function helper|function helper(): number');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 5, 1),
            (2, 1, 2, 1, 2, 3, 3),
            (3, 1, 3, 7, 0, 9, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 5, X'00'),
            (2, 1, 1, 1, 3, X'00'),
            (3, 1, 2, 7, 9, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1),
            (3, 3, 1);
        `);
      },
      (db) => {
        const map = buildAstCalleeMap(db, [
          {
            symbolId: 1,
            documentId: 1,
            startLine: 0,
            endLine: 5,
            symbol: 'scip-typescript npm fixture 1.0.0 src/`nested.ts`/outer().',
            relativePath: 'src/nested.ts',
          },
          {
            symbolId: 2,
            documentId: 1,
            startLine: 1,
            endLine: 3,
            symbol: 'scip-typescript npm fixture 1.0.0 src/`nested.ts`/outer().inner().',
            relativePath: 'src/nested.ts',
          },
          {
            symbolId: 3,
            documentId: 1,
            startLine: 7,
            endLine: 9,
            symbol: 'scip-typescript npm fixture 1.0.0 src/`nested.ts`/helper().',
            relativePath: 'src/nested.ts',
          },
        ]);

        expect(map.get(2)).toContainEqual({
          symbol: 'scip-typescript npm fixture 1.0.0 src/`nested.ts`/helper().',
          file: 'src/nested.ts',
          chunkId: 2,
          source: 'ast-callsite',
        });
        expect(map.get(1)).toContainEqual({
          symbol: 'scip-typescript npm fixture 1.0.0 src/`nested.ts`/outer().inner().',
          file: 'src/nested.ts',
          chunkId: 4,
          source: 'ast-callsite',
        });
      },
    );
  });

  it('keeps chunk callee evidence scoped to requested definition documents', () => {
    withFixture(
      'chunk-callee-scope',
      {
        'src/target.custom': [
          'def target',
          '  helper()',
          'end',
          '',
          'def helper',
          'end',
          '',
        ].join('\n'),
        'src/unrelated.custom': [
          'def unrelated',
          '  noisy()',
          'end',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'text', 'src/target.custom'),
            (2, 'text', 'src/unrelated.custom');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'custom src/\`target.custom\`/target().', 'target', 12, 'target'),
            (2, 'custom src/\`target.custom\`/helper().', 'helper', 12, 'helper'),
            (3, 'custom src/\`unrelated.custom\`/noisy().', 'noisy', 12, 'noisy');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 2, 3),
            (2, 1, 2, 4, 0, 5, 3),
            (3, 2, 3, 0, 0, 2, 3);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 2, X'00'),
            (2, 1, 1, 4, 5, X'00'),
            (3, 2, 0, 0, 2, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (1, 2, 0),
            (2, 2, 1),
            (3, 3, 1),
            (3, 3, 0);
        `);
      },
      (db) => {
        const map = buildChunkCalleeMap(db, [{
          documentId: 1,
          startLine: 0,
          endLine: 2,
          symbolId: 1,
        }]);

        expect(map.get(1)).toEqual([{
          symbol: 'custom src/`target.custom`/helper().',
          file: 'src/target.custom',
          chunkId: 1,
          source: 'scip-chunk',
        }]);
      },
    );
  });

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
          'export const assignedTarget = () => {',
          '  const value = firstHelper();',
          '  return value;',
          '};',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/helpers.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`helpers.ts\`/firstHelper().', 'firstHelper', 12, 'function firstHelper|function firstHelper(): string'),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`helpers.ts\`/targetHelper().', 'targetHelper', 12, 'function targetHelper|function targetHelper(): string'),
            (3, 'scip-typescript npm fixture 1.0.0 src/\`helpers.ts\`/assignedTarget.', 'assignedTarget', 13, 'const assignedTarget|const assignedTarget: () => string');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 2, 1),
            (2, 1, 2, 0, 0, 2, 1),
            (3, 1, 3, 8, 0, 8, 37);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 2, X'00'),
            (2, 1, 1, 4, 6, X'00'),
            (3, 1, 2, 8, 8, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1),
            (2, 1, 0),
            (3, 3, 1),
            (3, 1, 0);
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

        const assignedRow = symbols(db, 'helpers.ts')
          .find((row) => row.shortName.includes('assignedTarget'));
        expect(assignedRow).toBeDefined();
        expect(assignedRow!.startLine).toBe(8);
        expect(assignedRow!.endLine).toBe(11);

        const assignedSnippet = code(db, 'assignedTarget');
        expect(assignedSnippet?.source).toContain('export const assignedTarget = () => {');
        expect(assignedSnippet?.source).toContain('const value = firstHelper();');
        expect(assignedSnippet?.source).toContain('return value;');
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

  it('does not resolve member calls to unrelated unique global functions', () => {
    withFixture(
      'member-call-unique-global',
      {
        'backend/src/auth.ts': [
          'export async function createUser(client: { user: { create(input: unknown): Promise<unknown> } }) {',
          "  return client.user.create({ email: 'test@example.com' });",
          '}',
          '',
        ].join('\n'),
        'frontend/src/wizard.ts': [
          'export function create(path: string) {',
          '  return { path };',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'backend/src/auth.ts'),
            (2, 'typescript', 'frontend/src/wizard.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 backend/src/\`auth.ts\`/createUser().', 'createUser', 12, 'function createUser|function createUser(): Promise<unknown>'),
            (2, 'scip-typescript npm fixture 1.0.0 frontend/src/\`wizard.ts\`/create().', 'create', 12, 'function create|function create(path: string): { path: string }');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 2, 1),
            (2, 2, 2, 0, 0, 2, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 2, X'00'),
            (2, 2, 0, 0, 2, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1);
        `);
      },
      (db) => {
        const result = dataflow(db, 'createUser');
        expect(result?.producers.map((row) => row.shortName)).not.toContain('src:wizard:create()');
      },
    );
  });
});
