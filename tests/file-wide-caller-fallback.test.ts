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
import { callGraph } from '../src/queries/call-graph.js';
import { wrapperCandidates } from '../src/queries/wrapper-candidates.js';
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

describe('file-wide caller fallback', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-caller-fallback-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });

    writeFileSync(
      join(projectRoot, 'src', 'StatusBadgeRelay.java'),
      [
        'package fixture;',
        'public final class StatusBadgeRelay {',
        '  private StatusBadgeRelay() {}',
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

    const reporterFiles = [
      ['StatusAuditReporter.java', 'renderAuditStatus'],
      ['StatusBoardReporter.java', 'renderBoardStatus'],
      ['StatusDigestReporter.java', 'renderDigestStatus'],
      ['StatusPreviewReporter.java', 'renderPreviewStatus'],
    ] as const;
    for (const [fileName, methodName] of reporterFiles) {
      const className = fileName.replace('.java', '');
      writeFileSync(
        join(projectRoot, 'src', fileName),
        [
          'package fixture;',
          'public final class ' + className + ' {',
          '  private final AnalysisStatusPresenter presenter = new AnalysisStatusPresenter();',
          '  public String ' + methodName + '(String rawStatus) {',
          '    return presenter.renderStatusBadge(rawStatus);',
          '  }',
          '}',
          '',
        ].join('\n'),
      );
    }

    const sqliteDb = new Database(join(tempDir, 'index.db'));
    createSchema(sqliteDb);
    sqliteDb.exec(`
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'java', 'src/StatusBadgeRelay.java'),
        (2, 'java', 'src/AnalysisStatusPresenter.java'),
        (3, 'java', 'src/StatusAuditReporter.java'),
        (4, 'java', 'src/StatusBoardReporter.java'),
        (5, 'java', 'src/StatusDigestReporter.java'),
        (6, 'java', 'src/StatusPreviewReporter.java');

      INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
        (1, 'semanticdb maven . . fixture/StatusBadgeRelay#', 'StatusBadgeRelay', 5, 'class StatusBadgeRelay|class StatusBadgeRelay'),
        (2, 'semanticdb maven . . fixture/StatusBadgeRelay#normalizeBadgeStatus().', 'normalizeBadgeStatus', 12, 'normalizeBadgeStatus|String normalizeBadgeStatus(String rawStatus)'),
        (3, 'semanticdb maven . . fixture/AnalysisStatusPresenter#', 'AnalysisStatusPresenter', 5, 'class AnalysisStatusPresenter|class AnalysisStatusPresenter'),
        (4, 'semanticdb maven . . fixture/AnalysisStatusPresenter#renderStatusBadge().', 'renderStatusBadge', 12, 'renderStatusBadge|String renderStatusBadge(String rawStatus)'),
        (5, 'semanticdb maven . . fixture/StatusAuditReporter#', 'StatusAuditReporter', 5, 'class StatusAuditReporter|class StatusAuditReporter'),
        (6, 'semanticdb maven . . fixture/StatusAuditReporter#renderAuditStatus().', 'renderAuditStatus', 12, 'renderAuditStatus|String renderAuditStatus(String rawStatus)'),
        (7, 'semanticdb maven . . fixture/StatusBoardReporter#', 'StatusBoardReporter', 5, 'class StatusBoardReporter|class StatusBoardReporter'),
        (8, 'semanticdb maven . . fixture/StatusBoardReporter#renderBoardStatus().', 'renderBoardStatus', 12, 'renderBoardStatus|String renderBoardStatus(String rawStatus)'),
        (9, 'semanticdb maven . . fixture/StatusDigestReporter#', 'StatusDigestReporter', 5, 'class StatusDigestReporter|class StatusDigestReporter'),
        (10, 'semanticdb maven . . fixture/StatusDigestReporter#renderDigestStatus().', 'renderDigestStatus', 12, 'renderDigestStatus|String renderDigestStatus(String rawStatus)'),
        (11, 'semanticdb maven . . fixture/StatusPreviewReporter#', 'StatusPreviewReporter', 5, 'class StatusPreviewReporter|class StatusPreviewReporter'),
        (12, 'semanticdb maven . . fixture/StatusPreviewReporter#renderPreviewStatus().', 'renderPreviewStatus', 12, 'renderPreviewStatus|String renderPreviewStatus(String rawStatus)');

      INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
        (1, 1, 1, 1, 0, 5, 1),
        (2, 1, 2, 2, 2, 4, 3),
        (3, 2, 3, 1, 0, 4, 1),
        (4, 2, 4, 2, 2, 3, 3),
        (5, 3, 5, 1, 0, 5, 1),
        (6, 3, 6, 3, 2, 4, 3),
        (7, 4, 7, 1, 0, 5, 1),
        (8, 4, 8, 3, 2, 4, 3),
        (9, 5, 9, 1, 0, 5, 1),
        (10, 5, 10, 3, 2, 4, 3),
        (11, 6, 11, 1, 0, 5, 1),
        (12, 6, 12, 3, 2, 4, 3);

      INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
        (1, 1, 0, 0, 6, X'00'),
        (2, 2, 0, 0, 5, X'00'),
        (3, 3, 0, 0, 6, X'00'),
        (4, 4, 0, 0, 6, X'00'),
        (5, 5, 0, 0, 6, X'00'),
        (6, 6, 0, 0, 6, X'00');

      INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
        (1, 1, 1),
        (1, 2, 1),
        (2, 3, 1),
        (2, 4, 1),
        (2, 2, 0),
        (3, 5, 1),
        (3, 6, 1),
        (3, 4, 0),
        (4, 7, 1),
        (4, 8, 1),
        (4, 4, 0),
        (5, 9, 1),
        (5, 10, 1),
        (5, 4, 0),
        (6, 11, 1),
        (6, 12, 1),
        (6, 4, 0);
    `);
    sqliteDb.close();

    const config: ScipQueryConfig = {
      dbPath: join(tempDir, 'index.db'),
      indexPath: join(tempDir, 'index.scip'),
      projectRoot,
    };
    db = new ScipDatabase(config);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('recovers callers when file-wide chunks start above every method definition', () => {
    const graph = callGraph(db, 'renderStatusBadge');
    expect(graph?.callers.map((row) => row.shortName)).toEqual(expect.arrayContaining([
      'fixture:StatusAuditReporter:renderAuditStatus()',
      'fixture:StatusBoardReporter:renderBoardStatus()',
      'fixture:StatusDigestReporter:renderDigestStatus()',
      'fixture:StatusPreviewReporter:renderPreviewStatus()',
    ]));
  });

  it('finds wrapper candidates when the sole caller is discovered from source', () => {
    expect(wrapperCandidates(db)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        shortName: 'fixture:StatusBadgeRelay:normalizeBadgeStatus()',
        singleCallerShort: 'fixture:AnalysisStatusPresenter:renderStatusBadge()',
        callerFanIn: 4,
      }),
    ]));
  });
});
