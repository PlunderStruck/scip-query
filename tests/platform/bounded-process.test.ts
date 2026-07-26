import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { runBoundedProcess, type BoundedProcessResult } from '../../src/platform/bounded-process.js';
import type { BoundedProcessError } from '../../src/platform/bounded-process.js';

function nodeProcess(source: string, overrides: Partial<Parameters<typeof runBoundedProcess>[0]> = {}) {
  return runBoundedProcess({
    command: process.execPath,
    args: ['-e', source],
    label: 'hostile fixture',
    timeoutMs: 2_000,
    terminationGraceMs: 50,
    maxStdoutBytes: 16 * 1024,
    maxStderrBytes: 16 * 1024,
    ...overrides,
  });
}

describe('runBoundedProcess', () => {
  it('returns bounded stdout, stderr, and a nonzero exit without hiding the status', async () => {
    const result = await nodeProcess("process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7;");

    expect(result).toEqual<BoundedProcessResult>(
      expect.objectContaining({
        status: 7,
        stdout: 'out',
        stderr: 'err',
        timedOut: false,
      }),
    );
  });

  it('terminates and reaps a child that ignores the graceful signal', async () => {
    const started = performance.now();
    await expect(
      nodeProcess("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", {
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({
      name: 'BoundedProcessError',
      kind: 'timeout',
      timedOut: true,
    } satisfies Partial<BoundedProcessError>);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('waits for a child that exits during the graceful termination window', async () => {
    await expect(
      nodeProcess("process.on('SIGTERM', () => setTimeout(() => process.exit(0), 10)); setInterval(() => {}, 1000);", {
        timeoutMs: 50,
        terminationGraceMs: 100,
      }),
    ).rejects.toMatchObject({ kind: 'timeout', reaped: true });
  });

  it('bounds stdout independently of the child exit status', async () => {
    await expect(
      nodeProcess("process.stdout.write('x'.repeat(64 * 1024));", {
        maxStdoutBytes: 1_024,
      }),
    ).rejects.toMatchObject({
      kind: 'stdout-limit',
      reaped: true,
    });
  });

  it('bounds stderr independently of stdout', async () => {
    await expect(
      nodeProcess("process.stderr.write('x'.repeat(64 * 1024));", {
        maxStderrBytes: 1_024,
      }),
    ).rejects.toMatchObject({
      kind: 'stderr-limit',
      reaped: true,
    });
  });

  it('classifies a command that cannot be spawned as already reaped', async () => {
    await expect(
      runBoundedProcess({
        command: '/definitely/not/a/scip-query-command',
        args: [],
        label: 'missing fixture',
        timeoutMs: 1_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
      }),
    ).rejects.toMatchObject({
      kind: 'spawn',
      reaped: true,
    });
  });

  it('can retain a bounded tail while draining output beyond the budget', async () => {
    const result = await nodeProcess("process.stdout.write('prefix-' + 'x'.repeat(8 * 1024) + '-suffix');", {
      maxStdoutBytes: 64,
      outputLimitBehavior: 'truncate-tail',
    });

    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64);
    expect(result.stdout).toMatch(/-suffix$/);
  });

  it('supports owned cancellation and settles only after the child is reaped', async () => {
    const controller = new AbortController();
    const completion = nodeProcess("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", {
      signal: controller.signal,
      terminationGraceMs: 25,
    });
    controller.abort();

    await expect(completion).rejects.toMatchObject({
      kind: 'aborted',
      reaped: true,
    });
  });
});
