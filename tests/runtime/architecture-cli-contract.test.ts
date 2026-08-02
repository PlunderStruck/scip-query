import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureDb, createFixtureProject } from '../fixtures/command-accuracy-fixtures.js';

describe('architecture CLI enforcement contract', () => {
  const repositoryRoot = process.cwd();
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'scip-query-architecture-cli-'));
  const dbPath = join(fixtureRoot, 'index.db');

  beforeAll(() => {
    createFixtureProject(fixtureRoot);
    createFixtureDb(dbPath);
    writeFileSync(
      join(fixtureRoot, '.scipquery.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          architecture: {
            boundaries: [
              { name: 'source', paths: ['src/**'] },
              { name: 'tests', paths: ['tests/**'] },
            ],
            allowedDependencies: {
              source: ['tests'],
              tests: ['source'],
            },
            requireCompletePolicy: true,
            requireCompleteCoverage: true,
            requireMinimalPolicy: true,
          },
        },
        null,
        2,
      ),
    );
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('fails when a required-minimal policy contains a stale permission', () => {
    const invocation = spawnSync(
      join(repositoryRoot, 'node_modules', '.bin', 'vite-node'),
      ['--script', join(repositoryRoot, 'src', 'runtime', 'cli.ts'), 'architecture'],
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

    expect(invocation.status).toBe(1);
    expect(invocation.stderr).toBe('');
    expect(invocation.stdout).toContain('Architecture policy failed with 1 enforced finding');
    expect(invocation.stdout).toContain('Stale dependency allowances (1)');
    expect(invocation.stdout).toContain('[violates requireMinimalPolicy]');
    expect(invocation.stdout).toContain('source -> tests');
  });
});
