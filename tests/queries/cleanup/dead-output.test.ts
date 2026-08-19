import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { dead } from '../../../src/queries/cleanup/dead.js';
import { renderDeadGroup } from '../../../src/runtime/query-commands/cleanup/renderers.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { createEvidenceSchema } from '../../fixtures/evidence-fixture.js';

const sym = (name: string) => `scip-typescript npm fixture 1.0.0 src/\`foo.ts\`/${name}().`;
const publicSym = (name: string) => `scip-typescript npm fixture 1.0.0 src/\`public.ts\`/${name}().`;
const internalSym = (name: string) => `scip-typescript npm fixture 1.0.0 src/\`internal.ts\`/${name}().`;
const contractSym = (owner: string, name: string) =>
  `scip-typescript npm fixture 1.0.0 src/\`contracts.ts\`/${owner}#${name}().`;
const routeSym = (name: string) => `scip-typescript npm fixture 1.0.0 src/app/api/health/\`route.ts\`/${name}().`;
const instrumentationClientSym = (name: string) =>
  `scip-typescript npm fixture 1.0.0 \`instrumentation-client.ts\`/${name}().`;
const rustSym = (file: string, name: string) => `rust-analyzer cargo fixture 0.1.0 ${file}/${name}().`;

function withDeadFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-dead-output-'));
  const projectRoot = join(tempDir, 'project');
  const dbPath = join(tempDir, 'index.db');
  try {
    const sourcePath = join(projectRoot, 'src', 'foo.ts');
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(
      sourcePath,
      [
        'export function unusedExport() {',
        '  return 1;',
        '}',
        '',
        'export function testOnlyExport() {',
        '  return 2;',
        '}',
        '',
        'export function internalOnly() {',
        '  return shared();',
        '}',
        '',
        'function shared() {',
        '  return 3;',
        '}',
        '',
      ].join('\n'),
    );
    const testPath = join(projectRoot, 'tests', 'foo.test.ts');
    mkdirSync(dirname(testPath), { recursive: true });
    writeFileSync(
      testPath,
      ["import { testOnlyExport } from '../src/foo.js';", '', 'testOnlyExport();', ''].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'src', 'public.ts'),
      ['export function publicApi() {', '  return 3;', '}', ''].join('\n'),
    );
    writeFileSync(join(projectRoot, 'src', 'index.ts'), "export * from './internal.js';\n");
    writeFileSync(
      join(projectRoot, 'src', 'internal.ts'),
      ['export function transitivelyPublicApi() {', '  return 4;', '}', ''].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'src', 'contracts.ts'),
      [
        'export interface Executor {',
        '  readFile(path: string): Promise<string>;',
        '}',
        'export abstract class Base {',
        '  constructor(protected readonly value: string) {}',
        '}',
        'class Boundary extends Component {',
        '  static getDerivedStateFromError() { return {}; }',
        '}',
        'class Provider implements Executor {',
        "  readFile(): Promise<string> { return Promise.resolve('ok'); }",
        '}',
        'class Plain {',
        '  unusedMethod() { return 1; }',
        '}',
        '',
      ].join('\n'),
    );
    const routePath = join(projectRoot, 'src', 'app', 'api', 'health', 'route.ts');
    mkdirSync(dirname(routePath), { recursive: true });
    writeFileSync(
      routePath,
      [
        'export function GET() {',
        '  return Response.json({ ok: true });',
        '}',
        '',
        'export function unusedRouteHelper() {',
        '  return 4;',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'instrumentation-client.ts'),
      'export function onRouterTransitionStart() { return true; }\n',
    );
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        exports: {
          '.': './dist/index.js',
          './public': './dist/public.js',
        },
      }),
    );

    const sqliteDb = new Database(dbPath);
    createEvidenceSchema(sqliteDb);
    sqliteDb.exec(`
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'typescript', 'src/foo.ts'),
        (2, 'typescript', 'src/public.ts'),
        (3, 'typescript', 'src/app/api/health/route.ts'),
        (4, 'typescript', 'src/index.ts'),
        (5, 'typescript', 'src/internal.ts'),
          (6, 'typescript', 'src/contracts.ts'),
          (7, 'typescript', 'instrumentation-client.ts');

      INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
        (1, '${sym('unusedExport')}', 'unusedExport', 3, 'function unusedExport'),
        (2, '${sym('testOnlyExport')}', 'testOnlyExport', 3, 'function testOnlyExport'),
        (3, '${sym('internalOnly')}', 'internalOnly', 3, 'function internalOnly'),
        (4, '${sym('shared')}', 'shared', 3, 'function shared'),
        (5, '${publicSym('publicApi')}', 'publicApi', 3, 'function publicApi'),
        (6, '${routeSym('GET')}', 'GET', 3, 'function GET'),
        (7, '${routeSym('unusedRouteHelper')}', 'unusedRouteHelper', 3, 'function unusedRouteHelper'),
        (8, '${internalSym('transitivelyPublicApi')}', 'transitivelyPublicApi', 3, 'function transitivelyPublicApi'),
        (9, '${contractSym('Executor', 'readFile')}', 'readFile', 6, 'method readFile'),
        (10, '${contractSym('Base', '`<constructor>`')}', '<constructor>', 9, 'constructor'),
        (11, '${contractSym('Boundary', 'getDerivedStateFromError')}', 'getDerivedStateFromError', 6, 'method getDerivedStateFromError'),
        (12, '${contractSym('Provider', 'readFile')}', 'readFile', 6, 'method readFile'),
          (13, '${contractSym('Plain', 'unusedMethod')}', 'unusedMethod', 6, 'method unusedMethod'),
          (14, '${instrumentationClientSym('onRouterTransitionStart')}', 'onRouterTransitionStart', 3, 'function onRouterTransitionStart');

      INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
        (1, 1, 1, 0, 0, 2, 1),
        (2, 1, 2, 4, 0, 6, 1),
        (3, 1, 3, 8, 0, 10, 1),
        (4, 1, 4, 12, 0, 14, 1),
        (5, 2, 5, 0, 0, 2, 1),
        (6, 3, 6, 0, 0, 2, 1),
        (7, 3, 7, 4, 0, 6, 1),
        (8, 5, 8, 0, 0, 2, 1),
        (9, 6, 9, 1, 2, 1, 41),
        (10, 6, 10, 4, 2, 4, 52),
        (11, 6, 11, 7, 2, 7, 57),
        (12, 6, 12, 10, 2, 10, 65),
          (13, 6, 13, 13, 2, 13, 34),
          (14, 7, 14, 0, 0, 0, 59);

      INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
        (1, 1, 0, 0, 2, X'00'),
        (2, 1, 1, 4, 6, X'00'),
        (3, 1, 2, 8, 10, X'00'),
        (4, 1, 3, 12, 14, X'00'),
        (5, 2, 0, 0, 2, X'00'),
        (6, 3, 0, 0, 2, X'00'),
        (7, 3, 1, 4, 6, X'00'),
        (8, 5, 0, 0, 2, X'00'),
        (9, 6, 0, 1, 1, X'00'),
        (10, 6, 1, 4, 4, X'00'),
        (11, 6, 2, 7, 7, X'00'),
        (12, 6, 3, 10, 10, X'00'),
          (13, 6, 4, 13, 13, X'00'),
          (14, 7, 0, 0, 0, X'00');

      INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
        (1, 1, 1),
        (2, 2, 1),
        (3, 3, 1),
        (3, 4, 0),
        (4, 4, 1),
        (5, 5, 1),
        (6, 6, 1),
        (7, 7, 1),
        (8, 8, 1),
        (9, 9, 1),
        (10, 10, 1),
        (11, 11, 1),
        (12, 12, 1),
          (13, 13, 1),
          (14, 14, 1);
    `);
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

function withRustDeadFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-rust-dead-output-'));
  const projectRoot = join(tempDir, 'project');
  const dbPath = join(tempDir, 'index.db');
  try {
    const sourcePath = join(projectRoot, 'src', 'lib.rs');
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, ['pub mod api;', 'mod internal;', ''].join('\n'));
    writeFileSync(join(projectRoot, 'src', 'api.rs'), ['pub fn public_api() {}', ''].join('\n'));
    writeFileSync(
      join(projectRoot, 'src', 'internal.rs'),
      ['fn private_unused() {}', 'fn another_private_unused() {}', ''].join('\n'),
    );
    writeFileSync(join(projectRoot, 'src', 'commands.rs'), ['#[tauri::command]', 'fn launch() {', '}', ''].join('\n'));
    mkdirSync(join(projectRoot, 'tools', 'helper', 'src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'tools', 'helper', 'src', 'unused.rs'),
      ['pub fn binary_unused() {}', ''].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'tools', 'helper', 'src', 'main.rs'),
      ['mod unused;', 'fn main() {}', ''].join('\n'),
    );
    writeFileSync(join(projectRoot, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\n');
    writeFileSync(
      join(projectRoot, 'tools', 'helper', 'Cargo.toml'),
      '[package]\nname = "helper"\nversion = "0.1.0"\n',
    );

    const sqliteDb = new Database(dbPath);
    createEvidenceSchema(sqliteDb);
    sqliteDb.exec(`
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'rust', 'src/commands.rs'),
        (2, 'rust', 'src/api.rs'),
        (3, 'rust', 'src/internal.rs'),
        (4, 'rust', 'tools/helper/src/unused.rs');

      INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
        (1, '${rustSym('src/commands.rs', 'launch')}', 'launch', 12, 'fn launch'),
        (2, '${rustSym('src/api.rs', 'public_api')}', 'public_api', 12, 'fn public_api'),
        (3, '${rustSym('src/internal.rs', 'private_unused')}', 'private_unused', 12, 'fn private_unused'),
        (4, '${rustSym('tools/helper/src/unused.rs', 'binary_unused')}', 'binary_unused', 12, 'fn binary_unused'),
        (5, '${rustSym('src/internal.rs', 'another_private_unused')}', 'another_private_unused', 12, 'fn another_private_unused');

      INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
        (1, 1, 1, 1, 3, 2, 1),
        (2, 2, 2, 0, 4, 0, 22),
        (3, 3, 3, 0, 3, 0, 22),
        (4, 4, 4, 0, 4, 0, 24),
        (5, 3, 5, 1, 3, 1, 30);

      INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
        (1, 1, 0, 1, 2, X'00'),
        (2, 2, 0, 0, 0, X'00'),
        (3, 3, 0, 0, 0, X'00'),
        (4, 4, 0, 0, 0, X'00'),
        (5, 3, 1, 1, 1, X'00');

      INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
        (1, 1, 1),
        (2, 2, 1),
        (3, 3, 1),
        (4, 4, 1),
        (5, 5, 1);
    `);
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

describe('dead output contract', () => {
  it('exposes explicit counts alongside compatibility summary fields', () => {
    withDeadFixture((db) => {
      const result = dead(db, { minLoc: 1, semantic: false });

      expect(result.counts).toEqual({
        total: result.totalCount,
        deadCode: result.deadCodeCount,
        fileInternal: result.fileInternalCount,
        implicitUsage: result.implicitUsageCount,
        loc: result.totalLoc,
      });
      expect(result.counts).toMatchObject({
        total: 4,
        deadCode: 3,
        fileInternal: 1,
        implicitUsage: 0,
      });
      expect(result.symbols.filter((symbol) => symbol.kind === 'file-internal')).toEqual([
        expect.objectContaining({ shortName: expect.stringContaining('shared') }),
      ]);
      expect(result.symbols).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ shortName: expect.stringContaining('unusedExport') }),
          expect.objectContaining({ shortName: expect.stringContaining('internalOnly') }),
          expect.objectContaining({ shortName: expect.stringContaining('unusedMethod') }),
        ]),
      );
      expect(result.symbols).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ shortName: expect.stringContaining('testOnlyExport') }),
          expect.objectContaining({ shortName: expect.stringContaining('GET') }),
          expect.objectContaining({ shortName: expect.stringContaining('unusedRouteHelper') }),
          expect.objectContaining({ shortName: expect.stringContaining('publicApi') }),
          expect.objectContaining({ shortName: expect.stringContaining('transitivelyPublicApi') }),
          expect.objectContaining({ shortName: expect.stringContaining('readFile') }),
          expect.objectContaining({ shortName: expect.stringContaining('<constructor>') }),
          expect.objectContaining({ shortName: expect.stringContaining('getDerivedStateFromError') }),
          expect.objectContaining({ shortName: expect.stringContaining('Provider:readFile') }),
          expect.objectContaining({ shortName: expect.stringContaining('onRouterTransitionStart') }),
        ]),
      );
    });
  });

  it('separates Rust implicit usage and roots only public library definitions', () => {
    withRustDeadFixture((db) => {
      const result = dead(db, { minLoc: 1, semantic: false });

      expect(result.counts).toMatchObject({ total: 4, deadCode: 3, implicitUsage: 1 });
      expect(result.symbols).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            shortName: expect.stringContaining('launch'),
            kind: 'implicit-usage',
            implicitUsageReason: 'Rust attribute macro #[tauri::command]',
          }),
          expect.objectContaining({ shortName: expect.stringContaining('private_unused'), kind: 'dead-code' }),
          expect.objectContaining({
            shortName: expect.stringContaining('another_private_unused'),
            kind: 'dead-code',
          }),
          expect.objectContaining({ shortName: expect.stringContaining('binary_unused'), kind: 'dead-code' }),
        ]),
      );
      expect(result.symbols).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ shortName: expect.stringContaining('public_api') })]),
      );
    });
  });
});

