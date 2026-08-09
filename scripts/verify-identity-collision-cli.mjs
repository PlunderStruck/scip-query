import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(projectRoot, 'tests/fixtures/exploration-benchmark/identity-collision');
const sandboxRoot = mkdtempSync(join(tmpdir(), 'scip-query-identity-collision-cli-'));
const repository = join(sandboxRoot, 'repository');
const cliPath = join(projectRoot, 'dist/cli.js');
const env = { ...process.env, SCIP_QUERY_CACHE_DIR: join(sandboxRoot, 'cache') };

try {
  cpSync(fixtureRoot, repository, { recursive: true });
  execFileSync(process.execPath, [cliPath, 'reindex', '--language', 'typescript', '--force'], {
    cwd: repository,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = execFileSync(
    process.execPath,
    [
      cliPath,
      'evidence',
      '--at',
      'src/source.ts:1',
      '--edge',
      'execution',
      '--direction',
      'outgoing',
      '--depth',
      '1',
      '--max-edges',
      '50',
    ],
    {
      cwd: repository,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  assert.match(output, /src:source:transform/);
  assert.doesNotMatch(output, /src\/push\.ts/);
  assert.doesNotMatch(output, /src\/slice\.ts/);
  console.log('identity-collision packaged CLI corpus passed');
} finally {
  rmSync(sandboxRoot, { recursive: true, force: true });
}
