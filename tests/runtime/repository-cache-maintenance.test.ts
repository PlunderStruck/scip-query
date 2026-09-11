import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import { RepositoryCacheMaintenance } from '../../src/runtime/repository-cache-maintenance.js';
import {
  BoundedProcessError,
  runBoundedProcess,
  type BoundedProcessResult,
} from '../../src/platform/bounded-process.js';

const success: BoundedProcessResult = {
  status: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  durationMs: 1,
  stdoutTruncated: false,
  stderrTruncated: false,
};
const tick = () => new Promise<void>((done) => setImmediate(done));

test('coalesces cleanup requests, permits the next completed job, and never starts after close', async () => {
  let finish!: (value: BoundedProcessResult) => void;
  const run = vi.fn<typeof runBoundedProcess>(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const maintenance = new RepositoryCacheMaintenance({
    projectRoot: '/fixture',
    cliVersion: 'test',
    onError: vi.fn(),
    run,
  });
  maintenance.start();
  maintenance.start();
  maintenance.start();
  expect(run).toHaveBeenCalledTimes(1);
  finish(success);
  await tick();
  maintenance.start();
  expect(run).toHaveBeenCalledTimes(2);
  const closing = maintenance.close();
  expect(run.mock.calls[1]![0].signal!.aborted).toBe(true);
  finish(success);
  await closing;
  maintenance.start();
  expect(run).toHaveBeenCalledTimes(2);
});

test('reports a spawn or exit failure without failing indexing and retries on the next sweep', async () => {
  const report = vi.fn();
  const run = vi
    .fn<typeof runBoundedProcess>()
    .mockRejectedValueOnce(new BoundedProcessError('spawn', 'cleanup', 'could not spawn', { reaped: true }))
    .mockResolvedValueOnce({ ...success, status: 7, stderr: 'sweep failed' })
    .mockResolvedValue(success);
  const maintenance = new RepositoryCacheMaintenance({
    projectRoot: '/fixture',
    cliVersion: 'test',
    onError: report,
    run,
  });
  for (let n = 0; n < 3; n++) {
    maintenance.start();
    await tick();
  }
  expect(run).toHaveBeenCalledTimes(3);
  expect(report.mock.calls.map(([error]) => error.message)).toEqual([
    'could not spawn',
    'Repository cache maintenance exited with 7: sweep failed',
  ]);
  await maintenance.close();
});

test('an unreaped process prevents a replacement and fails the shutdown ownership check', async () => {
  const failure = new BoundedProcessError('timeout', 'cleanup', 'unreaped cleanup', { reaped: false });
  const run = vi.fn<typeof runBoundedProcess>().mockRejectedValue(failure);
  const maintenance = new RepositoryCacheMaintenance({
    projectRoot: '/fixture',
    cliVersion: 'test',
    onError: vi.fn(),
    run,
  });
  maintenance.start();
  await tick();
  maintenance.start();
  expect(run).toHaveBeenCalledTimes(1);
  await expect(maintenance.close()).rejects.toBe(failure);
});

test('failure reporting cannot create an unhandled rejection or disappear before shutdown', async () => {
  const failure = new Error('state write failed');
  const maintenance = new RepositoryCacheMaintenance({
    projectRoot: '/fixture',
    cliVersion: 'test',
    run: vi.fn<typeof runBoundedProcess>().mockRejectedValue(new Error('cleanup failed')),
    onError() {
      throw failure;
    },
  });
  maintenance.start();
  await tick();
  await expect(maintenance.close()).rejects.toBe(failure);
});

test('a blocked cleanup child leaves timers and request handling responsive and is reaped on shutdown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scip-cache-maintenance-'));
  const ready = join(root, 'ready.json');
  const worker = join(root, 'busy.mjs');
  writeFileSync(
    worker,
    `import {writeFileSync} from 'node:fs';\nprocess.on('SIGTERM',()=>{});\nwriteFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);\n`,
  );
  const report = vi.fn();
  const maintenance = new RepositoryCacheMaintenance({
    projectRoot: root,
    cliVersion: 'test',
    onError: report,
    workerUrl: pathToFileURL(worker),
  });
  let heartbeats = 0;
  const timer = setInterval(() => {
    heartbeats++;
  }, 10);
  try {
    maintenance.start();
    const deadline = performance.now() + 1500;
    while (!existsSync(ready) && performance.now() < deadline) await delay(10);
    expect(existsSync(ready)).toBe(true);
    const { pid } = JSON.parse(readFileSync(ready, 'utf8'));
    const before = heartbeats;
    await delay(80);
    expect(heartbeats - before).toBeGreaterThanOrEqual(3);
    expect(await Promise.resolve('request served')).toBe('request served');
    await maintenance.close();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(report).not.toHaveBeenCalled();
  } finally {
    clearInterval(timer);
    await maintenance.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the packaged finite worker uses the existing cache policy and exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scip-cache-worker-'));
  try {
    const result = await runBoundedProcess({
      command: process.execPath,
      args: [resolve('dist/repository-cache-worker.js'), root, 'test'],
      cwd: root,
      env: { ...process.env, XDG_CACHE_HOME: join(root, 'cache') },
      label: 'cache worker smoke',
      timeoutMs: 3000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 4096,
    });
    expect(result.status, result.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
