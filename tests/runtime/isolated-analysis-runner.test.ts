import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  groupAnalysisTasks,
  ISOLATED_ANALYSIS_PROTOCOL,
  ISOLATED_ANALYSIS_SCHEMA_VERSION,
  printIsolatedAnalysisResult,
  runAnalysisTasks,
  runIsolatedJsonProcess,
  runIsolatedJsonProcessAsync,
} from '../../src/runtime/isolated-analysis-runner.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('analysis scheduler', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('identifies the private child-process protocol and producer', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    printIsolatedAnalysisResult('__probe', { ok: true });

    expect(JSON.parse(writes[0]!)).toMatchObject({
      protocol: ISOLATED_ANALYSIS_PROTOCOL,
      schemaVersion: ISOLATED_ANALYSIS_SCHEMA_VERSION,
      producer: { name: 'scip-query', version: expect.any(String) },
      command: '__probe',
      result: { ok: true },
    });
  });

  it('preserves input order while running tasks concurrently', async () => {
    const completionOrder: number[] = [];
    let active = 0;
    let maxActive = 0;

    const results = await runAnalysisTasks([30, 5, 10], 2, async (duration) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(duration);
      active -= 1;
      completionOrder.push(duration);
      return duration / 5;
    });

    expect(results).toEqual([6, 1, 2]);
    expect(completionOrder).toEqual([5, 10, 30]);
    expect(maxActive).toBe(2);
  });

  it('groups first-seen task families and keeps unrelated tasks as singletons', () => {
    const reactTasks = new Set(['react-component', 'react-hook']);
    const vueTasks = new Set(['vue-component', 'suppressions']);

    expect(
      groupAnalysisTasks(
        ['overview', 'react-component', 'dead', 'vue-component', 'react-hook', 'suppressions'],
        [reactTasks, vueTasks],
      ),
    ).toEqual([['overview'], ['react-component', 'react-hook'], ['dead'], ['vue-component', 'suppressions']]);
  });

  it('reads JSON from an isolated child process', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-analysis-scheduler-'));
    tempDirs.push(tempDir);
    const scriptPath = join(tempDir, 'child.cjs');
    writeFileSync(
      scriptPath,
      [
        'process.stdout.write(JSON.stringify({',
        `  protocol: ${JSON.stringify(ISOLATED_ANALYSIS_PROTOCOL)},`,
        `  schemaVersion: ${ISOLATED_ANALYSIS_SCHEMA_VERSION},`,
        "  producer: { name: 'scip-query', version: 'test' },",
        '  command: process.argv[2],',
        '  result: { command: process.argv[2], args: process.argv.slice(3) },',
        '}));',
      ].join('\n'),
    );

    await expect(
      runIsolatedJsonProcessAsync<{ command: string; args: string[] }>({
        cliPath: scriptPath,
        command: 'probe',
        args: ['alpha', 'beta'],
        label: 'Scheduler child',
      }),
    ).resolves.toEqual({ command: 'probe', args: ['alpha', 'beta'] });
  });

  it('rejects an unsupported isolated-analysis protocol version before using the result', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-analysis-protocol-'));
    tempDirs.push(tempDir);
    const scriptPath = join(tempDir, 'child.cjs');
    writeFileSync(
      scriptPath,
      `process.stdout.write(JSON.stringify({ protocol: ${JSON.stringify(
        ISOLATED_ANALYSIS_PROTOCOL,
      )}, schemaVersion: 2, producer: { name: 'scip-query', version: 'future' }, command: process.argv[2], result: {} }));\n`,
    );

    await expect(
      runIsolatedJsonProcessAsync({
        cliPath: scriptPath,
        command: 'probe',
        label: 'Scheduler child',
      }),
    ).rejects.toThrow(/unsupported isolated-analysis schemaVersion 2/);
  });

  it('enforces the timeout supplied to the synchronous isolated runner', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-analysis-sync-timeout-'));
    tempDirs.push(tempDir);
    const scriptPath = join(tempDir, 'child.cjs');
    writeFileSync(scriptPath, 'setInterval(() => {}, 1000);\n');

    expect(() =>
      runIsolatedJsonProcess({
        cliPath: scriptPath,
        command: 'probe',
        label: 'Synchronous child',
        timeoutMs: 50,
      }),
    ).toThrow(/timed out after 50ms/i);
  });

  it('terminates and reaps an asynchronous isolated child at its deadline', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-analysis-async-timeout-'));
    tempDirs.push(tempDir);
    const scriptPath = join(tempDir, 'child.cjs');
    writeFileSync(scriptPath, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");

    await expect(
      runIsolatedJsonProcessAsync({
        cliPath: scriptPath,
        command: 'probe',
        label: 'Asynchronous child',
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ timedOut: true, reaped: true });
  });
});
