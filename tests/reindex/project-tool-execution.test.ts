import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trustProjectLocalIndexerBinary } from '../../src/platform/indexer-toolchain.js';
import { runPreparedIndexers, type PreparedIndexerRun } from '../../src/reindex/indexer-runner.js';
import { getIndexerConfig } from '../../src/reindex/indexers.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('trusted project indexer execution', () => {
  it('executes the reviewed identity when it is unchanged', async () => {
    const root = createProject();
    const output = join(root, 'trusted.scip');
    writeTool(root, `printf trusted > ${shellQuote(output)}\n`);
    const identity = trustIdentity(root);

    const [result] = await runPreparedIndexers([preparedRun(output, identity)], root, () => {});

    expect(result?.skipped).toBeUndefined();
    expect(result?.outputBytes).toBe(7);
  });

  it('refuses a project indexer replaced after consent and never executes it', async () => {
    const root = createProject();
    const output = join(root, 'replaced.scip');
    const marker = join(root, 'executed');
    const tool = writeTool(root, 'exit 0\n');
    const identity = trustIdentity(root);
    writeFileSync(tool, `#!/bin/sh\nprintf executed > ${shellQuote(marker)}\n`);
    chmodSync(tool, 0o755);

    const [result] = await runPreparedIndexers([preparedRun(output, identity)], root, () => {});

    expect(result?.skipped?.reason).toContain('refusing changed project-local indexer');
    expect(existsSync(marker)).toBe(false);
  });
});

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-project-exec-'));
  roots.push(root);
  return root;
}

function writeTool(root: string, body: string): string {
  const path = join(root, 'node_modules/.bin/scip-clojure');
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

function trustIdentity(root: string) {
  const identity = trustProjectLocalIndexerBinary(getIndexerConfig('clojure'), root);
  if (!identity) throw new Error('fixture tool was not discovered');
  return identity;
}

function preparedRun(
  output: string,
  trustedProjectTool: NonNullable<PreparedIndexerRun['trustedProjectTool']>,
): PreparedIndexerRun {
  return {
    id: 'clojure',
    language: 'clojure',
    label: 'clojure',
    scipPath: output,
    outputScipPath: output,
    config: getIndexerConfig('clojure'),
    resolvedBinary: trustedProjectTool.canonicalPath,
    binary: trustedProjectTool.canonicalPath,
    args: [],
    env: process.env,
    trustedProjectTool,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
