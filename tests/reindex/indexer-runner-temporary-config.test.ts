import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runPreparedIndexers, type PreparedIndexerRun } from '../../src/reindex/indexer-runner.js';
import { getIndexerConfig } from '../../src/reindex/indexers.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('temporary indexer root configuration', () => {
  it('removes the exact config it exclusively created after a successful run', async () => {
    const root = createProject();
    const output = join(root, 'index.scip');

    const [result] = await runPreparedIndexers([nodeRun(root, output)], root, () => {});

    expect(result?.skipped).toBeUndefined();
    expect(existsSync(output)).toBe(true);
    expect(existsSync(join(root, 'tsconfig.json'))).toBe(false);
  });

  it('does not replace or remove a pre-existing config', async () => {
    const root = createProject();
    const output = join(root, 'index.scip');
    const configPath = join(root, 'tsconfig.json');
    writeFileSync(configPath, '{"compilerOptions":{"strict":true}}');

    await runPreparedIndexers([nodeRun(root, output)], root, () => {});

    expect(readFileSync(configPath, 'utf8')).toBe('{"compilerOptions":{"strict":true}}');
  });

  it('removes its unchanged config after an indexer failure', async () => {
    const root = createProject();
    const output = join(root, 'index.scip');
    const run = nodeRun(root, output);
    run.args = ['-e', 'process.exitCode = 2'];

    const [result] = await runPreparedIndexers([run], root, () => {});

    expect(result?.skipped?.reason).toContain('exited with status 2');
    expect(existsSync(join(root, 'tsconfig.json'))).toBe(false);
  });

  it('preserves actionable multiline indexer stderr in the skipped reason', async () => {
    const root = createProject();
    const output = join(root, 'index.scip');
    const run = nodeRun(root, output);
    run.args = ['-e', "process.stderr.write('missing compile_commands.json\\n'); process.exitCode = 2"];

    const [result] = await runPreparedIndexers([run], root, () => {});

    expect(result?.skipped?.reason).toContain('exited with status 2');
    expect(result?.skipped?.reason).toContain('missing compile_commands.json');
  });

  it('retains an owned config if another actor edits it during indexing', async () => {
    const root = createProject();
    const output = join(root, 'index.scip');
    const configPath = join(root, 'tsconfig.json');
    const replacement = '{"compilerOptions":{"checkJs":true}}';

    await runPreparedIndexers([nodeRun(root, output, replacement)], root, () => {});

    expect(readFileSync(configPath, 'utf8')).toBe(replacement);
  });

  it('creates every bounded project config for the child and removes them afterward', async () => {
    const root = createProject();
    const output = join(root, 'index.scip');
    const first = join(root, 'shard-0.json');
    const second = join(root, 'shard-1.json');
    const run = nodeRun(root, output);
    run.temporaryProjectConfigs = [
      { path: first, content: '{"files":["a.ts"]}' },
      { path: second, content: '{"files":["b.ts"]}' },
    ];
    run.args = [
      '-e',
      `const fs = require('node:fs'); const ok = fs.readFileSync(${JSON.stringify(first)}, 'utf8').includes('a.ts') && fs.readFileSync(${JSON.stringify(second)}, 'utf8').includes('b.ts'); if (!ok) process.exitCode = 2; else fs.writeFileSync(${JSON.stringify(output)}, 'index')`,
    ];

    const [result] = await runPreparedIndexers([run], root, () => {});

    expect(result?.skipped).toBeUndefined();
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it('replaces a stale owned project config left behind by an interrupted run', async () => {
    const root = createProject();
    const output = join(root, 'index.scip');
    const configPath = join(root, 'shard-0.json');
    writeFileSync(configPath, '{"files":["stale.ts"]}');
    const run = nodeRun(root, output);
    run.temporaryProjectConfigs = [{ path: configPath, content: '{"files":["fresh.ts"]}' }];
    run.args = [
      '-e',
      `const fs = require('node:fs'); if (!fs.readFileSync(${JSON.stringify(configPath)}, 'utf8').includes('fresh.ts')) process.exitCode = 2; else fs.writeFileSync(${JSON.stringify(output)}, 'index')`,
    ];

    const [result] = await runPreparedIndexers([run], root, () => {});

    expect(result?.skipped).toBeUndefined();
    expect(existsSync(configPath)).toBe(false);
  });
});

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-indexer-config-'));
  roots.push(root);
  return root;
}

function nodeRun(root: string, output: string, replacement?: string): PreparedIndexerRun {
  const configPath = join(root, 'tsconfig.json');
  const script = replacement
    ? `require('node:fs').writeFileSync(${JSON.stringify(configPath)}, ${JSON.stringify(replacement)}); require('node:fs').writeFileSync(${JSON.stringify(output)}, 'index')`
    : `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'index')`;
  return {
    id: 'javascript',
    language: 'javascript',
    label: 'javascript',
    scipPath: output,
    outputScipPath: output,
    config: getIndexerConfig('javascript'),
    resolvedBinary: process.execPath,
    binary: process.execPath,
    args: ['-e', script],
    env: process.env,
    temporaryRootConfigContent: '{"compilerOptions":{"allowJs":true}}',
  };
}
