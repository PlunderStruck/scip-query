import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { similarSignatures } from '../../../src/queries/cleanup/similar-signatures.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';

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
    writeFileSync(
      join(projectRoot, 'src', 'BulkIssueService.ts'),
      [
        'export class BulkIssueService {',
        '  async bulkArchive(issueIds: string[], userId: string): Promise<{ updated: number }> {',
        '    return { updated: issueIds.length };',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'src', 'BulkIssueRepository.ts'),
      [
        'export class BulkIssueRepository {',
        '  async bulkRestore(issueIds: string[], userId: string): Promise<{ updated: number }> {',
        '    return { updated: issueIds.length };',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'src', 'Particle.rs'),
      'pub struct Particle { pub position: Vec3 }\nimpl Default for Particle { fn default() -> Self { todo!() } }\n',
    );
    writeFileSync(
      join(projectRoot, 'src', 'Trail.rs'),
      'pub struct Trail { pub position: Vec3 }\nimpl Default for Trail { fn default() -> Self { todo!() } }\n',
    );

    const sqliteDb = new Database(join(tempDir, 'index.db'));
    createSchema(sqliteDb);
    sqliteDb.exec(`
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'java', 'src/StatusAuditReporter.java'),
        (2, 'java', 'src/StatusBoardReporter.java'),
        (3, 'java', 'src/StatusDigestReporter.java'),
        (4, 'typescript', 'src/BulkIssueService.ts'),
        (5, 'typescript', 'src/BulkIssueRepository.ts'),
        (6, 'rust', 'src/Particle.rs'),
        (7, 'rust', 'src/Trail.rs');

      INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
        (1, 'semanticdb maven . . fixture/StatusAuditReporter#', 'StatusAuditReporter', 7, 'class StatusAuditReporter|class StatusAuditReporter'),
        (2, 'semanticdb maven . . fixture/StatusAuditReporter#renderAuditStatus().', 'renderAuditStatus', 26, 'semanticdb maven . . fixture/StatusAuditReporter#renderAuditStatus().|'),
        (3, 'semanticdb maven . . fixture/StatusBoardReporter#', 'StatusBoardReporter', 7, 'class StatusBoardReporter|class StatusBoardReporter'),
        (4, 'semanticdb maven . . fixture/StatusBoardReporter#renderBoardStatus().', 'renderBoardStatus', 26, 'semanticdb maven . . fixture/StatusBoardReporter#renderBoardStatus().|'),
        (5, 'semanticdb maven . . fixture/StatusDigestReporter#', 'StatusDigestReporter', 7, 'class StatusDigestReporter|class StatusDigestReporter'),
        (6, 'semanticdb maven . . fixture/StatusDigestReporter#renderDigestStatus().', 'renderDigestStatus', 26, 'semanticdb maven . . fixture/StatusDigestReporter#renderDigestStatus().|'),
        (7, 'scip-typescript npm fixture 1.0.0 src/\`BulkIssueService.ts\`/BulkIssueService#', 'BulkIssueService', 7, NULL),
        (8, 'scip-typescript npm fixture 1.0.0 src/\`BulkIssueService.ts\`/BulkIssueService#bulkArchive().', 'bulkArchive', 26, NULL),
        (9, 'scip-typescript npm fixture 1.0.0 src/\`BulkIssueRepository.ts\`/BulkIssueRepository#', 'BulkIssueRepository', 7, NULL),
        (10, 'scip-typescript npm fixture 1.0.0 src/\`BulkIssueRepository.ts\`/BulkIssueRepository#bulkRestore().', 'bulkRestore', 26, NULL),
        (11, 'rust-analyzer cargo fixture 0.1.0 model/Particle#position.', 'position', 15, 'fn position(value: Vec3)'),
        (12, 'rust-analyzer cargo fixture 0.1.0 model/Trail#position.', 'position', 15, 'fn position(value: Vec3)'),
        (13, 'rust-analyzer cargo fixture 0.1.0 model/impl#[Particle][Default]default().', 'default', 26, 'fn default() -> Self'),
        (14, 'rust-analyzer cargo fixture 0.1.0 model/impl#[Trail][Default]default().', 'default', 26, 'fn default() -> Self');

      INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
        (1, 1, 1, 1, 0, 4, 1),
        (2, 1, 2, 2, 2, 3, 3),
        (3, 2, 3, 1, 0, 4, 1),
        (4, 2, 4, 2, 2, 3, 3),
        (5, 3, 5, 1, 0, 4, 1),
        (6, 3, 6, 2, 2, 3, 3),
        (7, 4, 7, 0, 0, 4, 1),
        (8, 4, 8, 1, 2, 3, 3),
        (9, 5, 9, 0, 0, 4, 1),
        (10, 5, 10, 1, 2, 3, 3),
        (11, 6, 11, 0, 0, 0, 48),
        (12, 7, 12, 0, 0, 0, 45),
        (13, 6, 13, 1, 0, 1, 71),
        (14, 7, 14, 1, 0, 1, 65);
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
    const reporterGroup = groups.find((group) =>
      group.functions.some((fn) => fn.shortName === 'fixture:StatusAuditReporter:renderAuditStatus()'),
    );
    expect(reporterGroup?.functions.map((fn) => fn.shortName)).toEqual(
      expect.arrayContaining([
        'fixture:StatusAuditReporter:renderAuditStatus()',
        'fixture:StatusBoardReporter:renderBoardStatus()',
      ]),
    );
    expect(reporterGroup?.functions.map((fn) => fn.shortName)).not.toContain(
      'fixture:StatusDigestReporter:renderDigestStatus()',
    );
  });

  it('keeps object return types intact when normalizing TypeScript source signatures', () => {
    const groups = similarSignatures(db, { minLoc: 1 });
    const bulkGroup = groups.find((group) =>
      group.functions.some((fn) => fn.shortName === 'src:BulkIssueService:BulkIssueService:bulkArchive()'),
    );

    expect(bulkGroup?.signature).toBe('(issueids:string[],userid:string):promise<{updated:number}>');
    expect(bulkGroup?.functions.map((fn) => fn.shortName)).toEqual(
      expect.arrayContaining([
        'src:BulkIssueService:BulkIssueService:bulkArchive()',
        'src:BulkIssueRepository:BulkIssueRepository:bulkRestore()',
      ]),
    );
  });

  it('excludes Rust fields even when their index metadata contains callable-looking documentation', () => {
    const groups = similarSignatures(db, { minLoc: 1, semantic: false });
    const names = groups.flatMap((group) => group.functions.map((fn) => fn.shortName));
    expect(names).not.toContain('model:Particle:position');
    expect(names).not.toContain('model:impl:Particle:Default:default()');
  });
});