describe('dead human renderer', () => {
  it('shows section totals separately from capped display rows', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message = '') => logs.push(String(message));
    try {
      renderDeadGroup(
        [
          {
            relativePath: 'src/a.ts',
            startLine: 0,
            endLine: 9,
            loc: 10,
            symbol: 'sym/a',
            shortName: 'a',
            sameFileRefs: 0,
            kind: 'dead-code',
          },
        ],
        'DEAD CODE',
        'explanation',
        10,
        { count: 25, loc: 250 },
      );
    } finally {
      console.log = originalLog;
    }

    expect(logs[0]).toBe('═══ DEAD CODE (1 of 25, 10 of 250 LOC) ═══');
  });

  it('shows implicit-usage reasons when present', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message = '') => logs.push(String(message));
    try {
      renderDeadGroup(
        [
          {
            relativePath: 'src/commands.rs',
            startLine: 1,
            endLine: 2,
            loc: 2,
            symbol: rustSym('src/commands.rs', 'launch'),
            shortName: 'src:lib:launch()',
            sameFileRefs: 0,
            kind: 'implicit-usage',
            implicitUsageReason: 'Rust attribute macro #[tauri::command]',
          },
        ],
        'DEAD CODE',
        'explanation',
        2,
      );
    } finally {
      console.log = originalLog;
    }

    expect(logs).toContain(
      '    2-3  (2 LOC)  src:lib:launch()  [implicit usage: Rust attribute macro #[tauri::command]]',
    );
  });
});
