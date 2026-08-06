import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('search CLI identity and materialization contract', { timeout: 10_000 }, () => {
  const repositoryRoot = process.cwd();
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'scip-query-search-cli-'));
  const dbPath = join(fixtureRoot, 'index.db');

  beforeAll(() => {
    const fixture = evidenceFixtureDb(dbPath);
    const files: Record<string, string> = {};
    for (let index = 1; index <= 30; index += 1) {
      const relativePath = `src/group-${String(index).padStart(2, '0')}/match.ts`;
      files[relativePath] = `export const value${index} = 'needle';\n`;
      fixture.document(index, 'typescript', relativePath);
    }
    for (let index = 31; index <= 180; index += 1) {
      const group = String(Math.floor((index - 31) / 15) + 1).padStart(2, '0');
      const relativePath = `src/broad-${group}/match-${String(index).padStart(3, '0')}.ts`;
      files[relativePath] = `export const broadValue${index} = 'broad_selector_token';\n`;
      fixture.document(index, 'typescript', relativePath);
    }
    files['src/object-commands.ts'] = [
      'export const commands = {',
      '  async sourceOwnedCommand(input: unknown) {',
      '    return input;',
      '  },',
      '};',
      '',
    ].join('\n');
    fixture.document(181, 'typescript', 'src/object-commands.ts');
    writeFixtureFiles(fixtureRoot, files);
    fixture.write();
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('reports every identity while materializing only the requested representative windows', () => {
    const invocation = runSearch(['needle', '--limit', '2', '--context', '0']);

    expect(invocation.status).toBe(0);
    expect(invocation.stderr).toBe('');
    expect(invocation.stdout).toContain('MATCH IDENTITIES (30/30, COMPLETE)');
    expect(invocation.stdout).toContain('REPRESENTATIVE SOURCE (2/30 WINDOWS)');
    expect(invocation.stdout).toContain('Exact cardinality: 30 matching line(s) across 30 file(s).');
    expect(invocation.stdout).toContain('Identity manifest: 30/30 matching line(s); complete.');
    expect(invocation.stdout).toContain('Recover every unmaterialized owning unit in 2 bounded batch command(s)');
    expect(invocation.stdout).toContain('src/group-30/match.ts');
    expect(invocation.stdout).not.toContain('[scip-query output page:');
  });

  it('keeps the default locator view small while preserving the complete identity manifest', () => {
    const invocation = runSearch(['needle']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain('MATCH IDENTITIES (30/30, COMPLETE)');
    expect(invocation.stdout).toContain('REPRESENTATIVE SOURCE (6/30 WINDOWS)');
    expect(invocation.stdout).toContain('Identity manifest: 30/30 matching line(s); complete.');
  });

  it('keeps machine-readable identity coverage separate from source materialization', () => {
    const invocation = runSearch(['needle', '--limit', '2', '--context', '0', '--json']);

    expect(invocation.status).toBe(0);
    const envelope = JSON.parse(invocation.stdout);
    expect(envelope.result.identities).toHaveLength(30);
    expect(envelope.result.identityManifest).toBeUndefined();
    expect(envelope.result.matches).toHaveLength(2);
    expect(envelope.coverage).toMatchObject({ complete: true, returned: 30, total: 30, omitted: 0 });
  });

  it('uses --full only to materialize every already-known identity', () => {
    const invocation = runSearch(['needle', '--full', '--context', '0']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain('MATCH IDENTITIES (30/30, COMPLETE)');
    expect(invocation.stdout).toContain('REPRESENTATIVE SOURCE (30/30 WINDOWS)');
    expect(invocation.stdout).toContain('Every matching source window was materialized; no drilldown remains.');
  });

  it('bounds an accidentally broad identity selector before transport while preserving exact recovery scopes', () => {
    const invocation = runSearch(['broad_selector_token', '--limit', '2', '--context', '0']);

    expect(invocation.status).toBe(0);
    expect(invocation.stderr).toBe('');
    expect(invocation.stdout).toContain('MATCH IDENTITIES (64/150, BOUNDED)');
    expect(invocation.stdout).toContain('Exact cardinality: 150 matching line(s) across 150 file(s).');
    expect(invocation.stdout).toContain('Broad selector: identity enumeration stopped before output transport');
    expect(invocation.stdout).toContain("scip-query search 'broad_selector_token' --scope 'src/broad-");
    expect(invocation.stdout).not.toContain('[scip-query output page:');
    expect(invocation.stdout.length).toBeLessThan(32_000);
  });

  it('reports bounded machine-readable coverage for a broad selector', () => {
    const invocation = runSearch(['broad_selector_token', '--limit', '2', '--context', '0', '--json']);

    expect(invocation.status).toBe(0);
    const envelope = JSON.parse(invocation.stdout);
    expect(envelope.result.identities).toHaveLength(150);
    expect(envelope.result.identityManifest).toHaveLength(64);
    expect(envelope.result.identityCoverage).toEqual({ mode: 'bounded', returned: 64, total: 150, omitted: 86 });
    expect(envelope.coverage).toMatchObject({ complete: true, returned: 150, total: 150, omitted: 0 });
    expect(envelope.result.scopeHints.length).toBeGreaterThan(0);
  });

  it('attributes an unindexed object method to its exact source callable instead of the module', () => {
    const invocation = runSearch(['sourceOwnedCommand']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain('sourceOwnedCommand 2-4 @ 2');
    expect(invocation.stdout).not.toContain('<file scope> @ 2');
  });

  function runSearch(args: readonly string[]): ReturnType<typeof spawnSync> {
    return spawnSync(
      join(repositoryRoot, 'node_modules', '.bin', 'vite-node'),
      ['--script', join(repositoryRoot, 'src', 'runtime', 'cli.ts'), 'search', ...args],
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
