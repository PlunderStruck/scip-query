import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cli = resolve('dist/cli.js');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-review-cli-')));
  roots.push(root);
  writeFileSync(join(root, 'a.ts'), 'export function run(x) { return x; }');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], {
    cwd: root,
  });
  return root;
}
function run(root: string, args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SCIP_QUERY_')));
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...env, SCIP_QUERY_PROJECT_ROOT: root, SCIP_QUERY_CACHE_DIR: join(root, '.cache') },
  });
}

describe('source maintenance CLI without an index', () => {
  it('records and applies a source exception before indexing, then reopens it when evidence changes', () => {
    const root = fixture();
    const source = `export function added(x) { ${Array.from({ length: 11 }, (_, i) => `if(x === ${i}) return ${i};`).join(' ')} return -1; }`;
    writeFileSync(join(root, 'new.ts'), source);
    expect(run(root, ['review', '--check']).status).toBe(1);
    const saved = run(root, [
      'suppress',
      'complexity:new.ts:added',
      '--reason',
      'Deliberate fixture branches',
      '--reason-code',
      'test-fixture',
      '--evidence',
      'source:new.ts',
    ]);
    expect(saved.status, saved.stderr).toBe(0);
    for (const mode of ['health', 'review']) {
      const result = run(root, [mode, '--check', '--full']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Suppression accepted: complexity:new.ts:added');
      expect(result.stdout).toContain('Blocking findings: 0');
    }
    writeFileSync(join(root, 'new.ts'), source + '\n// changed\n');
    const reopened = run(root, ['review', '--check']);
    expect(reopened.status).toBe(1);
    expect(reopened.stdout).toContain('Suppression invalidated: complexity:new.ts:added');
  });

  it('provides first-use findings without indexing or starting a watcher', () => {
    const result = run(fixture(), ['health', '--check']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1/1 eligible files');
    expect(result.stdout).toContain('Test coverage: not supplied');
    expect(result.stderr).not.toMatch(/reindex|watcher|missing index/i);
  });

  it('fails the derived-finding gate on a newly complex function', () => {
    const root = fixture();
    writeFileSync(
      join(root, 'new.ts'),
      `export function added(x) { ${Array.from({ length: 11 }, (_, i) => `if(x === ${i}) return ${i};`).join(' ')} return -1; }`,
    );
    const result = run(root, ['review', '--check']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('added new.ts:1 added');
    expect(result.stdout).toContain('[introduced; derived] complexity');
  });

  it('fails incomplete requested coverage and misspelled scopes explicitly', () => {
    const root = fixture();
    writeFileSync(join(root, 'coverage.json'), JSON.stringify({ schemaVersion: 1, files: {} }));
    const coverage = run(root, ['health', '--coverage', 'coverage.json', '--check']);
    expect(coverage.status).toBe(2);
    expect(coverage.stdout).toContain('Requested test coverage is incomplete');
    const scope = run(root, ['review', '--scope', 'missing', '--check']);
    expect(scope.status).toBe(2);
    expect(scope.stdout).toContain('matches no analyzed source file');
  });
});

it('shows concise source groups and honors reference inclusion without an index', () => {
  const root = fixture();
  mkdirSync(join(root, 'agent_docs'));
  writeFileSync(join(root, 'agent_docs', 'sdk.ts'), 'export function sdk() {}');
  expect(run(root, ['health']).stdout).toContain('reference 1');
  expect(run(root, ['health', '--include-references']).stdout).toContain('2/2 eligible files');
  const incompatible = run(root, ['health', '--indexed', '--include-references']);
  expect(incompatible.status).not.toBe(0);
  expect(incompatible.stderr).toContain('belongs to current-source health');
});
