import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../src/storage/db.js';
import { health } from '../src/queries/health.js';
import type { ScipQueryConfig } from '../src/domain/types.js';

function createHealthFullFixtureDb(dbPath: string): void {
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
      (1, 'typescript', 'src/similar-burst.ts');
  `);

  const insertSymbol = sqliteDb.prepare(
    `INSERT INTO global_symbols (id, symbol, display_name, kind, documentation)
     VALUES (?, ?, ?, 3, ?)`,
  );
  const insertDefinition = sqliteDb.prepare(
    `INSERT INTO defn_enclosing_ranges
      (id, document_id, symbol_id, start_line, start_char, end_line, end_char)
     VALUES (?, 1, ?, ?, 0, ?, 0)`,
  );
  const insertChunk = sqliteDb.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences)
     VALUES (?, 1, 0, ?, ?, X'00')`,
  );
  const insertMention = sqliteDb.prepare(
    'INSERT INTO mentions (chunk_id, symbol_id, role) VALUES (?, ?, ?)',
  );

  const callerIdsByGroup: number[][] = [[], []];
  const helperIdsByGroup: number[][] = [[], []];
  const chunkIdBySymbolId = new Map<number, number>();
  let symbolId = 1;
  let rangeId = 1;
  let chunkId = 1;

  for (let group = 0; group < 2; group += 1) {
    for (let i = 0; i < 8; i += 1) {
      const id = symbolId;
      const name = `group${group}Caller${i}`;
      callerIdsByGroup[group]!.push(id);
      insertSymbol.run(
        id,
        `scip-typescript npm fixture 1.0.0 src/\`similar-burst.ts\`/${name}().`,
        name,
        'fixture caller',
      );
      symbolId += 1;
    }
    for (let i = 0; i < 4; i += 1) {
      const id = symbolId;
      const name = `group${group}Helper${i}`;
      helperIdsByGroup[group]!.push(id);
      insertSymbol.run(
        id,
        `scip-typescript npm fixture 1.0.0 src/\`similar-burst.ts\`/${name}().`,
        name,
        'fixture helper',
      );
      symbolId += 1;
    }
  }

  const allSymbols = [...callerIdsByGroup.flat(), ...helperIdsByGroup.flat()];
  for (const id of allSymbols) {
    const startLine = id * 10;
    const endLine = startLine + 6;
    insertDefinition.run(rangeId, id, startLine, endLine);
    insertChunk.run(chunkId, startLine, endLine);
    insertMention.run(chunkId, id, 1);
    chunkIdBySymbolId.set(id, chunkId);
    rangeId += 1;
    chunkId += 1;
  }

  for (let group = 0; group < 2; group += 1) {
    for (const callerId of callerIdsByGroup[group]!) {
      const callerChunkId = chunkIdBySymbolId.get(callerId)!;
      for (const helperId of helperIdsByGroup[group]!) {
        insertMention.run(callerChunkId, helperId, 0);
      }
    }
  }

  sqliteDb.close();
}

describe('health --full', () => {
  let db: ScipDatabase;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-health-full-'));
    const dbPath = join(tempDir, 'index.db');
    createHealthFullFixtureDb(dbPath);

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    };
    db = new ScipDatabase(config);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes the health detector result cap when full is true', () => {
    const regularReport = health(db);
    const fullReport = health(db, { full: true });

    expect(regularReport.findings.similarPairs).toBe(50);
    expect(fullReport.findings.similarPairs).toBe(56);
    expect(regularReport.pressure).toEqual([]);
    expect(fullReport.pressure).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          axis: 'similar-pressure',
          category: 'Similar functions',
          count: 56,
          threshold: 50,
          extraPenalty: 1,
        }),
      ]),
    );
    expect(fullReport.scoreBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          axis: 'similar-pressure',
          points: 1,
          kind: 'hygiene',
        }),
      ]),
    );
    expect(fullReport.hygieneScore).toBeLessThan(regularReport.hygieneScore);
  });
});
