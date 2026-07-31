import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureDb, createFixtureProject } from '../fixtures/command-accuracy-fixtures.js';

describe('code CLI output contract', () => {
  const repositoryRoot = process.cwd();
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'scip-query-code-cli-'));
  const dbPath = join(fixtureRoot, 'index.db');

  beforeAll(() => {
    createFixtureProject(fixtureRoot);
    createFixtureDb(dbPath);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('renders source hierarchically with preserved indentation and one-based line numbers', () => {
    const invocation = runCode(['src:watch:Watcher']);

    expect(invocation.status).toBe(0);
    expect(invocation.stderr).toBe('');
    expect(invocation.stdout).toBe(
      [
        'src/watch.ts:1-5  src:watch:Watcher  [typescript]',
        '',
        '     1  export class Watcher {',
        '     2    start() { return true; }',
        '     3    stop() { return false; }',
        '     4  }',
        '     5  ',
        '',
      ].join('\n'),
    );
  });

  it('keeps the stable envelope for plain JSON consumers', () => {
    const invocation = runCode(['src:watch:Watcher', '--json']);
    const output = JSON.parse(invocation.stdout) as Record<string, unknown>;

    expect(invocation.status).toBe(0);
    expect(output).toMatchObject({
      kind: 'scip-query-result',
      schemaVersion: 1,
      command: 'code',
      operationRole: 'repository-observation',
      evidenceContext: {
        schemaVersion: 1,
        operationRole: 'repository-observation',
        receipt: {
          schemaVersion: 1,
          authorityKind: 'index-only',
          projectIdentity: expect.any(String),
          index: {
            generationIdentity: expect.any(String),
            source: expect.stringMatching(/^(immutable|legacy)$/),
            alignment: 'not-certified',
          },
        },
        analysisManifest: {
          schemaVersion: 1,
        },
      },
      result: {
        code: {
          relativePath: 'src/watch.ts',
          shortName: 'src:watch:Watcher',
          startLine: 0,
          endLine: 4,
          source: expect.stringContaining('  start() { return true; }'),
        },
      },
    });
  });

  it('emits only minimal, line-oriented source data for --result-only', () => {
    const invocation = runCode(['src:watch:Watcher', '--json', '--result-only']);
    const output = JSON.parse(invocation.stdout) as Record<string, unknown>;

    expect(invocation.status).toBe(0);
    expect(Object.keys(output)).toEqual(['file', 'symbol', 'language', 'range', 'lines']);
    expect(output).toEqual({
      file: 'src/watch.ts',
      symbol: 'src:watch:Watcher',
      language: 'typescript',
      range: { startLine: 1, endLine: 5 },
      lines: [
        { line: 1, text: 'export class Watcher {' },
        { line: 2, text: '  start() { return true; }' },
        { line: 3, text: '  stop() { return false; }' },
        { line: 4, text: '}' },
        { line: 5, text: '' },
      ],
    });
  });

  it('renders an explicit file range with the requested one-based lines only', () => {
    const invocation = runCode(['src/watch.ts:2-3']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toBe(
      [
        'src/watch.ts:2-3  src/watch.ts:2-3  [typescript]',
        '',
        '     2    start() { return true; }',
        '     3    stop() { return false; }',
        '',
      ].join('\n'),
    );
  });

  it('rejects zero-based or reversed explicit source ranges', () => {
    for (const range of ['src/watch.ts:0-2', 'src/watch.ts:3-2']) {
      const invocation = runCode([range]);

      expect(invocation.status, range).toBe(1);
      expect(invocation.stdout, range).toBe('');
      expect(invocation.stderr, range).toMatch(/Source range (?:start|end) line/u);
    }
  });

  it('expands source context without losing line identity', () => {
    const invocation = runCode(['src:watch:Watcher#start', '--context', '1']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain('src/watch.ts:1-3');
    expect(invocation.stdout).toContain('     1  export class Watcher {');
    expect(invocation.stdout).toContain('     3    stop() { return false; }');
  });

  it('keeps missing-symbol output concise and free of result metadata', () => {
    const invocation = runCode(['DefinitelyMissing']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain("No definition matched 'DefinitelyMissing'.");
    expect(invocation.stdout).not.toContain('schemaVersion');
    expect(invocation.stdout).not.toContain('coverage');
  });

  it('adds resolution alternatives only when a symbol is ambiguous', () => {
    writeFileSync(
      join(fixtureRoot, 'src', 'other-watch.ts'),
      ['export class Watcher {', '  start() { return "other"; }', '}', ''].join('\n'),
    );
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      INSERT INTO documents (id, language, relative_path)
      VALUES (90, 'typescript', 'src/other-watch.ts');
      INSERT INTO global_symbols (id, symbol, display_name, kind)
      VALUES (
        90,
        'scip-typescript npm pkg 1.0.0 src/\`other-watch.ts\`/Watcher#',
        'Watcher',
        5
      );
      INSERT INTO defn_enclosing_ranges
        (id, document_id, symbol_id, start_line, start_char, end_line, end_char)
      VALUES (90, 90, 90, 0, 0, 3, 0);
    `);
    sqlite.close();

    const invocation = runCode(['Watcher', '--json', '--result-only']);
    const output = JSON.parse(invocation.stdout) as Record<string, unknown>;

    expect(invocation.status).toBe(0);
    expect(output).toMatchObject({
      file: expect.stringMatching(/^src\/(?:other-)?watch\.ts$/u),
      resolution: {
        selected: expect.any(Object),
        alternatives: expect.arrayContaining([expect.any(Object)]),
        totalMatches: 2,
      },
    });
  });

  it('keeps agent-readable output smaller than structured modes', () => {
    const human = runCode(['src:watch:Watcher']).stdout;
    const resultOnly = runCode(['src:watch:Watcher', '--json', '--result-only']).stdout;
    const envelope = runCode(['src:watch:Watcher', '--json']).stdout;

    expect(human.length).toBeLessThan(resultOnly.length);
    expect(resultOnly.length).toBeLessThan(envelope.length);
  });

  it('rejects partial and negative context values instead of silently changing the range', () => {
    for (const context of ['2junk', '-1']) {
      const invocation = runCode(['src:watch:Watcher', '--context', context]);

      expect(invocation.status, context).toBe(1);
      expect(invocation.stdout, context).toBe('');
      expect(invocation.stderr, context).toContain('Expected a non-negative integer');
      expect(invocation.stderr, context).not.toContain('at parse');
    }
  });

  it('requires JSON before either structured-output modifier', () => {
    for (const modifier of ['--result-only', '--compact']) {
      const invocation = runCode(['src:watch:Watcher', modifier]);

      expect(invocation.status, modifier).toBe(1);
      expect(invocation.stdout, modifier).toBe('');
      expect(invocation.stderr, modifier).toContain(`${modifier} requires --json`);
    }
  });

  function runCode(args: readonly string[]): ReturnType<typeof spawnSync> {
    return spawnSync(
      join(repositoryRoot, 'node_modules', '.bin', 'vite-node'),
      ['--script', join(repositoryRoot, 'src', 'runtime', 'cli.ts'), 'code', ...args],
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
