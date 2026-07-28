import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureDb, createFixtureProject } from '../fixtures/command-accuracy-fixtures.js';

describe('methods CLI resolution contract', () => {
  const repositoryRoot = process.cwd();
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'scip-query-methods-cli-'));
  const dbPath = join(fixtureRoot, 'index.db');

  beforeAll(() => {
    createFixtureProject(fixtureRoot);
    createFixtureDb(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      INSERT INTO documents (id, language, relative_path)
      VALUES (90, 'typescript', 'src/other/watch.ts');
      INSERT INTO global_symbols (id, symbol, display_name, kind)
      VALUES (
        90,
        'scip-typescript npm pkg 1.0.0 src/other/\`watch.ts\`/Watcher#',
        'Watcher',
        5
      );
      INSERT INTO defn_enclosing_ranges
        (id, document_id, symbol_id, start_line, start_char, end_line, end_char)
      VALUES (90, 90, 90, 0, 0, 2, 1);
    `);
    sqlite.close();
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('emits a JSON missing result with a nonzero exit status', () => {
    const invocation = runMethods('DefinitelyMissing', true);

    expect(invocation.status).toBe(1);
    expect(invocation.stderr).toBe('');
    expect(JSON.parse(invocation.stdout)).toMatchObject({
      kind: 'scip-query-result',
      command: 'methods',
      result: {
        kind: 'missing',
        query: 'DefinitelyMissing',
        suggestions: expect.any(Array),
      },
      coverage: {
        complete: true,
        resolution: { state: 'missing', totalCandidates: 0 },
      },
    });
  });

  it('emits structured JSON candidates for ambiguity', () => {
    const invocation = runMethods('Watcher', true);

    expect(invocation.status).toBe(1);
    expect(invocation.stderr).toBe('');
    expect(JSON.parse(invocation.stdout)).toMatchObject({
      kind: 'scip-query-result',
      command: 'methods',
      result: {
        kind: 'ambiguous',
        query: 'Watcher',
        total: 2,
        candidates: expect.arrayContaining([
          expect.objectContaining({ relativePath: 'src/watch.ts' }),
          expect.objectContaining({ relativePath: 'src/other/watch.ts' }),
        ]),
      },
      coverage: {
        complete: true,
        resolution: { state: 'ambiguous', totalCandidates: 2 },
      },
    });
  });

  it('keeps human ambiguity output concise and actionable', () => {
    const invocation = runMethods('Watcher', false);

    expect(invocation.status).toBe(1);
    expect(invocation.stdout).toContain("Class 'Watcher' is ambiguous across 2 definitions");
    expect(invocation.stdout).toContain('Qualify it with a path or exact SCIP symbol identity.');
  });

  function runMethods(className: string, json: boolean): ReturnType<typeof spawnSync> {
    return spawnSync(
      join(repositoryRoot, 'node_modules', '.bin', 'vite-node'),
      ['--script', join(repositoryRoot, 'src', 'runtime', 'cli.ts'), 'methods', className, ...(json ? ['--json'] : [])],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          SCIP_QUERY_PROJECT_ROOT: fixtureRoot,
          SCIP_QUERY_INDEX_DB: dbPath,
          SCIP_QUERY_INDEX_SCIP: join(fixtureRoot, 'index.scip'),
          SCIP_QUERY_CACHE_DIR: join(fixtureRoot, '.cache'),
          SCIP_QUERY_SHARED_CACHE: '0',
          SCIP_QUERY_UPDATE_CHECK: '0',
          XDG_CACHE_HOME: join(fixtureRoot, '.xdg-cache'),
        },
      },
    );
  }
});
