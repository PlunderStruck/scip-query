import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { IndexerHistoryFixture } from './indexer-history-fixture.js';

export function interruptibleIndexer(
  fixture: IndexerHistoryFixture,
  point: string,
  action: 'pause' | 'fail' | 'cancel' = 'pause',
) {
  const control = mkdtempSync(join(tmpdir(), 'scip-query-indexer-control-'));
  const checkpoint = join(control, 'checkpoint.json');
  const started = join(control, 'started');
  const release = join(control, 'release');
  const config = join(control, 'input.json');
  writeFileSync(
    config,
    JSON.stringify({ root: fixture.root, cache: fixture.cache, point, action, started, checkpoint, release }),
  );
  const child = spawn(
    process.execPath,
    [
      resolve('node_modules/vite-node/vite-node.mjs'),
      resolve('tests/fixtures/indexer-interruption-process.ts'),
      config,
    ],
    {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (bytes: Buffer) => {
    output = (output + bytes.toString()).slice(-16_000);
  });
  child.stderr.on('data', (bytes: Buffer) => {
    output = (output + bytes.toString()).slice(-16_000);
  });
  let ended = false;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      ended = true;
      resolveResult({ code, signal });
    });
  });
  // Observe startup failures even while the caller awaits the checkpoint.
  void completion.catch(() => {});
  function kill(): void {
    if (!child.pid || ended) return;
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  const timer = setTimeout(kill, 60_000);
  return {
    completion,
    output: () => output,
    release() {
      writeFileSync(release, 'continue');
    },
    hasReached: () => existsSync(checkpoint),
    async started() {
      const deadline = performance.now() + 25_000;
      while (!existsSync(started)) {
        assert.ok(!ended && performance.now() < deadline, `Indexer did not fingerprint its inputs: ${output}`);
        await delay(10);
      }
    },
    async reached() {
      const deadline = performance.now() + 25_000;
      while (!existsSync(checkpoint)) {
        assert.ok(!ended && performance.now() < deadline, `Indexer failed to reach ${point}: ${output}`);
        await delay(10);
      }
      assert.equal(JSON.parse(readFileSync(checkpoint, 'utf8')).point, point);
    },
    async kill() {
      kill();
      return completion;
    },
    async dispose() {
      try {
        kill();
        await completion;
      } finally {
        clearTimeout(timer);
        rmSync(control, { recursive: true, force: true });
      }
    },
  };
}
