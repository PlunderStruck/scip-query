import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureDb, createFixtureProject } from '../fixtures/command-accuracy-fixtures.js';

const root = mkdtempSync(join(tmpdir(), 'scip-efficient-human-'));
const cli = resolve('dist/cli.js');
beforeAll(() => {
  createFixtureProject(root);
  createFixtureDb(join(root, 'index.db'));
  writeFileSync(join(root, 'src/constants.ts'), 'const LIMIT = 137;\nexport function readLimit() { return LIMIT; }\n');
  const db = new Database(join(root, 'index.db'));
  db.exec(`INSERT INTO documents (id,language,relative_path) VALUES (300,'typescript','src/constants.ts');
    INSERT INTO defn_enclosing_ranges VALUES (300,300,300,1,0,1,43);`);
  db.prepare('INSERT INTO global_symbols (id,symbol,display_name,kind) VALUES (?,?,?,?)').run(
    300,
    'scip-typescript npm pkg 1.0.0 src/`constants.ts`/readLimit().',
    'readLimit',
    3,
  );
  db.prepare('INSERT INTO global_symbols (id,symbol,display_name,kind) VALUES (?,?,?,?)').run(
    301,
    'scip-typescript npm pkg 1.0.0 src/`constants.ts`/LIMIT.',
    'LIMIT',
    13,
  );
  db.exec('INSERT INTO defn_enclosing_ranges VALUES (301,300,301,0,0,0,18)');
  db.close();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      SCIP_QUERY_PROJECT_ROOT: root,
      SCIP_QUERY_INDEX_DB: join(root, 'index.db'),
      SCIP_QUERY_SHARED_CACHE: '0',
      SCIP_QUERY_UPDATE_CHECK: '0',
      SCIP_QUERY_CACHE_DIR: join(root, '.cache'),
      XDG_CACHE_HOME: join(root, '.xdg'),
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const saved = result.stdout.startsWith('Full result: ')
    ? result.stdout.split('\n')[0]!.slice('Full result: '.length)
    : undefined;
  return saved ? readFileSync(saved, 'utf8') : result.stdout;
}

describe('public concise output retains evidence and makes extras explicit', () => {
  it.each(['code', 'inspect'])('%s only adds external literal definitions on request', (command) => {
    const args = command === 'code' ? ['code', 'readLimit'] : ['inspect', '--symbol', 'readLimit', '--view', 'source'];
    const ordinary = run(args);
    expect(ordinary).toContain('return LIMIT;');
    expect(ordinary).not.toContain('inline  LIMIT');
    const explicit = run([...args, '--bindings']);
    expect(explicit).toContain('inline  LIMIT');
    expect(explicit).toContain('137');
  });

  it('retains the three independently known callees while making inventory and provider detail opt-in', () => {
    const args = [
      'evidence',
      '--at',
      'src/flow.ts:5',
      '--edge',
      'execution',
      '--direction',
      'outgoing',
      '--depth',
      '1',
      '--max-edges',
      '30',
    ];
    const ordinary = run(args);
    for (const name of ['sharedOne', 'sharedTwo', 'uniqueAlpha']) expect(ordinary).toContain(name);
    expect(ordinary).not.toContain('uniqueBeta');
    expect(ordinary).toContain('[candidate]');
    expect(ordinary).not.toContain('inventory execution');
    expect(ordinary).not.toContain('provider=');
    expect(ordinary).not.toMatch(/CALIBRATION|COVERAGE|OBSERVED FACTS/);
    const detail = run([...args, '--detail']);
    expect(detail).toContain('inventory execution/call');
    expect(detail).toContain('provider=');
    expect(run([...args, '--inventory-only'])).toContain('inventory execution/call');
  });

  it('summarizes module groups before explicit implementation detail', () => {
    const overview = run(['system', '--source']);
    expect(overview).toContain('directory:src');
    expect(overview).toContain('directory:src/reindex');
    expect(overview).toContain('Cross-group production dependencies');
    expect(overview).not.toContain('Source exports');
    expect(run(['system', '--source', 'directory:src/reindex'])).toContain('Source exports');
  });
});
