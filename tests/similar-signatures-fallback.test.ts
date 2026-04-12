import Database from 'better-sqlite3';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../src/db.js';
import { similarSignatures } from '../src/queries/similar-signatures.js';
import type { ScipQueryConfig } from '../src/types.js';

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
    CREATE INDEX idx_chunks_doc_id ON chunks(document_id);
    CREATE INDEX idx_global_symbols_symbol ON global_symbols(symbol);
  `);
}

describe('similar-signatures source fallback', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-similar-signatures-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });

    writeFileSync(
      join(projectRoot, 'src', 'StatusAuditReporter.java'),
      [
        'package fixture;',
        'public final class StatusAuditReporter {',
        '  public String renderAuditStatus(String rawStatus) {',
        '    return rawStatus.trim();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'src', 'StatusBoardReporter.java'),
      [
        'package fixture;',
        'public final class StatusBoardReporter {',
        '  public String renderBoardStatus(String rawStatus) {',
        '    return rawStatus.trim();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'src', 'StatusDigestReporter.java'),
      [
        'package fixture;',
        'public final class StatusDigestReporter {',
        '  public String renderDigestStatus(String rawStatus, String prefix) {',
        '    return prefix + rawStatus.trim();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const sqliteDb = new Database(join(tempDir, 'index.db'));
    createSchema(sqliteDb);
    sqliteDb.exec(`
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'java', 'src/StatusAuditReporter.java'),
        (2, 'java', 'src/StatusBoardReporter.java'),
        (3, 'java', 'src/StatusDigestReporter.java');

      INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
        (1, 'semanticdb maven . . fixture/StatusAuditReporter#', 'StatusAuditReporter', 5, 'class StatusAuditReporter|class StatusAuditReporter'),
        (2, 'semanticdb maven . . fixture/StatusAuditReporter#renderAuditStatus().', 'renderAuditStatus', 12, 'semanticdb maven . . fixture/StatusAuditReporter#renderAuditStatus().|'),
        (3, 'semanticdb maven . . fixture/StatusBoardReporter#', 'StatusBoardReporter', 5, 'class StatusBoardReporter|class StatusBoardReporter'),
        (4, 'semanticdb maven . . fixture/StatusBoardReporter#renderBoardStatus().', 'renderBoardStatus', 12, 'semanticdb maven . . fixture/StatusBoardReporter#renderBoardStatus().|'),
        (5, 'semanticdb maven . . fixture/StatusDigestReporter#', 'StatusDigestReporter', 5, 'class StatusDigestReporter|class StatusDigestReporter'),
        (6, 'semanticdb maven . . fixture/StatusDigestReporter#renderDigestStatus().', 'renderDigestStatus', 12, 'semanticdb maven . . fixture/StatusDigestReporter#renderDigestStatus().|');

      INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
        (1, 1, 1, 1, 0, 4, 1),
        (2, 1, 2, 2, 2, 3, 3),
        (3, 2, 3, 1, 0, 4, 1),
        (4, 2, 4, 2, 2, 3, 3),
        (5, 3, 5, 1, 0, 4, 1),
        (6, 3, 6, 2, 2, 3, 3);
    `);
    sqliteDb.close();

    const config: ScipQueryConfig = {
      dbPath: join(tempDir, 'index.db'),
      projectRoot,
    };
    db = new ScipDatabase(config);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('groups same-shape functions when documentation signatures are missing', () => {
    const groups = similarSignatures(db, { minLoc: 1 });
    const reporterGroup = groups.find((group) => group.functions.length === 2);
    expect(reporterGroup?.functions.map((fn) => fn.shortName)).toEqual(expect.arrayContaining([
      'fixture:StatusAuditReporter:renderAuditStatus()',
      'fixture:StatusBoardReporter:renderBoardStatus()',
    ]));
    expect(reporterGroup?.functions.map((fn) => fn.shortName)).not.toContain('fixture:StatusDigestReporter:renderDigestStatus()');
  });
});
