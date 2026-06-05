/**
 * Tier-pinning tests for attributeIdentifier.
 *
 * Each test uses its own leaf, designed so that exactly one disambiguation
 * tier fires. The tiers are layered:
 *   T1. Unique leaf -> that one symbol
 *   T2. Same-file -> that file's candidate wins over global ambiguity
 *   T3. Direct import -> when the LEAF NAME itself is imported by name from
 *       a path that matches a candidate's defining file
 *   T4. Indirect access -> ALL candidates live in a file the referrer imports
 *       anything from (the interface-dispatch fallback)
 *   T5. Otherwise -> empty (no over-attribution)
 */
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
import { attributeIdentifier } from '../src/symbols/identifier-attribution.js';
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
    CREATE INDEX idx_defn_enclosing_ranges_symbol_id ON defn_enclosing_ranges(symbol_id);
    CREATE INDEX idx_defn_enclosing_ranges_document ON defn_enclosing_ranges(document_id, start_line, end_line);
  `);
}

const SCIP_PREFIX = 'scip-typescript npm . . src';

describe('attributeIdentifier — tier pinning', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-attribution-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });

    // ── Leaf `compute`: ambiguous across 2 files (T1/T2/T5 fixture) ──────
    writeFileSync(
      join(projectRoot, 'src', 'lib-a.ts'),
      'export function compute(x: number): number { return x + 1; }\n',
    );
    writeFileSync(
      join(projectRoot, 'src', 'lib-b.ts'),
      'export function compute(x: number): number { return x + 2; }\n',
    );

    // T1: same-file wins
    writeFileSync(
      join(projectRoot, 'src', 'self-referrer.ts'),
      [
        'export function compute(x: number): number { return x; }',
        'export function caller(): number { return compute(2); }',
        '',
      ].join('\n'),
    );

    // T2: directly imports `compute` from lib-a → tier 2 fires, returns
    // only the lib-a candidate (paths-match filter on the ambiguous bucket).
    writeFileSync(
      join(projectRoot, 'src', 'tier2-direct-import.ts'),
      [
        'import { compute } from "./lib-a.js";',
        'export function run(x: number): number { return compute(x); }',
        '',
      ].join('\n'),
    );

    // T5: imports nothing relevant. Bucket is ambiguous (lib-a, lib-b,
    // self-referrer all have `compute`); no signal disambiguates → empty.
    writeFileSync(
      join(projectRoot, 'src', 'tier5-no-signal.ts'),
      [
        'export function unrelated(x: number): number { return x * 2; }',
        '',
      ].join('\n'),
    );

    // ── Leaf `dispatch`: ambiguous within ONE file (T4 fixture) ─────────
    // Both Reader.dispatch and Writer.dispatch live in lib-multi.ts. A
    // consumer that imports any other name from lib-multi.ts gets credited
    // for both via the indirect-dispatch fallback.
    writeFileSync(
      join(projectRoot, 'src', 'lib-multi.ts'),
      [
        'export class Reader {',
        '  dispatch(): void {}',
        '}',
        'export class Writer {',
        '  dispatch(): void {}',
        '}',
        'export function makeReader(): Reader { return new Reader(); }',
        '',
      ].join('\n'),
    );

    // T4: imports `makeReader` (NOT `dispatch`) from lib-multi.ts. Tier 3
    // (direct-import on `dispatch`) doesn't fire — `dispatch` isn't imported
    // by name. Tier 4 fires: lib-multi.ts is in the imported set AND ALL
    // `dispatch` candidates live there.
    writeFileSync(
      join(projectRoot, 'src', 'tier4-indirect.ts'),
      [
        'import { makeReader } from "./lib-multi.js";',
        'export function run(): void {',
        '  const r = makeReader();',
        '  r.dispatch();',
        '}',
        '',
      ].join('\n'),
    );

    // ── Leaf `unique`: only one global definition (T0/unique fixture) ───
    writeFileSync(
      join(projectRoot, 'src', 'lib-unique.ts'),
      'export function unique(x: number): number { return x; }\n',
    );
    writeFileSync(
      join(projectRoot, 'src', 'unique-caller.ts'),
      [
        'import { unique } from "./lib-unique.js";',
        'export function run(x: number): number { return unique(x); }',
        '',
      ].join('\n'),
    );

    const sqliteDb = new Database(join(tempDir, 'index.db'));
    createSchema(sqliteDb);
    sqliteDb.exec(`
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'typescript', 'src/lib-a.ts'),
        (2, 'typescript', 'src/lib-b.ts'),
        (3, 'typescript', 'src/self-referrer.ts'),
        (4, 'typescript', 'src/tier2-direct-import.ts'),
        (5, 'typescript', 'src/tier5-no-signal.ts'),
        (6, 'typescript', 'src/lib-multi.ts'),
        (7, 'typescript', 'src/tier4-indirect.ts'),
        (8, 'typescript', 'src/lib-unique.ts'),
        (9, 'typescript', 'src/unique-caller.ts');

      INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
        -- compute (ambiguous across 3 files)
        (1, '${SCIP_PREFIX}/lib-a.ts/compute().', 'compute', 12, ''),
        (2, '${SCIP_PREFIX}/lib-b.ts/compute().', 'compute', 12, ''),
        (3, '${SCIP_PREFIX}/self-referrer.ts/compute().', 'compute', 12, ''),
        (4, '${SCIP_PREFIX}/self-referrer.ts/caller().', 'caller', 12, ''),
        (5, '${SCIP_PREFIX}/tier2-direct-import.ts/run().', 'run', 12, ''),
        (6, '${SCIP_PREFIX}/tier5-no-signal.ts/unrelated().', 'unrelated', 12, ''),
        -- dispatch (both candidates in same file)
        (7, '${SCIP_PREFIX}/lib-multi.ts/Reader#', 'Reader', 5, ''),
        (8, '${SCIP_PREFIX}/lib-multi.ts/Reader#dispatch().', 'dispatch', 12, ''),
        (9, '${SCIP_PREFIX}/lib-multi.ts/Writer#', 'Writer', 5, ''),
        (10, '${SCIP_PREFIX}/lib-multi.ts/Writer#dispatch().', 'dispatch', 12, ''),
        (11, '${SCIP_PREFIX}/lib-multi.ts/makeReader().', 'makeReader', 12, ''),
        (12, '${SCIP_PREFIX}/tier4-indirect.ts/run().', 'run', 12, ''),
        -- unique (single global candidate)
        (13, '${SCIP_PREFIX}/lib-unique.ts/unique().', 'unique', 12, ''),
        (14, '${SCIP_PREFIX}/unique-caller.ts/run().', 'run', 12, '');

      INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
        (1, 1, 1, 0, 0, 0, 60),
        (2, 2, 2, 0, 0, 0, 60),
        (3, 3, 3, 0, 0, 0, 50),
        (4, 3, 4, 1, 0, 1, 60),
        (5, 4, 5, 1, 0, 1, 60),
        (6, 5, 6, 0, 0, 0, 60),
        (7, 6, 7, 0, 0, 2, 1),
        (8, 6, 8, 1, 2, 1, 30),
        (9, 6, 9, 3, 0, 5, 1),
        (10, 6, 10, 4, 2, 4, 30),
        (11, 6, 11, 6, 0, 6, 80),
        (12, 7, 12, 1, 0, 4, 1),
        (13, 8, 13, 0, 0, 0, 60),
        (14, 9, 14, 1, 0, 1, 70);

      INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
        (1, 1, 0, 0, 1, X'00'),
        (2, 2, 0, 0, 1, X'00'),
        (3, 3, 0, 0, 2, X'00'),
        (4, 4, 0, 0, 2, X'00'),
        (5, 5, 0, 0, 1, X'00'),
        (6, 6, 0, 0, 7, X'00'),
        (7, 7, 0, 0, 5, X'00'),
        (8, 8, 0, 0, 1, X'00'),
        (9, 9, 0, 0, 2, X'00');

      INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
        (1, 1, 1),
        (2, 2, 1),
        (3, 3, 1),
        (3, 4, 1),
        (4, 5, 1),
        (5, 6, 1),
        (6, 7, 1),
        (6, 8, 1),
        (6, 9, 1),
        (6, 10, 1),
        (6, 11, 1),
        (7, 12, 1),
        (8, 13, 1),
        (9, 14, 1);
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

  it('T0 — unique leaf resolves immediately', () => {
    const refs = attributeIdentifier(db, 'src/unique-caller.ts', 'unique');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.symbol).toBe(`${SCIP_PREFIX}/lib-unique.ts/unique().`);
    expect(refs[0]?.relativePath).toBe('src/lib-unique.ts');
  });

  it('T1 — same-file resolution wins over global ambiguity', () => {
    const refs = attributeIdentifier(db, 'src/self-referrer.ts', 'compute');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.relativePath).toBe('src/self-referrer.ts');
  });

  it('T2 — direct import of the leaf wins over global ambiguity', () => {
    // tier2-direct-import.ts has `import { compute } from "./lib-a.js"`.
    // The leaf `compute` is itself in importsByName, so the leaf-imported-
    // from-path tier fires and selects only lib-a's candidate.
    const refs = attributeIdentifier(db, 'src/tier2-direct-import.ts', 'compute');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.relativePath).toBe('src/lib-a.ts');
    expect(refs[0]?.symbol).toBe(`${SCIP_PREFIX}/lib-a.ts/compute().`);
  });

  it('T4 — indirect access credits all candidates in same imported file', () => {
    // tier4-indirect.ts imports `makeReader` (not `dispatch`) from lib-multi.
    // All `dispatch` candidates live in lib-multi.ts, so the indirect tier
    // returns both — interface dispatch could land on either at runtime.
    const refs = attributeIdentifier(db, 'src/tier4-indirect.ts', 'dispatch');
    const symbols = refs.map((r) => r.symbol).sort();
    expect(symbols).toEqual([
      `${SCIP_PREFIX}/lib-multi.ts/Reader#dispatch().`,
      `${SCIP_PREFIX}/lib-multi.ts/Writer#dispatch().`,
    ]);
  });

  it('T5 — no signal returns empty (no over-attribution)', () => {
    const refs = attributeIdentifier(db, 'src/tier5-no-signal.ts', 'compute');
    expect(refs).toEqual([]);
  });
});
