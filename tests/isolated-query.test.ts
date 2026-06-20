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
import { ScipDatabase } from '../src/storage/db.js';
import { isolated } from '../src/queries/cleanup/isolated.js';
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
    CREATE INDEX idx_chunks_doc_id ON chunks(document_id);
    CREATE INDEX idx_global_symbols_symbol ON global_symbols(symbol);
  `);
}

describe('isolated query', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-isolated-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });

    writeFileSync(
      join(projectRoot, 'src', 'AnalysisStatusShadow.java'),
      [
        'package fixture;',
        'public final class AnalysisStatusShadow {',
        '  public static String shadowStatus() {',
        '    return "shadow-status";',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'src', 'StatusBadgeRelay.java'),
      [
        'package fixture;',
        'public final class StatusBadgeRelay {',
        '  public static String normalizeBadgeStatus(String rawStatus) {',
        '    return rawStatus.trim();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'src', 'AnalysisStatusPresenter.java'),
      [
        'package fixture;',
        'public final class AnalysisStatusPresenter {',
        '  public String renderStatusBadge(String rawStatus) {',
        '    return StatusBadgeRelay.normalizeBadgeStatus(rawStatus);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const sqliteDb = new Database(join(tempDir, 'index.db'));
    createSchema(sqliteDb);
    sqliteDb.exec(`
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'java', 'src/AnalysisStatusShadow.java'),
        (2, 'java', 'src/StatusBadgeRelay.java'),
        (3, 'java', 'src/AnalysisStatusPresenter.java');

      INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
        (1, 'semanticdb maven . . fixture/AnalysisStatusShadow#', 'AnalysisStatusShadow', 5, 'class AnalysisStatusShadow|class AnalysisStatusShadow'),
        (2, 'semanticdb maven . . fixture/AnalysisStatusShadow#shadowStatus().', 'shadowStatus', 12, 'shadowStatus|String shadowStatus()'),
        (3, 'semanticdb maven . . fixture/StatusBadgeRelay#', 'StatusBadgeRelay', 5, 'class StatusBadgeRelay|class StatusBadgeRelay'),
        (4, 'semanticdb maven . . fixture/StatusBadgeRelay#normalizeBadgeStatus().', 'normalizeBadgeStatus', 12, 'normalizeBadgeStatus|String normalizeBadgeStatus(String rawStatus)'),
        (5, 'semanticdb maven . . fixture/AnalysisStatusPresenter#', 'AnalysisStatusPresenter', 5, 'class AnalysisStatusPresenter|class AnalysisStatusPresenter'),
        (6, 'semanticdb maven . . fixture/AnalysisStatusPresenter#renderStatusBadge().', 'renderStatusBadge', 12, 'renderStatusBadge|String renderStatusBadge(String rawStatus)');

      INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
        (1, 1, 1, 1, 0, 4, 1),
        (2, 1, 2, 2, 2, 3, 3),
        (3, 2, 3, 1, 0, 4, 1),
        (4, 2, 4, 2, 2, 3, 3),
        (5, 3, 5, 1, 0, 4, 1),
        (6, 3, 6, 2, 2, 3, 3);

      INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
        (1, 1, 0, 0, 5, X'00'),
        (2, 2, 0, 0, 5, X'00'),
        (3, 3, 0, 0, 5, X'00');

      INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
        (1, 1, 1),
        (1, 2, 1),
        (2, 3, 1),
        (2, 4, 1),
        (3, 5, 1),
        (3, 6, 1),
        (3, 4, 0);
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

  it('returns only disconnected callables', () => {
    const results = isolated(db, { minLoc: 1 });
    expect(results.map((row) => row.shortName)).toContain('fixture:AnalysisStatusShadow:shadowStatus()');
    expect(results.map((row) => row.shortName)).not.toContain('fixture:StatusBadgeRelay:normalizeBadgeStatus()');
    expect(results.map((row) => row.shortName)).not.toContain('fixture:AnalysisStatusPresenter:renderStatusBadge()');
  });
});
