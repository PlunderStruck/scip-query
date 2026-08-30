import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReindexRunner, type ReindexRunRequest } from '../../src/runtime/watch.js';

const tempDirs: string[] = [];

function fixtureRequest(projectRoot: string): ReindexRunRequest {
  return {
    projectRoot,
    config: {},
    pnpmWorkspaces: false,
    trigger: { kind: 'watch-source', detail: 'fixture' },
  };
}

function fixtureRunner(scriptPath: string, maxOutputBytes = 1_024) {
  return createReindexRunner({
    timeoutMs: 2_000,
    terminationGraceMs: 25,
    maxOutputBytes,
    resolveLaunch: () => ({
      workerPath: scriptPath,
      env: process.env,
    }),
  });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('watch reindex runner', () => {
  it('drains output larger than an OS pipe while retaining bounded diagnostic tails', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-watch-runner-output-'));
    tempDirs.push(projectRoot);
    const scriptPath = join(projectRoot, 'worker.cjs');
    writeFileSync(
      scriptPath,
      [
        "process.stdout.write('stdout-prefix-' + 'x'.repeat(256 * 1024) + '-stdout-suffix');",
        "process.stderr.write('stderr-prefix-' + 'y'.repeat(256 * 1024) + '-stderr-suffix');",
      ].join('\n'),
    );

    const operation = fixtureRunner(scriptPath).start(fixtureRequest(projectRoot));
    await expect(operation.completion).resolves.toBeGreaterThanOrEqual(0);

    expect(operation.diagnostics()).toEqual(
      expect.objectContaining({
        stdoutTruncated: true,
        stderrTruncated: true,
      }),
    );
    expect(Buffer.byteLength(operation.diagnostics().stdoutTail)).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(operation.diagnostics().stderrTail)).toBeLessThanOrEqual(1_024);
    expect(operation.diagnostics().stdoutTail).toMatch(/-stdout-suffix$/);
    expect(operation.diagnostics().stderrTail).toMatch(/-stderr-suffix$/);
  });

  it('cancels, escalates, and reaps a worker that ignores TERM', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-watch-runner-cancel-'));
    tempDirs.push(projectRoot);
    const scriptPath = join(projectRoot, 'worker.cjs');
    writeFileSync(scriptPath, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");

    const operation = fixtureRunner(scriptPath).start(fixtureRequest(projectRoot));
    const completion = expect(operation.completion).rejects.toThrow(/cancelled/i);
    await expect(operation.cancel()).resolves.toEqual(
      expect.objectContaining({
        state: 'exited',
      }),
    );
    await completion;
  });

  it('includes the bounded stderr tail when a worker exits unsuccessfully', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-watch-runner-error-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'nested'));
    const scriptPath = join(projectRoot, 'worker.cjs');
    writeFileSync(scriptPath, "process.stderr.write('worker diagnostic'); process.exitCode = 7;\n");

    const operation = fixtureRunner(scriptPath).start(fixtureRequest(projectRoot));
    await expect(operation.completion).rejects.toThrow(/worker diagnostic/);
    expect(operation.diagnostics().stderrTail).toBe('worker diagnostic');
  });

  it('marks exit code 75 as a retryable ownership conflict', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-watch-runner-retry-'));
    tempDirs.push(projectRoot);
    const scriptPath = join(projectRoot, 'worker.cjs');
    writeFileSync(scriptPath, "process.stderr.write('cache lifecycle lock is busy'); process.exitCode = 75;\n");

    const operation = fixtureRunner(scriptPath).start(fixtureRequest(projectRoot));
    const error = await operation.completion.catch((failure: unknown) => failure);

    expect(error).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('cache lifecycle lock is busy'),
        retryable: true,
      }),
    );
  });
});
