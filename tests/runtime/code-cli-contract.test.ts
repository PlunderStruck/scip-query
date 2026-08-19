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
        '═══ REQUEST ═══',
        '  resolved-selector=scip-typescript npm pkg 1.0.0 src/`watch.ts`/Watcher#',
        '',
        '═══ OBSERVED FACTS ═══',
        'src/watch.ts:1-5  src:watch:Watcher  [typescript]',
        '',
        '     1  export class Watcher {',
        '     2    start() { return true; }',
        '     3    stop() { return false; }',
        '     4  }',
        '     5  ',
        '',
        '═══ EVIDENCE CALIBRATION ═══',
        '  Source bodies are exact working-tree bytes; compiler identity and bindings are limited to reported semantic coverage.',
        '  Freshness: 1/1 text current; semantics 0 aligned, 0 stale, 1 unavailable.',
        '',
        '═══ COVERAGE ═══',
        '  One exact selector resolved to the complete source body shown; callers and runtime relationships are not implied.',
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
          schemaVersion: 2,
          facts: {
            index: {
              generation: {
                hashAlgorithm: 'sha256',
                projection: { name: 'scip-query:index-generation', version: 1 },
                digest: expect.any(String),
              },
              source: expect.stringMatching(/^(immutable|legacy)$/),
            },
          },
          observedSources: [{ kind: 'index-generation' }],
          stabilityProofs: [{ source: 'index-generation', kind: expect.any(String) }],
        },
        analysisManifest: {
          schemaVersion: 1,
          claimQualification: {
            schemaVersion: 1,
            origin: 'compiler-graph',
            coverage: {
              state: 'complete',
              returned: 1,
              totalKnown: true,
              total: 1,
              omitted: 0,
            },
            producerValidation: { status: 'not-evaluated' },
            stateAuthority: { authority: 'advisory' },
            repositoryPolicy: { permission: 'not-established' },
          },
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
    expect(Object.keys(output)).toEqual(['file', 'symbol', 'language', 'range', 'freshness', 'lines']);
    expect(output).toEqual({
      file: 'src/watch.ts',
      symbol: 'src:watch:Watcher',
      language: 'typescript',
      range: { startLine: 1, endLine: 5 },
      freshness: {
        exactText: {
          state: 'current',
          basis: 'working-tree-read',
          sha256: expect.any(String),
        },
        semantic: { state: 'unavailable', basis: 'fingerprint-unavailable' },
      },
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
        '═══ REQUEST ═══',
        '  resolved-selector=src/watch.ts:2-3',
        '',
        '═══ OBSERVED FACTS ═══',
        'src/watch.ts:2-3  src/watch.ts:2-3  [typescript]',
        '',
        '     2    start() { return true; }',
        '     3    stop() { return false; }',
        '',
        '═══ EVIDENCE CALIBRATION ═══',
        '  Source bodies are exact working-tree bytes; compiler identity and bindings are limited to reported semantic coverage.',
        '  Freshness: 1/1 text current; semantics 0 aligned, 0 stale, 1 unavailable.',
        '',
        '═══ COVERAGE ═══',
        '  One exact selector resolved to the complete source body shown; callers and runtime relationships are not implied.',
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

  it('reads several exact definitions in one complete packet', () => {
    const invocation = runCode(['src:watch:Watcher#start', 'src/watch.ts:3-3']);

    expect(invocation.status).toBe(0);
    expect(invocation.stderr).toBe('');
    expect(invocation.stdout).toContain('═══ REQUEST ═══');
    expect(invocation.stdout).toContain('═══ OBSERVED FACTS (2 requested: 2 matched, 0 ambiguous, 0 missing) ═══');
    expect(invocation.stdout).toContain('src/watch.ts:2-2  src:watch:Watcher:start()');
    expect(invocation.stdout).toContain('src/watch.ts:3-3  src/watch.ts:3-3');
    expect(invocation.stdout).toContain('═══ COVERAGE ═══');
    expect(invocation.stdout).toContain('2/2 selectors resolved');
    expect(invocation.stdout).toContain('dynamic calls and references outside the requested lines are not claimed');
  });

  it('completes an exact range with statically attributed same-file callable definitions', () => {
    const invocation = runCode(['src/flow.ts:5-5']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain('     5  export function alpha()');
    expect(invocation.stdout).toContain('     1  export function sharedOne()');
    expect(invocation.stdout).toContain('     2  export function sharedTwo()');
    expect(invocation.stdout).toContain('     3  export function uniqueAlpha()');
    expect(invocation.stdout).not.toContain('     4  export function uniqueBeta()');
    expect(invocation.stdout).toContain('═══ RANGE SOURCE COVERAGE ═══');
    expect(invocation.stdout).toContain('3/3 statically attributed same-file definition(s)');
    expect(invocation.stdout).not.toContain('no selector or matched source range was withheld');
  });

  it('returns citation-ready exported source and complete file coverage for an exact indexed file path', () => {
    const invocation = runCode(['src/watch.ts']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain('═══ FILE SOURCE COVERAGE ═══');
    expect(invocation.stdout).toContain('     1  export class Watcher {');
    expect(invocation.stdout).toContain('cover 3/3 indexed definition(s)');
    expect(invocation.stdout).toContain('0 file-local definition(s) omitted');
    expect(invocation.stdout).toContain('absolute file line numbers and are citation-ready');
  });

  it('discloses unreturned file-local definitions through a compact exact-range ledger', () => {
    writeFileSync(
      join(fixtureRoot, 'src', 'surface.ts'),
      [
        'export function publicThing() { return privateThing(); }',
        'function privateThing() { return false; }',
        'function unusedThing() { return false; }',
        'class Hidden {',
        '  reveal() { return true; }',
        '}',
        '',
      ].join('\n'),
    );
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      INSERT INTO documents (id, language, relative_path)
      VALUES (91, 'typescript', 'src/surface.ts');
      INSERT INTO global_symbols (id, symbol, display_name, kind)
      VALUES
        (91, 'scip-typescript npm pkg 1.0.0 src/\`surface.ts\`/publicThing().', 'publicThing', 3),
        (92, 'scip-typescript npm pkg 1.0.0 src/\`surface.ts\`/privateThing().', 'privateThing', 3),
        (93, 'scip-typescript npm pkg 1.0.0 src/\`surface.ts\`/unusedThing().', 'unusedThing', 3),
        (94, 'scip-typescript npm pkg 1.0.0 src/\`surface.ts\`/Hidden#', 'Hidden', 5),
        (95, 'scip-typescript npm pkg 1.0.0 src/\`surface.ts\`/Hidden#reveal().', 'reveal', 3);
      INSERT INTO defn_enclosing_ranges
        (id, document_id, symbol_id, start_line, start_char, end_line, end_char)
      VALUES
        (91, 91, 91, 0, 0, 0, 57),
        (92, 91, 92, 1, 0, 1, 42),
        (93, 91, 93, 2, 0, 2, 41),
        (94, 91, 94, 3, 0, 5, 1),
        (95, 91, 95, 4, 2, 4, 29);
      INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences)
      VALUES
        (91, 91, 0, 0, 0, X'00'),
        (92, 91, 1, 1, 1, X'00'),
        (93, 91, 2, 2, 2, X'00'),
        (94, 91, 3, 3, 5, X'00'),
        (95, 91, 4, 4, 4, X'00');
      INSERT INTO mentions (chunk_id, symbol_id, role)
      VALUES
        (91, 91, 1),
        (91, 92, 0),
        (92, 92, 1),
        (93, 93, 1),
        (94, 94, 1),
        (95, 95, 1);
    `);
    sqlite.close();

    const invocation = runCode(['src/surface.ts']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain('export function publicThing()');
    expect(invocation.stdout).toContain('     2  function privateThing()');
    expect(invocation.stdout).not.toContain('     3  function unusedThing()');
    expect(invocation.stdout).toContain('src/surface.ts:3-3');
    expect(invocation.stdout).toContain('unusedThing');
    expect(invocation.stdout).toContain('src/surface.ts:4-6');
    expect(invocation.stdout).toContain('Hidden');
    expect(invocation.stdout).toContain('src/surface.ts:5-5');
    expect(invocation.stdout).toContain('reveal');
    expect(invocation.stdout).toContain('3 file-local definition(s) omitted');
    expect(invocation.stdout).toContain("scip-query code 'src/surface.ts:3-3'");
    expect(invocation.stdout).toContain("'src/surface.ts:4-6'");
  });

  it('falls back to a useful top-level surface when a file has no explicit exports', () => {
    writeFileSync(join(fixtureRoot, 'src', 'internal.ts'), 'function internalRoot() { return true; }\n');
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      INSERT INTO documents (id, language, relative_path)
      VALUES (101, 'typescript', 'src/internal.ts');
      INSERT INTO global_symbols (id, symbol, display_name, kind)
      VALUES (101, 'scip-typescript npm pkg 1.0.0 src/\`internal.ts\`/internalRoot().', 'internalRoot', 3);
      INSERT INTO defn_enclosing_ranges
        (id, document_id, symbol_id, start_line, start_char, end_line, end_char)
      VALUES (101, 101, 101, 0, 0, 0, 40);
      INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences)
      VALUES (101, 101, 0, 0, 0, X'00');
      INSERT INTO mentions (chunk_id, symbol_id, role)
      VALUES (101, 101, 1);
    `);
    sqlite.close();

    const invocation = runCode(['src/internal.ts']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain('function internalRoot()');
    expect(invocation.stdout).toContain('basis: top-level-and-same-file-reference-closure');
    expect(invocation.stdout).toContain('0 file-local definition(s) omitted');
  });

  it('refuses an oversized code packet before emitting partial source', () => {
    const invocation = runCode(['src/watch.ts', '--output-page-size', '256']);

    expect(invocation.status).toBe(1);
    expect(invocation.stdout).toBe('');
    expect(invocation.stderr).toContain('CODE PACKET REFUSED');
    expect(invocation.stderr).toContain('No partial source was emitted.');
    expect(invocation.stderr).toContain('scip-query code');
    expect(invocation.stderr).not.toContain('scip-query --output-page-size');
    expect(invocation.stderr).not.toContain('Continue exactly:');
  });

  it('returns the complete file only when --members all is explicit', () => {
    const invocation = runCode(['src/watch.ts', '--members', 'all']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain('basis: complete-file-source; members=all');
    expect(invocation.stdout).toContain('cover 3/3 indexed definition(s)');
  });

  it('keeps missing-symbol output concise and free of result metadata', () => {
    const invocation = runCode(['DefinitelyMissing']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain("No definition matched 'DefinitelyMissing'.");
    expect(invocation.stdout).not.toContain('schemaVersion');
    expect(invocation.stdout).not.toContain('coverage');
  });

  it('returns every small ambiguous candidate instead of silently choosing the first', () => {
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
    const output = JSON.parse(invocation.stdout) as {
      requested: number;
      ambiguous: number;
      entries: Array<{ status: string; totalCandidates: number; sources: unknown[]; candidates: unknown[] }>;
    };

    expect(invocation.status).toBe(0);
    expect(output).toMatchObject({ requested: 1, ambiguous: 1 });
    expect(output.entries[0]).toMatchObject({ status: 'ambiguous', totalCandidates: 2 });
    expect(output.entries[0]?.sources).toHaveLength(2);
    expect(output.entries[0]?.candidates).toHaveLength(2);
  });

  it('rejects more selectors than one complete packet can account for', () => {
    const invocation = runCode(Array.from({ length: 25 }, () => 'src:watch:Watcher#start'));

    expect(invocation.status).toBe(1);
    expect(invocation.stdout).toBe('');
    expect(invocation.stderr).toContain('at most 24 selectors');
  });

  it('keeps agent-readable output smaller than structured modes', () => {
    const human = runCode(['src:watch:Watcher']).stdout;
    const resultOnly = runCode(['src:watch:Watcher', '--json', '--result-only']).stdout;
    const envelope = runCode(['src:watch:Watcher', '--json']).stdout;

    expect(human.length).toBeLessThan(resultOnly.length);
    expect(resultOnly.length).toBeLessThan(envelope.length);
  }, 10_000);

  it('rejects partial and negative context values instead of silently changing the range', () => {
    for (const context of ['2junk', '-1']) {
      const invocation = runCode(['src:watch:Watcher', '--context', context]);

      expect(invocation.status, context).toBe(1);
      expect(invocation.stdout, context).toBe('');
      expect(invocation.stderr, context).toContain('Expected a non-negative integer');
      expect(invocation.stderr, context).not.toContain('at parse');
    }
  });

  it('requires JSON before every structured-output modifier', () => {
    for (const [modifier, args] of [
      ['--result-only', ['--result-only']],
      ['--compact', ['--compact']],
      ['--agent-output', ['--agent-output']],
      ['--raw-json', ['--raw-json']],
      ['--json-output', ['--json-output', join(fixtureRoot, 'result.json')]],
    ] as const) {
      const invocation = runCode(['src:watch:Watcher', ...args]);

      expect(invocation.status, modifier).toBe(1);
      expect(invocation.stdout, modifier).toBe('');
      expect(invocation.stderr, modifier).toContain(`${modifier} requires --json`);
    }
  }, 10_000);

  it('rejects contradictory JSON transport controls', () => {
    for (const args of [
      ['--json', '--agent-output', '--raw-json'],
      ['--json', '--json-output', join(fixtureRoot, 'result.json'), '--agent-output'],
      ['--json', '--raw-json', '--output-page-size', '256'],
    ]) {
      const invocation = runCode(['src:watch:Watcher', ...args]);

      expect(invocation.status, args.join(' ')).toBe(1);
      expect(invocation.stdout, args.join(' ')).toBe('');
      expect(invocation.stderr, args.join(' ')).toContain('cannot be combined');
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
