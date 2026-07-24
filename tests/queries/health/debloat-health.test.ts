import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { classifyFile, getLiveBarrelPaths, isEntrySurface } from '../../../src/analysis/file-classifier.js';
import { dead } from '../../../src/queries/cleanup/dead.js';
import { health } from '../../../src/queries/health/health.js';
import {
  checkHealthBaseline,
  normalizeBaselineFindingIdentity,
  writeHealthBaseline,
} from '../../../src/queries/health/health-baseline.js';
import { isolated } from '../../../src/queries/cleanup/isolated.js';
import { selfAudit } from '../../../src/queries/quality/self-audit.js';
import { redundantReexports } from '../../../src/queries/cleanup/redundant-reexports.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';

function createDebloatFixtureDb(dbPath: string): void {
  const sqliteDb = new Database(dbPath);
  const run = (sql: string) => sqliteDb.exec(sql);

  run(`
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

  run(`
    INSERT INTO documents (id, language, relative_path) VALUES
      (1, 'typescript', 'src/cli.ts'),
      (2, 'typescript', 'src/index.ts'),
      (3, 'typescript', 'src/queries/index.ts'),
      (4, 'typescript', 'src/queries/health/health.ts'),
      (5, 'typescript', 'src/queries/cleanup/redundant-reexports.ts'),
      (6, 'typescript', 'src/reindex-worker.ts'),
      (7, 'typescript', 'src/unused/index.ts'),
      (8, 'typescript', 'src/unused/helper.ts'),
      (9, 'typescript', 'src/postinstall.ts');
  `);

  const insertSymbol = sqliteDb.prepare(
    `INSERT INTO global_symbols (id, symbol, display_name, kind, documentation)
     VALUES (?, ?, ?, ?, ?)`,
  );

  insertSymbol.run(1, 'src:cli', 'cli', 1, 'CLI module');
  insertSymbol.run(2, 'src:index', 'index', 1, 'Root entry surface');
  insertSymbol.run(3, 'src:queries:index', 'queries/index', 1, 'Queries barrel');
  insertSymbol.run(4, 'src:queries:health:health().', 'health', 3, 'health query');
  insertSymbol.run(
    5,
    'src:queries:redundant-reexports:redundantReexports().',
    'redundantReexports',
    3,
    'redundant re-export query',
  );
  insertSymbol.run(6, 'src:reindex-worker', 'reindex-worker', 1, 'Worker entry surface');
  insertSymbol.run(7, 'src:unused:helper:unusedHelper().', 'unusedHelper', 3, 'Only referenced by an inactive barrel');
  insertSymbol.run(8, 'src:postinstall', 'postinstall', 1, 'Postinstall entry surface');

  run(`
    INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
      (1, 1, 1, 0, 0, 5, 0),
      (2, 2, 2, 0, 0, 4, 0),
      (3, 3, 3, 0, 0, 5, 0),
      (4, 4, 4, 10, 0, 20, 0),
      (5, 5, 5, 10, 0, 18, 0),
      (6, 6, 6, 0, 0, 4, 0),
      (7, 8, 7, 12, 0, 18, 0),
      (8, 9, 8, 0, 0, 3, 0);
  `);

  run(`
    INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
      (1, 1, 0, 0, 5, X'00'),
      (2, 2, 0, 0, 4, X'00'),
      (3, 3, 0, 0, 5, X'00'),
      (4, 4, 0, 10, 20, X'00'),
      (5, 5, 0, 10, 18, X'00'),
      (6, 6, 0, 0, 4, X'00'),
      (7, 7, 0, 0, 4, X'00'),
      (8, 8, 0, 12, 18, X'00'),
      (9, 9, 0, 0, 3, X'00');
  `);

  run(`
    INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
      (1, 1, 1),
      (1, 3, 0),
      (2, 2, 1),
      (2, 3, 0),
      (3, 3, 1),
      (3, 4, 0),
      (3, 5, 0),
      (4, 4, 1),
      (5, 5, 1),
      (6, 6, 1),
      (7, 7, 0),
      (8, 7, 1),
      (9, 8, 1);
  `);

  sqliteDb.close();
}

describe('debloat liveness regressions', () => {
  let db: ScipDatabase;

  beforeAll(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-debloat-'));
    const dbPath = join(tempDir, 'index.db');
    createDebloatFixtureDb(dbPath);

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    };

    db = new ScipDatabase(config);
  });

  afterAll(() => {
    db.close();
  });

  it('tracks live barrels from structural entry surfaces', () => {
    const liveBarrels = getLiveBarrelPaths(db);

    expect(classifyFile('apps/api/src/index.ts')).toBe('entry');
    expect(classifyFile('apps/api/src/modules/auth/index.ts')).toBe('barrel');
    expect(liveBarrels.has('src/queries/index.ts')).toBe(true);
    expect(liveBarrels.has('src/unused/index.ts')).toBe(false);
    expect(isEntrySurface(db, 'src/reindex-worker.ts')).toBe(true);
    expect(isEntrySurface(db, 'src/queries/index.ts')).toBe(true);
    expect(isEntrySurface(db, 'src/unused/index.ts')).toBe(false);
  });

  it('keeps live barrel consumers out of dead-code results when skipBarrels is enabled', () => {
    const result = dead(db, { minLoc: 1, skipBarrels: true });
    const shortNames = result.symbols.map((symbol) => symbol.shortName);

    expect(shortNames.some((name) => name.includes('unusedHelper'))).toBe(true);
    expect(shortNames.some((name) => name.includes('health'))).toBe(false);
    expect(shortNames.some((name) => name.includes('redundantReexports'))).toBe(false);
    expect(shortNames.some((name) => name.includes('src:cli'))).toBe(false);
    expect(shortNames.some((name) => name.includes('src:index'))).toBe(false);
  });

  it('skips redundant re-exports from live barrels but still reports inactive ones', () => {
    const results = redundantReexports(db);
    const barrelFiles = results.map((result) => result.barrelFile);
    const shortNames = results.map((result) => result.shortName);

    expect(barrelFiles).toContain('src/unused/index.ts');
    expect(shortNames.some((name) => name.includes('unusedHelper'))).toBe(true);
    expect(barrelFiles).not.toContain('src/queries/index.ts');
  });

  it('reuses entry-surface rules in health scoring', () => {
    const report = health(db);

    expect(report.findings.deadSymbols).toBe(1);
    expect(report.findings.isolatedSymbols).toBe(0);
    expect(report.warnings).toBeUndefined();
    expect(report.actions.some((action) => action.category === 'Dead code' && action.count === 1)).toBe(true);
    expect(report.actions.some((action) => action.category === 'Isolated symbols')).toBe(false);
  });

  it('keeps runtime entry surfaces out of isolated results too', () => {
    const results = isolated(db, { minLoc: 1 });
    const shortNames = results.map((result) => result.shortName);

    expect(shortNames.some((name) => name.includes('src:cli'))).toBe(false);
    expect(shortNames.some((name) => name.includes('src:index'))).toBe(false);
    expect(shortNames.some((name) => name.includes('reindex-worker'))).toBe(false);
    expect(shortNames.some((name) => name.includes('postinstall'))).toBe(false);
  });

  it('reports self-audit as unavailable without a semantic provider', () => {
    const result = selfAudit(db, { samples: 5 });

    expect(result.available).toBe(false);
    expect(result.scores).toEqual([]);
  });

  it('ratchets findings through write-baseline / check-baseline round trips', () => {
    const written = writeHealthBaseline(db);
    expect(written.findingCount).toBeGreaterThan(0);

    // Same findings → no new, no fixed.
    const clean = checkHealthBaseline(db);
    expect(clean.newFindings).toEqual([]);
    expect(clean.fixedFindings).toEqual([]);

    // Tamper: drop one baselined finding → the check reports it as new.
    const baseline = JSON.parse(readFileSync(written.path, 'utf-8')) as { version: 1; findings: string[] };
    const removed = baseline.findings.pop()!;
    writeFileSync(written.path, JSON.stringify(baseline));
    const regressed = checkHealthBaseline(db);
    expect(regressed.newFindings).toEqual([removed]);
  });

  it('keeps pair identities stable across SCIP package versions and legacy baselines', () => {
    const similar018 =
      'similar:scip-typescript npm scip-query 0.18.0 src/a/`one.ts`/first().|scip-typescript npm scip-query 0.18.0 src/b/`two.ts`/second().';
    const similar019 =
      'similar:scip-typescript npm scip-query 0.19.0 src/a/`one.ts`/first().|scip-typescript npm scip-query 0.19.0 src/b/`two.ts`/second().';
    const duplicate018 =
      'duplicate-bodies:abc123:scip-typescript npm scip-query 0.18.0 src/a/`one.ts`/first().|scip-typescript npm scip-query 0.18.0 src/b/`two.ts`/second().';
    const duplicate019 =
      'duplicate-bodies:abc123:scip-typescript npm scip-query 0.19.0 src/a/`one.ts`/first().|scip-typescript npm scip-query 0.19.0 src/b/`two.ts`/second().';
    const stableSimilar = 'similar:src:a:one:first()|src:b:two:second()';
    const reversedSimilar019 =
      'similar:scip-typescript npm scip-query 0.19.0 src/b/`two.ts`/second().|scip-typescript npm scip-query 0.19.0 src/a/`one.ts`/first().';

    expect(normalizeBaselineFindingIdentity(similar018)).toBe(stableSimilar);
    expect(normalizeBaselineFindingIdentity(similar019)).toBe(normalizeBaselineFindingIdentity(similar018));
    expect(normalizeBaselineFindingIdentity(reversedSimilar019)).toBe(stableSimilar);
    expect(normalizeBaselineFindingIdentity(stableSimilar)).toBe(stableSimilar);
    expect(normalizeBaselineFindingIdentity(duplicate019)).toBe(normalizeBaselineFindingIdentity(duplicate018));
    expect(normalizeBaselineFindingIdentity('architecture:forbidden:runtime>domain')).toBe(
      'architecture:forbidden:runtime>domain',
    );
  });
});
