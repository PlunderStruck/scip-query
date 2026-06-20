/**
 * Accuracy regressions for `staleAbstractions`.
 *
 * Each test writes real source files (needed for the source-backed
 * re-export / class / definer-usage detectors) and a matching SQLite
 * index, then asserts the query's confidence tiers and filtering.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { staleAbstractions } from '../../../src/queries/cleanup/stale-abstractions.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { createEvidenceSchema } from '../../fixtures/evidence-fixture.js';

function createSchema(sqliteDb: Database.Database): void {
  createEvidenceSchema(sqliteDb);
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

describe('staleAbstractions accuracy', () => {
  it('does not flag a public-API type whose only consumer re-exports it through a barrel', () => {
    withFixture(
      'barrel-re-export',
      {
        'src/lib.ts': [
          'export interface PublicApi {',
          '  name: string;',
          '  version: number;',
          '  meta: string;',
          '}',
          '',
        ].join('\n'),
        'src/index.ts': ["export { type PublicApi } from './lib.js';", ''].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/lib.ts'),
            (2, 'typescript', 'src/index.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`lib.ts\`/PublicApi#', 'PublicApi', 11);

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 4, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 4, X'00'),
            (2, 2, 0, 0, 1, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 1, 0);
        `);
      },
      (db) => {
        const results = staleAbstractions(db, { minLoc: 3 });
        const hit = results.find((r) => r.shortName.endsWith('PublicApi'));
        expect(hit, 'barrel re-export should not count as a real consumer').toBeUndefined();
      },
    );
  });

  it('treats a re-export as a barrel even when the re-exports "from" path mismatches the definition file', () => {
    withFixture(
      'mismatched-barrel',
      {
        'src/lib.ts': [
          'export interface Shape {',
          '  id: string;',
          '  rank: number;',
          '  grade: number;',
          '}',
          '',
        ].join('\n'),
        'src/index.ts': ["export { type Shape } from './wrong-path.js';", ''].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/lib.ts'),
            (2, 'typescript', 'src/index.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`lib.ts\`/Shape#', 'Shape', 11);

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 4, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 4, X'00'),
            (2, 2, 0, 0, 1, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 1, 0);
        `);
      },
      (db) => {
        const results = staleAbstractions(db, { minLoc: 3 });
        const hit = results.find((r) => r.shortName.endsWith('Shape'));
        expect(hit, 'path mismatch should still be treated as passthrough').toBeUndefined();
      },
    );
  });

  it('counts a mix of one real consumer and one barrel consumer as consumers=1 + barrelConsumers=1', () => {
    withFixture(
      'mixed-consumers',
      {
        'src/lib.ts': ['export interface Entry {', '  id: number;', '  tag: string;', '  note: string;', '}', ''].join(
          '\n',
        ),
        'src/index.ts': ["export { type Entry } from './lib.js';", ''].join('\n'),
        'src/user.ts': [
          "import type { Entry } from './lib.js';",
          'export function describe(e: Entry): string {',
          '  return e.tag;',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/lib.ts'),
            (2, 'typescript', 'src/index.ts'),
            (3, 'typescript', 'src/user.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`lib.ts\`/Entry#', 'Entry', 11),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`user.ts\`/describe().', 'describe', 12);

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 4, 1),
            (2, 3, 2, 1, 0, 3, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 4, X'00'),
            (2, 2, 0, 0, 1, X'00'),
            (3, 3, 0, 0, 3, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 1, 0),
            (3, 1, 0),
            (3, 2, 1);
        `);
      },
      (db) => {
        const results = staleAbstractions(db, { minLoc: 3 });
        const hit = results.find((r) => r.shortName.endsWith('Entry'));
        expect(hit).toBeDefined();
        expect(hit!.consumers).toBe(1);
        expect(hit!.barrelConsumers).toBe(1);
      },
    );
  });

  it('ranks a 1-consumer class as low confidence so it is hidden by default', () => {
    withFixture(
      'class-demotion',
      {
        'src/pane.ts': [
          'export class ReasoningPane {',
          '  private text = "";',
          '  open() { this.text = "open"; }',
          '  close() { this.text = ""; }',
          '  readText() { return this.text; }',
          '}',
          '',
        ].join('\n'),
        'src/owner.ts': [
          "import { ReasoningPane } from './pane.js';",
          'export function createOwner(): ReasoningPane {',
          '  return new ReasoningPane();',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/pane.ts'),
            (2, 'typescript', 'src/owner.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`pane.ts\`/ReasoningPane#', 'ReasoningPane', 10),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`owner.ts\`/createOwner().', 'createOwner', 12);

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 5, 1),
            (2, 2, 2, 1, 0, 3, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 5, X'00'),
            (2, 2, 0, 0, 3, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 1, 0),
            (2, 2, 1);
        `);
      },
      (db) => {
        const defaultResults = staleAbstractions(db, { minLoc: 3 });
        expect(defaultResults.find((r) => r.shortName.endsWith('ReasoningPane'))).toBeUndefined();

        const inclusive = staleAbstractions(db, { minLoc: 3, includeLowConfidence: true });
        const hit = inclusive.find((r) => r.shortName.endsWith('ReasoningPane'));
        expect(hit).toBeDefined();
        expect(hit!.kind).toBe('class');
        expect(hit!.confidence).toBe('low');
      },
    );
  });

  it('promotes a type whose defining file never uses it outside the declaration to high confidence', () => {
    withFixture(
      'misplaced-type',
      {
        'src/shapes.ts': [
          'export interface Payload {',
          '  kind: string;',
          '  body: string;',
          '  seq: number;',
          '}',
          '',
          'export const SHAPE_VERSION = 1;',
          '',
        ].join('\n'),
        'src/service.ts': [
          "import type { Payload } from './shapes.js';",
          'export function handle(p: Payload): string {',
          '  return p.kind;',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/shapes.ts'),
            (2, 'typescript', 'src/service.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`shapes.ts\`/Payload#', 'Payload', 11),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`service.ts\`/handle().', 'handle', 12);

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 4, 1),
            (2, 2, 2, 1, 0, 3, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 6, X'00'),
            (2, 2, 0, 0, 3, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 1, 0),
            (2, 2, 1);
        `);
      },
      (db) => {
        const results = staleAbstractions(db, { minLoc: 3 });
        const hit = results.find((r) => r.shortName.endsWith('Payload'));
        expect(hit).toBeDefined();
        expect(hit!.confidence).toBe('high');
        expect(hit!.definerUsesType).toBe(false);
      },
    );
  });

  it('demotes to medium when the defining file uses the type in its own declarations', () => {
    withFixture(
      'self-use',
      {
        'src/service.ts': [
          'export interface Args {',
          '  path: string;',
          '  flag: boolean;',
          '}',
          '',
          'export function run(args: Args): string {',
          '  return args.path;',
          '}',
          '',
        ].join('\n'),
        'src/client.ts': [
          "import { run, type Args } from './service.js';",
          'export function call(a: Args): string {',
          '  return run(a);',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/service.ts'),
            (2, 'typescript', 'src/client.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`service.ts\`/Args#', 'Args', 11),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`service.ts\`/run().', 'run', 12),
            (3, 'scip-typescript npm fixture 1.0.0 src/\`client.ts\`/call().', 'call', 12);

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 3, 1),
            (2, 1, 2, 5, 0, 7, 1),
            (3, 2, 3, 1, 0, 3, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 7, X'00'),
            (2, 2, 0, 0, 3, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (1, 1, 0),
            (1, 2, 1),
            (2, 1, 0),
            (2, 2, 0),
            (2, 3, 1);
        `);
      },
      (db) => {
        const results = staleAbstractions(db, { minLoc: 3 });
        const hit = results.find((r) => r.shortName.endsWith('Args'));
        expect(hit).toBeDefined();
        expect(hit!.definerUsesType).toBe(true);
        expect(hit!.confidence).toBe('medium');
      },
    );
  });
});
