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
  it('keeps Python models live through inheritance and multi-level nested response schemas', () => {
    withFixture(
      'python-transitive-models',
      {
        'models.py': [
          'class InnerModel:',
          '    value: str',
          '    rank: int',
          '',
          'class BaseModel:',
          '    base_id: str',
          '    created_at: str',
          '',
          'class DerivedModel(BaseModel):',
          '    inner: InnerModel',
          '    label: str',
          '',
          'class Envelope:',
          '    derived: DerivedModel',
          '    status: str',
          '',
          'class PublicResponse:',
          '    envelope: Envelope',
          '    request_id: str',
          '',
        ].join('\n'),
        'consumer.py': [
          'from models import PublicResponse',
          '',
          'def render(value: PublicResponse):',
          '    return value',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'python', 'models.py'),
            (2, 'python', 'consumer.py');

          INSERT INTO global_symbols (id, symbol, display_name, kind) VALUES
            (1, 'scip-python python fixture 1.0.0 models/InnerModel#', 'InnerModel', 5),
            (2, 'scip-python python fixture 1.0.0 models/BaseModel#', 'BaseModel', 5),
            (3, 'scip-python python fixture 1.0.0 models/DerivedModel#', 'DerivedModel', 5),
            (4, 'scip-python python fixture 1.0.0 models/Envelope#', 'Envelope', 5),
            (5, 'scip-python python fixture 1.0.0 models/PublicResponse#', 'PublicResponse', 5),
            (6, 'scip-python python fixture 1.0.0 consumer/render().', 'render', 12);

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 2, 13),
            (2, 1, 2, 4, 0, 6, 19),
            (3, 1, 3, 8, 0, 10, 14),
            (4, 1, 4, 12, 0, 14, 15),
            (5, 1, 5, 16, 0, 18, 19),
            (6, 2, 6, 2, 0, 3, 16);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 19, X'00'),
            (2, 2, 0, 0, 4, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1), (1, 2, 1), (1, 3, 1), (1, 4, 1), (1, 5, 1),
            (2, 5, 0), (2, 6, 1);
        `);
      },
      (db) => {
        const results = staleAbstractions(db, { minLoc: 3, includeLowConfidence: true });
        for (const liveType of ['InnerModel', 'BaseModel', 'DerivedModel', 'Envelope']) {
          expect(
            results.find((result) => result.shortName.endsWith(liveType)),
            `${liveType} is transitively exposed by PublicResponse`,
          ).toBeUndefined();
        }
      },
    );
  });

  it('excludes ambient declaration contracts from repository liveness scoring', () => {
    withFixture(
      'ambient-declaration',
      {
        'src/env.d.ts': [
          'declare namespace JSX {',
          '  interface IntrinsicElements {',
          '    [elementName: string]: unknown;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/env.d.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`env.d.ts\`/JSX/IntrinsicElements#', 'IntrinsicElements', 11);

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 1, 0, 4, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 5, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1);
        `);
      },
      (db) => {
        expect(staleAbstractions(db, { minLoc: 3, includeLowConfidence: true })).toEqual([]);
      },
    );
  });

  it('marks a zero-consumer type as a direct unused-abstraction cleanup', () => {
    withFixture(
      'unused-type',
      {
        'src/lib.ts': [
          'export interface UnusedShape {',
          '  id: string;',
          '  name: string;',
          '  rank: number;',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/lib.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`lib.ts\`/UnusedShape#', 'UnusedShape', 11);

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 4, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 4, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1);
        `);
      },
      (db) => {
        const results = staleAbstractions(db, { minLoc: 3 });
        const hit = results.find((r) => r.shortName.endsWith('UnusedShape'));
        expect(hit).toBeDefined();
        expect(hit!.confidence).toBe('high');
        expect(hit!.actionTier).toBe('direct');
        expect(hit!.stalenessKind).toBe('unused-abstraction');
        expect(hit!.recommendation).toContain('Delete the abstraction or wire the missing consumer');
      },
    );
  });

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
        expect(hit!.actionTier).toBe('signal');
        expect(hit!.stalenessKind).toBe('misplaced-single-consumer-type');
        expect(hit!.recommendation).toContain('co-locating the type with its only real consumer');
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
        expect(hit!.actionTier).toBe('signal');
        expect(hit!.stalenessKind).toBe('one-to-one-class-encapsulation');
        expect(hit!.recommendation).toContain('one-consumer class may be intentional encapsulation');
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
        expect(hit!.actionTier).toBe('signal');
        expect(hit!.stalenessKind).toBe('misplaced-single-consumer-type');
        expect(hit!.recommendation).toContain('only real consumer');
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
        expect(hit!.actionTier).toBe('signal');
        expect(hit!.stalenessKind).toBe('single-consumer-abstraction');
        expect(hit!.recommendation).toContain('single-consumer abstraction');
      },
    );
  });

  // Reproduces the archetype from docs/plans/2026-07-02-followups.md item 1 /
  // the 2026-07-01 Stable_Management calibration (OrgMember/OrgInvite/
  // OrgAssignment falsely "unused"): scip-typescript emits zero mention rows
  // for a symbol consumed only through a whole-statement `import type { X }
  // from '@alias/...'` clause when the alias is unresolvable to it (root
  // cause confirmed live: raw `mentions` table has 0 cross-file rows for
  // this shape on the real repo). The only remaining evidence is the
  // source-fallback layer (`sourceImportPathsByLocalName` ->
  // `resolveImportPath`), which used to return `sourcePath: null` for any
  // non-relative specifier — including tsconfig `paths` aliases — so the
  // fallback also came up empty and the type was reported "unused".
  it('does not report a type-only tsconfig-path-aliased consumer as unused when SCIP has no mention for it', () => {
    withFixture(
      'aliased-type-only-import',
      {
        'tsconfig.json': JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
          include: ['src/**/*.ts'],
        }),
        'src/lib.ts': ['export interface AliasedShape {', '  id: string;', '  label: string;', '}', ''].join('\n'),
        'src/consumer.ts': [
          "import type { AliasedShape } from '@/lib';",
          'export function useShape(value: AliasedShape): string {',
          '  return value.label;',
          '}',
          '',
        ].join('\n'),
        // A second, unrelated same-leaf-name type elsewhere in the project.
        // Without this, `attributeIdentifier`'s global-leaf-index shortcut
        // (bucket.length === 1 -> resolve immediately, no import lookup
        // needed) would make this fixture pass even with the resolver bug
        // still in place, since "AliasedShape" would already be unambiguous
        // project-wide. The real Stable_Management repro (OrgMember) had
        // two same-named candidates — one per package — which is exactly
        // what forces attribution through the broken import-path-resolution
        // branch this fix targets.
        'src/other/unrelated.ts': [
          'export interface AliasedShape {',
          '  different: true;',
          '}',
          'export function noop(x: AliasedShape): boolean {',
          '  return x.different;',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/lib.ts'),
            (2, 'typescript', 'src/consumer.ts'),
            (3, 'typescript', 'src/other/unrelated.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`lib.ts\`/AliasedShape#', 'AliasedShape', 11),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`consumer.ts\`/useShape().', 'useShape', 12),
            (3, 'scip-typescript npm fixture 1.0.0 src/other/\`unrelated.ts\`/AliasedShape#', 'AliasedShape', 11),
            (4, 'scip-typescript npm fixture 1.0.0 src/other/\`unrelated.ts\`/noop().', 'noop', 12);

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 3, 1),
            (2, 2, 2, 1, 0, 3, 1),
            (3, 3, 3, 0, 0, 2, 1),
            (4, 3, 4, 3, 0, 5, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 3, X'00'),
            (2, 2, 0, 0, 3, X'00'),
            (3, 3, 0, 0, 5, X'00');

          -- Definition-site rows only. No row at all for consumer.ts's
          -- chunk (2, ...) referencing symbol 1 — this is the real indexer
          -- gap being reproduced, not an omission. unrelated.ts's own
          -- self-file usage of its own (different) AliasedShape is real
          -- SCIP evidence, same as any ordinary same-file type usage.
          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (3, 3, 1),
            (3, 3, 0),
            (3, 4, 1);
        `);
      },
      (db) => {
        // semantic: false isolates this test to the source-fallback layer
        // this fix targets; the fixture's tiny tsconfig also has no real
        // ts-morph project wiring to lean on.
        const results = staleAbstractions(db, { minLoc: 3, semantic: false });
        const hit = results.find((r) => r.shortName.endsWith('AliasedShape') && r.file === 'src/lib.ts');
        expect(hit).toBeDefined();
        expect(hit!.consumers).toBe(1);
        expect(hit!.reason).not.toContain('unused');
        expect(hit!.stalenessKind).not.toBe('unused-abstraction');
      },
    );
  });
});
