import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('search CLI identity and materialization contract', () => {
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
    expect(invocation.stdout).toContain('Identity coverage: 30/30 matching line(s) across 30 file(s); complete.');
    expect(invocation.stdout).toContain('Recover every unmaterialized owning unit in 2 bounded batch command(s)');
    expect(invocation.stdout).toContain('src/group-30/match.ts');
    expect(invocation.stdout).not.toContain('[scip-query output page:');
  });

  it('keeps machine-readable identity coverage separate from source materialization', () => {
    const invocation = runSearch(['needle', '--limit', '2', '--context', '0', '--json']);

    expect(invocation.status).toBe(0);
    const envelope = JSON.parse(invocation.stdout);
    expect(envelope.result.identities).toHaveLength(30);
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
