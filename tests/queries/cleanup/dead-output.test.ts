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
const routeSym = (name: string) => `scip-typescript npm fixture 1.0.0 src/app/api/health/\`route.ts\`/${name}().`;

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
        'export function internalOnly() {',
        '  return shared();',
        '}',
        '',
        'function shared() {',
        '  return 2;',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(projectRoot, 'src', 'public.ts'),
      ['export function publicApi() {', '  return 3;', '}', ''].join('\n'),
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
      join(projectRoot, 'package.json'),
      JSON.stringify({
        exports: {
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
        (3, 'typescript', 'src/app/api/health/route.ts');

      INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
        (1, '${sym('unusedExport')}', 'unusedExport', 3, 'function unusedExport'),
        (2, '${sym('internalOnly')}', 'internalOnly', 3, 'function internalOnly'),
        (3, '${sym('shared')}', 'shared', 3, 'function shared'),
        (4, '${publicSym('publicApi')}', 'publicApi', 3, 'function publicApi'),
        (5, '${routeSym('GET')}', 'GET', 3, 'function GET'),
        (6, '${routeSym('unusedRouteHelper')}', 'unusedRouteHelper', 3, 'function unusedRouteHelper');

      INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
        (1, 1, 1, 0, 0, 2, 1),
        (2, 1, 2, 4, 0, 6, 1),
        (3, 1, 3, 8, 0, 10, 1),
        (4, 2, 4, 0, 0, 2, 1),
        (5, 3, 5, 0, 0, 2, 1),
        (6, 3, 6, 4, 0, 6, 1);

      INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
        (1, 1, 0, 0, 2, X'00'),
        (2, 1, 1, 4, 6, X'00'),
        (3, 1, 2, 8, 10, X'00'),
        (4, 2, 0, 0, 2, X'00'),
        (5, 3, 0, 0, 2, X'00'),
        (6, 3, 1, 4, 6, X'00');

      INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
        (1, 1, 1),
        (2, 2, 1),
        (2, 3, 0),
        (3, 3, 1),
        (4, 4, 1),
        (5, 5, 1),
        (6, 6, 1);
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
        loc: result.totalLoc,
      });
      expect(result.counts).toMatchObject({
        total: 4,
        deadCode: 3,
        fileInternal: 1,
      });
      expect(result.symbols.filter((symbol) => symbol.kind === 'file-internal')).toEqual([
        expect.objectContaining({ shortName: expect.stringContaining('shared') }),
      ]);
      expect(result.symbols).toEqual(
        expect.arrayContaining([expect.objectContaining({ shortName: expect.stringContaining('unusedRouteHelper') })]),
      );
      expect(result.symbols).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ shortName: expect.stringContaining('GET') }),
          expect.objectContaining({ shortName: expect.stringContaining('publicApi') }),
        ]),
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
});
