import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runPreparedIndexers, type PreparedIndexerRun } from '../../src/reindex/indexer-runner.js';
import { getIndexerConfig } from '../../src/reindex/indexers.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('indexer owner cancellation', () => {
  it('terminates an active bounded indexer and propagates the owner-loss reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-indexer-cancel-'));
    roots.push(root);
    const output = join(root, 'late.scip');
    const controller = new AbortController();
    const reason = new Error('watcher owner exited');
    const running = runPreparedIndexers([delayedNodeRun(output)], root, () => {}, 1, controller.signal);

    setTimeout(() => controller.abort(reason), 25);

    await expect(running).rejects.toBe(reason);
    expect(existsSync(output)).toBe(false);
  });
});

function delayedNodeRun(output: string): PreparedIndexerRun {
  return {
    id: 'typescript',
    language: 'typescript',
    label: 'typescript',
    scipPath: output,
    outputScipPath: output,
    config: getIndexerConfig('typescript'),
    resolvedBinary: process.execPath,
    binary: process.execPath,
    args: ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(output)}, 'late'), 10_000)`],
    env: process.env,
  };
}
